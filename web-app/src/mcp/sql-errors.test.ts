import assert from "node:assert/strict";
import test from "node:test";
import {
	BINARY_CONTENT_HINT,
	NAMESPACE_CONFLICT_HINT,
	SQL_TEXT_WRITE_RECIPE,
	destinationFromParams,
	namespaceConflictMessage,
	parseNamespaceConflict,
	sqlToolError,
} from "./sql-errors.ts";

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

void test("text in the byte column gets the one binding it needs, in either phrasing", () => {
	for (const message of [
		"lix_file.content expects binary content",
		"lix_file fast write column 'content' expects blob content",
	]) {
		const error = sqlToolError(
			{
				code: "LIX_TYPE_MISMATCH",
				message,
				hint: "Use CAST($1 AS BYTEA) with a text parameter for file contents.",
				details: { statementIndex: 1 },
			},
			running,
		);
		assert.equal(error.statement_index, 1);
		assert.equal(error.outcome, "not_committed");
		assert.ok(error.hint!.startsWith(BINARY_CONTENT_HINT), error.hint);
		assert.doesNotMatch(
			error.hint!,
			/CAST\(\$1 AS BYTEA\) with a text parameter/,
		);
		assert.equal(error.hint!.includes(SQL_TEXT_WRITE_RECIPE), false);
	}
});

void test("a namespace conflict is read, and restated with the destination path", () => {
	const conflict = parseNamespaceConflict(
		'filesystem namespace conflict: parent "01a0c785-4ce2-7283-9c4a-6412c1287904" already contains file entry "b.md"',
	);
	assert.deepEqual(conflict, {
		parentId: "01a0c785-4ce2-7283-9c4a-6412c1287904",
		kind: "file",
		name: "b.md",
	});
	assert.deepEqual(
		parseNamespaceConflict(
			'filesystem namespace conflict: parent "<root>" already contains directory entry "gtm"',
		),
		{ parentId: "<root>", kind: "directory", name: "gtm" },
	);
	assert.equal(
		parseNamespaceConflict("unique constraint violation"),
		undefined,
	);
	// SET and VALUES come first, so the new path is found before the old one.
	assert.equal(
		destinationFromParams(
			[
				{ kind: "text", value: "/gtm/archive/b.md" },
				{ kind: "text", value: "/gtm/b.md" },
			],
			"b.md",
		),
		"/gtm/archive/b.md",
	);
	assert.equal(
		destinationFromParams([{ kind: "text", value: "b.md" }], "b.md"),
		undefined,
	);
	assert.deepEqual(namespaceConflictMessage(conflict!, "/gtm/archive/b.md"), {
		message: "Destination /gtm/archive/b.md already exists (file).",
		hint: NAMESPACE_CONFLICT_HINT,
	});
	assert.match(
		namespaceConflictMessage(conflict!, undefined).message,
		/named "b\.md"/,
	);
});

void test("a guard conflict is a definite rollback", () => {
	const error = sqlToolError(
		{ code: "conflict", message: "changed since last_seen_commit_id" },
		running,
	);
	assert.equal(error.outcome, "not_committed");
});
