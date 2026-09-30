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

void test("startup RPC retains its captured parent after an async boundary", async () => {
	exporter.reset();
	const traceId = "33333333333333333333333333333333";
	const parentSpanId = "3333333333333333";
	await Promise.resolve();
	let transmittedParent: string | null = null;
	const response = await fetchLixWithTrace(
		"repo",
		new Request("https://lix.invalid/lix/v1/repo/open"),
		async (_id, request) => {
			transmittedParent = request.headers.get("traceparent");
			return new Response(null, { status: 204 });
		},
		{ traceparent: `00-${traceId}-${parentSpanId}-01` },
	);
	assert.equal(response.status, 204);
	const [rpc] = exporter.getFinishedSpans();
	assert.equal(rpc?.parentSpanContext?.spanId, parentSpanId);
	assert.equal(rpc.spanContext().traceId, traceId);
	assert.equal(
		transmittedParent,
		`00-${traceId}-${rpc.spanContext().spanId}-01`,
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
		.scopeLix(filePath, fileId, fakeLix)
		.observe("SELECT 1");
	const firstFrame = observation.next();
	controller.documentLoaded(filePath, fileId);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(exporter.getFinishedSpans().length, 0);
	releaseNext();
	await firstFrame;
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.name, "lixray.file.open");
	assert.equal(observedParent, root?.spanContext().spanId);
	assert.equal(root.attributes["lixray.file.open.outcome"], "loaded");
});

void test("repository shell observations join an active file open only", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	const observedParents: Array<string | undefined> = [];
	const lix = {
		observe: () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next: async () => {
				observedParents.push(
					trace.getSpan(context.active())?.spanContext().spanId,
				);
				return { done: true as const, value: undefined };
			},
		}),
	} as unknown as Lix;
	const shellLix = controller.scopeRepositoryLix(lix);
	await shellLix.observe("SELECT 1").next();
	controller.ensureRoute("file-id");
	await shellLix.observe("SELECT 2").next();
	controller.cancel();
	await shellLix.observe("SELECT 3").next();
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.name, "lixray.file.open");
	assert.deepEqual(observedParents, [
		undefined,
		root.spanContext().spanId,
		undefined,
	]);
});

void test("repository and document transactions join the active file-open root", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	const observedParents: Array<string | undefined> = [];
	const lix = {
		beginTransaction: async () => ({
			execute: async () => {
				observedParents.push(
					trace.getSpan(context.active())?.spanContext().spanId,
				);
				return { rows: [] };
			},
			rollback: async () => undefined,
		}),
	} as unknown as Lix;
	const repositoryLix = controller.scopeRepositoryLix(lix);
	controller.ensureRoute("file-id");
	const shellTransaction = await repositoryLix.beginTransaction();
	await Promise.resolve();
	await shellTransaction.execute("SELECT 1");
	const documentLix = controller.scopeLix(
		"/posts.csv",
		"file-id",
		repositoryLix,
	);
	const documentTransaction = await documentLix.beginTransaction();
	await Promise.resolve();
	await documentTransaction.execute("SELECT 2");
	controller.cancel();
	await shellTransaction.execute("SELECT 3");
	const [root] = exporter.getFinishedSpans();
	assert.deepEqual(observedParents, [
		root?.spanContext().spanId,
		root?.spanContext().spanId,
		undefined,
	]);
});

void test("an old document cannot join a newer file's root through the repository proxy", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	const observedParents: Array<string | undefined> = [];
	const lix = {
		execute: async () => {
			observedParents.push(
				trace.getSpan(context.active())?.spanContext().spanId,
			);
			return { rows: [] };
		},
	} as unknown as Lix;
	const repositoryLix = controller.scopeRepositoryLix(lix);
	controller.ensureRoute("file-a");
	const oldDocumentLix = controller.scopeLix("/a.csv", "file-a", repositoryLix);
	await oldDocumentLix.execute("SELECT 1");
	controller.ensureRoute("file-b");
	await oldDocumentLix.execute("SELECT 2");
	await repositoryLix.execute("SELECT 3");
	controller.cancel();
	const [fileA, fileB] = exporter.getFinishedSpans();
	assert.deepEqual(observedParents, [
		fileA?.spanContext().spanId,
		undefined,
		fileB?.spanContext().spanId,
	]);
});

void test("a stalled repository shell observation does not delay a rendered file", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	const lix = {
		observe: () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next: () => new Promise<IteratorResult<never>>(() => {}),
		}),
	} as unknown as Lix;
	controller.ensureRoute("file-id");
	controller.resolved("file-id", "/posts.csv");
	void controller.scopeRepositoryLix(lix).observe("SELECT 1").next();
	controller.documentLoaded("/posts.csv", "file-id");
	await new Promise((resolve) => setTimeout(resolve, 550));
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.attributes["lixray.file.open.outcome"], "loaded");
});

