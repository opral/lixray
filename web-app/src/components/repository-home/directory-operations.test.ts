import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { unzipSync } from "fflate";
import {
	loadDirectoryOperationsForTest,
	openDirectoryTestLix,
} from "./directory-operations-test-loader.ts";

const {
	collectDroppedWorkspaceEntries,
	createNamedWorkspaceFolder,
	deleteWorkspaceEntries,
	importWorkspaceEntries,
	moveWorkspaceEntries,
	prepareWorkspaceDownload,
	renameWorkspaceEntry,
} = await loadDirectoryOperationsForTest();

async function fixture() {
	const lix = await openDirectoryTestLix();
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
		"/target",
	]);
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
		"/source",
	]);
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
		"/source/empty",
	]);
	await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
		"/source/note.md",
		new TextEncoder().encode("keep me"),
	]);
	await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
		"/a.txt",
		new TextEncoder().encode("hello"),
	]);
	return lix;
}

async function paths(lix: Lix, kind: "file" | "directory") {
	return (
		await lix.execute(`SELECT path FROM lix_${kind} ORDER BY path`, [])
	).rows.map((row) => row.path);
}

void test("named folders persist the chosen name and reject file/folder collisions", async () => {
	const lix = await fixture();
	try {
		assert.equal(
			await createNamedWorkspaceFolder(lix, "/target", "  My folder  "),
			"/target/My folder",
		);
		assert.ok((await paths(lix, "directory")).includes("/target/My folder"));
		await assert.rejects(
			createNamedWorkspaceFolder(lix, "/", "A.TXT"),
			/already exists/,
		);
		await assert.rejects(
			createNamedWorkspaceFolder(lix, "/", ".."),
			/Enter a name/,
		);
		await assert.rejects(
			createNamedWorkspaceFolder(lix, "/missing/", "folder"),
			/no longer exists/,
		);
	} finally {
		await lix.close();
	}
});

void test("bulk move preserves file contents and empty descendants, and deduplicates ancestor selections", async () => {
	const lix = await fixture();
	try {
		assert.deepEqual(
			await moveWorkspaceEntries(
				lix,
				["/source", "/source/note.md", "/a.txt"],
				"/target",
			),
			["/target/source", "/target/a.txt"],
		);
		assert.deepEqual(await paths(lix, "file"), [
			"/target/a.txt",
			"/target/source/note.md",
		]);
		assert.ok((await paths(lix, "directory")).includes("/target/source/empty"));
		const download = await prepareWorkspaceDownload(lix, [
			"/target/source/note.md",
		]);
		assert.equal(new TextDecoder().decode(download.bytes), "keep me");
	} finally {
		await lix.close();
	}
});

