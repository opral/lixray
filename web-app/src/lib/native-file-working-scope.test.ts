import assert from "node:assert/strict";
import { test } from "node:test";
import type { Lix } from "@lix-js/sdk";
import {
	NATIVE_FILE_SCOPE_UNAVAILABLE_CODE,
	withNativeFileWorkingScope,
} from "./native-file-working-scope.ts";

const FILE_QUERY = "SELECT id, content FROM lix_file WHERE id = $1";
const HEAD_QUERY = "SELECT lix_active_branch_commit_id() AS commit_id";

function mockLix(
	options: {
		branch?: string;
		fileReads?: Array<{ id: string; content: Uint8Array } | Error>;
		prepareOfflineEditing?: () => Promise<void>;
		observe?: () => AsyncIterableIterator<unknown>;
	} = {},
) {
	let branch = options.branch ?? "main";
	let head = `${branch}-head`;
	const calls: Array<{ method: string; sql?: string; params?: unknown[] }> = [];
	const fileReads = [
		...(options.fileReads ?? [{ id: "file-1", content: new Uint8Array([1]) }]),
	];
	const hasFileReadFixture = options.fileReads !== undefined;
	const lix = {
		activeBranchId: async () => branch,
		execute: async (sql: string, params: unknown[] = []) => {
			calls.push({ method: "execute", sql, params });
			if (sql === HEAD_QUERY)
				return { rows: [{ commit_id: head }], commit: null };
			if (sql === FILE_QUERY) {
				const next = hasFileReadFixture
					? fileReads.shift()
					: { id: "file-1", content: new Uint8Array([1]) };
				if (next instanceof Error) throw next;
				return { rows: next ? [next] : [] };
			}
			if (/^\s*(?:UPDATE|INSERT|DELETE)\b/i.test(sql)) {
				const before = head;
				head = `${head}-next`;
				return {
					rows: [{ value: 1 }],
					commit: { before, after: head },
				};
			}
			return { rows: [{ value: 1 }], commit: null };
		},
		prepareOfflineEditing: async () => {
			calls.push({ method: "prepare" });
			await options.prepareOfflineEditing?.();
		},
		executeBatch: async (statements: Array<{ sql: string }>) => {
			calls.push({ method: "executeBatch" });
			return {
				results: statements.map(({ sql }) => {
					calls.push({ method: "batch-statement", sql });
					return { rows: [{ value: 1 }], rowsAffected: 0 };
				}),
				commit: null,
			};
		},
		observe: (sql: string) => {
			calls.push({ method: "observe", sql });
			return (
				options.observe?.() ??
				({
					next: async () => ({ done: false, value: "event" }),
					return: async () => ({ done: true, value: undefined }),
					[Symbol.asyncIterator]() {
						return this;
					},
				} as AsyncIterableIterator<unknown>)
			);
		},
		switchBranch: async ({ branchId }: { branchId: string }) => {
			branch = branchId;
			head = `${branchId}-head`;
			return { branchId };
		},
	};
	return {
		lix: lix as unknown as Lix,
		calls,
		switchBranch: (id: string) => {
			branch = id;
			head = `${id}-head`;
		},
		setHead: (nextHead: string) => (head = nextHead),
	};
}

void test("prepares the exact file and active branch before a document mutation", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);

	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		[
			HEAD_QUERY,
			FILE_QUERY,
			"prepare",
			HEAD_QUERY,
			HEAD_QUERY,
			"UPDATE lix_file SET content = $1 WHERE id = $2",
		],
	);
	assert.deepEqual(calls[1]?.params, ["file-1"]);
});

void test("prepares once per branch and rechecks the same stable file id", async () => {
	const { lix, calls, switchBranch } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([1]),
		"file-1",
	]);
	switchBranch("draft");
	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);
	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([3]),
		"file-1",
	]);

	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 2);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 2);
	assert.deepEqual(
		calls.filter((call) => call.sql === FILE_QUERY).map((call) => call.params),
		[["file-1"], ["file-1"]],
	);
});