void test("restored document observation joins the route root before ID lookup finishes", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute("file-id");
	controller.documentAttempted(
		"/different.csv",
		"different-file",
		true,
		"restoration",
	);
	controller.documentAttempted("/posts.csv", "file-id", true, "route");
	const observedParents: Array<string | undefined> = [];
	const lix = {
		observe: () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next: async () => {
				observedParents.push(
					trace.getSpan(context.active())?.spanContext().spanId,
				);
				return { done: true as const, value: undefined };
			},
		}),
	} as unknown as Lix;
	await controller
		.scopeLix("/different.csv", "different-file", lix)
		.observe("SELECT 1")
		.next();
	await controller
		.scopeLix("/posts.csv", "file-id", lix)
		.observe("SELECT 1")
		.next();
	controller.cancel();
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.name, "lixray.file.open");
	assert.deepEqual(observedParents, [undefined, root.spanContext().spanId]);
});

void test("a different file cannot complete the route root even at the same path", () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute("file-a");
	controller.documentAttempted("/posts.csv", "file-a", true, "route");
	controller.documentLoaded("/posts.csv", "file-b");
	controller.cancel();
	const [root] = exporter.getFinishedSpans();
	assert.equal(root?.attributes["lixray.file.open.outcome"], "cancelled");
	assert.equal(root?.attributes["lix.file.id"], "file-a");
});

void test("a document root keeps its ID when a different deep link supersedes it", () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.documentAttempted("/b.csv", "file-b", true, "foreground");
	controller.ensureRoute("file-a");
	controller.cancel();
	const roots = exporter.getFinishedSpans();
	assert.deepEqual(
		roots.map((root) => [
			root.attributes["lix.file.id"],
			root.attributes["lixray.file.open.outcome"],
		]),
		[
			["file-b", "superseded"],
			["file-a", "cancelled"],
		],
	);
});

void test("opening a second document supersedes an in-place document root", () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.documentAttempted("/a.csv", "file-a", true, "foreground");
	controller.documentAttempted("/b.csv", "file-b", true, "foreground");
	controller.cancel();
	assert.deepEqual(
		exporter
			.getFinishedSpans()
			.map((root) => [
				root.attributes["lix.file.id"],
				root.attributes["lixray.file.open.outcome"],
			]),
		[
			["file-a", "superseded"],
			["file-b", "cancelled"],
		],
	);
});

void test("foreground B joins its own root before route A navigates away", async () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute("file-a");
	controller.documentAttempted("/b.csv", "file-b", true, "foreground");
	let observedParent: string | undefined;
	const lix = {
		observe: () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next: async () => {
				observedParent = trace.getSpan(context.active())?.spanContext().spanId;
				return { done: true as const, value: undefined };
			},
		}),
	} as unknown as Lix;
	await controller.scopeLix("/b.csv", "file-b", lix).observe("SELECT 1").next();
	controller.ensureRoute("file-b");
	controller.cancel();
	const [routeA, openB] = exporter.getFinishedSpans();
	assert.equal(routeA?.attributes["lix.file.id"], "file-a");
	assert.equal(routeA?.attributes["lixray.file.open.outcome"], "superseded");
	assert.equal(openB?.attributes["lix.file.id"], "file-b");
	assert.equal(observedParent, openB?.spanContext().spanId);
});

void test("route B can supersede route A before Atelier emits its open event", () => {
	exporter.reset();
	const controller = createBrowserFileOpenTraceController(
		"repo",
		"partial_replica",
		tracer,
	);
	controller.ensureRoute("file-a");
	controller.documentAttempted("/b.csv", "file-b", true, "route");
	controller.cancel();
	assert.deepEqual(
		exporter
			.getFinishedSpans()
			.map((root) => [
				root.attributes["lix.file.id"],
				root.attributes["lixray.file.open.outcome"],
			]),
		[
			["file-a", "superseded"],
			["file-b", "cancelled"],
		],
	);
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

void test("failed opening spans preserve structured causes without recording error content", async () => {
	exporter.reset();
	await assert.rejects(
		withSpan("repository.open", async () => {
			throw Object.assign(new Error("private content"), {
				code: "LIX_PARTIAL_REPLICA_STATE_INVALID",
				details: {
					sourceCode: "LIX_PARTIAL_REPLICA_STATE_INVALID",
					fromVersion: 2,
					toVersion: 3,
					receiptVersion: 2,
					expectedReceiptVersion: 3,
					retryable: false,
					admissionRetryExhausted: true,
					recoveryDeadlineExceeded: true,
					responseBody: "secret",
				},
			});
		}),
	);
	const finished = exporter.getFinishedSpans()[0]!;
	assert.equal(
		finished.attributes["error.type"],
		"LIX_PARTIAL_REPLICA_STATE_INVALID",
	);
	assert.equal(
		finished.attributes["lix.error.source_code"],
		"LIX_PARTIAL_REPLICA_STATE_INVALID",
	);
	assert.equal(finished.attributes["lix.migration.from_version"], 2);
	assert.equal(finished.attributes["lix.migration.to_version"], 3);
	assert.equal(finished.attributes["lix.receipt.version"], 2);
	assert.equal(finished.attributes["lix.receipt.expected_version"], 3);
	assert.equal(finished.attributes["lix.error.retryable"], false);
	assert.equal(finished.attributes["lix.recovery.retry_exhausted"], true);
	assert.equal(finished.attributes["lix.recovery.deadline_exceeded"], true);
	assert.doesNotMatch(JSON.stringify(finished.attributes), /private|secret/);
});
