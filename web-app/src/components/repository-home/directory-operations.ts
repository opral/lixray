import type { Lix, LixTransaction } from "@lix-js/sdk";
import {
	deleteWorkspaceEntry as deleteAtelierEntry,
	renameWorkspaceEntry as renameAtelierEntry,
} from "@opral/atelier";
import { zipSync } from "fflate";

type Entry = { id: string; path: string; kind: "file" | "directory" };
type Executor = Pick<Lix, "execute">;

const withoutSlash = (path: string) => path.replace(/\/+$/, "") || "/";
const directoryPath = (path: string) =>
	`${withoutSlash(path).replace(/\/$/, "")}/`;
const nameOf = (path: string) => withoutSlash(path).split("/").at(-1) ?? "";
const archivePath = (entry: Entry) =>
	entry.kind === "directory" ? directoryPath(entry.path) : entry.path;
const key = (path: string) => withoutSlash(path).toLowerCase();

export function validateWorkspaceEntryName(name: string): string {
	const trimmed = name.trim();
	if (
		!trimmed ||
		trimmed === "." ||
		trimmed === ".." ||
		/[/\\]/.test(trimmed) ||
		Array.from(trimmed).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	) {
		throw new Error("Enter a name without slashes or control characters.");
	}
	return trimmed;
}

async function entries(executor: Executor): Promise<Entry[]> {
	const { rows } = await executor.execute(
		"SELECT id, path, 'directory' AS kind FROM lix_directory UNION ALL SELECT id, path, 'file' AS kind FROM lix_file",
		[],
	);
	return rows.map((row) => ({
		kind: row.kind as Entry["kind"],
		id: String(row.id),
		path: String(row.path),
	}));
}

// Atelier's public mutations currently accept Lix but use only execute().
// A transaction supplies that same SQL interface so the shared mutations stay atomic.
const atelierTransaction = (transaction: LixTransaction) =>
	transaction as unknown as Lix;
const atelierEntry = (entry: Entry) =>
	entry.kind === "file"
		? { kind: "file" as const, id: entry.id }
		: { kind: "directory" as const, path: entry.path };

async function atomic<T>(
	lix: Lix,
	work: (transaction: LixTransaction) => Promise<T>,
): Promise<T> {
	let retryDeadline: number | undefined;
	for (let attempt = 0; ; attempt += 1) {
		let transaction: LixTransaction | undefined;
		let committing = false;
		try {
			transaction = await lix.beginTransaction();
			const result = await work(transaction);
			committing = true;
			await transaction.commit();
			return result;
		} catch (error) {
			// commit() consumes the SDK handle even on failure. Before commit,
			// require successful rollback before restarting all reads and writes.
			let released = !transaction || committing;
			if (transaction && !committing) {
				try {
					await transaction.rollback();
					released = true;
				} catch {
					/* Preserve the failure; an unreleased transaction cannot retry. */
				}
			}
			if (!released || !isRetryableReadExpiration(error)) throw error;
			// Native commit reports expiration during preparation too. Failures
			// after durable mutation carry nonRetryableAfterCommit; never replay
			// those or failures after completed SQL execution.
			retryDeadline ??= Date.now() + 3_000;
			const remaining = retryDeadline - Date.now();
			if (remaining <= 0) throw error;
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.min(10 * 2 ** Math.min(attempt, 4), 100, remaining),
				),
			);
		}
	}
}

function isRetryableReadExpiration(error: unknown): boolean {
	if (
		typeof error !== "object" ||
		error === null ||
		!("code" in error) ||
		error.code !== "LIX_STORAGE_READ_EXPIRED"
	)
		return false;
	const details = "details" in error ? error.details : undefined;
	return !(
		typeof details === "object" &&
		details !== null &&
		(("nonRetryableAfterCommit" in details &&
			details.nonRetryableAfterCommit === true) ||
			("nonRetryableAfterExecution" in details &&
				details.nonRetryableAfterExecution === true))
	);
}

function requireParent(all: Entry[], path: string): void {
	if (
		path !== "/" &&
		!all.some(
			(entry) =>
				entry.kind === "directory" &&
				withoutSlash(entry.path) === withoutSlash(path),
		)
	) {
		throw new Error("The destination folder no longer exists.");
	}
}

function selectedRoots(all: Entry[], paths: readonly string[]): Entry[] {
	const selected = [...new Set(paths.map(withoutSlash))].map((path) => {
		if (path === "/") throw new Error("The workspace root cannot be changed.");
		const entry = all.find(
			(candidate) => withoutSlash(candidate.path) === path,
		);
		if (!entry) throw new Error(`“${nameOf(path)}” no longer exists.`);
		return entry;
	});
	return selected.filter(
		(entry) =>
			!selected.some(
				(parent) =>
					parent !== entry &&
					parent.kind === "directory" &&
					entry.path.startsWith(directoryPath(parent.path)),
			),
	);
}

