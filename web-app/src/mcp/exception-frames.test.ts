import assert from "node:assert/strict";
import test from "node:test";
import { safeRustErrorOriginInCauseChain } from "../lib/exception-stack-trace.ts";
import { mcpExceptionStacktrace } from "./exception-frames.ts";

void test("projects only source locations from an Error and its cause", () => {
	const privateCause = new Error("bearer-token=private-value");
	const caught = new Error(
		"SQL result private-value\n at /root/web-app/src/mcp/forged-secret.ts:4:5",
		{ cause: privateCause },
	);
	const stacktrace = mcpExceptionStacktrace(caught);

	assert.ok(stacktrace);
	assert.equal(stacktrace.type, "raw");
	assert.ok(stacktrace.frames.length > 0);
	assert.ok(
		stacktrace.frames.some((frame) =>
			frame.filename.endsWith("web-app/src/mcp/exception-frames.test.ts"),
		),
		JSON.stringify(stacktrace),
	);
	assert.equal(JSON.stringify(stacktrace).includes("private-value"), false);
	assert.equal(JSON.stringify(stacktrace).includes("forged-secret"), false);
	assert.equal(JSON.stringify(stacktrace).includes("SQL result"), false);
});

void test("omits locations outside application and dependency source paths", () => {
	const error = new Error("private-value");
	Object.defineProperty(error, "stack", {
		value: "Error: private-value\n    at query (/tmp/private-value.js:1:2)",
	});
	assert.equal(mcpExceptionStacktrace(error), undefined);
});

void test("projects the deployed Railway server bundle path", () => {
	const error = new Error("private-value");
	Object.defineProperty(error, "stack", {
		value:
			"Error: private-value\n    at query (file:///app/web-app/dist/server/railway-server.js:101:7)",
	});
	assert.deepEqual(mcpExceptionStacktrace(error), {
		type: "raw",
		frames: [
			{
				filename: "web-app/dist/server/railway-server.js",
				lineno: 101,
				colno: 7,
			},
		],
	});
});

void test("projects bounded Rust origin and status from the original cause", () => {
	const nativeCause = Object.assign(new Error("SQL and private value"), {
		rustOrigin: {
			kind: "source_location" as const,
			file: "packages/lix/src/engine.rs",
			line: 27,
			column: 11,
		},
		rustStacktraceStatus: "not_captured" as const,
	});
	const wrapper = new Error("transport wrapper with secret", {
		cause: nativeCause,
	});
	const located = safeRustErrorOriginInCauseChain(wrapper);

	assert.deepEqual(located, {
		origin: {
			kind: "source_location",
			file: "packages/lix/src/engine.rs",
			line: 27,
			column: 11,
		},
		causeIndex: 0,
		rustStacktraceStatus: "not_captured",
	});
	assert.doesNotMatch(JSON.stringify(located), /SQL and private value|secret/);
});
