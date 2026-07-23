interface ExecuteSqlCoreTable {
	name: string;
	purpose: string;
	columns: ReadonlyArray<string>;
}

/**
 * The stable, agent-facing part of a Lix workspace schema.
 *
 * Entity tables deliberately do not appear here: a workspace can register its
 * own entity schemas, so their names and columns must be discovered at runtime.
 */
export const EXECUTE_SQL_CORE_TABLES: ReadonlyArray<ExecuteSqlCoreTable> = [
	{
		name: "lix_file",
		purpose: "Active files.",
		columns: ["id", "path", "directory_id", "name", "data (BLOB)"],
	},
	{
		name: "lix_directory",
		purpose: "Active directories.",
		columns: ["id", "path", "parent_id", "name"],
	},
	{
		name: "lix_branch",
		purpose: "Branches.",
		columns: ["id", "name", "hidden", "commit_id"],
	},
	{
		name: "lix_change",
		purpose: "Global activity.",
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

export const EXECUTE_SQL_CORE_SCHEMA = `- \`lix_file\` — active files: \`id, path, directory_id, name, data\` (BLOB).
- \`lix_directory\` — active directories: \`id, path, parent_id, name\`.
- \`lix_branch\` — branches: \`id, name, hidden, commit_id\`.
- \`lix_change\` — global activity: \`id, entity_pk, schema_key, file_id, snapshot_content, metadata, created_at, origin_key\`. Use \`WHERE NOT starts_with(schema_key,'lix_')\` for application-only activity.`;

export const EXECUTE_SQL_TABLES_QUERY = `SELECT lix_json_get_text(value,'x-lix-key') AS table_name, value AS json_schema
FROM lix_registered_schema
WHERE NOT starts_with(lix_json_get_text(value,'x-lix-key'),'lix_')
ORDER BY table_name`;

export const EXECUTE_TOOL_DESCRIPTION = `Execute 1–100 Lix SQL statements atomically and in order; any failure rolls back all. Active tables use the active branch; use \`_by_branch\` across branches or \`switch_branch\` to change it. SQL dialect: Apache DataFusion, not SQLite. DDL and recursive CTEs are unsupported.

Core:
${EXECUTE_SQL_CORE_SCHEMA}

File paths never end in \`/\`; directory paths always do. \`directory_id\` references \`lix_directory.id\`. Top-level directories have \`parent_id IS NULL\`; other \`parent_id\` values reference \`id\`. For descendants: \`lix_directory d LEFT JOIN lix_file f ON starts_with(f.path,d.path)\`.

Files, directories, and entity tables have \`_by_branch\` (\`lixcol_branch_id\`) and read-only \`_history\` companions; branch/change do not.

Discover workspace-specific application schemas only when needed:
\`\`\`sql
${EXECUTE_SQL_TABLES_QUERY}
\`\`\`

Cast \`data AS TEXT\` only for known UTF-8 files. To return matching lines, put \`UNNEST(string_to_array(CAST(data AS TEXT), chr(10))) AS line\` in a derived \`SELECT\`, then filter \`line\` outside it.

Typed \`_history\` queries require \`lixcol_start_commit_id=lix_active_branch_commit_id()\`. For complete entity history also filter its user primary-key column(s) (\`id\` for files/directories), or tombstones and renames may be omitted. Resolve IDs/keys from active rows; for a deleted or old path, use a bounded path lookup in the same history, then query by ID. Metadata: \`lixcol_depth\` (graph distance; low is close; gaps are normal), \`lixcol_observed_commit_id\`, and \`lixcol_commit_created_at\` (chronology); no \`lixcol_commit_id\`.
`;