function requireFree(all: Entry[], path: string, exceptId?: string): void {
	if (
		all.some((entry) => entry.id !== exceptId && key(entry.path) === key(path))
	) {
		throw new Error(
			`An item named “${nameOf(path)}” already exists in this folder.`,
		);
	}
}

/** Names are collected in the UI before this call; no placeholder folder is persisted. */
export async function createNamedWorkspaceFolder(
	lix: Lix,
	parent: string,
	name: string,
): Promise<string> {
	const path = `${directoryPath(parent)}${validateWorkspaceEntryName(name)}`;
	return atomic(lix, async (transaction) => {
		const all = await entries(transaction);
		requireParent(all, parent);
		requireFree(all, path);
		await transaction.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
			path,
		]);
		return path;
	});
}

export async function renameWorkspaceEntry(
	lix: Lix,
	path: string,
	name: string,
): Promise<string> {
	const cleanName = validateWorkspaceEntryName(name);
	return atomic(lix, async (transaction) => {
		const all = await entries(transaction);
		const entry = selectedRoots(all, [path])[0]!;
		const next = `${withoutSlash(path).slice(0, withoutSlash(path).lastIndexOf("/") + 1)}${cleanName}`;
		requireFree(all, next, entry.id);
		if (withoutSlash(entry.path) !== next) {
			await renameAtelierEntry(
				atelierTransaction(transaction),
				atelierEntry(entry),
				next,
			);
		}
		return next;
	});
}

/** The SDK moves directory descendants by identity; all selected roots move in one transaction. */
export async function moveWorkspaceEntries(
	lix: Lix,
	paths: readonly string[],
	destination: string,
): Promise<string[]> {
	if (!paths.length) return [];
	return atomic(lix, async (transaction) => {
		const all = await entries(transaction);
		requireParent(all, destination);
		const roots = selectedRoots(all, paths);
		const targets = new Set<string>();
		const moves = roots.map((entry) => {
			if (
				entry.kind === "directory" &&
				(withoutSlash(destination) === withoutSlash(entry.path) ||
					directoryPath(destination).startsWith(directoryPath(entry.path)))
			) {
				throw new Error(
					"A folder cannot be moved into itself or one of its subfolders.",
				);
			}
			const next = `${directoryPath(destination)}${nameOf(entry.path)}`;
			requireFree(all, next, entry.id);
			if (targets.has(key(next)))
				throw new Error(`Multiple selected items are named “${nameOf(next)}”.`);
			targets.add(key(next));
			return { entry, next };
		});
		for (const { entry, next } of moves) {
			if (withoutSlash(entry.path) !== next) {
				// Every destination was checked above in this same transaction.
				// Avoid the shared rename helper's two additional remote reads per item.
				// Lix moves directory descendants automatically with this path update.
				await transaction.execute(
					`UPDATE lix_${entry.kind} SET path = $1 WHERE id = $2`,
					[next, entry.id],
				);
			}
		}
		return moves.map(({ next }) => next);
	});
}

export async function deleteWorkspaceEntries(
	lix: Lix,
	paths: readonly string[],
): Promise<void> {
	if (!paths.length) return;
	await atomic(lix, async (transaction) => {
		const roots = selectedRoots(await entries(transaction), paths);
		for (const entry of roots) {
			await deleteAtelierEntry(
				atelierTransaction(transaction),
				atelierEntry(entry),
			);
		}
	});
}

export type WorkspaceImportEntry =
	| { kind: "file"; path: string; file: File }
	| { kind: "directory"; path: string };

/** Snapshot entry handles while the drop event still has access to its data store. */
export async function collectDroppedWorkspaceEntries(
	transfer: DataTransfer,
): Promise<WorkspaceImportEntry[]> {
	const handles = Array.from(transfer.items ?? [])
		.filter((item) => item.kind === "file")
		.map((item) => ({
			entry: item.webkitGetAsEntry?.() ?? null,
			file: item.getAsFile(),
		}));
	const fallback = Array.from(transfer.files ?? []);
	const result: WorkspaceImportEntry[] = [];
	async function visit(entry: FileSystemEntry, parent: string): Promise<void> {
		const path = `${parent}${entry.name}`;
		if (entry.isDirectory) {
			result.push({ kind: "directory", path });
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			// Chromium returns directory children in batches of at most 100.
			while (true) {
				const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
					reader.readEntries(resolve, reject),
				);
				if (!batch.length) break;
				for (const child of batch) await visit(child, `${path}/`);
			}
		} else {
			const file = await new Promise<File>((resolve, reject) =>
				(entry as FileSystemFileEntry).file(resolve, reject),
			);
			result.push({ kind: "file", path, file });
		}
	}
	if (handles.length) {
		for (const handle of handles) {
			if (handle.entry) await visit(handle.entry, "");
			else if (handle.file)
				result.push({
					kind: "file",
					path: handle.file.webkitRelativePath || handle.file.name,
					file: handle.file,
				});
		}
	} else {
		for (const file of fallback)
			result.push({
				kind: "file",
				path: file.webkitRelativePath || file.name,
				file,
			});
	}
	return result;
}

