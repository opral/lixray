import assert from "node:assert/strict";
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
		lix_error_code: "LIX_COLUMN_NOT_FOUND",
		lix_error_status: 404,
		lix_error_hint: "Use the canonical file column.",
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private content/,
	);
});

void test("ignores unrelated errors", () => {
	assert.deepEqual(
		lixErrorTelemetryProperties(new Error("network failed")),
		{},
	);
});
