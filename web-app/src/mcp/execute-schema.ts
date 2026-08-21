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

/**
 * Shared Lix operating guide. Lives once on server instructions / docs — not
 * on every tool description.
 */
export const LIX_SQL_OPERATING_GUIDE = `SQL is the interface for repository data. Lix SQL is a Postgres dialect subset. File and directory creation, reads, edits, deletes, and path changes use query_sql or execute_sql against public lix_file and lix_directory. Do not invent file helper tools.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

UTF-8 / text files: pass \`$1\` (path) and \`$2\` (file body) as \`kind: "text"\` and write with \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content\`. Never use \`CAST(... AS BLOB)\`; if a SQL cast is needed, use \`BYTEA\`. Actual binaries use \`kind: "blob"\` without CAST. To read a text file, use \`SELECT path, CAST(content AS TEXT) AS content FROM lix_file WHERE path = $1\`. Create directories with \`INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING\`.

Lix supports Postgres \`INSERT ... ON CONFLICT (cols) DO UPDATE\` / \`DO NOTHING\` with \`excluded.col\` on files (\`lix_file\` on \`path\` or \`id\`) and schema-driven views such as \`lix_key_value\`. Example: \`INSERT INTO lix_key_value (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value\`. This is how you create-or-update without a probe SELECT. Name the conflict columns; \`ON CONSTRAINT\`, inference without columns, and \`DO UPDATE WHERE\` are not supported.

execute_sql already persisted the mutation. \`rowsAffected\` and any rows the batch itself returned are sufficient. Do not follow a write with a verification SELECT, a second query_sql to check, or path/length/substring readback. One execute_sql batch is the whole write (dirs + file + ON CONFLICT is fine inside that batch). Then stop.

Entity tables are lix-dynamic: discover names through information_schema before guessing.

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

History table functions are read-only revision streams, not current-state snapshot tables. Call \`lix_history('lix_file')\`, \`lix_history('lix_directory')\`, or \`lix_history('<schema>')\` to start at the active branch head. For an explicit anchor commit, pass its id as the second function argument, for example \`lix_history('lix_file', $1)\`. The relation name must be a non-null text literal, not a SQL parameter.`;

export const QUERY_SQL_TOOL_DESCRIPTION =
	"Run one read-only SQL statement against the branch selected by context. INSERT, UPDATE, and DELETE are rejected; use execute_sql for writes. Results arrive in structuredContent.";

export const EXECUTE_SQL_TOOL_DESCRIPTION =
	"Run an ordered atomic SQL batch against the branch selected by context. Always treated as potentially destructive; if any statement fails, the complete batch is rolled back. The mutation is already persisted: use rowsAffected and any returned rows, and do not follow a write with a verification SELECT. Do not call create_checkpoint after a write.";