/** Each dropped top-level entry is atomic. A collision fails that entry without overwriting data. */
export async function importWorkspaceEntries(
	lix: Lix,
	parent: string,
	importedEntries: readonly WorkspaceImportEntry[],
): Promise<{ imported: number; failed: string[] }> {
	const groups = new Map<string, WorkspaceImportEntry[]>();
	const failed: string[] = [];
	for (const entry of importedEntries) {
		try {
			if (entry.path.startsWith("/")) throw new Error("Absolute import path");
			const parts = entry.path
				.replace(/\/$/, "")
				.split("/")
				.map((part) => validateWorkspaceEntryName(part));
			const normalized = { ...entry, path: parts.join("/") };
			groups.set(parts[0]!, [...(groups.get(parts[0]!) ?? []), normalized]);
		} catch {
			failed.push(entry.path);
		}
	}
	let imported = 0;
	for (const [root, group] of groups) {
		try {
			// Read browser files before holding a database transaction.
			const contents = new Map<WorkspaceImportEntry, Uint8Array>();
			for (const entry of group)
				if (entry.kind === "file")
					contents.set(entry, new Uint8Array(await entry.file.arrayBuffer()));
			await atomic(lix, async (transaction) => {
				const all = await entries(transaction);
				requireParent(all, parent);
				requireFree(all, `${directoryPath(parent)}${root}`);
				const directories = new Set<string>();
				for (const entry of group) {
					const parts = entry.path.split("/");
					const depth = parts.length - (entry.kind === "file" ? 1 : 0);
					for (let i = 1; i <= depth; i++)
						directories.add(parts.slice(0, i).join("/"));
				}
				for (const path of [...directories].sort(
					(a, b) => a.split("/").length - b.split("/").length,
				)) {
					await transaction.execute(
						"INSERT INTO lix_directory (path) VALUES ($1)",
						[`${directoryPath(parent)}${path}`],
					);
				}
				for (const entry of group) {
					if (entry.kind === "file")
						await transaction.execute(
							"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
							[`${directoryPath(parent)}${entry.path}`, contents.get(entry)!],
						);
				}
			});
			imported += group.filter((entry) => entry.kind === "file").length || 1;
		} catch {
			failed.push(root);
		}
	}
	return { imported, failed };
}

export async function prepareWorkspaceDownload(
	lix: Lix,
	paths: readonly string[],
): Promise<{ name: string; bytes: Uint8Array; type: string }> {
	return atomic(lix, async (transaction) => {
		const all = await entries(transaction);
		const roots = selectedRoots(all, paths);
		if (!roots.length) throw new Error("Select at least one item to download.");
		const readFile = async (entry: Entry) => {
			const result = await transaction.execute(
				"SELECT content FROM lix_file WHERE id = $1",
				[entry.id],
			);
			const bytes = result.rows[0]?.content;
			if (!(bytes instanceof Uint8Array))
				throw new Error(`Unable to read “${nameOf(entry.path)}”.`);
			return bytes;
		};
		if (roots.length === 1 && roots[0]!.kind === "file") {
			return {
				name: nameOf(roots[0]!.path),
				bytes: await readFile(roots[0]!),
				type: "application/octet-stream",
			};
		}
		const archive = Object.create(null) as Record<string, Uint8Array>;
		for (const root of roots) {
			const prefix = withoutSlash(root.path).slice(
				0,
				withoutSlash(root.path).lastIndexOf("/") + 1,
			);
			for (const entry of all.filter(
				(candidate) =>
					candidate === root ||
					(root.kind === "directory" &&
						candidate.path.startsWith(directoryPath(root.path))),
			)) {
				const relative = archivePath(entry).slice(prefix.length);
				if (relative in archive)
					throw new Error(
						"Selected items have duplicate names. Download them separately.",
					);
				archive[relative] =
					entry.kind === "directory" ? new Uint8Array() : await readFile(entry);
			}
		}
		return {
			name: roots.length === 1 ? `${nameOf(roots[0]!.path)}.zip` : "files.zip",
			bytes: zipSync(archive),
			type: "application/zip",
		};
	});
}

export async function downloadWorkspaceEntries(
	lix: Lix,
	paths: readonly string[],
): Promise<void> {
	const { name, bytes, type } = await prepareWorkspaceDownload(lix, paths);
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
