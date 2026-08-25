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
		lix_error_code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
		lix_error_status: 410,
	});
	assert.doesNotMatch(
		JSON.stringify(lixErrorTelemetryProperties(error)),
		/private document content/,
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
