import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lixErrorTelemetryProperties } from "./telemetry.ts";

void test("extracts safe Lix protocol fields for exception telemetry", () => {
	const error = Object.assign(new Error("column not found"), {
		name: "LixError",
		code: "LIX_COLUMN_NOT_FOUND",
		status: 404,
		hint: "Use the canonical file column.",
		details: { sql: "SELECT private content" },
	});

	assert.deepEqual(lixErrorTelemetryProperties(error), {
		error_kind: "LixError",
		lix_error_code: "LIX_COLUMN_NOT_FOUND",
		lix_error_status: 404,
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private content/,
	);
});

void test("native Lix exceptions preserve only allowlisted migration parser diagnosis", () => {
	const error = Object.assign(new Error("private receipt payload"), {
		name: "LixError",
		code: "LIX_PARTIAL_REPLICA_STATE_INVALID",
		details: {
			failureReason: "v2_descriptor_version_invalid",
			failurePath: "$.descriptor.descriptorVersion",
			parserMessage: "private receipt payload",
		},
	});

	assert.deepEqual(lixErrorTelemetryProperties(error), {
		error_kind: "LixError",
		lix_error_code: "LIX_PARTIAL_REPLICA_STATE_INVALID",
		failureReason: "v2_descriptor_version_invalid",
		failurePath: "$.descriptor.descriptorVersion",
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private receipt payload|parserMessage/,
	);
});

void test("ignores unrelated errors", () => {
	assert.deepEqual(
		lixErrorTelemetryProperties(new Error("network failed")),
		{},
	);
});

void test("extracts HTTP status preserved in structured Lix error details", () => {
	const error = Object.assign(new Error("The protocol session is gone"), {
		name: "LixError",
		code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
		details: {
			httpStatus: 410,
			sql: "SELECT private document content",
		},
	});

	assert.deepEqual(lixErrorTelemetryProperties(error), {
		error_kind: "LixError",
		lix_error_code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
		lix_error_status: 410,
		httpStatus: 410,
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private document content/,
	);
});

void test("worker RPC WASM errors expose only code-gated asset diagnostics", () => {
	const error = Object.assign(new Error("private compile cause"), {
		name: "LixError",
		code: "LIX_WASM_ASSET_UNAVAILABLE",
		details: {
			phase: "wasm_fetch",
			cacheStatus: "miss",
			httpStatus: 404,
			url: "https://private.example/asset.wasm?token=secret",
			body: "private response body",
			cause: "private compile cause",
		},
	});
	assert.deepEqual(lixErrorTelemetryProperties(error), {
		error_kind: "LixError",
		lix_error_code: "LIX_WASM_ASSET_UNAVAILABLE",
		lix_error_status: 404,
		httpStatus: 404,
		wasmAssetPhase: "wasm_fetch",
		wasmAssetCacheStatus: "miss",
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private|secret|asset\.wasm/,
	);
});

void test("operational failures are captured as exceptions, not product events", async () => {
	const sources = await Promise.all([
		readFile(new URL("./repository-lix-session.ts", import.meta.url), "utf8"),
		readFile(
			new URL("../components/auth-provider.tsx", import.meta.url),
			"utf8",
		),
		readFile(
			new URL("../components/repository-provider.tsx", import.meta.url),
			"utf8",
		),
	]);

	for (const source of sources) {
		assert.doesNotMatch(
			source,
			/["']webapp_(?:request|auth_session_validation|repository_list)_failed["']/u,
		);
		assert.match(source, /captureExceptionTelemetry/u);
	}
});

void test("wrapped RPC exceptions expose the native cause code without private details", () => {
	const cause = Object.assign(new Error("private CSV content"), {
		name: "LixError",
		code: "LIX_READ_FULFILLMENT_RESTART",
		status: 410,
		details: { sql: "SELECT private content" },
	});
	const wrapper = new Error("RPC failed", { cause });
	const captured = lixErrorTelemetryProperties(wrapper);
	assert.equal(captured.lix_error_code, "LIX_READ_FULFILLMENT_RESTART");
	assert.equal(captured.lix_error_status, 410);
	assert.doesNotMatch(JSON.stringify(captured), /private|CSV|SELECT/);
	const cycle = new Error("cycle");
	cycle.cause = cycle;
	assert.deepEqual(lixErrorTelemetryProperties(cycle), {});
});
