import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { EntryKind } from "../../lib/entry-kind.ts";
import {
	createWorkspaceFolder,
	listDirectory,
	persistedDirectoryPath,
	type WorkspaceTree,
	workspaceHasNoFiles,
} from "./lix-data.ts";

const tree: WorkspaceTree = {
	dirs: [
		{
			kind: EntryKind.Directory,
			id: "docs",
			parentId: null,
			path: "/docs/",
			name: "docs",
			updatedAt: "2026-08-10T00:00:00Z",
		},
		{
			kind: EntryKind.Directory,
			id: "guides",
			parentId: "docs",
			path: "/docs/guides/",
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

void test("lists directory entries from their separate surfaces", () => {
	const listing = listDirectory(tree, "/");
	assert.deepEqual(
		listing.dirs.map((entry) => entry.path),
		["/docs/"],
	);
	assert.deepEqual(
		listing.files.map((entry) => entry.path),
		["/README.md"],
	);
});

void test("lists nested children through parent identifiers", () => {
	const listing = listDirectory(tree, "/docs/");
	assert.deepEqual(
		listing.dirs.map((entry) => entry.path),
		["/docs/guides/"],
	);
	assert.deepEqual(
		listing.files.map((entry) => entry.path),
		["/docs/guide.md"],
	);
});

void test("resolves slashless links through the directory surface", () => {
	assert.equal(persistedDirectoryPath(tree, "/docs"), "/docs/");
	assert.equal(persistedDirectoryPath(tree, "/README.md"), null);
});

void test("workspaceHasNoFiles reports an empty workspace", async () => {
	const lix = {
		execute: async () => ({ rows: [] }),
	} as never;

	assert.equal(await workspaceHasNoFiles(lix), true);
});

void test("workspaceHasNoFiles preserves SQL failures for boot error UI", async () => {
	const failure = new Error("workspace query failed");
	const lix = {
		execute: async () => {
			throw failure;
		},
	} as never;

	await assert.rejects(
		workspaceHasNoFiles(lix),
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

	assert.equal(await createWorkspaceFolder(lix, "/"), "/new-folder/");
	assert.deepEqual(calls.at(-1), {
		sql: "INSERT INTO lix_directory (path) VALUES ($1)",
		params: ["/new-folder/"],
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

	assert.equal(await createWorkspaceFolder(lix, "/"), "/new-folder-1/");
});
