import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXECUTE_SQL_COLUMNS_QUERY,
	EXECUTE_SQL_CORE_SCHEMA,
	EXECUTE_SQL_CORE_TABLES,
	EXECUTE_SQL_TOOL_DESCRIPTION,
	EXECUTE_SQL_TABLES_QUERY,
	LIX_SQL_OPERATING_GUIDE,
	QUERY_SQL_TOOL_DESCRIPTION,
} from "./execute-schema.ts";
import { MCP_SERVER_INSTRUCTIONS } from "./server.ts";

const MCP_DOCS = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../../docs/mcp.md"),
	"utf8",
);

const SHARED_GUIDE_MARKERS = [
	/lix_history\('lix_file'/,
	/information_schema\.tables/,
	/CAST\(\$2 AS BYTEA\)/,
	/ON CONFLICT \(path\) DO UPDATE/,
] as const;

void test("SQL guidance models the public Lix surfaces", () => {
	assert.deepEqual(
		EXECUTE_SQL_CORE_TABLES.map((table) => table.name),
		["lix_file", "lix_directory", "lix_branch", "lix_commit", "lix_change"],
	);
	assert.match(EXECUTE_SQL_CORE_SCHEMA, /content \(binary\)/);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_COLUMNS_QUERY, /information_schema\.columns/);
});

void test("shared operating guide keeps file-content, upsert, and no-verify copy", () => {
	for (const text of [
		LIX_SQL_OPERATING_GUIDE,
		MCP_SERVER_INSTRUCTIONS,
		MCP_DOCS,
	]) {
		assert.match(text, /Lix SQL is a Postgres dialect subset\./);
		assert.match(text, /CAST\(\$2 AS BYTEA\)/);
		assert.match(text, /kind: "text"/);
		assert.match(text, /ON CONFLICT/);
		assert.doesNotMatch(
			text,
			/\{"kind":"blob"/,
			"must not tell callers to pass kind blob as the default content wire value",
		);
		assert.doesNotMatch(text, /Pass binary values as/);
		assert.doesNotMatch(text, /MCP callers pass/);
		assert.match(text, /verification [`']?SELECT/);
		assert.match(text, /do not follow a write/i);
		assert.doesNotMatch(text, /inspect the relevant rows first/);
		assert.doesNotMatch(text, /final verification SELECT is recommended/);
		assert.doesNotMatch(
			text,
			/Put related mutations and their final verification/,
		);
	}
	assert.match(LIX_SQL_OPERATING_GUIDE, /excluded\.content/);
	assert.match(
		LIX_SQL_OPERATING_GUIDE,
		/INSERT INTO lix_key_value \(key, value\) VALUES \(\$1, \$2\) ON CONFLICT \(key\) DO UPDATE SET value = excluded\.value/,
	);
	assert.match(
		LIX_SQL_OPERATING_GUIDE,
		/INSERT INTO lix_directory \(path\) VALUES \(\$1\) ON CONFLICT \(path\) DO NOTHING/,
	);
	assert.match(LIX_SQL_OPERATING_GUIDE, /without a probe SELECT/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /lix_history\('lix_file', \$1\)/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /lixcol_commit_is_checkpoint/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /actual first parent/);
	assert.match(
		LIX_SQL_OPERATING_GUIDE,
		/Filtering never changes the comparison baseline/,
	);
	assert.match(LIX_SQL_OPERATING_GUIDE, /lix_as_of/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lix_file_history|lix_state_at/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_branch_id/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_start_commit_id/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_entity_pk/);
	assert.match(MCP_DOCS, /CAST\(\$2 AS BYTEA\)/);
	assert.match(MCP_DOCS, /ON CONFLICT \(path\) DO UPDATE/);
});

void test("the SQL tools carry their guide on the card an agent reads first", () => {
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /INSERT, UPDATE, and DELETE/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /use execute_sql for writes/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /ordered atomic SQL batch/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /complete batch is rolled back/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /already persisted/);
	// Reads: not SQLite, the catalog, core tables, params, file reads, history.
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /not SQLite/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.tables/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.columns/);
	assert.match(
		QUERY_SQL_TOOL_DESCRIPTION,
		/lix_file \(id, path, directory_id, name, content\)/,
	);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /kind: "text"/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /CAST\(content AS TEXT\)/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /lix_history\('lix_file'\)/);
	// Writes: the file recipe, directories, rename, delete, no readback.
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /CAST\(\$2 AS BYTEA\)/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /ON CONFLICT \(path\) DO UPDATE/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /kind "text"/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /never CAST\(\.\.\. AS BLOB\)/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /INSERT INTO lix_directory/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /\/skills, not \/skills\//);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /verification SELECT/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /create_checkpoint/);
	// The instructions still carry the full guide for hosts that show it.
	assert.match(MCP_SERVER_INSTRUCTIONS, /verification SELECT/);
	assert.match(MCP_SERVER_INSTRUCTIONS, /Do not checkpoint after every edit/);
	for (const description of [
		QUERY_SQL_TOOL_DESCRIPTION,
		EXECUTE_SQL_TOOL_DESCRIPTION,
	]) {
		assert.ok(description.length <= 1_800, `${description.length} chars`);
		assert.doesNotMatch(description, /never infer success from prose/);
		assert.doesNotMatch(description, /lixcol_branch_id/);
		assert.doesNotMatch(description, /lixcol_start_commit_id/);
		assert.doesNotMatch(description, /lixcol_entity_pk/);
	}
	// Each half stays on its own tool.
	for (const marker of SHARED_GUIDE_MARKERS) {
		const carriers = [
			QUERY_SQL_TOOL_DESCRIPTION,
			EXECUTE_SQL_TOOL_DESCRIPTION,
		].filter((description) => marker.test(description));
		assert.equal(carriers.length, 1, `${marker} must live on one tool`);
	}
});
