export type ExecuteSqlType = "TEXT" | "JSON" | "BOOLEAN" | "BIGINT" | "BLOB";

export interface ExecuteSqlColumn {
	name: string;
	type: ExecuteSqlType;
	nullable: boolean;
}

export interface ExecuteSqlSurface {
	name: string;
	objectKind: "BASE TABLE" | "VIEW";
	columns: ReadonlyArray<ExecuteSqlColumn>;
}

const column = (
	name: string,
	type: ExecuteSqlType,
	nullable = true,
): ExecuteSqlColumn => ({ name, type, nullable });

const surface = (
	name: string,
	objectKind: ExecuteSqlSurface["objectKind"],
	columns: ReadonlyArray<ExecuteSqlColumn>,
): ExecuteSqlSurface => ({ name, objectKind, columns });

const entityActiveSystemColumns = [
	column("lixcol_entity_pk", "JSON"),
	column("lixcol_schema_key", "TEXT", false),
	column("lixcol_file_id", "TEXT"),
	column("lixcol_snapshot_content", "JSON"),
	column("lixcol_metadata", "JSON"),
	column("lixcol_created_at", "TEXT"),
	column("lixcol_updated_at", "TEXT"),
	column("lixcol_global", "BOOLEAN"),
	column("lixcol_change_id", "TEXT"),
	column("lixcol_commit_id", "TEXT"),
	column("lixcol_untracked", "BOOLEAN"),
] as const;

const entityHistorySystemColumns = [
	column("lixcol_entity_pk", "JSON", false),
	column("lixcol_schema_key", "TEXT", false),
	column("lixcol_file_id", "TEXT"),
	column("lixcol_snapshot_content", "JSON"),
	column("lixcol_metadata", "JSON"),
	column("lixcol_change_id", "TEXT", false),
	column("lixcol_origin_key", "TEXT"),
	column("lixcol_observed_commit_id", "TEXT", false),
	column("lixcol_commit_created_at", "TEXT", false),
	column("lixcol_start_commit_id", "TEXT", false),
	column("lixcol_depth", "BIGINT", false),
] as const;

const filesystemSystemColumns = [
	column("lixcol_entity_pk", "JSON", false),
	column("lixcol_schema_key", "TEXT", false),
	column("lixcol_file_id", "TEXT"),
	column("lixcol_global", "BOOLEAN"),
	column("lixcol_change_id", "TEXT"),
	column("lixcol_created_at", "TEXT"),
	column("lixcol_updated_at", "TEXT"),
	column("lixcol_commit_id", "TEXT"),
	column("lixcol_untracked", "BOOLEAN"),
	column("lixcol_metadata", "JSON"),
] as const;

const filesystemHistorySystemColumns = [
	column("lixcol_entity_pk", "JSON", false),
	column("lixcol_schema_key", "TEXT", false),
	column("lixcol_file_id", "TEXT"),
	column("lixcol_snapshot_content", "JSON"),
	column("lixcol_change_id", "TEXT", false),
	column("lixcol_origin_key", "TEXT"),
	column("lixcol_metadata", "JSON"),
	column("lixcol_observed_commit_id", "TEXT", false),
	column("lixcol_commit_created_at", "TEXT", false),
	column("lixcol_start_commit_id", "TEXT", false),
	column("lixcol_depth", "BIGINT", false),
] as const;

const stateColumns = [
	column("entity_pk", "JSON", false),
	column("schema_key", "TEXT", false),
	column("file_id", "TEXT"),
	column("snapshot_content", "JSON"),
	column("metadata", "JSON"),
	column("created_at", "TEXT"),
	column("updated_at", "TEXT"),
	column("global", "BOOLEAN"),
	column("change_id", "TEXT"),
	column("commit_id", "TEXT"),
	column("untracked", "BOOLEAN"),
] as const;

const stateHistoryColumns = [
	column("entity_pk", "JSON", false),
	column("schema_key", "TEXT", false),
	column("file_id", "TEXT"),
	column("snapshot_content", "JSON"),
	column("metadata", "JSON"),
	column("change_id", "TEXT", false),
	column("origin_key", "TEXT"),
	column("observed_commit_id", "TEXT", false),
	column("commit_created_at", "TEXT", false),
	column("start_commit_id", "TEXT", false),
	column("depth", "BIGINT", false),
] as const;

