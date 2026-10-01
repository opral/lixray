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

void test("opening facts distinguish initialization, cached state, joined opens and session reuse", () => {
	for (const state of [
		"fresh",
		"cached",
		"joined_open",
		"reused_session",
		"remote",
	] as const) {
		const f = fixture();
		f.controller.begin("repository");
		const recorder = f.controller.recorder("repo-id")!;
		if (state === "joined_open" || state === "reused_session")
			recorder.reused(
				state === "joined_open" ? "joined" : "reused",
				"partial_replica",
			);
		else
			recorder.opened(
				{
					format: 85,
					initialized: state === "fresh",
					migrations: [{ scope: "authority", fromFormat: 84, toFormat: 85 }],
				},
				state === "remote" ? "remote" : "partial_replica",
			);
		f.controller.finish("failed");
		const root = f.exporter
			.getFinishedSpans()
			.find((s) => s.name === "lixray.repository.open")!;
		assert.equal(
			root.attributes["lixray.repository.open.replica_state"],
			state,
		);
		if (state === "fresh" || state === "cached") {
			assert.equal(
				root.attributes["lixray.repository.open.initialized_this_open"],
				state === "fresh",
			);
			assert.equal(
				root.attributes["lixray.repository.open.authority_migration_count"],
				1,
			);
			assert.equal(
				root.attributes["lixray.repository.open.local_migration_count"],
				0,
			);
		} else
			assert.equal(
				root.attributes["lixray.repository.open.initialized_this_open"],
				undefined,
			);
	}
});

void test("same-route joined and reused handles cannot overwrite the native creator's classification", () => {
	const f = fixture();
	f.controller.begin("repository");
	const creator = f.controller.recorder("repo-id")!;
	const joiner = f.controller.recorder("repo-id")!;
	creator.engineAttempt();
	creator.opened(
		{ format: 85, initialized: true, migrations: [] },
		"partial_replica",
	);
	joiner.reused("joined", "partial_replica");
	f.controller.recorder("repo-id")!.reused("reused", "partial_replica");
	f.controller.finish("usable");
	const root = f.exporter
		.getFinishedSpans()
		.find((s) => s.name === "lixray.repository.open")!;
	assert.equal(
		root.attributes["lixray.repository.open.replica_state"],
		"fresh",
	);
	assert.equal(
		root.attributes["lixray.repository.open.session_acquisition"],
		"created",
	);
});

void test("SDK host profile exports fixed timings and never charges historical work to reuse", () => {
	const f = fixture();
	f.controller.begin("first");
	f.controller.recorder("repo-id")!.opened(
		{
			format: 85,
			initialized: true,
			migrations: [],
			hostProfile: {
				version: 1,
				wasm: {
					waitMs: 25,
					realmReused: false,
					source: "cache",
					cacheStatus: "hit",
					compileMs: 12,
					initializeMs: 8,
				},
				componentCompiler: { importMs: 10, initializeMs: 1 },
				provider: {
					moduleImportMs: 2,
					createMs: 5,
					openMs: 4,
					opfs: {
						lockWaitMs: 1,
						sqliteInitMs: 1,
						poolOpenMs: 1,
						schemaInitMs: 1,
					},
				},
				nativeBindingOpenMs: 10,
			},
		},
		"partial_replica",
	);
	f.controller.finish("usable");
	f.controller.begin("next");
	f.controller.recorder("repo-id")!.reused("reused", "partial_replica");
	f.controller.finish("usable");
	const roots = f.exporter
		.getFinishedSpans()
		.filter((s) => s.name === "lixray.repository.open");
	assert.equal(
		roots[0]!.attributes["lixray.repository.open.host.wasm.cache_status"],
		"hit",
	);
	assert.equal(
		roots[0]!.attributes["lixray.repository.open.host.wasm.compile_ms"],
		12,
	);
	assert.equal(
		roots[0]!.attributes[
			"lixray.repository.open.host.provider.opfs.lock_wait_ms"
		],
		1,
	);
	assert.equal(
		roots[1]!.attributes["lixray.repository.open.host.version"],
		undefined,
	);
	assert.equal(
		roots[1]!.attributes["lixray.repository.open.replica_state"],
		"reused_session",
	);
});

void test("native progress excludes retry waits and records repeated attempts and pending RPCs", () => {
	const f = fixture();
	f.controller.begin("repository");
	const recorder = f.controller.recorder("repo-id")!;
	recorder.engineAttempt();
	recorder.progress({ phase: "inspecting", scope: "local", toFormat: 85 });
	f.advance(20);
	recorder.progress({ phase: "inspecting", scope: "local", toFormat: 85 });
	f.advance(10);
	recorder.retry(100);
	f.advance(100);
	recorder.engineAttempt();
	recorder.progress({ phase: "inspecting", scope: "local", toFormat: 85 });
	f.advance(15);
	recorder.progress({ phase: "complete", scope: "local", toFormat: 85 });
	const first = recorder.request();
	f.advance(5);
	const second = recorder.request();
	f.advance(5);
	first(503);
	first(200);
	recorder.request();
	f.advance(5);
	second(200);
	f.controller.finish("failed");
	const root = f.exporter
		.getFinishedSpans()
		.find((s) => s.name === "lixray.repository.open")!;
	assert.equal(
		root.attributes["lixray.repository.open.native.local.inspecting_ms"],
		45,
	);
	assert.equal(root.attributes["lixray.repository.open.engine_attempts"], 2);
	assert.equal(
		root.attributes["lixray.repository.open.retry_backoff_scheduled_ms"],
		100,
	);
	assert.equal(root.attributes["lixray.repository.open.rpc_count"], 3);
	assert.equal(
		root.attributes["lixray.repository.open.rpc_response_headers_pending"],
		1,
	);
	assert.equal(root.attributes["lixray.repository.open.rpc_failed"], 1);
	assert.equal(
		root.attributes["lixray.repository.open.rpc_response_headers_total_ms"],
		20,
	);
	assert.equal(
		root.attributes["lixray.repository.open.rpc_response_headers_max_ms"],
		10,
	);
});

void test("stale and finished opening recorders cannot contaminate another attempt", () => {
	const f = fixture();
	f.controller.begin("first");
	const stale = f.controller.recorder("repo-id")!;
	const finished = stale.request();
	f.controller.begin("second");
	const current = f.controller.recorder("repo-id")!;
	stale.opened(
		{ format: 85, initialized: true, migrations: [] },
		"partial_replica",
	);
	stale.replacement();
	finished(503);
	current.reused("reused", "partial_replica");
	f.controller.finish("usable");
	current.retry(100);
	const roots = f.exporter
		.getFinishedSpans()
		.filter((s) => s.name === "lixray.repository.open");
	assert.equal(
		roots[0]!.attributes["lixray.repository.open.rpc_response_headers_pending"],
		1,
	);
	assert.equal(
		roots[1]!.attributes["lixray.repository.open.replica_state"],
		"reused_session",
	);
	assert.equal(roots[1]!.attributes["lixray.repository.open.retry_count"], 0);
	assert.equal(
		roots[1]!.attributes["lixray.repository.open.replacement_count"],
		0,
	);
	assert.equal(roots[1]!.attributes["lixray.repository.open.rpc_count"], 0);
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
