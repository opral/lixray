import assert from "node:assert/strict";
import test from "node:test";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	SimpleSpanProcessor,
	InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { createRepositoryOpenTrace } from "./repository-open-performance.ts";

function fixture() {
	const exporter = new InMemorySpanExporter();
	const provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	let now = 100;
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	const controller = createRepositoryOpenTrace(
		provider.getTracer("test"),
		() => now,
		() => 1_000,
		{
			request: (callback: FrameRequestCallback) => {
				frames.set(++id, callback);
				return id;
			},
			cancel: (id: number) => {
				frames.delete(id);
			},
		},
	);
	const frame = () => {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(now);
	};
	return {
		controller,
		exporter,
		frame,
		advance(ms: number) {
			now += ms;
		},
	};
}
void test("cold route timing includes bootstrap and ends only after the initial view paints", () => {
	const f = fixture();
	f.controller.begin("private/path", 0, "navigation");
	f.controller.phase("auth");
	f.advance(20);
	f.controller.phase("access");
	f.advance(30);
	f.controller.phase("replica", "repo-id");
	f.advance(40);
	f.controller.phase("engine");
	f.advance(50);
	f.controller.phase("branch");
	f.advance(10);
	f.controller.phase("session");
	f.advance(10);
	f.controller.phase("atelier");
	f.advance(60);
	f.controller.phase("initial_view");
	f.advance(100);
	f.controller.usable("repo-id");
	assert.equal(f.exporter.getFinishedSpans().length, 0);
	f.advance(16);
	f.frame();
	assert.equal(f.exporter.getFinishedSpans().length, 0);
	f.advance(16);
	f.frame();
	const spans = f.exporter.getFinishedSpans(),
		root = spans.find((s) => s.name === "lixray.repository.open")!;
	assert.equal(root.attributes["lixray.repository.open.duration_ms"], 452);
	assert.equal(root.attributes["lixray.repository.open.outcome"], "usable");
	assert.equal(root.attributes["lixray.repository.open.bootstrap_ms"], 100);
	assert.equal(root.attributes["lixray.repository.open.initial_view_ms"], 100);
	assert.equal(root.attributes["lixray.repository.open.paint_ms"], 32);
	assert.equal(spans.length, 11);
	for (const child of spans.filter((s) => s !== root)) {
		assert.equal(child.spanContext().traceId, root.spanContext().traceId);
		assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
	}
	assert.doesNotMatch(
		JSON.stringify(spans.map((s) => s.attributes)),
		/private\/path/,
	);
});

void test("stale readiness and paint cannot complete another route; failures and retries remain samples", () => {
	const f = fixture();
	f.controller.begin("first");
	f.controller.phase("initial_view", "first-id");
	f.controller.usable("first-id");
	f.controller.begin("second");
	f.controller.phase("initial_view", "second-id");
	f.frame();
	f.frame();
	f.controller.usable("first-id");
	assert.equal(
		f.exporter
			.getFinishedSpans()
			.filter((s) => s.name === "lixray.repository.open").length,
		1,
	);
	f.controller.finish("failed");
	f.controller.finish("failed");
	f.advance(50);
	f.controller.attempt("second-id");
	f.controller.phase("initial_view", "second-id");
	f.controller.usable("second-id");
	f.frame();
	f.frame();
	const roots = f.exporter
		.getFinishedSpans()
		.filter((s) => s.name === "lixray.repository.open");
	assert.deepEqual(
		roots.map((s) => s.attributes["lixray.repository.open.outcome"]),
		["superseded", "failed", "usable"],
	);
	assert.equal(roots[2]!.attributes["lixray.repository.open.entry"], "retry");
});

void test("pre-mount navigation abort closes only its own attempt, and mounting transfers ownership", () => {
	const f = fixture();
	const old = new AbortController(),
		current = new AbortController();
	f.controller.begin("first", 100, "client_navigation", old.signal);
	f.controller.begin("second", 100, "client_navigation", current.signal);
	old.abort();
	f.controller.phase("initial_view", "second-id");
	f.controller.mount();
	current.abort();
	f.controller.usable("second-id");
	f.frame();
	f.frame();
	const outcomes = f.exporter
		.getFinishedSpans()
		.filter((s) => s.name === "lixray.repository.open")
		.map((s) => s.attributes["lixray.repository.open.outcome"]);
	assert.deepEqual(outcomes, ["superseded", "usable"]);
	const aborted = new AbortController();
	f.controller.begin("third", 100, "client_navigation", aborted.signal);
	aborted.abort();
	assert.equal(
		f.exporter.getFinishedSpans().at(-1)!.attributes[
			"lixray.repository.open.outcome"
		],
		"cancelled",
	);
});

void test("a newer pre-mount transition owns same-key cancellation and failed routes can reopen", () => {
	const f = fixture();
	const old = new AbortController(),
		current = new AbortController();
	f.controller.begin("same", 100, "client_navigation", old.signal);
	f.controller.begin("same", 100, "client_navigation", current.signal);
	old.abort();
	assert.equal(f.exporter.getFinishedSpans().length, 0);
	current.abort();
	f.controller.begin("same");
	f.controller.phase("replica", "repo-id");
	f.controller.finish("failed");
	f.controller.begin("same");
	f.controller.phase("initial_view", "repo-id");
	f.controller.usable("repo-id");
	f.frame();
	f.frame();
	assert.deepEqual(
		f.exporter
			.getFinishedSpans()
			.filter((s) => s.name === "lixray.repository.open")
			.map((s) => s.attributes["lixray.repository.open.outcome"]),
		["cancelled", "failed", "usable"],
	);
});
