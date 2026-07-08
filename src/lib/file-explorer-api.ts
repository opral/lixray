import { useMemo } from "react";
import { zipSync } from "fflate";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { type WireValue, useLixrayApi } from "./lixray-api";

export interface DirEntry {
	kind: "dir";
	id: string;
	path: string;
	name: string;
	updatedAt: string;
}

export interface FileEntry {
	kind: "file";
	id: string;
	path: string;
	name: string;
	size: number | null;
	updatedAt: string;
}

export type ExplorerEntry = DirEntry | FileEntry;

export interface UploadItem {
	relativePath: string;
	bytes: Uint8Array;
}

export class DirectoryNotFoundError extends Error {
	constructor(path: string) {
		super(`Directory not found: ${path}`);
		this.name = "DirectoryNotFoundError";
	}
}

/** Normalizes to a leading- and trailing-slash directory path; "" → "/". */
export function normalizeDirPath(raw: unknown): string {
	if (typeof raw !== "string" || !raw) {
		return "/";
	}
	const segments = raw.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return "/";
	}
	return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

export function parentDirPath(dirPath: string): string {
	return normalizeDirPath(
		dirPath.split("/").filter(Boolean).slice(0, -1).join("/"),
	);
}

const UPLOAD_BATCH_MAX_FILES = 10;
const UPLOAD_BATCH_MAX_BASE64_CHARS = 2 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;