void test("retries only transient read-only preparation errors", async () => {
	const offline = Object.assign(new Error("offline"), {
		code: "LIX_PARTIAL_REPLICA_OFFLINE",
	});
	const { lix, calls } = mockLix({
		fileReads: [
			offline,
			offline,
			{ id: "file-1", content: new Uint8Array([1]) },
		],
	});
	const delays: number[] = [];
	const scoped = withNativeFileWorkingScope(lix, {
		fileId: "file-1",
		retryDelaysMs: [5, 10],
		delay: async (milliseconds) => {
			delays.push(milliseconds);
		},
	});

	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);

	assert.deepEqual(delays, [5, 10]);
	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 3);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 1);
	assert.equal(
		calls.at(-1)?.sql,
		"UPDATE lix_file SET content = $1 WHERE id = $2",
	);
});

void test("re-prepares when a native pull advances the active branch head", async () => {
	const { lix, calls, setHead } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([1]),
		"file-1",
	]);
	setHead("main-head-after-native-pull");
	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);

	assert.equal(calls.filter((call) => call.method === "prepare").length, 2);
	assert.equal(
		calls.at(-1)?.sql,
		"UPDATE lix_file SET content = $1 WHERE id = $2",
	);
	const writeIndex = calls.findIndex((call) => call.sql?.startsWith("UPDATE"));
	assert.ok(
		calls.slice(0, writeIndex).some((call) => call.method === "prepare"),
	);
});

void test("local write commit receipts advance the prepared head without another prepare", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);
	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([3]),
		"file-1",
	]);

	assert.equal(calls.filter((call) => call.method === "prepare").length, 1);
});

void test("a later document operation retries after preparation exhausted its budget", async () => {
	const offline = Object.assign(new Error("offline"), {
		code: "LIX_PARTIAL_REPLICA_OFFLINE",
	});
	const { lix, calls } = mockLix({
		fileReads: [offline, { id: "file-1", content: new Uint8Array([1]) }],
	});
	const scoped = withNativeFileWorkingScope(lix, {
		fileId: "file-1",
		retryDelaysMs: [],
		delay: async () => undefined,
	});

	await assert.rejects(
		scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
			new Uint8Array([1]),
			"file-1",
		]),
		/offline/,
	);
	await scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
		new Uint8Array([2]),
		"file-1",
	]);

	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 2);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 1);
	assert.equal(
		calls.at(-1)?.sql,
		"UPDATE lix_file SET content = $1 WHERE id = $2",
	);
});

void test("fails closed when the exact selected file is missing", async () => {
	const { lix, calls } = mockLix({ fileReads: [] });
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await assert.rejects(
		scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
			new Uint8Array([2]),
			"file-1",
		]),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === NATIVE_FILE_SCOPE_UNAVAILABLE_CODE,
	);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
	assert.equal(
		calls.some((call) => call.sql?.startsWith("UPDATE")),
		false,
	);
});

void test("allows a historical read when the current file row is absent", async () => {
	const { lix, calls } = mockLix({ fileReads: [] });
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const historicalSql =
		"SELECT id, content FROM lix_as_of('lix_file', $1) WHERE id = $2";

	await scoped.execute(historicalSql, ["commit-old", "file-1"]);

	assert.equal(calls.at(-1)?.sql, historicalSql);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
});

void test("a historical read with an absent current row does not ready writes", async () => {
	const { lix, calls } = mockLix({ fileReads: [] });
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const historicalSql =
		"SELECT id, content FROM lix_as_of('lix_file', $1) WHERE id = $2";

	await scoped.execute(historicalSql, ["commit-old", "file-1"]);
	await assert.rejects(
		scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
			new Uint8Array([2]),
			"file-1",
		]),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === NATIVE_FILE_SCOPE_UNAVAILABLE_CODE,
	);

	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 1);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
	assert.equal(
		calls.some((call) => call.sql?.startsWith("UPDATE")),
		false,
	);
});

void test("allows an observer to read history when the current file row is absent", async () => {
	const { lix, calls } = mockLix({ fileReads: [] });
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const historicalSql =
		"SELECT id, content FROM lix_as_of('lix_file', $1) WHERE id = $2";
	const observation = scoped.observe(historicalSql, ["commit-old", "file-1"]);

	assert.deepEqual(await observation.next(), { done: false, value: "event" });
	assert.equal(calls.at(-1)?.method, "observe");
	assert.equal(calls.at(-1)?.sql, historicalSql);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
});

void test("fails closed when the exact selected file lookup returns another file", async () => {
	const { lix, calls } = mockLix({
		fileReads: [{ id: "different-file", content: new Uint8Array([1]) }],
	});
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await assert.rejects(
		scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
			new Uint8Array([2]),
			"file-1",
		]),
	);
	assert.equal(
		calls.some((call) => call.sql?.startsWith("UPDATE")),
		false,
	);
});

