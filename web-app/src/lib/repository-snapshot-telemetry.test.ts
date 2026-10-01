import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import protobuf from "protobufjs/light.js";
import schema from "../worker/otlp-traces.schema.json" with { type: "json" };
import { handleOtlpTelemetry } from "../worker/otlp-telemetry.ts";
import { fetchLixWithTrace } from "../telemetry.ts";
import {
	RepositoryRemoteSnapshotError,
	fetchRepositoryRemoteSnapshot,
} from "./repository-debug-remote.ts";
import { downloadRepositorySnapshot } from "./repository-snapshot-telemetry.ts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();
const codec = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

void test("snapshot HTTP failure reaches PostHog wire events with correlated reproduction context", async () => {
	exporter.reset();
	const requests: string[] = [];
	let fail = true;
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.setHeader("x-request-id", "snapshot-test-request");
		response.writeHead(fail ? 404 : 200, {
			"content-type": fail ? "text/plain" : "application/vnd.lix.snapshot",
		});
		response.end(fail ? "private-response-must-not-be-logged" : "LIX-fixture");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing server address");
		const repository = "11111111-1111-4111-8111-111111111111";
		const url = new URL(
			`http://127.0.0.1:${address.port}/lix/v1/${repository}/snapshot`,
		);
		const exceptions: Record<string, unknown>[] = [];
		const lifecycle: Record<string, unknown>[] = [];
		const run = () =>
			downloadRepositorySnapshot(
				() =>
					fetchRepositoryRemoteSnapshot({
						url,
						headers: { Authorization: "Bearer private-test-credential" },
						fetch: (input, init) =>
							fetchLixWithTrace(
								repository,
								new Request(input, init),
								(_id, request) => fetch(request),
							),
					}),
				repository,
				(_error, properties) => {
					exceptions.push(properties ?? {});
				},
				(_event, properties) => {
					lifecycle.push(properties ?? {});
				},
			);
		await assert.rejects(
			run(),
			(error) =>
				error instanceof RepositoryRemoteSnapshotError && error.status === 404,
		);
		assert.equal(exceptions.length, 1);
		assert.deepEqual(
			lifecycle.map((event) => event.outcome),
			["started", "failed"],
		);
		assert.equal(
			lifecycle[0]?.snapshot_attempt_id,
			lifecycle[1]?.snapshot_attempt_id,
		);
		const failure = exceptions[0]!;
		assert.equal(failure.httpStatus, 404);
		assert.equal(failure.failure_stage, "http_response");
		assert.equal(failure.request_id, "snapshot-test-request");
		assert.match(String(failure.$otel_trace_id), /^[0-9a-f]{32}$/);
		assert.match(String(failure.$otel_span_id), /^[0-9a-f]{16}$/);
		const spans = exporter.getFinishedSpans();
		const operation = spans.find(
			(span) => span.name === "repository.snapshot.download",
		)!;
		const request = spans.find((span) => span.name === "lix.client.rpc")!;
		assert.equal(
			request.spanContext().traceId,
			operation.spanContext().traceId,
		);
		assert.equal(
			request.parentSpanContext?.spanId,
			operation.spanContext().spanId,
		);
		const bytes = codec
			.encode(
				codec.fromObject({
					resourceSpans: [
						{
							resource: {
								attributes: [
									{ key: "service.name", value: { stringValue: "lixray-web" } },
									{
										key: "service.version",
										value: { stringValue: "test-release" },
									},
								],
							},
							scopeSpans: [
								{
									spans: spans.map((span) => ({
										name: span.name,
										traceId: Buffer.from(span.spanContext().traceId, "hex"),
										spanId: Buffer.from(span.spanContext().spanId, "hex"),
										parentSpanId: span.parentSpanContext
											? Buffer.from(span.parentSpanContext.spanId, "hex")
											: undefined,
										startTimeUnixNano: String(
											BigInt(span.startTime[0]) * 1000000000n +
												BigInt(span.startTime[1]),
										),
										status: { code: span.status.code },
										attributes: Object.entries(span.attributes).map(
											([key, value]) => ({
												key,
												value:
													typeof value === "number"
														? { doubleValue: value }
														: { stringValue: String(value) },
											}),
										),
									})),
								},
							],
						},
					],
				}),
			)
			.finish();
		const batches: Array<{
			batch: Array<{ event: string; properties: Record<string, unknown> }>;
		}> = [];
		const delivered = await handleOtlpTelemetry(
			new Request("https://lixray.test/api/telemetry/browser/otlp/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/x-protobuf" },
				body: new Uint8Array(bytes),
			}),
			{
				POSTHOG_PROJECT_TOKEN: "test-project",
				POSTHOG_HOST: "https://posthog.test",
				POSTHOG_ENVIRONMENT: "production",
			},
			{
				authenticatedBrowser: true,
				browserRepositoryId: repository,
				browserUserId: "test-user",
				fetch: async (input, init) => {
					const request = new Request(input, init);
					if (new URL(request.url).pathname === "/batch/") {
						const body: unknown = JSON.parse(await request.text());
						batches.push(body as (typeof batches)[number]);
					}
					return new Response(null, { status: 200 });
				},
			},
		);
		assert.equal(delivered.status, 200);
		const projected = batches
			.flatMap((batch) => batch.batch)
			.find(
				(event) =>
					event.properties.operation === "repository.snapshot.download",
			);
		assert.equal(projected?.event, "$exception");
		assert.deepEqual(projected?.properties.$exception_list, [
			{
				type: "RepositorySnapshotDownloadError",
				value: "Remote snapshot download failed (http_response, HTTP 404)",
				mechanism: { type: "generic", handled: true },
			},
		]);
		assert.equal(projected?.properties.failure_stage, "http_response");
		assert.equal(
			projected?.properties.snapshot_attempt_id,
			failure.snapshot_attempt_id,
		);
		assert.equal(projected?.properties.$otel_trace_id, failure.$otel_trace_id);
		assert.equal(projected?.properties.httpStatus, 404);
		assert.deepEqual(projected?.properties.reproduction, failure.reproduction);
		assert.doesNotMatch(
			JSON.stringify({ batches, exceptions, lifecycle }),
			/private-response|private-test-credential|Authorization|Bearer/,
		);
		fail = false;
		assert.equal(await (await run()).text(), "LIX-fixture");
		assert.deepEqual(requests, [
			`/lix/v1/${repository}/snapshot`,
			`/lix/v1/${repository}/snapshot`,
		]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

void test("stream failures are captured, while success and cancellation are quiet", async () => {
	let captures = 0;
	const capture = () => {
		captures++;
	};
	const event = () => {};
	await assert.rejects(
		downloadRepositorySnapshot(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("private stream contents"));
						},
					}),
				).blob(),
			"repository",
			capture,
			event,
		),
	);
	assert.equal(captures, 1);
	const blob = new Blob(["snapshot"]);
	assert.equal(
		await downloadRepositorySnapshot(
			async () => blob,
			"repository",
			capture,
			event,
		),
		blob,
	);
	await assert.rejects(
		downloadRepositorySnapshot(
			async () => {
				throw new DOMException("cancelled", "AbortError");
			},
			"repository",
			capture,
			event,
		),
	);
	assert.equal(captures, 1);
});
