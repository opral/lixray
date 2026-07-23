import assert from "node:assert/strict";
import test from "node:test";
import { openLix } from "@lix-js/sdk";
import {
	EXECUTE_SQL_CORE_SCHEMA,
	EXECUTE_SQL_CORE_TABLES,
	EXECUTE_SQL_TABLES_QUERY,
	EXECUTE_TOOL_DESCRIPTION,
} from "./execute-schema.ts";

void test("execute core schema guide matches fresh Lix surfaces", async (t) => {
	const lix = await openLix();
	t.after(async () => lix.close());
	const result = await lix.execute(`SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('lix_file', 'lix_directory', 'lix_branch', 'lix_change')
ORDER BY table_name, ordinal_position;`);
	const columnsByTable = new Map<string, Set<string>>();

	for (const row of result.rows) {
		const { table_name, column_name } = row.toObject() as {
			table_name: string;
			column_name: string;
		};
		const columns = columnsByTable.get(table_name) ?? new Set<string>();
		columns.add(column_name);
		columnsByTable.set(table_name, columns);
	}

	for (const table of EXECUTE_SQL_CORE_TABLES) {
		const actualColumns = columnsByTable.get(table.name);
		assert.ok(actualColumns, `${table.name} should exist in a fresh workspace`);
		for (const documentedColumn of table.columns) {
			const columnName = documentedColumn.split(" ")[0];
			assert.ok(
				actualColumns.has(columnName),
				`${table.name}.${columnName} should exist in a fresh workspace`,
			);
		}
	}
});

void test("entity discovery returns registered application schemas", async (t) => {
	const lix = await openLix();
	t.after(async () => lix.close());
	const schema = {
		"x-lix-key": "ax_execute_schema_probe",
		"x-lix-primary-key": ["/id"],
		type: "object",
		properties: { id: { type: "string" }, title: { type: "string" } },
		required: ["id", "title"],
		additionalProperties: false,
	};
	await lix.execute(
		`INSERT INTO lix_registered_schema (value) VALUES (lix_json($1))`,
		[JSON.stringify(schema)],
	);

	const result = await lix.execute(EXECUTE_SQL_TABLES_QUERY);
	const discovered = result.rows.map(
		(row) =>
			row.toObject() as {
				table_name: string;
				json_schema: Record<string, unknown>;
			},
	);
	assert.ok(
		discovered.some(
			(row) =>
				row.table_name === schema["x-lix-key"] &&
				row.json_schema["x-lix-key"] === schema["x-lix-key"],
		),
	);
	assert.equal(
		discovered.some((row) => row.table_name.startsWith("lix_")),
		false,
	);
});

void test("execute tool documents only the compact core schema", () => {
	for (const table of EXECUTE_SQL_CORE_TABLES) {
		assert.ok(EXECUTE_SQL_CORE_SCHEMA.includes(`\`${table.name}\``));
	}
	assert.doesNotMatch(
		EXECUTE_SQL_CORE_SCHEMA,
		/lix_state|_by_branch|_history|lixcol_/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /Apache DataFusion, not SQLite/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /recursive CTEs are unsupported/);
	assert.doesNotMatch(EXECUTE_TOOL_DESCRIPTION, /information_schema/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /File paths never end/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /directory paths always do/);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/`directory_id` references `lix_directory\.id`/,
	);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/Top-level directories have `parent_id IS NULL`/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /_by_branch.*lixcol_branch_id/);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/read-only `_history` companions; branch\/change do not/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /Cast `data AS TEXT`.*UTF-8/);
	assert.match(
		EXECUTE_TOOL_DESCRIPTION,
		/UNNEST\(string_to_array\(CAST\(data AS TEXT\), chr\(10\)\)\)/,
	);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /lix_active_branch_commit_id\(\)/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /user primary-key column/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /deleted or old path/);
	assert.match(EXECUTE_TOOL_DESCRIPTION, /no `lixcol_commit_id`/);
	assert.doesNotMatch(
		EXECUTE_TOOL_DESCRIPTION,
		/Batch envelope|Request:|Response:/,
	);
	assert.ok(EXECUTE_TOOL_DESCRIPTION.length <= 2_100);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /FROM lix_registered_schema/);
	assert.match(EXECUTE_SQL_TABLES_QUERY, /x-lix-key/);
	assert.doesNotMatch(EXECUTE_SQL_TABLES_QUERY, /information_schema\.tables/);
});
