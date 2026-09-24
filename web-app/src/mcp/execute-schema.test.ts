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
	/UPDATE lix_file SET path/,
	/excluded\.content/,
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

void test("shared operating guide keeps file-content, upsert, and outcome-aware recovery copy", () => {
	for (const text of [LIX_SQL_OPERATING_GUIDE, MCP_DOCS]) {
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
		assert.match(text, /outcome is unknown/);
		assert.match(text, /validation is part of the task/i);
		assert.doesNotMatch(text, /inspect the relevant rows first/);
		assert.doesNotMatch(text, /final verification SELECT is recommended/);
		assert.doesNotMatch(
			text,
			/Put related mutations and their final verification/,
		);
	}
	assert.match(LIX_SQL_OPERATING_GUIDE, /excluded\.content/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /OCTET_LENGTH\(content\)/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /SUBSTRING\(content FROM 1 FOR 4096\)/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /known to be small/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /Agents previously overfetched/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /#485/);
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
	assert.match(LIX_SQL_OPERATING_GUIDE, /log\.is_checkpoint/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_commit_is_checkpoint/);
	assert.doesNotMatch(
		LIX_SQL_OPERATING_GUIDE,
		/lix_commit WHERE is_checkpoint/,
	);
	assert.match(LIX_SQL_OPERATING_GUIDE, /actual first parent/);
	assert.match(
		LIX_SQL_OPERATING_GUIDE,
		/Filtering the joined result never changes the comparison baseline/,
	);
	assert.match(LIX_SQL_OPERATING_GUIDE, /lix_as_of/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lix_file_history|lix_state_at/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_branch_id/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_start_commit_id/);
	assert.doesNotMatch(LIX_SQL_OPERATING_GUIDE, /lixcol_entity_pk/);
	assert.match(MCP_DOCS, /CAST\(\$2 AS BYTEA\)/);
	assert.match(MCP_DOCS, /ON CONFLICT \(path\) DO UPDATE/);
});

void test("each tool carries its own guide; SQL supports files directly", () => {
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /INSERT, UPDATE, and DELETE/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /use execute_sql for writes/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /ordered atomic SQL batch/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /complete batch is rolled back/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /already persisted/);
	// Reads: bounded SQL reads, not SQLite, the catalog, core tables, params, history.
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /query_sql is the read path/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /Agents previously overfetched/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /OCTET_LENGTH\(content\)/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /SUBSTRING\(content FROM 1 FOR 4096\)/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /known small text file/);
	assert.doesNotMatch(QUERY_SQL_TOOL_DESCRIPTION, /Prefer (?:read_files|list_files)/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /not SQLite/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.tables/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /information_schema\.columns/);
	assert.match(
		QUERY_SQL_TOOL_DESCRIPTION,
		/lix_file \(id, path, directory_id, name, content\)/,
	);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /kind: "text"/);
	assert.match(QUERY_SQL_TOOL_DESCRIPTION, /lix_history\('lix_file'/);
	// Writes: the one write path, with its guard, checkpoint, and recipes.
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /one write path/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /one call per coherent change/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /checkpoint: true/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /last_seen_commit_id/);
	assert.match(
		EXECUTE_SQL_TOOL_DESCRIPTION,
		/INSERT INTO lix_file \(path, content\) VALUES \(\$1, CAST\(\$2 AS BYTEA\)\) ON CONFLICT \(path\) DO UPDATE SET content = excluded\.content/,
	);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /lixcol_metadata/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /parents are created/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /UPDATE lix_file SET path/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /keeps the id, so links survive/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /Copy\+delete makes a new id/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /occupied target fails the batch/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /DELETE FROM lix_file/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /\/skills, not \/skills\//);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /Example: \[/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /outcome is unknown/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /write_files/);
	// The registered SQL read tool carries a complete, safe file-read guide.
	// The instructions carry recovery/routing; the full guide is a resource.
	assert.match(MCP_SERVER_INSTRUCTIONS, /outcome is unknown/);
	assert.match(MCP_SERVER_INSTRUCTIONS, /lixray:\/\/docs\/sql/);
	assert.doesNotMatch(MCP_SERVER_INSTRUCTIONS, /INSERT INTO/);
	assert.match(MCP_SERVER_INSTRUCTIONS, /Do not checkpoint after every edit/);
	for (const description of [
		QUERY_SQL_TOOL_DESCRIPTION,
		EXECUTE_SQL_TOOL_DESCRIPTION,
	]) {
		assert.ok(description.length <= 1_800, `${description.length} chars`);
		assert.doesNotMatch(description, /never infer success from prose/);
		assert.doesNotMatch(description, /lixcol_branch_id/);
	}
	// execute_sql is the one write path; nothing routes writes elsewhere.
	for (const text of [
		LIX_SQL_OPERATING_GUIDE,
		MCP_SERVER_INSTRUCTIONS,
		MCP_DOCS,
		QUERY_SQL_TOOL_DESCRIPTION,
		EXECUTE_SQL_TOOL_DESCRIPTION,
	])
		assert.doesNotMatch(text, /write_files/);
	assert.match(MCP_SERVER_INSTRUCTIONS, /execute_sql is the one write path/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /execute_sql is the one write path/);
	assert.match(LIX_SQL_OPERATING_GUIDE, /keeps its id, so links to it survive/);
	assert.match(MCP_DOCS, /`execute_sql` is the one write path/);
	// Each half of the SQL guide stays on its own tool.
	for (const marker of SHARED_GUIDE_MARKERS) {
		const carriers = [
			QUERY_SQL_TOOL_DESCRIPTION,
			EXECUTE_SQL_TOOL_DESCRIPTION,
		].filter((description) => marker.test(description));
		assert.equal(carriers.length, 1, `${marker} must live on one tool`);
	}
});
