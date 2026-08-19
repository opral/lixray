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

export const QUERY_SQL_TOOL_DESCRIPTION = `Use SQL as the universal read interface to Lix. Lix SQL is a Postgres dialect subset. query_sql runs exactly one SELECT statement against the branch selected by context. Non-SELECT and multi-statement scripts are rejected; use execute_sql when arbitrary SQL is required. Do not look for or invent typed file or entity tools.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

Use focused projections, predicates, and LIMIT where applicable. UTF-8 / text files are written with \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA))\` using \`kind: "text"\` parameters. To read a text file, use \`SELECT path, CAST(content AS TEXT) AS content FROM lix_file WHERE path = $1\`. \`lix_file.content\` is stored as bytes; select only content the user actually requested.

SQL tables always use the branch selected by the current Lix session. They do not expose branch-routing columns or \`_by_branch\` variants. Entity tables are lix-dynamic: discover their table and column names before guessing:

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

History table functions are read-only revision streams, not current-state snapshot tables. Scope every history query with \`WHERE lixcol_start_commit_id = lix_active_branch_commit_id()\`, then constrain it by stable identity (\`id = $n\` for files/directories or \`lixcol_entity_pk = $n\` for entities) resolved from the current table. Read a current item's \`lixcol_change_id\` from its current table, not an historical row; use \`lixcol_depth\` / \`lixcol_observed_commit_id\` for prior revisions.`;

const EXECUTE_SQL_GUIDE = `Use SQL as the universal interface to Lix. Lix SQL is a Postgres dialect subset. execute_sql runs any ordered atomic SQL batch against the branch selected by context and is always treated as potentially destructive. File and directory creation, reads, edits, deletes, path changes, and entity operations are SQL. Do not look for or invent typed file or entity tools. Lix SQL does not support DDL statements.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

Path rules: \`lix_file.path\` and \`lix_directory.path\` are canonical absolute paths and neither ends in \`/\` (except the root path \`/\`). \`lix_file.directory_id\` references \`lix_directory.id\`; \`lix_directory.parent_id\` references \`lix_directory.id\`. Use those IDs for hierarchy queries.

\`lix_file.content\` is stored as bytes. For UTF-8 / text files, pass \`$1\` (path) and \`$2\` (file body) as \`kind: "text"\` and write with \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA))\`. Never use \`CAST(... AS BLOB)\`; if a SQL cast is needed, use \`BYTEA\`. Actual binaries use \`kind: "blob"\` without CAST.

To create a file, use \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content\`; to read it, use \`SELECT path, CAST(content AS TEXT) AS content FROM lix_file WHERE path = $1\`; to rename it, use \`UPDATE lix_file SET path = $2 WHERE path = $1\`. Create directories with \`INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING\`.

Lix supports Postgres \`INSERT ... ON CONFLICT (cols) DO UPDATE\` / \`DO NOTHING\` with \`excluded.col\` on files (\`lix_file\` on \`path\` or \`id\`) and schema-driven views such as \`lix_key_value\`. Example: \`INSERT INTO lix_key_value (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value\`. This is how you create-or-update without a probe SELECT. Name the conflict columns; \`ON CONSTRAINT\`, inference without columns, and \`DO UPDATE WHERE\` are not supported.

For a mutation, inspect the relevant rows first with query_sql, execute the mutation, and verify it with a focused SELECT. Put related mutations and their final verification SELECT in one execute_sql call so the change is atomic and the returned final result is its readback. Use rowsAffected plus returned rows to report what changed; never infer success from prose alone.

A successful execute_sql mutation is already saved; Lix does not require a checkpoint for durability. Unlike Git, skipping create_checkpoint keeps the files; you just do not have a named restore point, and \`lix_working_diff\` keeps accumulating from the last checkpoint. create_checkpoint is optional later, when a session or task is complete and someone may want this exact state; do not call it after every write. List checkpoints with \`SELECT\` on \`lix_checkpoint\` or \`lix_checkpoint_history()\`.

SQL tables always use the branch selected by the current Lix session. They do not expose branch-routing columns or \`_by_branch\` variants.

Entity tables are lix-dynamic: do not assume a fixed entity-table list or column shape. Before guessing a dynamic table or column name, discover its table name through information_schema, then inspect only that table:

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

System \`lixcol_*\` metadata is intentionally omitted from the core guide. History table functions are read-only revision streams, not current-state snapshot tables. Scope every history query with \`WHERE lixcol_start_commit_id = lix_active_branch_commit_id()\`, then constrain it by stable identity (\`id = $n\` for files/directories or \`lixcol_entity_pk = $n\` for entities) resolved from the current table. That avoids \`LIX_HISTORY_NON_IDENTITY_FILTER\` and preserves renamed/tombstoned history. Read a current item's \`lixcol_change_id\` from its current table, not an historical row; use \`lixcol_depth\` / \`lixcol_observed_commit_id\` for prior revisions.`;

export const EXECUTE_SQL_TOOL_DESCRIPTION = `${EXECUTE_SQL_GUIDE}

Statements may be read-only or mutating. If any statement fails, the complete batch is rolled back.`;
