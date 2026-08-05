interface ExecuteSqlCoreTable {
	name: string;
	purpose: string;
	columns: ReadonlyArray<string>;
}

/**
 * The stable, agent-facing part of a Lix lix schema.
 *
 * Entity tables deliberately do not appear here: a lix can register its
 * own entity schemas, so their names and columns must be discovered at runtime.
 */
export const EXECUTE_SQL_CORE_TABLES: ReadonlyArray<ExecuteSqlCoreTable> = [
	{
		name: "lix_file",
		purpose: "Current files in the active branch.",
		columns: ["id", "path", "directory_id", "name", "content (binary)"],
	},
	{
		name: "lix_directory",
		purpose: "Current directories in the active branch.",
		columns: ["id", "path", "parent_id", "name"],
	},
	{
		name: "lix_branch",
		purpose: "Lix branches and their current commits.",
		columns: ["id", "name", "hidden", "commit_id"],
	},
	{
		name: "lix_change",
		purpose: "Global immutable change ledger; use it for activity and audit.",
		columns: [
			"id",
			"entity_pk",
			"schema_key",
			"file_id",
			"snapshot_content",
			"metadata",
			"created_at",
			"origin_key",
		],
	},
];

export const EXECUTE_SQL_CORE_SCHEMA = EXECUTE_SQL_CORE_TABLES.map(
	(table) =>
		`- \`${table.name}\` — ${table.purpose} Columns: \`${table.columns.join(", ")}\`.`,
).join("\n");

export const EXECUTE_SQL_TABLES_QUERY = `SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;`;

export const EXECUTE_SQL_COLUMNS_QUERY = `SELECT column_name, data_type, is_nullable, ordinal_position
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = $1
ORDER BY ordinal_position;`;

export const EXECUTE_TOOL_DESCRIPTION = `Use the JavaScript Lix SDK SQL surface. execute runs one statement; execute_batch runs an ordered atomic batch against the branch selected by context. File and directory creation, reads, edits, deletes, and path changes are SQL operations. SQL can read or mutate any SQL-accessible branch data. Lix SQL does not support DDL statements.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

Path rules: \`lix_file.path\` and \`lix_directory.path\` are canonical absolute paths and neither ends in \`/\` (except the root path \`/\`). \`lix_file.directory_id\` references \`lix_directory.id\`; \`lix_directory.parent_id\` references \`lix_directory.id\`. Use those IDs for hierarchy queries.

\`lix_file.content\` is binary. Pass binary values as \`{"kind":"blob","base64":"..."}\`. Never use \`CAST(... AS BLOB)\`; if a SQL cast is unavoidable, use \`BYTEA\`.

To create a file, use \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA))\`; to read it, use \`SELECT CAST(content AS TEXT) FROM lix_file WHERE path = $1\`; to rename it, use \`UPDATE lix_file SET path = $2 WHERE path = $1\`. Create directories with \`INSERT INTO lix_directory (path) VALUES ($1)\`. Use \`execute_batch\` for a multi-step change.

Use the core tables above, plus their \`_by_branch\` / \`_history\` companions, directly; do not inspect \`information_schema\` for them.

Entity tables are lix-dynamic: do not assume a fixed entity-table list or column shape. Only when a task needs an entity table, discover its table name, then inspect only that table:

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

System \`lixcol_*\` metadata is intentionally omitted from the core guide. Where present, \`<table>_by_branch\` adds \`lixcol_branch_id\` for cross-branch reads and writes. \`<table>_history\` is read-only: scope every history query with \`WHERE lixcol_start_commit_id = lix_active_branch_commit_id()\`, then constrain it by stable identity (\`id = $n\` for files/directories or \`lixcol_entity_pk = $n\` for entities) resolved from the active table. That avoids \`LIX_HISTORY_NON_IDENTITY_FILTER\` and preserves renamed/tombstoned history. Read a current item's \`lixcol_change_id\` from its active table, not an historical row; use \`lixcol_depth\` / \`lixcol_observed_commit_id\` for prior revisions.`;
