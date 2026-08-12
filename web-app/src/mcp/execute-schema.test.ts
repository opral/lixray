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
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /exactly one SELECT/);
	assert.match(
		QUERY_SQL_TOOL_DESCRIPTION,
		/use execute_sql when arbitrary SQL/,
	);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /SQL as the universal interface/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /Do not look for or invent typed/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /any ordered atomic SQL batch/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /never infer success from prose/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_file\.path.*canonical/);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/lix_directory\.path.*neither ends/,
	);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /INSERT INTO lix_file/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /UPDATE lix_file SET path/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /INSERT INTO lix_directory/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lix_active_branch_commit_id/);
	assert.match(EXECUTE_SQL_CORE_SCHEMA, /content \(binary\)/);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_COLUMNS_QUERY, /information_schema\.columns/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /complete batch is rolled back/);
});
