import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { EntryKind } from "../../lib/entry-kind.ts";
import {
	canonicalDirectoryPath,
	createRepositoryFile,
	createRepositoryFolder,
	importDroppedFiles,
	listDirectory,
	persistedDirectoryPath,
	resolveRepositoryHref,
	type RepositoryTree,
	repositoryHasNoFiles,
	resolveObservedRowsAfterError,
	WORKING_DIFF_COUNT_SQL,
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

void test("queries the latest Lix working-diff table function", () => {
	assert.equal(
		WORKING_DIFF_COUNT_SQL,
		"SELECT count(*) AS n FROM lix_working_diff()",
	);
});

void test("optional observer failures resolve first-frame loading to empty data", () => {
	assert.deepEqual(resolveObservedRowsAfterError(null, true), {
		rows: [],
		hadRows: false,
	});
});

void test("optional observer failures after a frame preserve its rows", () => {
	const rows = [{ value: "cached" }];
	const resolved = resolveObservedRowsAfterError(rows, true);
	assert.equal(resolved.rows, rows);
	assert.equal(resolved.hadRows, true);
});

void test("authoritative observer failures remain unresolved for explicit error UI", () => {
	assert.deepEqual(resolveObservedRowsAfterError(null, false), {
		rows: null,
		hadRows: false,
	});
});

void test("lists directory entries from their separate surfaces", () => {
	const listing = listDirectory(tree, "/");
	assert.deepEqual(
		listing.dirs.map((entry) => entry.path),
		["/docs"],
	);
	assert.deepEqual(
		listing.files.map((entry) => entry.path),
		["/README.md"],
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

void test("repositoryHasNoFiles reports an empty repository", async () => {
	const lix = {
		execute: async () => ({ rows: [] }),
	} as never;

	assert.equal(await repositoryHasNoFiles(lix), true);
});

void test("repositoryHasNoFiles preserves SQL failures for boot error UI", async () => {
	const failure = new Error("repository query failed");
	const lix = {
		execute: async () => {
			throw failure;
		},
	} as never;

	await assert.rejects(
		repositoryHasNoFiles(lix),
		(caught) => caught === failure,
	);
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

void test("checks the opposite surface when choosing a directory path", async () => {
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			if (sql.includes("FROM lix_file") && params[0] === "/new-folder") {
				return { rows: [{}] };
			}
			return { rows: [] };
		},
	} as unknown as Lix;

	assert.equal(await createRepositoryFolder(lix, "/"), "/new-folder-1");
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