export function useFileExplorerApi() {
	const api = useLixrayApi();

	return useMemo(() => {
		async function resolveDirectoryId(
			branchId: string,
			dirPath: string,
		): Promise<string | null> {
			if (dirPath === "/") {
				return null;
			}
			const result = await api.execute({
				branchId,
				sql: "SELECT id FROM lix_directory WHERE path = $1",
				params: [text(dirPath)],
			});
			const id = result.rows[0]?.[0];
			if (!id || id.kind !== "text") {
				throw new DirectoryNotFoundError(dirPath);
			}
			return id.value;
		}

		async function listDirectory(
			branchId: string,
			dirPath: string,
		): Promise<Array<ExplorerEntry>> {
			const directoryId = await resolveDirectoryId(branchId, dirPath);
			const [dirs, files] = await Promise.all([
				api.execute({
					branchId,
					sql:
						directoryId === null
							? "SELECT id, path, name, lixcol_updated_at FROM lix_directory WHERE parent_id IS NULL ORDER BY name"
							: "SELECT id, path, name, lixcol_updated_at FROM lix_directory WHERE parent_id = $1 ORDER BY name",
					params: directoryId === null ? [] : [text(directoryId)],
				}),
				api.execute({
					branchId,
					sql:
						directoryId === null
							? "SELECT id, path, name, lixcol_metadata, lixcol_updated_at FROM lix_file WHERE directory_id IS NULL ORDER BY name"
							: "SELECT id, path, name, lixcol_metadata, lixcol_updated_at FROM lix_file WHERE directory_id = $1 ORDER BY name",
					params: directoryId === null ? [] : [text(directoryId)],
				}),
			]);

			return [
				...dirs.rows.map((row): DirEntry => ({
					kind: "dir",
					id: asText(row[0]),
					path: asText(row[1]),
					name: asText(row[2]),
					updatedAt: asText(row[3]),
				})),
				...files.rows.map((row): FileEntry => ({
					kind: "file",
					id: asText(row[0]),
					path: asText(row[1]),
					name: asText(row[2]),
					size: sizeFromMetadata(row[3]),
					updatedAt: asText(row[4]),
				})),
			];
		}

		async function createDirectory(
			branchId: string,
			dirPath: string,
			name: string,
		): Promise<void> {
			await api.execute({
				branchId,
				sql: "INSERT INTO lix_directory (path) VALUES ($1)",
				params: [text(`${dirPath}${name}/`)],
			});
		}

		/** Creates directories if missing (used for empty dirs in folder uploads). */
		async function ensureDirectories(
			branchId: string,
			dirPaths: Array<string>,
		): Promise<void> {
			for (const dirPath of dirPaths) {
				await api.execute({
					branchId,
					sql: "INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING",
					params: [text(dirPath)],
				});
			}
		}

		/**
		 * Uploads into dirPath, overwriting files that already exist at the same
		 * path. Batches small files into multi-row inserts; throws UploadError with
		 * the number of files already written if a batch fails part-way.
		 */
		async function uploadFiles(
			branchId: string,
			dirPath: string,
			items: Array<UploadItem>,
		): Promise<void> {
			const batches: Array<
				Array<{ path: string; base64: string; size: number }>
			> = [];
			let current: Array<{ path: string; base64: string; size: number }> = [];
			let currentChars = 0;
			for (const item of items) {
				const base64 = bytesToBase64(item.bytes);
				if (
					current.length > 0 &&
					(current.length >= UPLOAD_BATCH_MAX_FILES ||
						currentChars + base64.length > UPLOAD_BATCH_MAX_BASE64_CHARS)
				) {
					batches.push(current);
					current = [];
					currentChars = 0;
				}
				current.push({
					path: `${dirPath}${item.relativePath}`,
					base64,
					size: item.bytes.length,
				});
				currentChars += base64.length;
			}
			if (current.length > 0) {
				batches.push(current);
			}

			let uploaded = 0;
			for (const batch of batches) {
				const placeholders = batch
					.map(
						(_, index) =>
							`($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`,
					)
					.join(", ");
				const params = batch.flatMap((file): Array<WireValue> => [
					text(file.path),
					{ kind: "blob", base64: file.base64 },
					{ kind: "json", value: { size: file.size } },
				]);
				try {
					await api.execute({
						branchId,
						sql:
							`INSERT INTO lix_file (path, data, lixcol_metadata) VALUES ${placeholders} ` +
							"ON CONFLICT (path) DO UPDATE SET data = excluded.data, lixcol_metadata = excluded.lixcol_metadata",
						params,
					});
				} catch (caught) {
					throw new UploadError(uploaded, items.length, caught);
				}
				uploaded += batch.length;
			}
		}

		async function fetchFileBytes(
			branchId: string,
			fileId: string,
		): Promise<Uint8Array<ArrayBuffer>> {
			const result = await api.execute({
				branchId,
				sql: "SELECT data FROM lix_file WHERE id = $1",
				params: [text(fileId)],
			});
			const value = result.rows[0]?.[0];
			if (!value || value.kind !== "blob") {
				throw new Error("File data not found.");
			}
			return base64ToBytes(value.base64);
		}

		async function listSubtreeFiles(
			branchId: string,
			dirPath: string,
		): Promise<Array<{ id: string; path: string }>> {
			const result = await api.execute({
				branchId,
				// Lexicographic prefix range: dir paths end in "/" (0x2F), so the
				// exclusive upper bound replaces it with "0" (0x30).
				sql: "SELECT id, path FROM lix_file WHERE path >= $1 AND path < $2 ORDER BY path",
				params: [text(dirPath), text(`${dirPath.slice(0, -1)}0`)],
			});
			return result.rows.map((row) => ({
				id: asText(row[0]),
				path: asText(row[1]),
			}));
		}

		async function listSubtreeDirs(
			branchId: string,
			dirPath: string,
		): Promise<Array<string>> {
			const result = await api.execute({
				branchId,
				sql: "SELECT path FROM lix_directory WHERE path >= $1 AND path < $2 ORDER BY path",
				params: [text(dirPath), text(`${dirPath.slice(0, -1)}0`)],
			});
			return result.rows.map((row) => asText(row[0]));
		}

		/**
		 * Builds a zip of the given entries. Selected files land at the zip root;
		 * selected directories are included recursively as top-level folders.
		 */
		async function buildZip(
			branchId: string,
			entries: Array<ExplorerEntry>,
		): Promise<Uint8Array<ArrayBuffer>> {
			const zipEntries: Record<string, Uint8Array> = {};
			const filesToFetch: Array<{ id: string; zipPath: string }> = [];

			for (const entry of entries) {
				if (entry.kind === "file") {
					filesToFetch.push({ id: entry.id, zipPath: entry.name });
				} else {
					const basePrefix = parentDirPath(entry.path);
					for (const subDirPath of await listSubtreeDirs(
						branchId,
						entry.path,
					)) {
						zipEntries[subDirPath.slice(basePrefix.length)] = new Uint8Array(0);
					}
					for (const file of await listSubtreeFiles(branchId, entry.path)) {
						filesToFetch.push({
							id: file.id,
							zipPath: file.path.slice(basePrefix.length),
						});
					}
				}
			}

			await mapLimit(filesToFetch, DOWNLOAD_CONCURRENCY, async (file) => {
				zipEntries[file.zipPath] = await fetchFileBytes(branchId, file.id);
			});

			return zipSync(zipEntries);
		}

		async function renameEntry(
			branchId: string,
			entry: ExplorerEntry,
			newName: string,
		): Promise<void> {
			await api.execute({
				branchId,
				sql:
					entry.kind === "dir"
						? "UPDATE lix_directory SET name = $1 WHERE id = $2"
						: "UPDATE lix_file SET name = $1 WHERE id = $2",
				params: [text(newName), text(entry.id)],
			});
		}

		/** Directory deletes are recursive (the engine removes the whole subtree). */
		async function deleteEntries(
			branchId: string,
			entries: Array<ExplorerEntry>,
		): Promise<void> {
			for (const table of ["lix_file", "lix_directory"] as const) {
				const kind = table === "lix_file" ? "file" : "dir";
				const ids = entries
					.filter((entry) => entry.kind === kind)
					.map((entry) => entry.id);
				if (ids.length === 0) {
					continue;
				}
				const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
				await api.execute({
					branchId,
					sql: `DELETE FROM ${table} WHERE id IN (${placeholders})`,
					params: ids.map(text),
				});
			}
		}

		return {
			listBranches: api.listBranches,
			listDirectory,
			createDirectory,
			ensureDirectories,
			uploadFiles,
			fetchFileBytes,
			buildZip,
			renameEntry,
			deleteEntries,
		};
	}, [api]);
}

export class UploadError extends Error {
	readonly uploaded: number;
	readonly total: number;

	constructor(uploaded: number, total: number, cause: unknown) {
		super(
			cause instanceof Error ? cause.message : "Upload failed.",
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "UploadError";
		this.uploaded = uploaded;
		this.total = total;
	}
}

function text(value: string): WireValue {
	return { kind: "text", value };
}

function asText(value: WireValue | undefined): string {
	if (!value || value.kind !== "text") {
		throw new Error("Expected a text value in the query result.");
	}
	return value.value;
}

function sizeFromMetadata(value: WireValue | undefined): number | null {
	if (!value || value.kind !== "json") {
		return null;
	}
	const metadata = value.value;
	if (
		metadata &&
		typeof metadata === "object" &&
		"size" in metadata &&
		typeof metadata.size === "number"
	) {
		return metadata.size;
	}
	return null;
}

async function mapLimit<T>(
	items: Array<T>,
	limit: number,
	task: (item: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex += 1;
				await task(items[index]);
			}
		},
	);
	await Promise.all(workers);
}
