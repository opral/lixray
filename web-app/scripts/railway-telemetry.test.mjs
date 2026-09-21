import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { connect } from "node:net";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { createRailwayServer } from "./railway-server.mjs";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new W3CTraceContextPropagator() });

async function serve(fetcher, run) {
	const server = createRailwayServer({
		app: { fetch: fetcher },
		clientRoot: "/nonexistent",
		env: {},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${server.address().port}`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test("HTTP span starts before app and ends after SSE tool, body and cleanup", async () => {
	exporter.reset();
	const responseReady = Promise.withResolvers();
	const work = Promise.withResolvers();
	let parentContext;
	await serve(
		async () => {
			parentContext = trace.getSpan(context.active()).spanContext();
			const tool = trace.getTracer("test").startSpan("mcp.tool");
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode("event: ready\ndata: {}\n\n"),
						);
						responseReady.resolve();
						void work.promise.then(() => {
							tool.end();
							controller.enqueue(
								new TextEncoder().encode("event: done\ndata: {}\n\n"),
							);
							controller.close();
						});
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		async (origin) => {
			const pending = fetch(`${origin}/mcp`, {
				method: "POST",
				headers: {
					traceparent:
						"00-11111111111111111111111111111111-2222222222222222-01",
					tracestate: "vendor=value",
				},
			});
			await responseReady.promise;
			const response = await pending;
			assert.equal(exporter.getFinishedSpans().length, 0);
			assert.equal(parentContext.traceId, "11111111111111111111111111111111");
			work.resolve();
			assert.match(await response.text(), /done/);
		},
	);
	const spans = exporter.getFinishedSpans();
	assert.equal(spans.length, 2);
	const root = spans.find((span) => span.name === "POST /mcp");
	const tool = spans.find((span) => span.name === "mcp.tool");
	assert.equal(root.parentSpanContext.spanId, "2222222222222222");
	assert.equal(root.spanContext().traceState.serialize(), "vendor=value");
	assert.equal(tool.parentSpanContext.spanId, root.spanContext().spanId);
	assert.ok(root.events.some((event) => event.name === "response_ready"));
	assert.ok(
		root.endTime[0] > tool.endTime[0] ||
			(root.endTime[0] === tool.endTime[0] &&
				root.endTime[1] >= tool.endTime[1]),
	);
});

test("bodyless and failed requests produce one completed HTTP span", async () => {
	for (const fail of [false, true]) {
		exporter.reset();
		await serve(
			async () => {
				if (fail) throw new Error("test failure");
				return new Response(null, { status: 204 });
			},
			async (origin) => {
				const response = await fetch(`${origin}/mcp`);
				assert.equal(response.status, fail ? 500 : 204);
				await response.text();
			},
		);
		assert.equal(exporter.getFinishedSpans().length, 1);
		assert.equal(
			exporter.getFinishedSpans()[0].status.code,
			fail ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
		);
	}
});

test("premature disconnect cancels request and ends root once", async () => {
	exporter.reset();
	const aborted = Promise.withResolvers();
	const cancelled = Promise.withResolvers();
	await serve(
		async (incoming) => {
			incoming.signal.addEventListener("abort", () => aborted.resolve(), {
				once: true,
			});
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("waiting"));
					},
					cancel() {
						cancelled.resolve();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		async (origin) => {
			await new Promise((resolve, reject) => {
				const call = request(`${origin}/mcp`, (response) => {
					response.once("data", () => {
						call.destroy();
						resolve();
					});
				});
				call.on("error", reject);
				call.end();
			});
			await aborted.promise;
			await cancelled.promise;
		},
	);
	assert.equal(exporter.getFinishedSpans().length, 1);
	assert.equal(
		exporter.getFinishedSpans()[0].status.code,
		SpanStatusCode.ERROR,
	);
});

test("malformed request target cannot crash the HTTP host", async () => {
	await serve(
		async () => new Response("ok"),
		async (origin) => {
			const port = Number(new URL(origin).port);
			const response = await new Promise((resolve, reject) => {
				const socket = connect(port, "127.0.0.1", () =>
					socket.write(
						"GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
					),
				);
				let text = "";
				socket.on("data", (chunk) => {
					text += chunk;
				});
				socket.on("end", () => resolve(text));
				socket.on("error", reject);
			});
			assert.match(response, /HTTP\/1.1 400/);
			assert.equal(await (await fetch(`${origin}/mcp`)).text(), "ok");
		},
	);
});

test("upstream body failure is not mislabeled as a client cancellation", async () => {
	exporter.reset();
	const fail = Promise.withResolvers();
	await serve(
		async () =>
			new Response(
				new ReadableStream({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("ready"));
						await fail.promise;
						controller.error(new Error("private upstream body detail"));
					},
				}),
			),
		async (origin) => {
			const response = await fetch(`${origin}/mcp`);
			fail.resolve();
			await assert.rejects(response.text());
		},
	);
	assert.equal(exporter.getFinishedSpans().length, 1);
	assert.equal(
		exporter.getFinishedSpans()[0].attributes["error.type"],
		"response_body_failed",
	);
});