void test(
	"bulk move keeps root reads and live queries usable until the whole move commits",
	{ timeout: 15_000 },
	async () => {
		const lix = await fixture();
		const query = "SELECT path FROM lix_file ORDER BY path";
		const originalFiles = ["/a.txt", "/source/note.md"];
		const events = lix.observe(query);
		let during: ReturnType<Lix["observe"]> | undefined;
		let move: Promise<string[]> | undefined;
		let transaction: Awaited<ReturnType<Lix["beginTransaction"]>> | undefined;
		let release = () => {};
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStaged = () => {};
		const staged = new Promise<void>((resolve) => {
			markStaged = resolve;
		});
		let begins = 0;
		async function bounded<T>(promise: Promise<T>): Promise<T> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Root query or move stalled")),
							3_000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		try {
			const wrapped = {
				// Deliberately expose only the originating handle's transaction API:
				// an app workaround opening another session would fail this regression.
				beginTransaction: async () => {
					begins++;
					const native = await lix.beginTransaction();
					transaction = native;
					let firstWrite = true;
					return {
						execute: async (
							sql: string,
							params: Parameters<Lix["execute"]>[1],
						) => {
							const result = await native.execute(sql, params);
							if (firstWrite && /^UPDATE/i.test(sql)) {
								firstWrite = false;
								markStaged();
								await paused;
							}
							return result;
						},
						commit: () => native.commit(),
						rollback: () => native.rollback(),
					};
				},
			} as unknown as Lix;
			move = moveWorkspaceEntries(wrapped, ["/source", "/a.txt"], "/target");
			await bounded(
				Promise.race([
					staged,
					move.then(() => {
						throw new Error("Move completed without staging a write");
					}),
				]),
			);
			assert.equal(begins, 1);
			assert.ok(transaction);
			assert.deepEqual(
				(await transaction.execute(query)).rows.map((row) => row.path),
				["/a.txt", "/target/source/note.md"],
			);
			assert.deepEqual(await bounded(paths(lix, "file")), originalFiles);
			assert.deepEqual(await bounded(paths(lix, "directory")), [
				"/source",
				"/source/empty",
				"/target",
			]);

			// Evaluate the pre-existing observer only after the move has staged a
			// write, exercising the old active-transaction read guard directly.
			assert.deepEqual(
				(await bounded(events.next()))?.result.rows.map((row) => row.path),
				originalFiles,
			);

			// A newly mounted directory view must also register successfully while
			// the same root handle has a staged transaction.
			during = lix.observe(query);
			assert.deepEqual(
				(await bounded(during.next()))?.result.rows.map((row) => row.path),
				originalFiles,
			);
			const committedUpdate = events.next();
			assert.equal(
				await Promise.race([
					committedUpdate.then(() => "event"),
					new Promise<"pending">((resolve) =>
						setTimeout(() => resolve("pending"), 100),
					),
				]),
				"pending",
				"staged moves must not emit partial file-list changes",
			);
			release();
			assert.deepEqual(await bounded(move), [
				"/target/source",
				"/target/a.txt",
			]);
			const movedFiles = ["/target/a.txt", "/target/source/note.md"];
			assert.deepEqual(
				(await bounded(committedUpdate))?.result.rows.map((row) => row.path),
				movedFiles,
			);
			assert.deepEqual(await paths(lix, "file"), movedFiles);
			assert.deepEqual(await paths(lix, "directory"), [
				"/target",
				"/target/source",
				"/target/source/empty",
			]);
			for (const [path, expected] of [
				["/target/source/note.md", "keep me"],
				["/target/a.txt", "hello"],
			] as const) {
				const download = await prepareWorkspaceDownload(lix, [path]);
				assert.equal(new TextDecoder().decode(download.bytes), expected);
			}
		} finally {
			release();
			await move?.catch(() => undefined);
			during?.close();
			events.close();
			await lix.close();
		}
	},
);

void test("cycle, case-insensitive collision and duplicate target failures preserve every source", async () => {
	const lix = await fixture();
	try {
		await assert.rejects(
			moveWorkspaceEntries(lix, ["/source/"], "/source/empty/"),
			/itself/,
		);
		await assert.rejects(
			moveWorkspaceEntries(lix, ["/source/"], "/source/"),
			/itself/,
		);
		await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
			"/target/A.TXT",
			new Uint8Array(),
		]);
		await assert.rejects(
			moveWorkspaceEntries(lix, ["/source/", "/a.txt"], "/target/"),
			/already exists/,
		);
		assert.ok((await paths(lix, "directory")).includes("/source"));
		assert.ok((await paths(lix, "file")).includes("/a.txt"));
		await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
			"/source/a.txt",
			new Uint8Array(),
		]);
		await assert.rejects(
			moveWorkspaceEntries(lix, ["/a.txt", "/source/a.txt"], "/source/empty/"),
			/Multiple selected/,
		);
	} finally {
		await lix.close();
	}
});

void test("an unexpected error in the second write rolls back the first move", async () => {
	const lix = await fixture();
	try {
		const wrapped = {
			beginTransaction: async () => {
				const transaction = await lix.beginTransaction();
				let updates = 0;
				return {
					execute: (sql: string, params: Parameters<Lix["execute"]>[1]) => {
						if (/^UPDATE/i.test(sql) && ++updates === 2)
							throw new Error("Connection interrupted");
						return transaction.execute(sql, params);
					},
					commit: () => transaction.commit(),
					rollback: () => transaction.rollback(),
				};
			},
		} as unknown as Lix;
		await assert.rejects(
			moveWorkspaceEntries(wrapped, ["/source/", "/a.txt"], "/target/"),
			/Connection interrupted/,
		);
		assert.deepEqual(await paths(lix, "file"), ["/a.txt", "/source/note.md"]);
	} finally {
		await lix.close();
	}
});

