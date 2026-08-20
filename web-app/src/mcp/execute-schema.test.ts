import assert from "node:assert/strict";
import test from "node:test";
import {
	EXECUTE_SQL_COLUMNS_QUERY,
	EXECUTE_SQL_CORE_SCHEMA,
	EXECUTE_SQL_CORE_TABLES,
	EXECUTE_SQL_TOOL_DESCRIPTION,
	EXECUTE_SQL_TABLES_QUERY,
	QUERY_SQL_TOOL_DESCRIPTION,
} from "./execute-schema.ts";

void test("SQL guidance models the public Lix surfaces", () => {
	assert.deepEqual(
		EXECUTE_SQL_CORE_TABLES.map((table) => table.name),
		["lix_file", "lix_directory", "lix_branch", "lix_change"],
	);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /INSERT, UPDATE, and DELETE/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /use execute_sql for writes/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /SQL as the universal interface/);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/Lix SQL is a Postgres dialect subset\./,
	);
	assert.match(
		QUERY_SQL_TOOL_DESCRIPTION,
		/Lix SQL is a Postgres dialect subset\./,
	);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /Do not look for or invent typed/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /any ordered atomic SQL batch/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /never infer success from prose/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /already saved/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /does not require a checkpoint/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /user-facing/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /do not call it after a write/i);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /agent may recommend/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_file\.path.*canonical/);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/lix_directory\.path.*neither ends/,
	);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /INSERT INTO lix_file/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /UPDATE lix_file SET path/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /INSERT INTO lix_directory/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_history\('lix_file', \$1\)/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_working_diff\(\)/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_file_history/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /declared primary-key columns/);
	assert.match(EXECUTE_SQL_CORE_SCHEMA, /content \(binary\)/);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_COLUMNS_QUERY, /information_schema\.columns/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /complete batch is rolled back/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /current Lix session/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /current Lix session/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /lixcol_branch_id/);
	assert.doesNotMatch(QUERY_SQL_TOOL_DESCRIPTION, /lixcol_branch_id/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /lixcol_start_commit_id/);
	assert.doesNotMatch(QUERY_SQL_TOOL_DESCRIPTION, /lixcol_start_commit_id/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /lixcol_entity_pk/);
	assert.doesNotMatch(QUERY_SQL_TOOL_DESCRIPTION, /lixcol_entity_pk/);
});

void test("SQL tool descriptions use CAST plus kind text for file content", () => {
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /CAST\(\$2 AS BYTEA\)/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /CAST\(\$2 AS BYTEA\)/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /kind: "text"/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /kind: "text"/);
	for (const description of [
		EXECUTE_SQL_TOOL_DESCRIPTION,
		QUERY_SQL_TOOL_DESCRIPTION,
	]) {
		assert.doesNotMatch(
			description,
			/\{"kind":"blob"/,
			"must not tell callers to pass kind blob as the default content wire value",
		);
		assert.doesNotMatch(description, /Pass binary values as/);
		assert.doesNotMatch(description, /MCP callers pass/);
	}
});

void test("execute_sql describes Postgres ON CONFLICT upserts", () => {
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /ON CONFLICT/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /excluded\.content/);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/INSERT INTO lix_key_value \(key, value\) VALUES \(\$1, \$2\) ON CONFLICT \(key\) DO UPDATE SET value = excluded\.value/,
	);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/INSERT INTO lix_directory \(path\) VALUES \(\$1\) ON CONFLICT \(path\) DO NOTHING/,
	);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /without a probe SELECT/);
});
