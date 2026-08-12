import type { Lix } from "@lix-js/sdk";
import { useEffect, useMemo, useState } from "react";
import { EntryKind } from "../../lib/entry-kind.ts";

export function dirNameFromPath(dirPath: string): string {
	return dirPath.split("/").filter(Boolean).at(-1) ?? "";
}

export type WorkspaceTree = {
	readonly dirs: ReadonlyArray<{
		readonly kind: typeof EntryKind.Directory;
		readonly id: string;
		readonly parentId: string | null;
		readonly path: string;
		readonly name: string;
		readonly updatedAt: string;
	}>;
	readonly files: ReadonlyArray<{
		readonly kind: typeof EntryKind.File;
		readonly id: string;
		readonly directoryId: string | null;
		readonly path: string;
		readonly name: string;
		readonly updatedAt: string;
	}>;
};

type ObservedRow = {
	get(column: string): unknown;
	value(column: string): { asBytes(): Uint8Array | undefined };
};

function useObservedRows(
	lix: Lix,
	sql: string,
	params: ReadonlyArray<string>,
): ObservedRow[] | null {
	const [rows, setRows] = useState<ObservedRow[] | null>(null);
	const paramsKey = JSON.stringify(params);
	useEffect(() => {
		let disposed = false;
		// Remote observe reconciles every stream's first frame through execute,
		// including reconnects, so event.result is safe to publish directly.
		const events = lix.observe(sql, JSON.parse(paramsKey) as string[]);
		setRows(null);
		void (async () => {
			try {
				while (!disposed) {
					const event = await events.next();
					if (!event) break;
					if (!disposed) setRows(event.result.rows);
				}
			} catch (error) {
				if (!disposed) {
					console.error("workspace-home: lix observe failed", error);
				}
			}
		})();
		return () => {
			disposed = true;
			events.close();
		};
	}, [lix, sql, paramsKey]);
	return rows;
}

const asText = (value: unknown): string =>
	typeof value === "string" ? value : "";

const asNullableText = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/** The full directory/file tree, kept live via lix observe. */
export function useWorkspaceTree(lix: Lix): WorkspaceTree | null {
	const dirRows = useObservedRows(
		lix,
		"SELECT id, parent_id, path, name, lixcol_updated_at FROM lix_directory ORDER BY path",
		[],
	);
	const fileRows = useObservedRows(
		lix,
		"SELECT id, directory_id, path, name, lixcol_updated_at FROM lix_file ORDER BY path",
		[],
	);
	return useMemo(() => {
		if (!dirRows || !fileRows) return null;
		return {
			dirs: dirRows.map((row) => ({
				kind: EntryKind.Directory,
				id: asText(row.get("id")),
				parentId: asNullableText(row.get("parent_id")),
				path: asText(row.get("path")),
				name: asText(row.get("name")),
				updatedAt: asText(row.get("lixcol_updated_at")),
			})),
			files: fileRows.map((row) => ({
				kind: EntryKind.File,
				id: asText(row.get("id")),
				directoryId: asNullableText(row.get("directory_id")),
				path: asText(row.get("path")),
				name: asText(row.get("name")),
				updatedAt: asText(row.get("lixcol_updated_at")),
			})),
		};
	}, [dirRows, fileRows]);
}

/**
 * One-shot check whether the workspace has zero files — used before the
 * Atelier shell mounts (e.g. to seed the getting-started tab); the hook
 * below is the live variant.
 */
export async function workspaceHasNoFiles(lix: Lix): Promise<boolean> {
	const result = await lix.execute("SELECT 1 FROM lix_file LIMIT 1", []);
	return result.rows.length === 0;
}

