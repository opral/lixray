import { useMemo } from "react";
import { zipSync } from "fflate";
import { LixFileService, type LixRuntimeClient } from "../mcp/file-service";
import { base64ToBytes, bytesToBase64 } from "./base64";
import {
	fetchZipEntriesInBatches,
	type ZipFileFetch,
} from "./file-download-batches";
import {
	parseSubtreeListBatchResults,
	subtreeListStatements,
	type SubtreeEntries,
} from "./file-explorer-subtree";
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
	changeId: string;
	updatedAt: string;
}

export interface FileEntry {
	kind: "file";
	id: string;
	path: string;
	name: string;
	changeId: string;
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
const SUBTREE_LIST_BATCH_MAX_DIRECTORIES = 20;

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
			activeBranchId: () => api.activeBranchId(),
			switchBranch: async (_workspaceId, branchId) =>
				api.switchBranch(branchId),
			execute: async (_workspaceId, request) => {
				const [result] = (await api.executeActive(request)).results;
				if (!result) throw new Error("Lix did not return a SQL result");
				return result;
			},
			executeBatch: async (_workspaceId, request) =>
				api.executeBatchActive(request),
		} satisfies LixRuntimeClient);

		async function listDirectory(
			branchId: string,
			dirPath: string,
		): Promise<Array<ExplorerEntry>> {
			await api.switchBranch(branchId);
			const entries = await service.listDirectory(workspaceId, dirPath);
			return entries.map(
				(entry): ExplorerEntry =>
					entry.kind === "directory"
						? {
								kind: "dir",
								id: entry.path,
								path: entry.path,
								name: entry.name,
								changeId: entry.changeId,
								updatedAt: entry.updatedAt,
							}
						: {
								kind: "file",
								id: entry.path,
								path: entry.path,
								name: entry.name,
								changeId: entry.changeId,
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
			await api.switchBranch(branchId);
			await service.createDirectory(workspaceId, `${dirPath}${name}/`);
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

		async function fetchFileBytesByPathBatch(
			branchId: string,
			paths: Array<string>,
		): Promise<Map<string, Uint8Array>> {
			if (paths.length === 0) return new Map();
			const placeholders = paths.map((_, index) => `$${index + 1}`).join(", ");
			const result = await executeStatement({
				branchId,
				sql: `SELECT path, data FROM lix_file WHERE path IN (${placeholders})`,
				params: paths.map(text),
			});
			const bytesByPath = new Map<string, Uint8Array>();
			for (const row of result.rows) {
				const path = asText(row[0]);
				const value = row[1];
				if (!value || value.kind !== "blob") {
					throw new Error("File data not found.");
				}
				bytesByPath.set(path, base64ToBytes(value.base64));
			}
			return bytesByPath;
		}

		async function listSubtreeEntries(
			branchId: string,
			dirPaths: Array<string>,
		): Promise<Array<SubtreeEntries>> {
			const subtrees: Array<SubtreeEntries> = [];
			for (
				let offset = 0;
				offset < dirPaths.length;
				offset += SUBTREE_LIST_BATCH_MAX_DIRECTORIES
			) {
				const paths = dirPaths.slice(
					offset,
					offset + SUBTREE_LIST_BATCH_MAX_DIRECTORIES,
				);
				const response = await api.executeBatch({
					branchId,
					statements: paths.flatMap(subtreeListStatements),
				});
				subtrees.push(
					...parseSubtreeListBatchResults(response.results, paths.length),
				);
			}
			return subtrees;
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
			const filesToFetch: Array<ZipFileFetch> = [];
			const directoryPaths = entries.flatMap((entry) =>
				entry.kind === "dir" ? [entry.path] : [],
			);
			const subtrees = await listSubtreeEntries(branchId, directoryPaths);
			let subtreeIndex = 0;

			for (const entry of entries) {
				if (entry.kind === "file") {
					filesToFetch.push({ path: entry.path, zipPath: entry.name });
				} else {
					const basePrefix = parentDirPath(entry.path);
					const subtree = subtrees[subtreeIndex];
					subtreeIndex += 1;
					if (!subtree) throw new Error("Subtree listing result is missing.");
					for (const subDirPath of subtree.directoryPaths) {
						zipEntries[subDirPath.slice(basePrefix.length)] = new Uint8Array(0);
					}
					for (const file of subtree.files) {
						filesToFetch.push({
							path: file.path,
							zipPath: file.path.slice(basePrefix.length),
						});
					}
				}
			}

			Object.assign(
				zipEntries,
				await fetchZipEntriesInBatches(filesToFetch, (paths) =>
					fetchFileBytesByPathBatch(branchId, paths),
				),
			);

			return zipSync(zipEntries);
		}

		async function renameEntry(
			branchId: string,
			entry: ExplorerEntry,
			newName: string,
		): Promise<void> {
			const destination = `${entryParentPath(entry.path)}${newName}${entry.kind === "dir" ? "/" : ""}`;
			await api.switchBranch(branchId);
			await service.moveEntry(
				workspaceId,
				entry.path,
				destination,
				entry.changeId,
			);
		}

		/** Directory deletes are recursive (the engine removes the whole subtree). */
		async function deleteEntries(
			branchId: string,
			entries: Array<ExplorerEntry>,
		): Promise<void> {
			await api.switchBranch(branchId);
			for (const entry of entries) {
				await service.deleteEntry(
					workspaceId,
					entry.path,
					entry.changeId,
					entry.kind === "dir",
				);
			}
		}

		return {
			listBranches: () => api.listBranches(),
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
