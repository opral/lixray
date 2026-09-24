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
		purpose: "Repository-global retained commit identity and creation time.",
		columns: ["id", "created_at"],
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
export const LIX_SQL_OPERATING_GUIDE = `query_sql is the sole read path for repository data and file contents. Agents previously overfetched file data because read_files selected the full content blob and applied its 1 MiB cutoff only after retrieval (#485). Check size with \`SELECT OCTET_LENGTH(content) AS size FROM lix_file WHERE path = $1\`; when only an excerpt is needed, use \`SELECT SUBSTRING(content FROM 1 FOR 4096) AS excerpt_bytes FROM lix_file WHERE path = $1\`. Do not fetch full content just to measure it or retrieve an excerpt. \`CAST(content AS TEXT)\` is only for a known small text file. execute_sql is the one write path: one call per coherent change, with every create, update, move, rename, copy, delete and directory change in one ordered atomic batch against public lix_file and lix_directory. \`checkpoint: true\` marks the result; \`last_seen_commit_id\` (open_lix's commit_id, or \`commit.after\` of an earlier batch) refuses the batch if a file or directory it touches changed since that commit, and the conflict error carries the current contents. Lix SQL is a Postgres dialect subset. Use the registered tools only.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

UTF-8 / text files: pass \`$1\` (path) and \`$2\` (file body) as \`kind: "text"\` and write with \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content\`. Never use \`CAST(... AS BLOB)\`; if a SQL cast is needed, use \`BYTEA\`. Actual binaries use \`kind: "blob"\` without CAST. Missing parent directories are created. Per-file JSON metadata lives in the \`lixcol_metadata\` column (\`kind: "json"\`). For a size check use \`SELECT path, OCTET_LENGTH(content) AS size FROM lix_file WHERE path = $1\`; for bounded bytes use \`SELECT SUBSTRING(content FROM 1 FOR 4096) AS excerpt_bytes FROM lix_file WHERE path = $1\`. Decode the returned bytes as text in the client when appropriate; wrapping the SQL substring in a cast can load the full file. Only use \`CAST(content AS TEXT)\` when the file is known to be small. Create directories with \`INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING\`.

Move or rename with \`UPDATE lix_file SET path = $1 WHERE path = $2\`: the file keeps its id, so links to it survive, and missing parent directories are created; a destination that already exists fails the batch. Copy plus delete makes a new id, so never move that way. Delete with \`DELETE FROM lix_file WHERE path = $1\`. Directories work the same on \`lix_directory\`; moving one moves its files. Paths have no trailing slash: /skills, not /skills/.

Lix supports Postgres \`INSERT ... ON CONFLICT (cols) DO UPDATE\` / \`DO NOTHING\` with \`excluded.col\` on files (\`lix_file\` on \`path\` or \`id\`) and schema-driven views such as \`lix_key_value\`. Example: \`INSERT INTO lix_key_value (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value\`. This is how you create-or-update without a probe SELECT. Name the conflict columns; \`ON CONSTRAINT\`, inference without columns, and \`DO UPDATE WHERE\` are not supported.

execute_sql already persisted the mutation. \`rowsAffected\` and any rows the batch itself returned are sufficient. Read back when the outcome is unknown or validation is part of the task. Never blindly retry an uncertain write. When a link is needed, use get_entity_urls: store its ID-only url in documents and use display_url for human-facing browser links. This is a separate link-resolution read, not write verification.

Entity tables are lix-dynamic: discover names through information_schema before guessing.

\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

\`\`\`sql
${EXECUTE_SQL_COLUMNS_QUERY}
\`\`\`

Version-control reads use four surfaces. \`lix_log([anchor])\` lists retained commits on the first-parent chain ending at the anchor, with \`commit_id\`, \`parent_commit_id\`, \`created_at\`, \`is_checkpoint\`, and \`position\`. The \`is_checkpoint\` value is active at that anchor; use \`WHERE is_checkpoint ORDER BY position\` for the eligible checkpoint timeline. Position zero is the anchor and positions are assigned before filtering. \`lix_commit\` exposes retained commit identity and creation time, without checkpoint metadata.

\`lix_history('lix_file')\`, \`lix_history('lix_directory')\`, and \`lix_history('<schema>')\` return net row differences for each retained mainline commit compared with its actual first parent. For an explicit anchor, use the same anchor with \`lix_history('lix_file', $1)\` and \`lix_log($1)\`. History provides typed keys, \`diff_type\`, paired \`from_<column>\` / \`to_<column>\` values, \`lixcol_from_commit_id\`, \`lixcol_to_commit_id\`, \`lixcol_commit_created_at\`, and \`lixcol_position\`. To read a file's checkpoint changes, join \`lix_log($1)\` to \`lix_history('lix_file', $1)\` on \`log.commit_id = history.lixcol_to_commit_id\`, filter \`log.is_checkpoint\` and the file id, and order by \`log.position\`. Filtering the joined result never changes the comparison baseline: a checkpoint's parent can be an unmarked fork or restore baseline. Empty commits appear in log but have no history rows. Merged-side commits are not separate mainline entries, and compaction can remove automatic revisions.

\`lix_diff('lix_file')\` compares the actual working baseline with the current head; \`lix_diff('lix_file', $1, $2)\` compares explicit endpoints. Its endpoint columns identify that exact pair. Use \`lix_branch.working_base_commit_id\` for working context even when the diff is empty; the latest marked checkpoint is not necessarily the working baseline. For selected commands, reselect through the appropriate diff and guard its endpoints, rather than submitting a multi-commit history stream.

\`lix_as_of('lix_file', $1)\` reads historical state at one retained commit, including file content. The current file size and range pushdowns apply to direct \`lix_file\` reads, not \`lix_as_of\`; avoid querying large historical content through this function until historical range reads are supported. History is not a current-state snapshot. Relation arguments must be non-null text literals, not SQL parameters; commit endpoints and anchors accept parameters. Checkpoints no longer add marker records to \`lix_change\`; its counts measure retained source records, not user edits.`;