/** Whether the workspace has zero files (null while loading / no lix). */
export function useWorkspaceIsEmpty(lix: Lix | null): boolean | null {
	const [isEmpty, setIsEmpty] = useState<boolean | null>(null);
	useEffect(() => {
		if (!lix) {
			setIsEmpty(null);
			return;
		}
		let disposed = false;
		setIsEmpty(null);
		const events = lix.observe("SELECT count(*) AS n FROM lix_file", []);
		void (async () => {
			try {
				while (!disposed) {
					const event = await events.next();
					if (!event) break;
					const row = event.result.rows[0] as
						| { get(column: string): unknown }
						| undefined;
					const count = Number(row?.get("n") ?? 0);
					if (!disposed) setIsEmpty(count === 0);
				}
			} catch (error) {
				if (!disposed) {
					console.error("workspace-home: emptiness observe failed", error);
				}
			}
		})();
		return () => {
			disposed = true;
			events.close();
		};
	}, [lix]);
	return isEmpty;
}

/**
 * Resolves a README-relative link against a directory. Returns null for
 * absolute/external/fragment hrefs (which keep default browser behavior).
 */
export function resolveWorkspaceHref(
	baseDir: string,
	href: string,
): string | null {
	if (
		!href ||
		href.startsWith("#") ||
		href.startsWith("//") ||
		/^[a-z][a-z0-9+.-]*:/i.test(href)
	) {
		return null;
	}
	const raw = href.startsWith("/") ? href : `${baseDir}${href}`;
	const segments: string[] = [];
	for (const segment of raw.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	if (segments.length === 0) return null;
	const resolved = `/${segments.map((segment) => decodeURIComponent(segment)).join("/")}`;
	return raw.endsWith("/") ? `${resolved}/` : resolved;
}

type DirectoryListing = {
	readonly dirs: ReadonlyArray<{
		readonly path: string;
		readonly name: string;
		readonly itemCount: number;
	}>;
	readonly files: ReadonlyArray<{
		readonly path: string;
		readonly name: string;
		readonly updatedAt: string;
	}>;
	readonly readmePath: string | null;
};

/** Direct children of dirPath, folders first. Entry kind comes from the surface. */
export function listDirectory(
	tree: WorkspaceTree,
	dirPath: string,
): DirectoryListing {
	const currentDirectoryId =
		dirPath === "/"
			? null
			: tree.dirs.find((directory) => directory.path === dirPath)?.id;
	if (dirPath !== "/" && !currentDirectoryId) {
		return { dirs: [], files: [], readmePath: null };
	}
	const countItemsIn = (childDirPath: string) => {
		const childDirectory = tree.dirs.find(
			(directory) => directory.path === childDirPath,
		);
		if (!childDirectory) return 0;
		return (
			tree.dirs.filter((dir) => dir.parentId === childDirectory.id).length +
			tree.files.filter((file) => file.directoryId === childDirectory.id).length
		);
	};
	const dirs = tree.dirs
		.filter((dir) => dir.parentId === currentDirectoryId)
		.map((dir) => ({
			path: dir.path,
			name: dir.name,
			itemCount: countItemsIn(dir.path),
		}));
	// Per the home comp: README pinned first, then most recently updated.
	const files = tree.files
		.filter((file) => file.directoryId === currentDirectoryId)
		.map((file) => ({
			path: file.path,
			name: file.name,
			updatedAt: file.updatedAt,
		}))
		.sort((left, right) => {
			const leftReadme = left.name.toLowerCase() === "readme.md" ? 1 : 0;
			const rightReadme = right.name.toLowerCase() === "readme.md" ? 1 : 0;
			if (leftReadme !== rightReadme) return rightReadme - leftReadme;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	const readmePath =
		files.find((file) => file.name.toLowerCase() === "readme.md")?.path ?? null;
	return { dirs, files, readmePath };
}

/** Resolves a link against the persisted directory surface without inferring kind from a path. */
export function persistedDirectoryPath(
	tree: WorkspaceTree,
	resolvedPath: string,
): string | null {
	return (
		tree.dirs.find(
			(dir) =>
				dir.path === resolvedPath ||
				(!resolvedPath.endsWith("/") && dir.path === `${resolvedPath}/`),
		)?.path ?? null
	);
}

/** Live markdown text of the file at path (null while loading/missing). */
export function useFileMarkdown(lix: Lix, path: string | null): string | null {
	const rows = useObservedRows(
		lix,
		"SELECT content FROM lix_file WHERE path = $1",
		path ? [path] : [""],
	);
	return useMemo(() => {
		if (!path || !rows || rows.length === 0) return null;
		const row = rows[0];
		const bytes = row?.value("content").asBytes();
		if (bytes) return new TextDecoder().decode(bytes);
		const content = row?.get("content");
		if (typeof content === "string") return content;
		return null;
	}, [path, rows]);
}

const NEW_FILE_TEMPLATES: Record<string, { base: string; data: string }> = {
	md: { base: "untitled", data: "" },
	csv: { base: "untitled", data: "" },
	excalidraw: {
		base: "drawing",
		data: '{"type":"excalidraw","version":2,"elements":[],"appState":{}}',
	},
};

async function firstFreePath(
	lix: Lix,
	kind: EntryKind,
	candidate: (suffix: number | null) => string,
): Promise<string> {
	for (let suffix = null as number | null, i = 0; i < 1000; i += 1) {
		const path = candidate(suffix);
		const directoryPath = kind === EntryKind.Directory ? path : `${path}/`;
		const filePath = kind === EntryKind.File ? path : path.slice(0, -1);
		const [dirHit, fileHit] = await Promise.all([
			lix.execute("SELECT 1 FROM lix_directory WHERE lower(path) = lower($1)", [
				directoryPath,
			]),
			lix.execute("SELECT 1 FROM lix_file WHERE lower(path) = lower($1)", [
				filePath,
			]),
		]);
		if (dirHit.rows.length === 0 && fileHit.rows.length === 0) return path;
		suffix = suffix === null ? 1 : suffix + 1;
	}
	throw new Error("Unable to find a free file name.");
}

/** Creates an empty file of the given type in dirPath; returns its path. */
export async function createWorkspaceFile(
	lix: Lix,
	dirPath: string,
	extension: "md" | "csv" | "excalidraw",
): Promise<string> {
	const template = NEW_FILE_TEMPLATES[extension] ?? {
		base: "untitled",
		data: "",
	};
	const path = await firstFreePath(lix, EntryKind.File, (suffix) =>
		suffix === null
			? `${dirPath}${template.base}.${extension}`
			: `${dirPath}${template.base}-${suffix}.${extension}`,
	);
	await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
		path,
		new TextEncoder().encode(template.data),
	]);
	return path;
}

/** Creates an empty folder in dirPath; returns its trailing-slash path. */
export async function createWorkspaceFolder(
	lix: Lix,
	dirPath: string,
): Promise<string> {
	const path = await firstFreePath(lix, EntryKind.Directory, (suffix) =>
		suffix === null
			? `${dirPath}new-folder/`
			: `${dirPath}new-folder-${suffix}/`,
	);
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [path]);
	return path;
}