void test("rename preserves descendant IDs and bulk delete removes directory descendants", async () => {
	const lix = await fixture();
	try {
		const before = (
			await lix.execute("SELECT id FROM lix_file WHERE path = $1", [
				"/source/note.md",
			])
		).rows[0]!.id;
		assert.equal(
			await renameWorkspaceEntry(lix, "/source/", "Notes"),
			"/Notes",
		);
		assert.equal(
			(
				await lix.execute("SELECT id FROM lix_file WHERE path = $1", [
					"/Notes/note.md",
				])
			).rows[0]!.id,
			before,
		);
		assert.equal(await renameWorkspaceEntry(lix, "/Notes/", "notes"), "/notes");
		await assert.rejects(
			renameWorkspaceEntry(lix, "/notes/", "TARGET"),
			/already exists/,
		);
		await deleteWorkspaceEntries(lix, ["/notes/", "/notes/note.md", "/a.txt"]);
		assert.deepEqual(await paths(lix, "file"), []);
		assert.deepEqual(await paths(lix, "directory"), ["/target"]);
	} finally {
		await lix.close();
	}
});

void test("folder import preserves empty folders and nested bytes without replacing existing items", async () => {
	const lix = await fixture();
	try {
		const result = await importWorkspaceEntries(lix, "/target/", [
			{ kind: "directory", path: "photos/empty" },
			{
				kind: "file",
				path: "photos/nested/test.bin",
				file: new File([new Uint8Array([0, 255, 1])], "test.bin"),
			},
		]);
		assert.deepEqual(result, { imported: 1, failed: [] });
		assert.ok((await paths(lix, "directory")).includes("/target/photos/empty"));
		const zip = unzipSync(
			(await prepareWorkspaceDownload(lix, ["/target/photos/"])).bytes,
		);
		assert.ok("photos/empty/" in zip);
		assert.deepEqual(
			zip["photos/nested/test.bin"],
			new Uint8Array([0, 255, 1]),
		);
		assert.deepEqual(
			await importWorkspaceEntries(lix, "/target/", [
				{
					kind: "file",
					path: "photos/new.txt",
					file: new File(["new"], "new.txt"),
				},
			]),
			{ imported: 0, failed: ["photos"] },
		);
		assert.deepEqual(
			await importWorkspaceEntries(lix, "/", [
				{
					kind: "file",
					path: "../bad.txt",
					file: new File(["bad"], "bad.txt"),
				},
			]),
			{ imported: 0, failed: ["../bad.txt"] },
		);
		assert.deepEqual(
			await importWorkspaceEntries(lix, "/", [
				{ kind: "file", path: "/bad.txt", file: new File(["bad"], "bad.txt") },
			]),
			{ imported: 0, failed: ["/bad.txt"] },
		);
		assert.deepEqual(
			await importWorkspaceEntries(lix, "/", [
				{ kind: "directory", path: "vacant" },
			]),
			{ imported: 1, failed: [] },
		);
	} finally {
		await lix.close();
	}
});

void test("downloads reject duplicate names instead of silently dropping files", async () => {
	const lix = await fixture();
	try {
		await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
			"/source/a.txt",
			new TextEncoder().encode("different"),
		]);
		await assert.rejects(
			prepareWorkspaceDownload(lix, ["/a.txt", "/source/a.txt"]),
			/duplicate names/,
		);
		const download = await prepareWorkspaceDownload(lix, [
			"/source/",
			"/source/a.txt",
			"/a.txt",
		]);
		const zip = unzipSync(download.bytes);
		assert.equal(new TextDecoder().decode(zip["a.txt"]), "hello");
		assert.equal(new TextDecoder().decode(zip["source/a.txt"]), "different");
	} finally {
		await lix.close();
	}
});

void test("drop traversal consumes all directory reader batches and keeps empty directories", async () => {
	const file = new File(["hello"], "hello.txt");
	const empty = {
		name: "empty",
		isDirectory: true,
		createReader: () => ({
			readEntries: (success: (entries: unknown[]) => void) => success([]),
		}),
	};
	const batches = [
		[empty],
		[
			{
				name: "hello.txt",
				isDirectory: false,
				file: (success: (file: File) => void) => success(file),
			},
		],
		[],
	];
	const folder = {
		name: "folder",
		isDirectory: true,
		createReader: () => ({
			readEntries: (success: (entries: unknown[]) => void) =>
				success(batches.shift()!),
		}),
	};
	const transfer = {
		items: [
			{ kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null },
		],
		files: [],
	} as unknown as DataTransfer;
	const result = await collectDroppedWorkspaceEntries(transfer);
	assert.deepEqual(
		result.map(({ kind, path }) => ({ kind, path })),
		[
			{ kind: "directory", path: "folder" },
			{ kind: "directory", path: "folder/empty" },
			{ kind: "file", path: "folder/hello.txt" },
		],
	);
});
