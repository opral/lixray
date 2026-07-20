import type { Lix } from "@lix-js/sdk";
import { useEffect, useMemo, useState } from "react";

/** Normalizes to a leading- and trailing-slash directory path; "" → "/". */
export function normalizeHomeDirPath(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "/";
	const segments = raw.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return "/";
	}
	return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

export function dirNameFromPath(dirPath: string): string {
	return dirPath.split("/").filter(Boolean).at(-1) ?? "";
}

export type WorkspaceTree = {
	readonly dirs: ReadonlyArray<{
		readonly path: string;
		readonly name: string;
		readonly updatedAt: string;
	}>;
	readonly files: ReadonlyArray<{
		readonly id: string;
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
		setRows(null);
		const events = lix.observe(sql, JSON.parse(paramsKey) as string[]);
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

/** The full directory/file tree, kept live via lix observe. */
export function useWorkspaceTree(lix: Lix): WorkspaceTree | null {
	const dirRows = useObservedRows(
		lix,
		"SELECT path, name, lixcol_updated_at FROM lix_directory ORDER BY path",
		[],
	);
	const fileRows = useObservedRows(
		lix,
		"SELECT id, path, name, lixcol_updated_at FROM lix_file ORDER BY path",
		[],
	);
	return useMemo(() => {
		if (!dirRows || !fileRows) return null;
		return {
			dirs: dirRows.map((row) => ({
				path: asText(row.get("path")),
				name: asText(row.get("name")),
				updatedAt: asText(row.get("lixcol_updated_at")),
			})),
			files: fileRows.map((row) => ({
				id: asText(row.get("id")),
				path: asText(row.get("path")),
				name: asText(row.get("name")),
				updatedAt: asText(row.get("lixcol_updated_at")),
			})),
		};
	}, [dirRows, fileRows]);
}

export type DirectoryListing = {
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

/** Direct children of dirPath ("/" or "/segment/…/"), folders first. */
export function listDirectory(
	tree: WorkspaceTree,
	dirPath: string,
): DirectoryListing {
	const isDirectChildDir = (path: string) => {
		if (!path.startsWith(dirPath) || path === dirPath) return false;
		const rest = path.slice(dirPath.length);
		const segments = rest.split("/").filter(Boolean);
		return segments.length === 1 && rest.endsWith("/");
	};
	const isDirectChildFile = (path: string) => {
		if (!path.startsWith(dirPath)) return false;
		const rest = path.slice(dirPath.length);
		return rest.length > 0 && !rest.includes("/");
	};
	const countItemsIn = (childDirPath: string) => {
		const directDir = (path: string) => {
			if (!path.startsWith(childDirPath) || path === childDirPath) return false;
			const rest = path.slice(childDirPath.length);
			return rest.split("/").filter(Boolean).length === 1 && rest.endsWith("/");
		};
		const directFile = (path: string) => {
			if (!path.startsWith(childDirPath)) return false;
			const rest = path.slice(childDirPath.length);
			return rest.length > 0 && !rest.includes("/");
		};
		return (
			tree.dirs.filter((dir) => directDir(dir.path)).length +
			tree.files.filter((file) => directFile(file.path)).length
		);
	};
	const dirs = tree.dirs
		.filter((dir) => isDirectChildDir(dir.path))
		.map((dir) => ({
			path: dir.path,
			name: dir.name,
			itemCount: countItemsIn(dir.path),
		}));
	const files = tree.files
		.filter((file) => isDirectChildFile(file.path))
		.map((file) => ({
			path: file.path,
			name: file.name,
			updatedAt: file.updatedAt,
		}));
	const readmePath =
		files.find((file) => file.name.toLowerCase() === "readme.md")?.path ?? null;
	return { dirs, files, readmePath };
}

/** Live markdown text of the file at path (null while loading/missing). */
export function useFileMarkdown(lix: Lix, path: string | null): string | null {
	const rows = useObservedRows(
		lix,
		"SELECT data FROM lix_file WHERE path = $1",
		path ? [path] : [""],
	);
	return useMemo(() => {
		if (!path || !rows || rows.length === 0) return null;
		const row = rows[0];
		const bytes = row?.value("data").asBytes();
		if (bytes) return new TextDecoder().decode(bytes);
		const data = row?.get("data");
		if (typeof data === "string") return data;
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
	candidate: (suffix: number | null) => string,
): Promise<string> {
	for (let suffix = null as number | null, i = 0; i < 1000; i += 1) {
		const path = candidate(suffix);
		const [dirHit, fileHit] = await Promise.all([
			lix.execute(
				"SELECT 1 FROM lix_directory WHERE lower(path) = lower($1) OR lower(path) = lower($2)",
				[path, `${path}/`],
			),
			lix.execute("SELECT 1 FROM lix_file WHERE lower(path) = lower($1)", [
				path,
			]),
		]);
		if (dirHit.rows.length === 0 && fileHit.rows.length === 0) return path;
		suffix = (suffix ?? 1) + 1;
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
	const path = await firstFreePath(lix, (suffix) =>
		suffix === null
			? `${dirPath}${template.base}.${extension}`
			: `${dirPath}${template.base}-${suffix}.${extension}`,
	);
	await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
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
	const path = await firstFreePath(lix, (suffix) =>
		suffix === null ? `${dirPath}new-folder` : `${dirPath}new-folder-${suffix}`,
	);
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
		`${path}/`,
	]);
	return `${path}/`;
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
				"INSERT INTO lix_file (path, data) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET data = excluded.data",
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
