import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	initSync,
	openMemory,
} from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk.js";
import type { LixBinding } from "../../../vendor/lix/packages/js-sdk/dist/binding-types.js";
import {
	EXECUTE_SQL_COLUMNS_QUERY,
	EXECUTE_SQL_CORE_SCHEMA,
	EXECUTE_SQL_CORE_TABLES,
	EXECUTE_SQL_TABLES_QUERY,
	EXECUTE_TOOL_DESCRIPTION,
} from "./execute-schema.ts";

initSync({
	module: await readFile(
		new URL(
			"../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm",
			import.meta.url,
		),
	),
});

// Keep this contract on the source-matched binding used by the Worker.
async function openFreshLix(): Promise<LixBinding> {
	return (await openMemory()) as unknown as LixBinding;
}

void test("opens fresh Lix through the vendored WASM binding", async (t) => {
	const lix = await openFreshLix();
	t.after(async () => lix.close());
});

void test("execute core schema guide matches fresh Lix surfaces", async (t) => {
	const lix = await openFreshLix();
	t.after(async () => lix.close());
	const result = await lix.execute(
		`SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('lix_file', 'lix_directory', 'lix_branch', 'lix_change')
ORDER BY table_name, ordinal_position;`,
		[],
	);
	const columnsByTable = new Map<string, Set<string>>();

	for (const row of result.rows) {
		const [tableName, columnName] = row;
		if (tableName?.kind !== "text" || columnName?.kind !== "text") {
			throw new TypeError(
				"information_schema returned non-text column metadata",
			);
		}
		const columns = columnsByTable.get(tableName.value) ?? new Set<string>();
		columns.add(columnName.value);
		columnsByTable.set(tableName.value, columns);
	}

	for (const table of EXECUTE_SQL_CORE_TABLES) {
		const actualColumns = columnsByTable.get(table.name);
		assert.ok(actualColumns, `${table.name} should exist in a fresh lix`);
		for (const documentedColumn of table.columns) {
			const columnName = documentedColumn.split(" ")[0];
			assert.ok(
				actualColumns.has(columnName),
				`${table.name}.${columnName} should exist in a fresh lix`,
			);
		}
	}
});

void test("execute tool documents only the compact core schema", () => {
	for (const table of EXECUTE_SQL_CORE_TABLES) {
		assert.ok(EXECUTE_SQL_CORE_SCHEMA.includes(`\`${table.name}\``));
	}
	assert.doesNotMatch(
		EXECUTE_SQL_CORE_SCHEMA,
		/lix_state|_by_branch|_history|lixcol_/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /Entity tables are lix-dynamic/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /information_schema/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /lix_file\.path.*never ends/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /lix_directory\.path.*always does/);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/lix_file\.directory_id.*lix_directory\.id/,
	);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/lix_directory\.parent_id.*lix_directory\.id/,
	);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/do not inspect `information_schema` for them/,
	);
	assert.match(EXECUTE_SQL_CORE_SCHEMA, /data \(binary\)/);
	assert.doesNotMatch(EXECUTE_SQL_CORE_SCHEMA, /data \(BLOB\)/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /`lix_file\.data` is binary/);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/Pass binary values as `\{"kind":"blob","base64":"\.\.\."\}`/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /Never use `CAST\(\.\.\. AS BLOB\)`/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /use `BYTEA`/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /lix_active_branch_commit_id\(\)/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /LIX_HISTORY_NON_IDENTITY_FILTER/);
	assert.doesNotMatch(EXECUTE_TOOL_DESCRIPTION, /file-tool safeguards/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /current item's `lixcol_change_id`/);
	assert.ok(EXECUTE_TOOL_DESCRIPTION.length < 4_000);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /information_schema\.tables/);
	assert.match(EXECUTE_SQL_COLUMNS_QUERY, /information_schema\.columns/);
});
