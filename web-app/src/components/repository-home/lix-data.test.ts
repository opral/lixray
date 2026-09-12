import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { EntryKind } from "../../lib/entry-kind.ts";
import {
	CHANGE_SUMMARY_SQL,
	CHECKPOINT_SUMMARY_SQL,
	WORKING_CHANGE_SQL,
	WORKING_FILE_DIFF_SQL,
	describeWorkingChanges,
	canonicalDirectoryPath,
	createRepositoryFile,
	createRepositoryFolder,
	importDroppedFiles,
	listDirectory,
	persistedDirectoryPath,
	resolveRepositoryHref,
	type RepositoryTree,
	preserveObservedRowsAfterError,
} from "./lix-data.ts";

const tree: RepositoryTree = {
	dirs: [
		{
			kind: EntryKind.Directory,
			id: "docs",
			parentId: null,
			path: "/docs",
			name: "docs",
			updatedAt: "2026-08-10T00:00:00Z",
		},
		{
			kind: EntryKind.Directory,
			id: "guides",
			parentId: "docs",
			path: "/docs/guides",
			name: "guides",
			updatedAt: "2026-08-10T00:00:00Z",
		},
	],
	files: [
		{
			kind: EntryKind.File,
			id: "readme",
			directoryId: null,
			path: "/README.md",
			name: "README.md",
			updatedAt: "2026-08-10T00:00:00Z",
		},
		{
			kind: EntryKind.File,
			id: "guide",
			directoryId: "docs",
			path: "/docs/guide.md",
			name: "guide.md",
			updatedAt: "2026-08-10T00:00:00Z",
		},
	],
};

void test("keeps checkpoint dates bounded while returning the total count", () => {
	assert.match(CHECKPOINT_SUMMARY_SQL, /count\(\*\) over \(\) AS total_count/i);
	assert.match(CHECKPOINT_SUMMARY_SQL, /FROM lix_commit WHERE is_checkpoint/i);
	assert.match(CHECKPOINT_SUMMARY_SQL, /ORDER BY created_at DESC, id DESC/i);
	assert.match(CHECKPOINT_SUMMARY_SQL, /LIMIT 10$/i);
});

void test("derives change totals and dates from one bounded daily query", () => {
	assert.match(
		CHANGE_SUMMARY_SQL,
		/sum\(day_count\) over \(\) AS total_count/i,
	);
	assert.match(
		CHANGE_SUMMARY_SQL,
		/min\(day_created_at\) over \(\) AS created_at/i,
	);
	assert.match(CHANGE_SUMMARY_SQL, /LIMIT 10$/i);
});

void test("counts working changes through the status bar's own diff", () => {
	assert.match(WORKING_CHANGE_SQL, /FROM lix_diff\('lix_file'\)/);
	assert.match(WORKING_CHANGE_SQL, /count\(\*\) AS file_count/i);
	// The listing marks its rows from the same working diff the status bar
	// counts, one row per changed file. lix_diff rejects a bare star (it
	// would project file content), so the columns stay explicit.
	assert.match(WORKING_FILE_DIFF_SQL, /FROM lix_diff\('lix_file'\)/);
	assert.doesNotMatch(WORKING_FILE_DIFF_SQL, /SELECT \*/);
	for (const column of ["diff_type", "from_path", "to_path"])
		assert.match(WORKING_FILE_DIFF_SQL, new RegExp(column));
	assert.match(WORKING_FILE_DIFF_SQL, /coalesce\(to_path, from_path\) AS path/);
	assert.match(WORKING_CHANGE_SQL, /sum\(row_count\), 0\) AS change_count/i);
});

void test("words the Changes headline like the status bar", () => {
	assert.deepEqual(describeWorkingChanges(1, 4), {
		count: 1,
		label: "file changed since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(3, 9), {
		count: 3,
		label: "files changed since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(0, 0), {
		count: 0,
		label: "changes since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(null, null), {
		count: 0,
		label: "changes since checkpoint",
	});
});

void test("observer failures expose first-frame errors without inventing rows", () => {
	const error = new Error("observe failed");
	assert.deepEqual(
		preserveObservedRowsAfterError({ rows: null, error: null }, error),
		{ rows: null, error },
	);
});

void test("observer failures after a frame preserve its rows", () => {
	const rows = [{ value: "cached" }];
	const error = new Error("observe failed");
	const resolved = preserveObservedRowsAfterError({ rows, error: null }, error);
	assert.equal(resolved.rows, rows);
	assert.equal(resolved.error, error);
});

void test("lists directory entries from their separate surfaces", () => {
	const listing = listDirectory(tree, "/");
	assert.deepEqual(
		listing.dirs.map((entry) => entry.path),
		["/docs"],
	);
	assert.deepEqual(
		listing.files.map((entry) => ({ id: entry.id, path: entry.path })),
		[{ id: "readme", path: "/README.md" }],
	);
});

void test("lists nested children through parent identifiers", () => {
	const listing = listDirectory(tree, "/docs");
	assert.deepEqual(
		listing.dirs.map((entry) => entry.path),
		["/docs/guides"],
	);
	assert.deepEqual(
		listing.files.map((entry) => entry.path),
		["/docs/guide.md"],
	);
});

