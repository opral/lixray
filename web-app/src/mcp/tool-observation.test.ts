import assert from "node:assert/strict";
import test from "node:test";
import {
	mcpSurfaceVersion,
	observeExecuteInput,
	observeExecuteOutput,
} from "./tool-observation.ts";

void test("execute input observations retain query shape without values", () => {
	const observed = observeExecuteInput([
		{
			sql: `-- private comment
				SELECT value FROM lix_key_value
				WHERE key = $1 AND path = '/private/customer.txt' AND score > 42`,
			params: [{ kind: "text", value: "private-bound-value" }],
		},
		{
			sql: "INSERT INTO lix_key_value (key, value) VALUES ('secret', X'CAFE')",
		},
		{
			sql: "SELECT $$private dollar string$$, 0xDEADBEEF",
		},
	]);

	assert.deepEqual(observed, {
		statementCount: 3,
		statements: [
			{
				index: 0,
				operation: "SELECT",
				sanitizedSql:
					"select value from lix_key_value where key = ? and path = ? and score > ?",
				shapeId: "fnv1a32:2fa45ba1",
				parameterCount: 1,
				redactedLiteralCount: 2,
				truncated: false,
			},
			{
				index: 1,
				operation: "INSERT",
				sanitizedSql: "insert into lix_key_value(key,value)values(?,?)",
				shapeId: "fnv1a32:351d1f3b",
				parameterCount: 0,
				redactedLiteralCount: 2,
				truncated: false,
			},
			{
				index: 2,
				operation: "SELECT",
				sanitizedSql: "select ?,?",
				shapeId: "fnv1a32:422c7d99",
				parameterCount: 0,
				redactedLiteralCount: 2,
				truncated: false,
			},
		],
	});
	assert.doesNotMatch(
		JSON.stringify(observed),
		/private|customer|secret|CAFE|DEADBEEF|private-bound-value/,
	);
});

void test("execute output observations keep only aggregate results and notice codes", () => {
	const observed = observeExecuteOutput({
		results: [
			{
				columns: ["path", "data"],
				rows: [["/private.txt", "secret contents"]],
				rowsAffected: 0,
				notices: [
					{
						code: "LIX_HISTORY_NON_IDENTITY_FILTER",
						message: "private warning details",
					},
				],
			},
			{
				columns: [],
				rows: [],
				rowsAffected: 2,
				notices: [],
			},
		],
	});

	assert.deepEqual(observed, {
		resultCount: 2,
		rowCount: 1,
		rowsAffected: 2,
		noticeCodes: ["LIX_HISTORY_NON_IDENTITY_FILTER"],
		results: [
			{
				index: 0,
				columnCount: 2,
				rowCount: 1,
				rowsAffected: 0,
				noticeCodes: ["LIX_HISTORY_NON_IDENTITY_FILTER"],
			},
			{
				index: 1,
				columnCount: 0,
				rowCount: 0,
				rowsAffected: 2,
				noticeCodes: [],
			},
		],
	});
	assert.doesNotMatch(
		JSON.stringify(observed),
		/private|secret|warning details/,
	);
});

void test("execute input observations classify undo and redo SQL as mutations", () => {
	const observed = observeExecuteInput([
		{ sql: "SELECT commit_id FROM lix_undo()" },
		{
			sql: "SELECT commit_id FROM lix_redo($1)",
			params: [{ kind: "text", value: "id" }],
		},
	]);
	assert.deepEqual(
		observed?.statements.map((statement) => statement.operation),
		["UNDO", "REDO"],
	);
});

void test("MCP surface versions are stable and content-addressed", () => {
	assert.equal(mcpSurfaceVersion([{ name: "execute" }]), "fnv1a32:0625663b");
	assert.equal(
		mcpSurfaceVersion([{ name: "execute" }]),
		mcpSurfaceVersion([{ name: "execute" }]),
	);
	assert.notEqual(
		mcpSurfaceVersion([{ name: "execute" }]),
		mcpSurfaceVersion([{ name: "execute", description: "changed" }]),
	);
});
