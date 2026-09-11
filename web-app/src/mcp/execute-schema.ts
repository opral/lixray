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
		columns: ["id", "name", "hidden", "commit_id", "working_base_commit_id"],
	},
	{
		name: "lix_commit",
		purpose:
			"Repository-global retained commits; filter is_checkpoint for checkpoint inventory.",
		columns: ["id", "created_at", "is_checkpoint"],
	},
	{
		name: "lix_change",
		purpose:
			"Retained repository-global source records; use them for source activity and audit, not counts of user edits or net differences.",
		columns: [
			"id",
			"row_pk",
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

execute_sql already persisted the mutation. \`rowsAffected\` and any rows the batch itself returned are sufficient. Do not follow a write with a verification SELECT, a second query_sql to check, or path/length/substring readback. One execute_sql batch is the whole write (dirs + file + ON CONFLICT is fine inside that batch). No readback is needed to confirm persistence. When a browser link is needed, use get_entity_urls to resolve the canonical URL; that is a separate link-resolution read, not write verification.

Entity tables are lix-dynamic: discover names through information_schema before guessing.

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

Version-control reads use four surfaces. \`lix_log()\` lists retained commits on the active head's first-parent chain, with \`commit_id\`, \`parent_commit_id\`, \`created_at\`, \`is_checkpoint\`, and \`position\`. Use \`WHERE is_checkpoint ORDER BY position\` for the branch checkpoint timeline. Position zero is the anchor and positions are assigned before filtering. For repository-global checkpoint counts, query \`lix_commit WHERE is_checkpoint\` instead.

\`lix_history('lix_file')\`, \`lix_history('lix_directory')\`, and \`lix_history('<schema>')\` return net row differences for each retained mainline commit compared with its actual first parent. For an explicit anchor, use \`lix_history('lix_file', $1)\` and \`lix_log($1)\`. History provides typed keys, \`diff_type\`, paired \`from_<column>\` / \`to_<column>\` values, \`lixcol_from_commit_id\`, \`lixcol_to_commit_id\`, \`lixcol_commit_is_checkpoint\`, \`lixcol_commit_created_at\`, and \`lixcol_position\`. Filter \`WHERE id = $2 AND lixcol_commit_is_checkpoint ORDER BY lixcol_position\` for a file's checkpoint changes. Filtering never changes the comparison baseline: a checkpoint's parent can be an unmarked fork or restore baseline. Empty commits appear in log but have no history rows. Merged-side commits are not separate mainline entries, and compaction can remove automatic revisions.

\`lix_diff('lix_file')\` compares the actual working baseline with the current head; \`lix_diff('lix_file', $1, $2)\` compares explicit endpoints. Its endpoint columns identify that exact pair. Use \`lix_branch.working_base_commit_id\` for working context even when the diff is empty; the latest marked checkpoint is not necessarily the working baseline. For selected commands, reselect through the appropriate diff and guard its endpoints, rather than submitting a multi-commit history stream.

\`lix_as_of('lix_file', $1)\` reads complete state at one retained commit, including file content. Read file bytes lazily through this snapshot surface; history is not a current-state snapshot. Relation arguments must be non-null text literals, not SQL parameters; commit endpoints and anchors accept parameters. Checkpoints no longer add marker records to \`lix_change\`; its counts measure retained source records, not user edits.`;

// Per-tool descriptions say what the tool does and its one hard rule. The
// shared SQL guide, the no-readback rule, and the checkpoint policy live once
// in the server instructions, so nothing here repeats them.
export const QUERY_SQL_TOOL_DESCRIPTION =
	"Run one read-only SQL statement against the Lix and branch in context. INSERT, UPDATE, and DELETE are rejected; use execute_sql for writes.";

export const EXECUTE_SQL_TOOL_DESCRIPTION =
	"Run an ordered atomic SQL batch against the Lix and branch in context. If any statement fails, the complete batch is rolled back; a returned result is already persisted.";
