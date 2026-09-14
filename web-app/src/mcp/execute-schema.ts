import { SQL_TEXT_WRITE_RECIPE } from "./sql-errors.ts";

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
export const LIX_SQL_OPERATING_GUIDE = `SQL is the interface for repository data. Lix SQL is a Postgres dialect subset. File and directory creation, reads, edits, deletes, and path changes use query_sql or execute_sql against public lix_file and lix_directory. Use the registered tools only.

Core tables:
${EXECUTE_SQL_CORE_SCHEMA}

UTF-8 / text files: pass \`$1\` (path) and \`$2\` (file body) as \`kind: "text"\` and write with \`INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content\`. Never use \`CAST(... AS BLOB)\`; if a SQL cast is needed, use \`BYTEA\`. Actual binaries use \`kind: "blob"\` without CAST. To read a text file, use \`SELECT path, CAST(content AS TEXT) AS content FROM lix_file WHERE path = $1\`. Create directories with \`INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING\`.

Lix supports Postgres \`INSERT ... ON CONFLICT (cols) DO UPDATE\` / \`DO NOTHING\` with \`excluded.col\` on files (\`lix_file\` on \`path\` or \`id\`) and schema-driven views such as \`lix_key_value\`. Example: \`INSERT INTO lix_key_value (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value\`. This is how you create-or-update without a probe SELECT. Name the conflict columns; \`ON CONSTRAINT\`, inference without columns, and \`DO UPDATE WHERE\` are not supported.

execute_sql already persisted the mutation. \`rowsAffected\` and any rows the batch itself returned are sufficient. Read back when the outcome is unknown or validation is part of the task. Never blindly retry an uncertain write. When a browser link is needed, use get_entity_urls to resolve the canonical URL; that is a separate link-resolution read, not write verification.

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

// The two SQL tools carry the guide an agent needs to use them, in their own
// descriptions: hosts do not reliably show server instructions to the model,
// and the tool card is what an agent reads before its first query. Reads and
// writes each get their half; the other tools stay one or two sentences.
const LIX_SQL_READ_GUIDE = `Read repository data and files with SQL; read_files and list_files are optional conveniences. Lix SQL is a Postgres dialect subset, not SQLite: there is no sqlite_master and no PRAGMA. Discover tables with \`${EXECUTE_SQL_TABLES_QUERY.replace(/\s+/g, " ")}\` and columns, with their descriptions, with \`${EXECUTE_SQL_COLUMNS_WITH_DESCRIPTIONS_QUERY.replace(/\s+/g, " ")}\`. Core tables: lix_file (id, path, directory_id, name, content), lix_directory (id, path, parent_id, name), lix_branch, lix_commit, lix_change; entity tables are repository-defined, so discover them rather than guess. Parameters are $1, $2, … given as params: [{ kind: "text", value: "…" }] (kinds: text, int, float, json, blob); file bytes read as CAST(content AS TEXT). History: lix_log() lists retained commits, lix_history('lix_file') the net change per commit, lix_diff('lix_file') the working changes, lix_as_of('lix_file', $1) the state at a commit.`;

const LIX_SQL_WRITE_GUIDE = `${SQL_TEXT_WRITE_RECIPE} write_files is an optional convenience. Rename with \`UPDATE lix_file SET path = $1 WHERE path = $2\`; delete with \`DELETE FROM lix_file WHERE path = $1\`; directories likewise on lix_directory (paths have no trailing slash: /skills, not /skills/). Lix supports \`INSERT … ON CONFLICT (cols) DO UPDATE SET col = excluded.col\` and DO NOTHING; ON CONSTRAINT and DO UPDATE WHERE are not supported; text bound for a byte column is written as \`CAST($n AS BYTEA)\`. Successful writes are persisted; read back only when the outcome is unknown or validation is part of the task. Errors identify a zero-based statement_index when available and report outcome as not_committed, unknown, or committed. Never blindly retry an unknown or committed outcome. Mark meaningful milestones with create_checkpoint; saving needs no checkpoint.`;

export const LIST_FILES_TOOL_DESCRIPTION =
	"List the files of the Lix and branch in context with id, path, and canonical url, sorted by path. Optional directory (an absolute path prefix such as /gtm) and name (a case-insensitive substring of the file name) narrow the list; truncated says to narrow further. Read-only.";

export const READ_FILES_TOOL_DESCRIPTION =
	'Read files by absolute path. Each returns id, canonical url, size, content as text, and lixcol_metadata: the JSON the app keeps per file, null when none (the CSV view stores its column model there under atelier_csv: { version: 1, columns: [{ id, header, index, type, options? }] }). A file whose bytes are not text, or that is over a megabyte, comes back with no content and an encoding of "binary" or "too-large" saying why; read its bytes with SQL (SELECT content FROM lix_file WHERE path = $1) when you need them. Paths that do not exist come back in missing. commit_id is the commit the read reflects; pass it to write_files as last_seen_commit_id.';

export const WRITE_FILES_TOOL_DESCRIPTION =
	"Create or update files in one atomic commit, parent directories included. Each file takes content (text) or content_base64 (bytes), not both, and optionally lixcol_metadata (omitted keeps it, an object replaces it, null clears it); metadata alone updates an existing file. With last_seen_commit_id, a file that changed since that commit refuses the whole write: the error carries current_commit_id and the current content of the conflicting files, so merge and write again; unrelated changes never block. checkpoint: true marks the resulting commit. A successful write is already saved; read back if its outcome is uncertain or validation is requested. A write to a file LixRay can render (Markdown, CSV) returns the change as a card the reader can see, so describe the edit in a sentence rather than repeating the diff. Rename, delete, and everything else: execute_sql on lix_file and lix_directory.";

export const QUERY_SQL_TOOL_DESCRIPTION = `Run one read-only SQL statement against lix_ref (@handle/slug or UUID), optionally branch_id. Defaults to the repository default branch; no open_lix needed. Or pass context alone for its pinned branch. INSERT, UPDATE, and DELETE are rejected; use execute_sql for writes.

${LIX_SQL_READ_GUIDE}`;

export const EXECUTE_SQL_TOOL_DESCRIPTION = `Run an ordered atomic SQL batch against lix_ref (@handle/slug or UUID), optionally branch_id. Defaults to the repository default branch; no open_lix needed. Or pass context alone for its pinned branch. If any statement fails, the complete batch is rolled back; a returned result is already persisted.

${LIX_SQL_WRITE_GUIDE}`;