const fileColumns = [
	column("id", "TEXT"),
	column("path", "TEXT", false),
	column("directory_id", "TEXT"),
	column("name", "TEXT", false),
	column("data", "BLOB", false),
	...filesystemSystemColumns,
] as const;

const fileHistoryColumns = [
	column("id", "TEXT", false),
	column("path", "TEXT"),
	column("directory_id", "TEXT"),
	column("name", "TEXT"),
	column("data", "BLOB"),
	...filesystemHistorySystemColumns,
] as const;

const directoryColumns = [
	column("id", "TEXT"),
	column("path", "TEXT"),
	column("parent_id", "TEXT"),
	column("name", "TEXT", false),
	...filesystemSystemColumns,
] as const;

const directoryHistoryColumns = [
	column("id", "TEXT", false),
	column("path", "TEXT"),
	column("parent_id", "TEXT"),
	column("name", "TEXT"),
	...filesystemHistorySystemColumns,
] as const;

const systemSurfaces: ReadonlyArray<ExecuteSqlSurface> = [
	surface("lix_state", "BASE TABLE", stateColumns),
	surface("lix_state_by_branch", "BASE TABLE", [
		...stateColumns,
		column("branch_id", "TEXT", false),
	]),
	surface("lix_state_history", "VIEW", stateHistoryColumns),
	surface("lix_file", "BASE TABLE", fileColumns),
	surface("lix_file_by_branch", "BASE TABLE", [
		...fileColumns,
		column("lixcol_branch_id", "TEXT", false),
	]),
	surface("lix_file_history", "VIEW", fileHistoryColumns),
	surface("lix_directory", "BASE TABLE", directoryColumns),
	surface("lix_directory_by_branch", "BASE TABLE", [
		...directoryColumns,
		column("lixcol_branch_id", "TEXT", false),
	]),
	surface("lix_directory_history", "VIEW", directoryHistoryColumns),
	surface("lix_branch", "BASE TABLE", [
		column("id", "TEXT", false),
		column("name", "TEXT", false),
		column("hidden", "BOOLEAN", false),
		column("commit_id", "TEXT", false),
	]),
	surface("lix_change", "BASE TABLE", [
		column("id", "TEXT", false),
		column("entity_pk", "JSON", false),
		column("schema_key", "TEXT", false),
		column("file_id", "TEXT"),
		column("metadata", "JSON"),
		column("created_at", "TEXT", false),
		column("origin_key", "TEXT"),
		column("snapshot_content", "JSON"),
	]),
];

interface EntitySurfaceSpec {
	name: string;
	columns: ReadonlyArray<ExecuteSqlColumn>;
	hasHistory: boolean;
}

const entitySurfaceSpecs: ReadonlyArray<EntitySurfaceSpec> = [
	{
		name: "lix_account",
		columns: [column("id", "TEXT"), column("name", "TEXT")],
		hasHistory: true,
	},
	{
		name: "lix_binary_blob_ref",
		columns: [
			column("blob_hash", "TEXT"),
			column("id", "TEXT"),
			column("size_bytes", "BIGINT"),
		],
		hasHistory: true,
	},
	{
		name: "lix_branch_descriptor",
		columns: [
			column("hidden", "BOOLEAN"),
			column("id", "TEXT"),
			column("name", "TEXT"),
		],
		hasHistory: true,
	},
	{
		name: "lix_branch_ref",
		columns: [column("commit_id", "TEXT"), column("id", "TEXT")],
		hasHistory: true,
	},
	{
		name: "lix_change_author",
		columns: [column("account_id", "TEXT"), column("change_id", "TEXT")],
		hasHistory: true,
	},
	{
		name: "lix_commit",
		columns: [column("id", "TEXT")],
		hasHistory: false,
	},
	{
		name: "lix_commit_edge",
		columns: [
			column("child_id", "TEXT"),
			column("parent_id", "TEXT"),
			column("parent_order", "BIGINT"),
		],
		hasHistory: false,
	},
	{
		name: "lix_directory_descriptor",
		columns: [
			column("id", "TEXT"),
			column("name", "TEXT"),
			column("parent_id", "TEXT"),
		],
		hasHistory: true,
	},
	{
		name: "lix_file_descriptor",
		columns: [
			column("directory_id", "TEXT"),
			column("id", "TEXT"),
			column("name", "TEXT"),
		],
		hasHistory: true,
	},
	{
		name: "lix_key_value",
		columns: [column("key", "TEXT"), column("value", "JSON")],
		hasHistory: true,
	},
	{
		name: "lix_label",
		columns: [column("id", "TEXT"), column("name", "TEXT")],
		hasHistory: true,
	},
	{
		name: "lix_label_assignment",
		columns: [
			column("id", "TEXT"),
			column("label_id", "TEXT"),
			column("target_entity_pk", "JSON"),
			column("target_file_id", "TEXT"),
			column("target_schema_key", "TEXT"),
		],
		hasHistory: true,
	},
	{
		name: "lix_registered_schema",
		columns: [column("value", "JSON")],
		hasHistory: true,
	},
];