void test("read-only SQL reaches Lix without waiting for offline write preparation", async () => {
	const prepareError = new Error(
		"offline preparation should not run for a read",
	);
	let prepareCalls = 0;
	const { lix, calls } = mockLix({
		prepareOfflineEditing: async () => {
			prepareCalls += 1;
			throw prepareError;
		},
	});
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	assert.deepEqual(await scoped.execute("SELECT 1"), {
		rows: [{ value: 1 }],
		commit: null,
	});
	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		["SELECT 1"],
	);
	assert.equal(prepareCalls, 0);
});

void test("a SELECT that invokes a Lix mutator still waits for preparation", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const mutationSql = 'SELECT commit_id FROM public."lix_revert_range"($1, $2)';

	await scoped.execute(mutationSql, ["before", "after"]);

	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		[HEAD_QUERY, FILE_QUERY, "prepare", HEAD_QUERY, HEAD_QUERY, mutationSql],
	);
});

void test("a first mutation waits for offline write preparation", async () => {
	let releasePreparation!: () => void;
	let preparationStarted!: () => void;
	const preparationGate = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	const started = new Promise<void>((resolve) => {
		preparationStarted = resolve;
	});
	const { lix, calls } = mockLix({
		prepareOfflineEditing: async () => {
			preparationStarted();
			await preparationGate;
		},
	});
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const write = scoped.execute(
		"UPDATE lix_file SET content = $1 WHERE id = $2",
		[new Uint8Array([2]), "file-1"],
	);

	await started;
	assert.equal(
		calls.some((call) => call.sql?.startsWith("UPDATE")),
		false,
	);
	releasePreparation();
	await write;
	assert.equal(
		calls.at(-1)?.sql,
		"UPDATE lix_file SET content = $1 WHERE id = $2",
	);
});

void test("a read-only batch reaches Lix without preparing the write frontier", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const readSql = "SELECT content FROM lix_as_of('lix_file', $1) WHERE id = $2";

	await scoped.executeBatch([
		{ sql: readSql, params: ["commit-old", "file-1"] },
		{ sql: "SELECT 1" },
	]);

	assert.deepEqual(
		calls.map((call) => call.method),
		["executeBatch", "batch-statement", "batch-statement"],
	);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
});

void test("a batch containing a SELECT Lix mutator waits for preparation", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const mutationSql = "SELECT commit_id FROM lix_undo()";

	await scoped.executeBatch([{ sql: "SELECT 1" }, { sql: mutationSql }]);

	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		[
			HEAD_QUERY,
			FILE_QUERY,
			"prepare",
			HEAD_QUERY,
			HEAD_QUERY,
			"executeBatch",
			"SELECT 1",
			mutationSql,
		],
	);
});

void test("explicit offline preparation remains available to callers", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.prepareOfflineEditing();

	assert.deepEqual(
		calls.map((call) => call.method),
		["prepare"],
	);
});

void test("returning an observation before the first next does not start its native observer", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const observation = scoped.observe("SELECT commit_id");

	await observation.return?.();

	assert.equal(
		calls.some((call) => call.method === "observe"),
		false,
	);
});

void test("the first document observation starts without write-frontier preparation", async () => {
	let prepareCalls = 0;
	const { lix, calls } = mockLix({
		prepareOfflineEditing: async () => {
			prepareCalls += 1;
			throw new Error("offline preparation should not run for an observer");
		},
	});
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const observation = scoped.observe("SELECT commit_id");

	assert.equal(calls.length, 0);
	assert.deepEqual(await observation.next(), { done: false, value: "event" });
	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		["SELECT commit_id"],
	);
	assert.equal(prepareCalls, 0);
});

void test("does not retry permanent preparation errors", async () => {
	const permanent = Object.assign(new Error("unauthorized"), {
		code: "LIX_FORBIDDEN",
	});
	const { lix, calls } = mockLix({ fileReads: [permanent] });
	const scoped = withNativeFileWorkingScope(lix, {
		fileId: "file-1",
		retryDelaysMs: [0, 0],
		delay: async () => undefined,
	});

	await assert.rejects(
		scoped.execute("UPDATE lix_file SET content = $1 WHERE id = $2", [
			new Uint8Array([2]),
			"file-1",
		]),
		/unauthorized/,
	);
	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 1);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
});
