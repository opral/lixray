import assert from "node:assert/strict";
import test from "node:test";
import {
	createLixEngineOnSpan,
	isLixEnginePerfName,
	lixEngineAiSpan,
} from "./lix-engine-telemetry.ts";

void test("only Lix engine names are performance clocks", () => {
	assert.equal(isLixEnginePerfName("lix.sql.batch"), true);
	assert.equal(isLixEnginePerfName("lix.sql.query"), true);
	assert.equal(isLixEnginePerfName("lix.checkpoint.create"), true);
	assert.equal(isLixEnginePerfName("lix.engine.open"), true);
	assert.equal(isLixEnginePerfName("lix.opened"), false);
	assert.equal(isLixEnginePerfName("mcp.execute_sql"), false);
	assert.equal(isLixEnginePerfName("mcp.open_lix"), false);
	assert.equal(isLixEnginePerfName("mcp.create_checkpoint"), false);
	assert.equal(isLixEnginePerfName("repository_opened"), false);
});

void test("v2 Lix spans forward as $ai_span with Lix names and Lix ids", () => {
	assert.deepEqual(
		lixEngineAiSpan({
			schemaVersion: 2,
			name: "lix.sql.batch",
			traceId: "trace-lix",
			spanId: "span-lix",
			parentSpanId: "parent-lix",
			durationMs: 42,
			status: "ok",
			attributes: {
				"db.system.name": "lix",
				"lix.execution.kind": "batch",
				"lix.id": "lix-1",
			},
		}),
		{
			event: "$ai_span",
			properties: {
				$ai_span_name: "lix.sql.batch",
				$ai_latency: 0.042,
				$ai_is_error: false,
				$ai_trace_id: "trace-lix",
				$ai_span_id: "span-lix",
				$ai_parent_id: "parent-lix",
				lix_attributes: {
					"db.system.name": "lix",
					"lix.execution.kind": "batch",
					"lix.id": "lix-1",
				},
			},
			lixId: "lix-1",
		},
	);
});

void test("v1 Lix spans keep the Lix name and do not invent ids", () => {
	const mapped = lixEngineAiSpan({
		schemaVersion: 1,
		name: "lix.sql.query",
		durationMs: 12,
		status: "ok",
		attributes: { "db.query.text": "SELECT ? AS value" },
	});
	assert.equal(mapped?.properties.$ai_span_name, "lix.sql.query");
	assert.equal(mapped?.properties.$ai_latency, 0.012);
	assert.equal(mapped?.properties.$ai_trace_id, undefined);
	assert.equal(mapped?.properties.$ai_span_id, undefined);
	assert.equal(mapped?.properties.$ai_parent_id, undefined);
});

void test("mcp.* names and missing Lix duration are not engine clocks", () => {
	assert.equal(
		lixEngineAiSpan({
			name: "mcp.execute_sql",
			traceId: "invented",
			spanId: "invented",
			durationMs: 279,
			status: "ok",
		}),
		null,
	);
	assert.equal(
		lixEngineAiSpan({
			name: "lix.sql.query",
			status: "ok",
		}),
		null,
	);
	assert.equal(
		lixEngineAiSpan({
			name: "lix.opened",
			durationMs: 15,
			status: "ok",
			attributes: { "lix.id": "lix-1" },
		}),
		null,
	);
});

void test("onSpan captures Lix errors without inventing SQL or commit ids", () => {
	const captured: Array<ReturnType<typeof lixEngineAiSpan>> = [];
	const onSpan = createLixEngineOnSpan((event) => captured.push(event));
	onSpan({
		name: "mcp.open_lix",
		durationMs: 10,
		status: "ok",
	});
	onSpan({
		name: "lix.checkpoint.create",
		durationMs: 8,
		status: "error",
		attributes: { "error.type": "LIX_ERROR_UNKNOWN" },
	});
	assert.equal(captured.length, 1);
	assert.equal(captured[0]?.properties.$ai_span_name, "lix.checkpoint.create");
	assert.equal(captured[0]?.properties.$ai_is_error, true);
	assert.equal(
		JSON.stringify(captured).includes("commit"),
		false,
		"commit ids must come from Lix attributes, not the host",
	);
});
