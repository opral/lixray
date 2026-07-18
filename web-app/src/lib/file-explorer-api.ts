import { useMemo } from "react";
import { zipSync } from "fflate";
import { LixFileService, type LixRuntimeClient } from "../mcp/file-service";
import { base64ToBytes, bytesToBase64 } from "./base64";
import {
	type ExecuteRequest,
	type ExecuteResponse,
	type WireValue,
	useLixrayApi,
} from "./lixray-api";

export interface DirEntry {
	kind: "dir";
	id: string;
	path: string;
	name: string;
	revision: string;
	updatedAt: string;
}

export interface FileEntry {
	kind: "file";
	id: string;
	path: string;
	name: string;
	revision: string;
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
		const workspaceId = api.workspaceId ?? "";
		const executeStatement = async (
			request: ExecuteRequest,
		): Promise<ExecuteResponse> => {
			const response = await api.execute(request);
			const [result] = response.results;
			if (!result || response.results.length !== 1) {
				throw new Error("A single SQL statement did not return one result");
			}
			return result;
		};
		const service = new LixFileService({
			listWorkspaces: () => Promise.resolve([]),
			listBranches: () => api.listBranches(),
			execute: async (_workspaceId, request) => executeStatement(request),
			executeBatch: () =>
				Promise.reject(
					new Error("Batch execution is not used by the file explorer client"),
				),
			mutate: async (_workspaceId, request) => api.mutateFilesystem(request),
		} satisfies LixRuntimeClient);

		async function listDirectory(
			branchId: string,
			dirPath: string,
		): Promise<Array<ExplorerEntry>> {
			const entries = await service.listDirectory(
				workspaceId,
				branchId,
				dirPath,
			);
			return entries.map(
				(entry): ExplorerEntry =>
					entry.kind === "directory"
						? {
								kind: "dir",
								id: entry.path,
								path: entry.path,
								name: entry.name,
								revision: entry.revision,
								updatedAt: entry.updatedAt,
							}
						: {
								kind: "file",
								id: entry.path,
								path: entry.path,
								name: entry.name,
								revision: entry.revision,
								size: entry.size ?? null,
								updatedAt: entry.updatedAt,
							},
			);
		}

		async function createDirectory(
			branchId: string,
			dirPath: string,
			name: string,
		): Promise<void> {
			await service.createDirectory(
				workspaceId,
				branchId,
				`${dirPath}${name}/`,
			);
		}

		/** Creates directories if missing (used for empty dirs in folder uploads). */
		async function ensureDirectories(
			branchId: string,
			dirPaths: Array<string>,
		): Promise<void> {
			for (const dirPath of dirPaths) {
				await executeStatement({
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
				const params = batch.flatMap(
					(file): Array<WireValue> => [
						text(file.path),
						{ kind: "blob", base64: file.base64 },
						{ kind: "json", value: { size: file.size } },
					],
				);
				try {
					await executeStatement({
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
			filePath: string,
		): Promise<Uint8Array<ArrayBuffer>> {
			const result = await executeStatement({
				branchId,
				sql: "SELECT data FROM lix_file WHERE path = $1",
				params: [text(filePath)],
			});
			const value = result.rows[0]?.[0];
			if (!value || value.kind !== "blob") {
				throw new Error("File data not found.");
			}
			return base64ToBytes(value.base64);
		}

		async function fetchFileBytesById(
			branchId: string,
			fileId: string,
		): Promise<Uint8Array<ArrayBuffer>> {
			const result = await executeStatement({
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
			const result = await executeStatement({
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
			const result = await executeStatement({
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
				zipEntries[file.zipPath] = await fetchFileBytesById(branchId, file.id);
			});

			return zipSync(zipEntries);
		}

		async function renameEntry(
			branchId: string,
			entry: ExplorerEntry,
			newName: string,
		): Promise<void> {
			const destination = `${entryParentPath(entry.path)}${newName}${entry.kind === "dir" ? "/" : ""}`;
			await service.moveEntry(
				workspaceId,
				branchId,
				entry.path,
				destination,
				entry.revision,
			);
		}

		/** Directory deletes are recursive (the engine removes the whole subtree). */
		async function deleteEntries(
			branchId: string,
			entries: Array<ExplorerEntry>,
		): Promise<void> {
			for (const entry of entries) {
				await service.deleteEntry(
					workspaceId,
					branchId,
					entry.path,
					entry.revision,
					entry.kind === "dir",
				);
			}
		}

		return {
			listBranches: () => service.listBranches(workspaceId),
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

function entryParentPath(path: string): string {
	const withoutDirectorySuffix = path.endsWith("/") ? path.slice(0, -1) : path;
	return withoutDirectorySuffix.slice(
		0,
		withoutDirectorySuffix.lastIndexOf("/") + 1,
	);
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