void test("uses one hidden-file policy for root and nested listings", () => {
	const hiddenTree: RepositoryTree = {
		dirs: [
			{
				kind: EntryKind.Directory,
				id: "settings-dir",
				parentId: null,
				path: "/.settings",
				name: ".settings",
				updatedAt: "2026-08-10T00:00:00Z",
			},
			{
				kind: EntryKind.Directory,
				id: "cache-dir",
				parentId: "settings-dir",
				path: "/.settings/cache",
				name: "cache",
				updatedAt: "2026-08-10T00:00:00Z",
			},
		],
		files: [
			{
				kind: EntryKind.File,
				id: "env-file",
				directoryId: null,
				path: "/.env",
				name: ".env",
				updatedAt: "2026-08-10T00:00:00Z",
			},
			{
				kind: EntryKind.File,
				id: "config-file",
				directoryId: "settings-dir",
				path: "/.settings/config.json",
				name: "config.json",
				updatedAt: "2026-08-10T00:00:00Z",
			},
		],
	};

	assert.deepEqual(listDirectory(hiddenTree, "/"), {
		dirs: [],
		files: [],
		readmePath: null,
	});
	const revealed = listDirectory(hiddenTree, "/", {
		showHiddenFiles: true,
	});
	assert.equal(revealed.dirs[0]?.path, "/.settings");
	assert.equal(revealed.dirs[0]?.hidden, true);
	assert.equal(revealed.files[0]?.path, "/.env");
	assert.equal(revealed.files[0]?.hidden, true);
	assert.deepEqual(
		listDirectory(hiddenTree, "/.settings", { showHiddenFiles: true }).dirs.map(
			(entry) => entry.path,
		),
		["/.settings/cache"],
	);
});

void test("resolves canonical links through the directory surface", () => {
	assert.equal(persistedDirectoryPath(tree, "/docs/"), "/docs");
	assert.equal(persistedDirectoryPath(tree, "/README.md"), null);
});

void test("canonicalizes directory paths and nested relative links", () => {
	assert.equal(canonicalDirectoryPath("docs/"), "/docs");
	assert.equal(canonicalDirectoryPath("/"), "/");
	assert.equal(resolveRepositoryHref("/docs", "guides/"), "/docs/guides");
	assert.equal(resolveRepositoryHref("/docs", "../README.md"), "/README.md");
});

void test("creates a directory with an exact persisted directory path", async () => {
	const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			calls.push({ sql, params });
			return { rows: [] };
		},
	} as unknown as Lix;

	assert.equal(await createRepositoryFolder(lix, "/"), "/new-folder");
	assert.deepEqual(calls.at(-1), {
		sql: "INSERT INTO lix_directory (path) VALUES ($1)",
		params: ["/new-folder"],
	});
});

void test("checks both path surfaces once per candidate", async () => {
	const directoryPaths = new Set(["/new-folder"]);
	const filePaths = new Set(["/new-folder-1"]);
	const checkedPaths: string[] = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			if (sql.startsWith("SELECT 1 FROM lix_directory")) {
				assert.match(sql, /UNION ALL SELECT 1 FROM lix_file/);
				assert.match(sql, /LIMIT 1$/);
				const path = String(params[0]);
				checkedPaths.push(path);
				return {
					rows: directoryPaths.has(path) || filePaths.has(path) ? [{}] : [],
				};
			}
			return { rows: [] };
		},
	} as unknown as Lix;

	assert.equal(await createRepositoryFolder(lix, "/"), "/new-folder-2");
	assert.deepEqual(checkedPaths, [
		"/new-folder",
		"/new-folder-1",
		"/new-folder-2",
	]);
});

void test("creates nested files and folders with canonical separators", async () => {
	const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			calls.push({ sql, params });
			return { rows: [] };
		},
	} as unknown as Lix;

	assert.equal(await createRepositoryFolder(lix, "/docs"), "/docs/new-folder");
	assert.equal(
		await createRepositoryFile(lix, "/docs", "md"),
		"/docs/untitled.md",
	);
	assert.deepEqual(calls.at(-1)?.params[0], "/docs/untitled.md");
});

void test("file creation retries sync conflicts with a fresh available name", async () => {
	const paths = new Set<string>();
	const inserts: string[] = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			const path = String(params[0]);
			if (sql.startsWith("SELECT")) {
				return { rows: paths.has(path) ? [{}] : [] };
			}
			inserts.push(path);
			if (inserts.length === 1) {
				// Another writer claims the candidate while our write is rejected.
				paths.add(path);
				throw Object.assign(new Error("stale transaction"), {
					code: "LIX_TRANSACTION_CONFLICT",
				});
			}
			paths.add(path);
			return { rows: [] };
		},
	} as unknown as Lix;

	assert.equal(await createRepositoryFile(lix, "/", "csv"), "/untitled-1.csv");
	assert.deepEqual(inserts, ["/untitled.csv", "/untitled-1.csv"]);
});

void test("file creation bounds conflicts and does not retry ambiguous writes", async () => {
	for (const [code, expectedWrites] of [
		["LIX_TRANSACTION_CONFLICT", 4],
		["LIX_STORAGE_COMMIT_OUTCOME_UNKNOWN", 1],
		["LIX_INVALID_PARAM", 1],
	] as const) {
		let writes = 0;
		const failure = Object.assign(new Error(code), { code });
		const lix = {
			execute: async (sql: string) => {
				if (sql.startsWith("SELECT")) return { rows: [] };
				writes += 1;
				throw failure;
			},
		} as unknown as Lix;
		await assert.rejects(
			createRepositoryFile(lix, "/", "md"),
			(error) => error === failure,
		);
		assert.equal(writes, expectedWrites);
	}
});

void test("imports dropped files into a canonical nested directory", async () => {
	const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			calls.push({ sql, params });
			return { rows: [] };
		},
	} as unknown as Lix;
	const file = {
		name: "notes.md",
		arrayBuffer: async () => new TextEncoder().encode("notes").buffer,
	} as File;

	assert.deepEqual(await importDroppedFiles(lix, "/docs", [file]), {
		imported: 1,
		failed: [],
	});
	assert.equal(calls.at(-1)?.params[0], "/docs/notes.md");
});
