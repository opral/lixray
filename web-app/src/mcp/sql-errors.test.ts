import assert from "node:assert/strict";
import test from "node:test";
import { sqlToolError } from "./sql-errors.ts";

const running = {
	write: true,
	started: true,
	completed: false,
	statementCount: 2,
};
void test("SQL rejections preserve engine details and identify the failed statement", () => {
	const error = sqlToolError(
		{
			code: "LIX_TYPE_MISMATCH",
			message: "bad type",
			hint: "Expected binary.",
			details: { statementIndex: 1 },
		},
		running,
	);
	assert.equal(error.outcome, "not_committed");
	assert.equal(error.statement_index, 1);
	assert.match(error.hint!, /Expected binary/);
	assert.match(error.hint!, /CAST\(\$1 AS BYTEA\)/);
});
void test("uncertain writes are never advertised as rolled back or safe to replay", () => {
	for (const code of ["upstream_error", "internal_error", "unrecognized"]) {
		const error = sqlToolError({ code, message: "lost response" }, running);
		assert.equal(error.outcome, "unknown");
		assert.equal(error.statement_index, undefined);
		assert.match(error.hint!, /Read the affected state/);
	}
});
void test("preflight failures did not write; failures after confirmed execution committed", () => {
	assert.equal(
		sqlToolError(
			{ code: "internal_error", message: "error" },
			{ ...running, started: false },
		).outcome,
		"not_committed",
	);
	assert.equal(
		sqlToolError(
			{ code: "LIX_TYPE_MISMATCH", message: "error" },
			{ ...running, completed: true },
		).outcome,
		"committed",
	);
});
void test("read errors do not contain write guidance or outcomes", () => {
	const error = sqlToolError(
		{ code: "LIX_UNSUPPORTED_SQL", message: "bad SQL", hint: "Use SELECT 1." },
		{ ...running, write: false, statementCount: 1 },
	);
	assert.equal(error.outcome, undefined);
	assert.equal(error.hint, "Use SELECT 1.");
	assert.equal(error.statement_index, 0);
});
void test("invalid statement indexes are not reported", () => {
	for (const statementIndex of [-1, 2, 0.5, "1"]) {
		assert.equal(
			sqlToolError(
				{
					code: "LIX_PARSE_ERROR",
					message: "bad",
					details: { statementIndex },
				},
				running,
			).statement_index,
			undefined,
		);
	}
});