function entitySurfaces(spec: EntitySurfaceSpec): Array<ExecuteSqlSurface> {
	const activeColumns = [...spec.columns, ...entityActiveSystemColumns];
	const surfaces = [
		surface(spec.name, "BASE TABLE", activeColumns),
		surface(`${spec.name}_by_branch`, "BASE TABLE", [
			...activeColumns,
			column("lixcol_branch_id", "TEXT", false),
		]),
	];
	if (spec.hasHistory) {
		surfaces.push(
			surface(`${spec.name}_history`, "VIEW", [
				...spec.columns,
				...entityHistorySystemColumns,
			]),
		);
	}
	return surfaces;
}

export const EXECUTE_SQL_SURFACES: ReadonlyArray<ExecuteSqlSurface> = [
	...systemSurfaces,
	...entitySurfaceSpecs.flatMap(entitySurfaces),
];

export function renderExecuteSqlReferenceDdl(
	surfaces: ReadonlyArray<ExecuteSqlSurface> = EXECUTE_SQL_SURFACES,
): string {
	return surfaces
		.map((sqlSurface) => {
			const objectComment =
				sqlSurface.objectKind === "VIEW"
					? "-- Actual object: read-only VIEW.\n"
					: "";
			const columns = sqlSurface.columns
				.map(
					(sqlColumn) =>
						`  ${sqlColumn.name} ${sqlColumn.type}${sqlColumn.nullable ? "" : " NOT NULL"}`,
				)
				.join(",\n");
			return `${objectComment}CREATE TABLE ${sqlSurface.name} (\n${columns}\n);`;
		})
		.join("\n\n");
}

export const EXECUTE_SQL_REFERENCE_DDL = renderExecuteSqlReferenceDdl();

export const EXECUTE_SQL_INTROSPECTION_QUERY = `SELECT
  t.table_name,
  t.table_type,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.ordinal_position
FROM information_schema.tables AS t
JOIN information_schema.columns AS c
  ON t.table_catalog = c.table_catalog
 AND t.table_schema = c.table_schema
 AND t.table_name = c.table_name
WHERE t.table_schema = 'public'
ORDER BY t.table_name, c.ordinal_position;`;

export const EXECUTE_TOOL_DESCRIPTION = `Execute an ordered batch of caller-provided Lix SQL statements atomically against an authorized workspace branch. Omit branch_id to use the workspace's active branch. Each statement has its own parameters and produces one ordered result; if any statement fails, the complete batch rolls back. SQL can read or mutate any SQL-accessible branch data and bypasses file-tool safeguards.

The following reference DDL describes every SQL surface initialized in a fresh workspace. Lix SQL does not support DDL statements; use these CREATE TABLE signatures only to understand column names, semantic SQL types, and nullability. Signatures labeled as views are read-only engine views even though CREATE TABLE syntax is used to retain their typed schema.

\`\`\`sql
${EXECUTE_SQL_REFERENCE_DDL}
\`\`\`

Workspaces can register additional schema-derived surfaces after initialization. Discover the complete runtime schema for the selected workspace and branch with:

\`\`\`sql
${EXECUTE_SQL_INTROSPECTION_QUERY}
\`\`\``;
