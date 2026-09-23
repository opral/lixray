import assert from "node:assert/strict";
import test from "node:test";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { fetchLixWithTrace, traceResponse, withSpan } from "./telemetry.ts";
import { createBrowserFileOpenTraceController } from "./lib/browser-file-open-trace.ts";
import type { Lix } from "@lix-js/sdk";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new W3CTraceContextPropagator() });
const tracer = trace.getTracer("test");

void test("concurrent RPCs propagate their own parent and include body consumption", async () => {
	exporter.reset();
	const headers: Headers[] = [];
	const gates = [deferred(), deferred()];
	const arrived = [deferred(), deferred()];
	const remoteTraceIds = [
		"11111111111111111111111111111111",
		"22222222222222222222222222222222",
	];
	const remoteSpanIds = ["1111111111111111", "2222222222222222"];
	const runs = gates.map((gate, index) =>
		withSpan(`operation-${index}`, async (parent) => {
			const response = await fetchLixWithTrace(
				"repo",
				new Request("https://lix.invalid/lix/v1/repo/execute?private=secret", {
					headers: {
						traceparent: `00-${remoteTraceIds[index]}-${remoteSpanIds[index]}-01`,
					},
				}),
				async (_id, request) => {
					headers[index] = request.headers;
					return new Response(
						new ReadableStream({
							async start(controller) {
								arrived[index]!.resolve();
								await gate.promise;
								controller.enqueue(new TextEncoder().encode("secret document"));
								controller.close();
							},
						}),
					);
				},
			);
			assert.equal(trace.getSpan(context.active()), parent);
			assert.equal(await response.text(), "secret document");
		}),
	);
	await Promise.all(arrived.map((gate) => gate.promise));
	assert.equal(exporter.getFinishedSpans().length, 0);
	gates[1]!.resolve();
	await runs[1];
	assert.equal(exporter.getFinishedSpans().length, 2);
	gates[0]!.resolve();
	await runs[0];
	const spans = exporter.getFinishedSpans();
	for (let index = 0; index < 2; index++) {
		const child = spans.find(
			(span) =>
				span.name === "lix.client.rpc" &&
				span.parentSpanContext?.spanId === remoteSpanIds[index],
		)!;
		assert.equal(child.spanContext().traceId, remoteTraceIds[index]);
		assert.equal(
			headers[index]!.get("traceparent"),
			`00-${child.spanContext().traceId}-${child.spanContext().spanId}-01`,
		);
		assert.equal(child.attributes["http.route"], "/lix/v1/{lix_id}/execute");
	}
	assert.notEqual(
		headers[0]!.get("traceparent"),
		headers[1]!.get("traceparent"),
	);
	assert.doesNotMatch(
		JSON.stringify(spans.map((span) => span.attributes)),
		/secret|private/,
	);
});

void test("response EOF, cancellation, abort and body failure each end once", async () => {
	for (const mode of ["empty", "cancel", "abort", "error"] as const) {
		exporter.reset();
		const abort = new AbortController();
		const span = tracer.startSpan(mode);
		const response = traceResponse(
			mode === "empty"
				? new Response(null, { status: 204 })
				: new Response(
						new ReadableStream({
							pull(controller) {
								if (mode === "error") controller.error(new Error("secret"));
							},
						}),
					),
			span,
			undefined,
			abort.signal,
		);
		if (mode === "abort") {
			abort.abort();
			await response.body!.cancel();
		}
		if (mode === "cancel") {
			await response.body!.cancel();
			abort.abort();
		}
		if (mode === "error") await assert.rejects(response.text());
		const spans = exporter.getFinishedSpans();
		assert.equal(spans.length, 1, mode);
		assert.equal(
			spans[0]!.status.code,
			mode === "empty" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
		);
		assert.doesNotMatch(JSON.stringify(spans[0]!.events), /secret/);
	}
});

void test("withSpan preserves explicit tool errors and never records exception content", async () => {
	exporter.reset();
	await withSpan("tool-error", async (span) => {
		span.setStatus({ code: SpanStatusCode.ERROR });
	});
	await assert.rejects(
		withSpan("throw", async () => {
			throw new Error("private SQL and token");
		}),
	);
	assert.equal(exporter.getFinishedSpans().length, 2);
	assert.ok(
		exporter
			.getFinishedSpans()
			.every((span) => span.status.code === SpanStatusCode.ERROR),
	);
	assert.ok(
		exporter.getFinishedSpans().every((span) => span.events.length === 0),
	);
});

void test("file-open root covers a document's first live observation", async () => {
	exporter.reset();
	const fileId = "file-id";
	const filePath = "/posts.csv";
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute(fileId);
	controller.resolved(fileId, filePath);
	let releaseNext!: () => void;
	let observedParent: string | undefined;
	const fakeLix = {
		observe: () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next: () => {
				observedParent = trace.getSpan(context.active())?.spanContext().spanId;
				return new Promise<IteratorResult<never>>((resolve) => {
					releaseNext = () => resolve({ done: true, value: undefined });
				});
			},
		}),
	} as unknown as Lix;
	const observation = controller
		.scopeLix(filePath, fakeLix)
		.observe("SELECT 1");
	const firstFrame = observation.next();
	controller.documentLoaded(filePath);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(exporter.getFinishedSpans().length, 0);
	releaseNext();
	await firstFrame;
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.name, "lixray.file.open");
	assert.equal(observedParent, root?.spanContext().spanId);
	assert.equal(root.attributes["lixray.file.open.outcome"], "loaded");
});

void test("repository retry starts a new file-open root before SDK work", () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute("file-id");
	const initial = controller.run(() => trace.getSpan(context.active()));
	controller.ensureRepositoryAttempt("file-id");
	assert.equal(
		controller.run(() => trace.getSpan(context.active())),
		initial,
	);
	controller.failed("file-id");

	controller.ensureRepositoryAttempt("file-id");
	const retry = controller.run(() => trace.getSpan(context.active()));
	assert.ok(retry);
	assert.notEqual(retry?.spanContext().spanId, initial?.spanContext().spanId);
	controller.cancel();
	assert.deepEqual(
		exporter.getFinishedSpans().map((span) => span.name),
		["lixray.file.open", "lixray.file.open"],
	);
});
