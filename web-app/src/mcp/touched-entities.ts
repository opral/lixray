/**
 * What an execute_sql batch touched, read from Lix's own change log rather
 * than from the SQL text. Every execute stamps its changes with an
 * `origin_key`; the server gives each MCP call a unique one and then asks
 * `lix_change` what carries it. Renames, writes by id, cascades, and
 * plugin entities all show up the same way, because Lix recorded them.
 */

import type { WireValue } from "./lix-service.ts";

export type TouchedAction = "wrote" | "updated" | "deleted";

export type TouchedEntity = {
	readonly kind: "file" | "directory";
	/** Absolute path; for a deleted entity only the name may be known. */
	readonly path: string;
	readonly action: TouchedAction;
};

/** The origin key a call stamps on its changes; a supplied key is its prefix. */
export function mcpOriginKey(requestId: string, supplied?: string): string {
	const own = `mcp:${requestId}`;
	return supplied ? `${supplied}:${own}` : own;
}

export const TOUCHED_CHANGES_SQL =
	"SELECT c.schema_key, c.file_id, c.row_pk, CAST(c.snapshot_content AS TEXT) AS snapshot, f.path AS file_path FROM lix_change c LEFT JOIN lix_file f ON f.id = c.file_id WHERE c.origin_key = $1";

export const DELETED_FILE_NAMES_SQL =
	"SELECT file_id, CAST(snapshot_content AS TEXT) AS snapshot FROM lix_change WHERE schema_key = 'lix_file_descriptor' AND snapshot_content IS NOT NULL AND file_id IN (SELECT file_id FROM lix_change WHERE origin_key = $1 AND schema_key = 'lix_file_descriptor' AND snapshot_content IS NULL) ORDER BY created_at DESC";

export function directoryPathsSql(count: number): string {
	const placeholders = Array.from({ length: count }, (_, i) => `$${i + 1}`);
	return `SELECT id, path FROM lix_directory WHERE id IN (${placeholders.join(", ")})`;
}

type ResultLike = {
	readonly columns: ReadonlyArray<string>;
	readonly rows: ReadonlyArray<ReadonlyArray<WireValue>>;
};

function cell(
	result: ResultLike,
	row: ReadonlyArray<WireValue>,
	column: string,
) {
	const index = result.columns.indexOf(column);
	return index === -1 ? undefined : row[index];
}

function textOf(value: WireValue | undefined): string | null {
	if (!value) return null;
	if (value.kind === "text" || value.kind === "timestamp") return value.value;
	if (value.kind === "json")
		return typeof value.value === "string"
			? value.value
			: JSON.stringify(value.value);
	return null;
}

function firstIdOf(value: WireValue | undefined): string | null {
	if (!value) return null;
	const raw = value.kind === "json" ? value.value : textOf(value);
	const parsed =
		typeof raw === "string" && raw.startsWith("[")
			? (JSON.parse(raw) as unknown)
			: raw;
	if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
	return typeof parsed === "string" ? parsed : null;
}

function snapshotOf(
	value: WireValue | undefined,
): Record<string, unknown> | null {
	if (!value || value.kind === "null") return null;
	const raw = value.kind === "json" ? value.value : textOf(value);
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export type TouchedChanges = {
	/** Files still present, keyed by id, with their current path. */
	readonly files: ReadonlyArray<TouchedEntity>;
	/** Ids of files the batch deleted; their names need a second read. */
	readonly deletedFileIds: ReadonlyArray<string>;
	/** Ids of directories the batch created or renamed; paths need a read. */
	readonly directoryIds: ReadonlyArray<string>;
	readonly deletedDirectoryCount: number;
};

/**
 * Folds the change rows of one origin key. A file with a descriptor change
 * was written (created or renamed); one with only content or plugin-entity
 * changes was updated; a null descriptor snapshot means deleted.
 */
export function touchedFromChanges(result: ResultLike): TouchedChanges {
	const files = new Map<
		string,
		{ path: string | null; descriptor: boolean; deleted: boolean }
	>();
	const directoryIds = new Set<string>();
	let deletedDirectoryCount = 0;
	for (const row of result.rows) {
		const schemaKey = textOf(cell(result, row, "schema_key"));
		const snapshot = snapshotOf(cell(result, row, "snapshot"));
		if (schemaKey === "lix_directory_descriptor") {
			const id = firstIdOf(cell(result, row, "row_pk"));
			if (snapshot === null) deletedDirectoryCount += 1;
			else if (id) directoryIds.add(id);
			continue;
		}
		const fileId = textOf(cell(result, row, "file_id"));
		if (!fileId) continue;
		const entry = files.get(fileId) ?? {
			path: null,
			descriptor: false,
			deleted: false,
		};
		entry.path ??= textOf(cell(result, row, "file_path"));
		if (schemaKey === "lix_file_descriptor") {
			if (snapshot === null) entry.deleted = true;
			else entry.descriptor = true;
		}
		files.set(fileId, entry);
	}
	const present: TouchedEntity[] = [];
	const deletedFileIds: string[] = [];
	for (const [id, entry] of files) {
		if (entry.deleted || entry.path === null) {
			deletedFileIds.push(id);
			continue;
		}
		present.push({
			kind: "file",
			path: entry.path,
			action: entry.descriptor ? "wrote" : "updated",
		});
	}
	return {
		files: present,
		deletedFileIds,
		directoryIds: [...directoryIds],
		deletedDirectoryCount,
	};
}

/** Names for deleted files from their last descriptor snapshot. */
export function deletedFileNames(result: ResultLike): Map<string, string> {
	const names = new Map<string, string>();
	for (const row of result.rows) {
		const id = textOf(cell(result, row, "file_id"));
		const name = snapshotOf(cell(result, row, "snapshot"))?.name;
		if (id && typeof name === "string" && !names.has(id)) names.set(id, name);
	}
	return names;
}

export function directoryPaths(result: ResultLike): Map<string, string> {
	const paths = new Map<string, string>();
	for (const row of result.rows) {
		const id = textOf(cell(result, row, "id"));
		const path = textOf(cell(result, row, "path"));
		if (id && path) paths.set(id, path);
	}
	return paths;
}

const MIME_TYPES: Record<string, string> = {
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	txt: "text/plain",
	html: "text/html",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	pdf: "application/pdf",
};

export function mimeTypeForPath(path: string): string | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension && extension !== path ? MIME_TYPES[extension] : undefined;
}

/** "Wrote sales/lead-research.md · Updated leads.csv · 7 rows affected" */
export function describeTouched(
	touched: ReadonlyArray<TouchedEntity>,
	rowsAffected: number,
	deletedDirectoryCount = 0,
): string {
	const byAction = new Map<TouchedAction, string[]>();
	for (const entity of touched) {
		const list = byAction.get(entity.action) ?? [];
		list.push(entity.path.replace(/^\//, ""));
		byAction.set(entity.action, list);
	}
	const parts: string[] = [];
	for (const [action, label] of [
		["wrote", "Wrote"],
		["updated", "Updated"],
		["deleted", "Deleted"],
	] as const) {
		const paths = byAction.get(action);
		if (paths?.length) parts.push(`${label} ${paths.join(", ")}`);
	}
	if (deletedDirectoryCount > 0)
		parts.push(
			`Deleted ${deletedDirectoryCount} ${deletedDirectoryCount === 1 ? "folder" : "folders"}`,
		);
	parts.push(`${rowsAffected} ${rowsAffected === 1 ? "row" : "rows"} affected`);
	return parts.join(" · ");
}
