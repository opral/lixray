import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "./otlp-traces.schema.json" with { type: "json" };
import { handleOtlpTelemetry, MAX_OTLP_BYTES } from "./otlp-telemetry.ts";

const env = {
	LIXRAY_INTERNAL_TOKEN: "internal-secret",
	POSTHOG_PROJECT_TOKEN: "project-token",
	POSTHOG_HOST: "https://posthog.example",
	POSTHOG_ENVIRONMENT: "production",
};
interface CaptureBatch {
	api_key: string;
	batch: Array<{
		event: string;
		distinct_id: string;
		timestamp: string;
		uuid: string;
		properties: Record<string, string>;
	}>;
}
const codec = protobuf.Root.fromJSON(schema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

function span(name = "lix.repository.opened", account = "account-123") {
	return {
		name,
		traceId: Array(16).fill(1),
		spanId: Array(8).fill(2),
		startTimeUnixNano: "1788735600123456789",
		attributes: [
			{ key: "lix.account_id", value: { stringValue: account } },
			{ key: "lix.id", value: { stringValue: "lix-123" } },
			{ key: "lix.branch_id", value: { stringValue: "branch-123" } },
			{ key: "private-field", value: { stringValue: "must-not-project" } },
		],
	};
}
function encode(spans: ReturnType<typeof span>[]) {
	return codec
		.encode(
			codec.fromObject({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{ key: "service.name", value: { stringValue: "lix-server" } },
							],
						},
						scopeSpans: [{ spans }],
					},
				],
			}),
		)
		.finish();
}
function request(body: Uint8Array, headers: Record<string, string> = {}) {
	return new Request("https://lixray.com/api/telemetry/otlp/v1/traces", {
		method: "POST",
		body: new Uint8Array(body),
		headers: {
			authorization: `Bearer ${env.LIXRAY_INTERNAL_TOKEN}`,
			"content-type": "application/x-protobuf",
			...headers,
		},
	});
}

void test("standard compressed OTLP is forwarded unchanged and only identified opens are projected", async () => {
	const original = gzipSync(
		encode([
			span(),
			span("lix.sql.query"),
			span("lix.repository.opened", "lixray-demo"),
			span("lix.repository.opened", "00000000-0000-7000-8000-000000000002"),
			span("lix.repository.opened", ""),
		]),
	);
	const calls: Request[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		calls.push(new Request(input, init));
		return new Response(null, { status: 200 });
	};
	const result = await handleOtlpTelemetry(
		request(original, { "content-encoding": "gzip" }),
		env,
		{ fetch: fetcher },
	);
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("content-type"), "application/x-protobuf");
	assert.equal((await result.arrayBuffer()).byteLength, 0);
	assert.equal(calls.length, 2);
	const native = calls.find((call) => call.url.endsWith("/i/v1/traces"))!;
	assert.deepEqual(
		new Uint8Array(await native.arrayBuffer()),
		new Uint8Array(original),
	);
	assert.equal(native.headers.get("authorization"), "Bearer project-token");
	assert.equal(native.headers.get("content-encoding"), "gzip");
	const payload = (await calls
		.find((call) => call.url.endsWith("/batch/"))!
		.json()) as CaptureBatch;
	assert.equal(payload.api_key, "project-token");
	assert.equal(payload.batch.length, 1);
	const event = payload.batch[0];
	assert.equal(event.event, "$ai_span");
	assert.equal(event.distinct_id, "account-123");
	assert.equal(event.timestamp, "2026-09-06T23:00:00.123Z");
	assert.match(
		event.uuid,
		/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.deepEqual(event.properties, {
		$ai_span_name: "lix.repository.opened",
		$ai_trace_id: "01".repeat(16),
		$ai_span_id: "02".repeat(8),
		lix_id: "lix-123",
		branch_id: "branch-123",
		repository_id: "lix-123",
		environment: "production",
		source: "server",
	});
});

void test("partial destination failure is retryable and replay keeps event UUID and timestamp", async () => {
	const body = encode([span()]);
	const events: unknown[] = [];
	let fail = true;
	const fetcher: typeof fetch = async (input, init) => {
		const sent = new Request(input, init);
		if (sent.url.endsWith("/batch/"))
			events.push(((await sent.json()) as CaptureBatch).batch[0]);
		return new Response(null, {
			status: fail && sent.url.endsWith("/i/v1/traces") ? 503 : 200,
		});
	};
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		503,
	);
	fail = false;
	assert.equal(
		(await handleOtlpTelemetry(request(body), env, { fetch: fetcher })).status,
		200,
	);
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], events[1]);
});

void test("SQL-only batches preserve native tracing without product capture", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async (input) => {
		assert.match(new Request(input).url, /\/i\/v1\/traces$/);
		calls++;
		return new Response();
	};
	assert.equal(
		(
			await handleOtlpTelemetry(request(encode([span("lix.sql.query")])), env, {
				fetch: fetcher,
			})
		).status,
		200,
	);
	assert.equal(calls, 1);
});

void test("auth, malformed protobuf, unsupported formats, and compressed expansion are rejected before export", async () => {
	const fetcher: typeof fetch = async () => {
		assert.fail("must not export");
	};
	for (const [input, status] of [
		[request(new Uint8Array(), { authorization: "Bearer wrong" }), 401],
		[request(new Uint8Array([0xff])), 400],
		[request(new Uint8Array([1]), { "content-encoding": "gzip" }), 400],
		[request(new Uint8Array(), { "content-encoding": "br" }), 415],
		[request(new Uint8Array(), { "content-type": "application/json" }), 415],
		[request(new Uint8Array(MAX_OTLP_BYTES + 1)), 413],
		[
			request(gzipSync(new Uint8Array(MAX_OTLP_BYTES + 1)), {
				"content-encoding": "gzip",
			}),
			413,
		],
	] as const) {
		assert.equal(
			(await handleOtlpTelemetry(input, env, { fetch: fetcher })).status,
			status,
		);
	}
});

void test("unconfigured destination never silently acknowledges trace loss", async () => {
	const fetcher: typeof fetch = async () => {
		assert.fail("must not export");
	};
	assert.equal(
		(
			await handleOtlpTelemetry(
				request(encode([])),
				{ ...env, POSTHOG_PROJECT_TOKEN: undefined },
				{ fetch: fetcher },
			)
		).status,
		503,
	);
	assert.equal(
		(
			await handleOtlpTelemetry(
				request(encode([])),
				{ ...env, POSTHOG_ENVIRONMENT: "preview" },
				{ fetch: fetcher },
			)
		).status,
		503,
	);
});

void test("stalled downstream delivery is aborted within the receiver deadline", async () => {
	let aborted = false;
	const fetcher: typeof fetch = (_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			// Keep the test alive; the production fetch implementation owns the socket.
			const guard = setTimeout(
				() => reject(new Error("deadline was not enforced")),
				6_000,
			);
			init!.signal!.addEventListener(
				"abort",
				() => {
					aborted = true;
					clearTimeout(guard);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});
	const started = Date.now();
	const result = await handleOtlpTelemetry(
		request(encode([span("lix.sql.query")])),
		env,
		{ fetch: fetcher },
	);
	assert.equal(result.status, 503);
	assert.equal(aborted, true);
	assert.ok(Date.now() - started < 5_000);
});
