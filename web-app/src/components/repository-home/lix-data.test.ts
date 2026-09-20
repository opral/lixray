import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { EntryKind } from "../../lib/entry-kind.ts";
import {
	isOptionalHistoryInventoryUnavailable,
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
	assert.match(CHECKPOINT_SUMMARY_SQL, /FROM lix_log\(\) WHERE is_checkpoint/i);
	assert.match(CHECKPOINT_SUMMARY_SQL, /ORDER BY position/i);
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
	// counts, one row per changed file. Keep explicit columns to avoid
	// projecting file content into a metadata-only listing.
	assert.match(WORKING_FILE_DIFF_SQL, /FROM lix_diff\('lix_file'\)/);
	assert.doesNotMatch(WORKING_FILE_DIFF_SQL, /SELECT \*/);
	for (const column of ["diff_type", "from_path", "to_path"])
		assert.match(WORKING_FILE_DIFF_SQL, new RegExp(column));
	assert.match(WORKING_FILE_DIFF_SQL, /coalesce\(to_path, from_path\) AS path/);
	assert.doesNotMatch(WORKING_CHANGE_SQL, /row_count/);
});

void test("words the Changes headline like the status bar", () => {
	assert.deepEqual(describeWorkingChanges(1), {
		count: 1,
		label: "file changed since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(3), {
		count: 3,
		label: "files changed since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(0), {
		count: 0,
		label: "files changed since checkpoint",
	});
	assert.deepEqual(describeWorkingChanges(null), {
		count: 0,
		label: "files changed since checkpoint",
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
	const creationIds: unknown[] = [];
	const lix = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			const path = String(params[0]);
			if (sql.startsWith("SELECT")) {
				return { rows: paths.has(path) ? [{}] : [] };
			}
			inserts.push(path);
			creationIds.push(params[2]);
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
	assert.equal(new Set(creationIds).size, 1);
	assert.equal(typeof creationIds[0], "string");
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

void test("only optional whole-history inventories treat the typed partial boundary as unavailable", () => {
	const unsupported = Object.assign(new Error("inventory is not complete"), {
		code: "LIX_PARTIAL_REPLICA_SCOPE_UNSUPPORTED",
	});
	assert.equal(
		isOptionalHistoryInventoryUnavailable(CHECKPOINT_SUMMARY_SQL, unsupported),
		true,
	);
	assert.equal(
		isOptionalHistoryInventoryUnavailable(CHANGE_SUMMARY_SQL, unsupported),
		true,
	);
	assert.equal(
		isOptionalHistoryInventoryUnavailable(WORKING_CHANGE_SQL, unsupported),
		false,
	);
	assert.equal(
		isOptionalHistoryInventoryUnavailable(
			"SELECT content FROM lix_file",
			unsupported,
		),
		false,
	);
	assert.equal(
		isOptionalHistoryInventoryUnavailable(
			CHANGE_SUMMARY_SQL,
			new Error(unsupported.message),
		),
		false,
	);
	assert.equal(
		isOptionalHistoryInventoryUnavailable(
			CHANGE_SUMMARY_SQL,
			Object.assign(new Error("offline"), { code: "LIX_NETWORK_ERROR" }),
		),
		false,
	);
});

void test("concurrent file creators retry an atomically rejected name without overwriting", async () => {
	const { openDirectoryTestLix } =
		await import("./directory-operations-test-loader.ts");
	const first = await openDirectoryTestLix();
	const second = await first.openAnotherSession();
	let readers = 0;
	let release!: () => void;
	const bothRead = new Promise<void>((resolve) => {
		release = resolve;
	});
	const session = (lix: Lix) =>
		({
			execute: async (sql: string, params: ReadonlyArray<unknown>) => {
				if (sql.startsWith("SELECT") && params[0] === "/untitled.md") {
					const result = await lix.execute(
						sql,
						params as Parameters<Lix["execute"]>[1],
					);
					if (result.rows.length === 0 && readers < 2) {
						readers += 1;
						if (readers === 2) release();
						await bothRead;
					}
					return result;
				}
				return lix.execute(sql, params as Parameters<Lix["execute"]>[1]);
			},
		}) as unknown as Lix;
	try {
		const created = await Promise.all([
			createRepositoryFile(session(first), "/", "md"),
			createRepositoryFile(session(second), "/", "md"),
		]);
		assert.deepEqual(created.sort(), ["/untitled-1.md", "/untitled.md"]);
		assert.equal(readers, 2);
		const rows = (
			await first.execute(
				"SELECT id, path FROM lix_file WHERE path IN ('/untitled.md', '/untitled-1.md') ORDER BY path",
			)
		).rows;
		assert.equal(rows.length, 2);
		assert.notEqual(rows[0]!.id, rows[1]!.id);
		assert.deepEqual(
			rows.map((row) => row.path),
			created,
		);
	} finally {
		await second.close();
		await first.close();
	}
});

void test("file creation reconciles an accepted insert before retrying a conflict", async () => {
	const { openDirectoryTestLix } =
		await import("./directory-operations-test-loader.ts");
	const lix = await openDirectoryTestLix();
	let inserts = 0;
	const session = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			const result = await lix.execute(
				sql,
				params as Parameters<Lix["execute"]>[1],
			);
			if (sql.startsWith("INSERT INTO lix_file")) {
				inserts += 1;
				throw Object.assign(new Error("conflict reported after publication"), {
					code: "LIX_TRANSACTION_CONFLICT",
				});
			}
			return result;
		},
	} as unknown as Lix;
	try {
		assert.equal(
			await createRepositoryFile(session, "/", "md"),
			"/untitled.md",
		);
		assert.equal(inserts, 1);
		const rows = (
			await lix.execute(
				"SELECT id, path FROM lix_file WHERE path IN ('/untitled.md', '/untitled-1.md')",
			)
		).rows;
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.path, "/untitled.md");
	} finally {
		await lix.close();
	}
});

void test("file creation does not retry when exact identity reconciliation fails", async () => {
	let inserts = 0;
	const failure = new Error("reconciliation unavailable");
	const lix = {
		execute: async (sql: string) => {
			if (sql === "SELECT path FROM lix_file WHERE id = $1") throw failure;
			if (sql.startsWith("SELECT")) return { rows: [] };
			inserts += 1;
			throw Object.assign(new Error("conflict"), { code: "LIX_ERROR_UNIQUE" });
		},
	} as unknown as Lix;
	await assert.rejects(
		createRepositoryFile(lix, "/", "md"),
		(error) => error === failure,
	);
	assert.equal(inserts, 1);
});

void test("file creation never replays a marked conflict after an absent identity lookup", async () => {
	for (const code of ["LIX_TRANSACTION_CONFLICT", "LIX_STORAGE_READ_EXPIRED"]) {
		for (const marker of [
			"nonRetryableAfterCommit",
			"nonRetryableAfterExecution",
		]) {
			let inserts = 0;
			let reconciliations = 0;
			const failure = Object.assign(
				new Error("execution already crossed its retry boundary"),
				{
					code,
					details: { [marker]: true },
				},
			);
			const lix = {
				execute: async (sql: string) => {
					if (sql === "SELECT path FROM lix_file WHERE id = $1") {
						reconciliations += 1;
						return { rows: [] };
					}
					if (sql.startsWith("SELECT")) return { rows: [] };
					inserts += 1;
					throw failure;
				},
			} as unknown as Lix;
			await assert.rejects(
				createRepositoryFile(lix, "/", "md"),
				(error) => error === failure,
			);
			assert.equal(inserts, 1);
			assert.equal(reconciliations, 1);
		}
	}
});

void test("file creation retries only pure reads when completion bookkeeping expires", async () => {
	const { openDirectoryTestLix } =
		await import("./directory-operations-test-loader.ts");
	const lix = await openDirectoryTestLix();
	let nameFailures = 0;
	let identityFailures = 0;
	let inserts = 0;
	const expiry = () =>
		Object.assign(new Error("completed read bookkeeping expired"), {
			code: "LIX_STORAGE_READ_EXPIRED",
			details: { nonRetryableAfterExecution: true },
		});
	const session = {
		execute: async (sql: string, params: ReadonlyArray<unknown>) => {
			if (sql.startsWith("SELECT 1") && nameFailures++ < 2) throw expiry();
			if (
				sql === "SELECT path FROM lix_file WHERE id = $1" &&
				identityFailures++ < 2
			)
				throw expiry();
			const result = await lix.execute(
				sql,
				params as Parameters<Lix["execute"]>[1],
			);
			if (sql.startsWith("INSERT")) {
				inserts += 1;
				throw Object.assign(
					new Error("insert published before bookkeeping expired"),
					{
						code: "LIX_STORAGE_READ_EXPIRED",
						details: { nonRetryableAfterCommit: true },
					},
				);
			}
			return result;
		},
	} as unknown as Lix;
	try {
		assert.equal(
			await createRepositoryFile(session, "/", "md"),
			"/untitled.md",
		);
		assert.equal(inserts, 1);
		assert.equal(nameFailures, 3);
		assert.equal(identityFailures, 3);
		const rows = (
			await lix.execute(
				"SELECT id FROM lix_file WHERE path IN ('/untitled.md', '/untitled-1.md')",
			)
		).rows;
		assert.equal(rows.length, 1);
	} finally {
		await lix.close();
	}
});

void test("expired creation reads remain bounded and never reach an INSERT", async () => {
	let reads = 0;
	const failure = Object.assign(new Error("read keeps expiring"), {
		code: "LIX_STORAGE_READ_EXPIRED",
	});
	const lix = {
		execute: async (sql: string) => {
			assert.ok(sql.startsWith("SELECT"));
			reads += 1;
			throw failure;
		},
	} as unknown as Lix;
	await assert.rejects(
		createRepositoryFile(lix, "/", "md"),
		(error) => error === failure,
	);
	assert.equal(reads, 4);
});

void test("file name lookup retries a journal conflict before creating once", async () => {
	let reads = 0;
	let inserts = 0;
	const lix = {
		execute: async (sql: string) => {
			if (sql.startsWith("SELECT")) {
				if (reads++ === 0)
					throw Object.assign(new Error("read journal conflict"), {
						code: "LIX_TRANSACTION_CONFLICT",
						details: { nonRetryableAfterExecution: true },
					});
				return { rows: [] };
			}
			inserts += 1;
			return { rows: [] };
		},
	} as unknown as Lix;
	assert.equal(await createRepositoryFile(lix, "/", "md"), "/untitled.md");
	assert.equal(reads, 2);
	assert.equal(inserts, 1);
});