/**
 * Imports dropped files into dirPath, overwriting same-path files. Failures
 * (e.g. a name colliding with a folder) skip that file and continue.
 */
export async function importDroppedFiles(
	lix: Lix,
	dirPath: string,
	files: ReadonlyArray<File>,
): Promise<{ imported: number; failed: string[] }> {
	let imported = 0;
	const failed: string[] = [];
	for (const file of files) {
		const name = file.name.split("/").filter(Boolean).at(-1);
		if (!name) continue;
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			await lix.execute(
				"INSERT INTO lix_file (path, content) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET content = excluded.content",
				[`${dirPath}${name}`, bytes],
			);
			imported += 1;
		} catch (error) {
			console.error(`workspace-home: unable to import ${name}`, error);
			failed.push(name);
		}
	}
	return { imported, failed };
}

/** "2 min ago", "today", "yesterday", or "Jun 25" — matches the home comp. */
export function formatUpdatedAt(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const now = Date.now();
	const minutes = Math.max(0, Math.floor((now - time) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const date = new Date(time);
	const today = new Date();
	const startOfDay = (d: Date) =>
		new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const dayDiff = Math.round(
		(startOfDay(today) - startOfDay(date)) / 86_400_000,
	);
	if (dayDiff <= 0) return "today";
	if (dayDiff === 1) return "yesterday";
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