export const EXECUTE_SQL_COLUMNS_WITH_DESCRIPTIONS_QUERY = `SELECT column_name, data_type, is_nullable, description
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = $1
ORDER BY ordinal_position;`;

/**
 * What an agent that hits a SQLite habit needs to hear. Lix is not SQLite:
 * the catalog is information_schema, and the answer names the exact query.
 */
export const LIX_IS_NOT_SQLITE_MESSAGE =
	"Lix is not SQLite: there is no sqlite_master, sqlite_schema, or PRAGMA. The catalog is information_schema.";
export const LIX_CATALOG_HINT = `Discover tables with: ${EXECUTE_SQL_TABLES_QUERY.replace(/\s+/g, " ")} Discover columns with: ${EXECUTE_SQL_COLUMNS_WITH_DESCRIPTIONS_QUERY.replace(/\s+/g, " ")}`;

// The SQL tools carry the guide an agent needs to use them, in their own
// descriptions: hosts do not reliably show server instructions to the model,
// and the tool card is what an agent reads before its first query.
const LIX_SQL_READ_GUIDE = `query_sql is the read path for repository data and files. Agents previously overfetched: read_files selected full file content, then applied its 1 MiB cutoff after retrieval (#485). Do not fetch full content to check size or read an excerpt. First run \`SELECT OCTET_LENGTH(content) AS size FROM lix_file WHERE path = $1\`; for a bounded excerpt run \`SELECT SUBSTRING(content FROM 1 FOR 4096) AS excerpt_bytes FROM lix_file WHERE path = $1\`. \`CAST(content AS TEXT)\` is only for a known small text file. Lix SQL is a Postgres dialect subset, not SQLite: there is no sqlite_master and no PRAGMA. Discover tables with \`${EXECUTE_SQL_TABLES_QUERY.replace(/\s+/g, " ")}\` and columns with \`${EXECUTE_SQL_COLUMNS_WITH_DESCRIPTIONS_QUERY.replace(/\s+/g, " ")}\`. Core tables: lix_file (id, path, directory_id, name, content), lix_directory (id, path, parent_id, name), lix_branch, lix_commit, lix_change; entity tables are repository-defined, so discover them rather than guess. Parameters are $1, $2, … given as params: [{ kind: "text", value: "…" }]. History: lix_log([anchor]) lists retained commits with active checkpoint metadata; lix_history('lix_file'[, anchor]) gives net changes; lix_diff('lix_file') gives working changes; lix_as_of('lix_file', $1) gives state at a commit. Join log to history on destination commit ID for checkpoint filters.`;

const LIX_SQL_WRITE_GUIDE = `The one write path: one call per coherent change, its creates, updates, moves, copies, deletes and directory changes in order. checkpoint: true marks a milestone (saving needs no checkpoint); last_seen_commit_id (open_lix's commit_id or a batch's commit.after) refuses the batch if a file it touches changed since. Upsert: \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content\` (metadata: lixcol_metadata); parents are created. Move/rename: \`UPDATE lix_file SET path = $1 WHERE path = $2\` keeps the id, so links survive; an occupied target fails the batch. Copy+delete makes a new id; never move that way. Delete: \`DELETE FROM lix_file WHERE path = $1\`. Directories likewise on lix_directory (no trailing slash: /skills, not /skills/). Example: [upsert /gtm/plan.md, move /gtm/a.md to /gtm/archive/a.md, upsert a redirect at /gtm/a.md], checkpoint: true. Errors carry statement_index and an outcome; never blindly retry unknown or committed.`;

export const QUERY_SQL_TOOL_DESCRIPTION = `Run one read-only SQL statement against lix_ref (@handle/slug or UUID), optionally branch_id. Defaults to the repository default branch; no open_lix needed. Or pass context alone for its pinned branch. INSERT, UPDATE, and DELETE are rejected; use execute_sql for writes.

${LIX_SQL_READ_GUIDE}`;

export const EXECUTE_SQL_TOOL_DESCRIPTION = `Run an ordered atomic SQL batch against lix_ref (@handle/slug or UUID; no open_lix needed), optionally branch_id, or context alone for its pinned branch. If a statement fails, the complete batch is rolled back; a returned result is already persisted, read back only if the outcome is unknown or validation is part of the task. UI hosts show a card; summarize, do not list files.

${LIX_SQL_WRITE_GUIDE}`;
