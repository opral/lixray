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
	const runs = gates.map((gate, index) =>
		withSpan(`operation-${index}`, async (parent) => {
			const response = await fetchLixWithTrace(
				"repo",
				new Request("https://lix.invalid/lix/v1/repo/execute?private=secret", {
					headers: {
						traceparent:
							"00-11111111111111111111111111111111-1111111111111111-01",
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
		const parent = spans.find((span) => span.name === `operation-${index}`)!;
		const child = spans.find(
			(span) =>
				span.name === "lix.client.rpc" &&
				span.parentSpanContext?.spanId === parent.spanContext().spanId,
		)!;
		assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
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
