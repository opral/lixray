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

void test("prepares the exact file and active branch before document SQL", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("SELECT 1");

	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		[HEAD_QUERY, FILE_QUERY, "prepare", HEAD_QUERY, "SELECT 1"],
	);
	assert.deepEqual(calls[1]?.params, ["file-1"]);
});

void test("prepares once per branch and rechecks the same stable file id", async () => {
	const { lix, calls, switchBranch } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });

	await scoped.execute("SELECT 1");
	switchBranch("draft");
	await scoped.execute("SELECT 2");
	await scoped.execute("SELECT 3");

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

	await scoped.execute("SELECT 1");
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

	await assert.rejects(scoped.execute("SELECT 1"), /offline/);
	await scoped.execute("SELECT 2");

	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 2);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 1);
	assert.equal(calls.at(-1)?.sql, "SELECT 2");
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

	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 2);
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

void test("does not treat a mismatched exact file row as an absent file", async () => {
	const { lix, calls } = mockLix({
		fileReads: [{ id: "different-file", content: new Uint8Array([1]) }],
	});
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const historicalSql =
		"SELECT id, content FROM lix_as_of('lix_file', $1) WHERE id = $2";

	await assert.rejects(scoped.execute(historicalSql, ["commit-old", "file-1"]));
	assert.equal(
		calls.some((call) => call.sql === historicalSql),
		false,
	);
});

void test("defers the first document observation until preparation finishes", async () => {
	const { lix, calls } = mockLix();
	const scoped = withNativeFileWorkingScope(lix, { fileId: "file-1" });
	const observation = scoped.observe("SELECT commit_id");

	assert.equal(calls.length, 0);
	assert.deepEqual(await observation.next(), { done: false, value: "event" });
	assert.deepEqual(
		calls.map((call) => call.sql ?? call.method),
		[HEAD_QUERY, FILE_QUERY, "prepare", HEAD_QUERY, "SELECT commit_id"],
	);
});

void test("returning an observation during preparation does not start its native observer", async () => {
	const offline = Object.assign(new Error("offline"), {
		code: "LIX_PARTIAL_REPLICA_OFFLINE",
	});
	const { lix, calls } = mockLix({
		fileReads: [offline, { id: "file-1", content: new Uint8Array([1]) }],
	});
	let retryStarted!: () => void;
	let releaseRetry!: () => void;
	const started = new Promise<void>((resolve) => {
		retryStarted = resolve;
	});
	const retryGate = new Promise<void>((resolve) => {
		releaseRetry = resolve;
	});
	const scoped = withNativeFileWorkingScope(lix, {
		fileId: "file-1",
		retryDelaysMs: [1],
		delay: async () => {
			retryStarted();
			await retryGate;
		},
	});
	const observation = scoped.observe("SELECT commit_id");
	const pendingNext = observation.next();
	await started;
	await observation.return?.();
	releaseRetry();

	assert.deepEqual(await pendingNext, { done: true, value: undefined });
	assert.equal(
		calls.some((call) => call.method === "observe"),
		false,
	);
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

	await assert.rejects(scoped.execute("SELECT 1"), /unauthorized/);
	assert.equal(calls.filter((call) => call.sql === FILE_QUERY).length, 1);
	assert.equal(calls.filter((call) => call.method === "prepare").length, 0);
});
