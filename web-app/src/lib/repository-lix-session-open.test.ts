import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

interface MockOpenOptions {
	storage?: { options: { name: string } };
	server: { mode: string; headers: () => Promise<Record<string, string>> };
}
const opens: MockOpenOptions[] = [];
const routedNames: string[] = [];
let failures: Error[] = [];
let branch = "main";
let defaultBranch = "main";
let defaultSessionCalls = 0;
let defaultSessionCloses = 0;
let defaultQueryError: Error | undefined;
let defaultQueryFailures: Error[] = [];
const handles: { closeCalls: number }[] = [];
const defaultQueries: { sql: string; params: unknown[] }[] = [];
let switchFailures: Error[] = [];
let switchCalls = 0;
let createCalls = 0;
let currentHandle = { closeCalls: 0 };
mock.module("@lix-js/sdk", {
	namedExports: {
		openLix: async (options: MockOpenOptions) => {
			opens.push(options);
			const failure = failures.shift();
			if (failure) throw failure;
			const handle = (currentHandle = { closeCalls: 0 });
			handles.push(handle);
			return {
				activeBranchId: async () => branch,
				execute: async () => ({ rows: [{ value: "selected-branch-shadow" }] }),
				openAnotherSession: async ({ branchId }: { branchId: string }) => {
					assert.equal(branchId, "ffffffff-ffff-7fff-bfff-ffffffffffff");
					defaultSessionCalls += 1;
					return {
						execute: async (sql: string, params: unknown[]) => {
							defaultQueries.push({ sql, params });
							const failure = defaultQueryFailures.shift() ?? defaultQueryError;
							if (failure) throw failure;
							assert.match(sql, /FROM lix_key_value/);
							assert.match(
								sql,
								/WHERE key = \$1 AND lixcol_file_id IS NULL AND lixcol_untracked = false/,
							);
							assert.deepEqual(params, ["lix_default_branch_id"]);
							return { rows: [{ value: defaultBranch }] };
						},
						close: async () => {
							defaultSessionCloses += 1;
						},
					};
				},
				createBranch: async () => {
					createCalls += 1;
					return { id: "created" };
				},
				switchBranch: async ({ branchId }: { branchId: string }) => {
					switchCalls += 1;
					const failure = switchFailures.shift();
					if (failure) throw failure;
					return { branchId: (branch = branchId) };
				},
				close: async () => {
					handle.closeCalls += 1;
				},
			};
		},
		networkFetch: globalThis.fetch.bind(globalThis),
	},
});
mock.module("@lix-js/storage-opfs", {
	namedExports: {
		OpfsStorage: class {
			options: { name: string };
			constructor(options: { name: string }) {
				this.options = options;
			}
		},
	},
});
mock.module("./repository-opfs-cache.ts", {
	namedExports: {
		repositoryBrowserReplicaId: async (options: { authIdentity: string }) =>
			`${options.authIdentity}:replica`,
		repositoryOpfsCacheName: (options: {
			repositoryId: string;
			replicaId: string;
		}) => `lixray:local-first-v1:${options.repositoryId}:${options.replicaId}`,
	},
});
mock.module("./repository-migration.ts", {
	namedExports: {
		currentReplicaStorage: async (name: string) => {
			routedNames.push(name);
			return `${name}:format81:current`;
		},
	},
});
const { openRepositoryLixSession } =
	await import("./repository-lix-session.ts");
beforeEach(() => {
	opens.length = 0;
	routedNames.length = 0;
	failures = [];
	branch = "main";
	defaultBranch = "main";
	defaultSessionCalls = 0;
	defaultSessionCloses = 0;
	defaultQueryError = undefined;
	defaultQueryFailures = [];
	handles.length = 0;
	defaultQueries.length = 0;
	switchFailures = [];
	switchCalls = 0;
	createCalls = 0;
	currentHandle = { closeCalls: 0 };
});
let sequence = 0;
function options() {
	return {
		namespace: "acme",
		repositorySlug: `test-${++sequence}`,
		repositoryId: "01936f4e-7b6c-7c3d-8f9a-123456789abc",
		authIdentity: `user-${sequence}`,
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
	};
}

await test("browser opening explicitly selects partial replica and persistent per-user OPFS", async () => {
	const input = options();
	const session = await openRepositoryLixSession(input);
	assert.equal(opens[0].server.mode, "partial_replica");
	assert.equal(
		opens[0].storage!.options.name,
		`lixray:local-first-v1:${input.repositoryId}:${input.authIdentity}:replica:format81:current`,
	);
	assert.deepEqual(await opens[0].server.headers(), {
		Authorization: "Bearer token",
	});
	assert.equal(session.activeBranchSnapshot(), "main");
	await session.close();
});

await test("retries a recovering authority without remote fallback", async () => {
	failures = [
		Object.assign(new Error("recovering"), {
			code: "LIX_ERROR_RECOVERING",
		}),
	];
	const session = await openRepositoryLixSession(options());
	assert.equal(opens.length, 2);
	assert.ok(opens.every((open) => open.server.mode === "partial_replica"));
	assert.equal(opens[0].storage!.options.name, opens[1].storage!.options.name);
	await session.close();
});

await test("unrelated opening failures do not trigger conversion", async () => {
	const error = new Error("network unavailable");
	failures = [error];
	await assert.rejects(
		openRepositoryLixSession(options()),
		(value) => value === error,
	);
});

await test("initial branch selection uses the local partial session", async () => {
	const session = await openRepositoryLixSession({
		...options(),
		initialBranchId: "draft",
	});
	assert.equal(session.activeBranchSnapshot(), "draft");
	assert.equal(session.defaultBranchSnapshot(), "main");
	await session.close();
});

await test("pending initial branch admission keeps the opened sync worker alive", async () => {
	switchFailures = [
		Object.assign(new Error("pending upload"), {
			code: "LIX_PARTIAL_BRANCH_SWITCH_PENDING",
		}),
	];
	const session = await openRepositoryLixSession({
		...options(),
		initialBranchId: "draft",
	});
	assert.equal(opens.length, 1);
	assert.equal(currentHandle.closeCalls, 0);
	assert.equal(switchCalls, 2);
	assert.equal(session.activeBranchSnapshot(), "draft");
	await session.close();
});

await test("pending admission after creation retries only the switch", async () => {
	const session = await openRepositoryLixSession(options());
	switchFailures = [
		Object.assign(new Error("pending upload"), {
			code: "LIX_PARTIAL_BRANCH_SWITCH_PENDING",
		}),
	];
	assert.equal(await session.createBranch("draft"), "created");
	assert.equal(createCalls, 1);
	assert.equal(switchCalls, 2);
	assert.equal(currentHandle.closeCalls, 0);
	await session.close();
});

await test("cached branch selection does not replace the repository default", async () => {
	branch = "draft";
	const session = await openRepositoryLixSession({
		...options(),
		initialBranchId: "draft",
	});
	assert.equal(session.activeBranchSnapshot(), "draft");
	assert.equal(session.defaultBranchSnapshot(), "main");
	assert.equal(switchCalls, 0);
	await session.close();
});

await test("a route without a branch admits the tracked default after a cached branch reopen", async () => {
	branch = "draft";
	defaultBranch = "trunk";
	const session = await openRepositoryLixSession(options());
	assert.equal(session.activeBranchSnapshot(), "trunk");
	assert.equal(session.defaultBranchSnapshot(), "trunk");
	assert.equal(switchCalls, 1);
	await session.close();
});

await test("default lookup uses the tracked GLOBAL lane, excludes file scopes, and closes its session", async () => {
	branch = "draft";
	defaultBranch = "canonical-main";
	const session = await openRepositoryLixSession({
		...options(),
		initialBranchId: "draft",
	});
	assert.equal(session.defaultBranchSnapshot(), "canonical-main");
	assert.equal(defaultQueries.length, 1);
	assert.equal(defaultSessionCalls, 1);
	assert.equal(defaultSessionCloses, 1);
	assert.equal(currentHandle.closeCalls, 0);
	await session.close();
});

await test("failed default SQL closes both temporary and repository sessions", async () => {
	defaultQueryError = new Error("default query failed");
	await assert.rejects(
		openRepositoryLixSession(options()),
		/default query failed/,
	);
	assert.equal(defaultSessionCloses, 1);
	assert.equal(currentHandle.closeCalls, 1);
});

function pendingSwitchFailures() {
	return Array.from({ length: 7 }, () =>
		Object.assign(new Error("pending upload"), {
			code: "LIX_PARTIAL_BRANCH_SWITCH_PENDING",
		}),
	);
}

await test("exhausted initial admission preserves the cached branch and live handle", async () => {
	branch = "cached-draft";
	switchFailures = pendingSwitchFailures();
	const session = await openRepositoryLixSession(options());
	assert.equal(session.activeBranchSnapshot(), "cached-draft");
	assert.equal(session.defaultBranchSnapshot(), "main");
	assert.equal(opens.length, 1);
	assert.equal(switchCalls, 7);
	assert.equal(currentHandle.closeCalls, 0);
	assert.deepEqual((await session.lix.execute("SELECT value", [])).rows, [
		{ value: "selected-branch-shadow" },
	]);
	await session.switchBranch("main");
	assert.equal(session.activeBranchSnapshot(), "main");
	assert.equal(opens.length, 1);
	await session.close();
});

await test("explicit pending switch exhaustion still rejects and preserves active branch", async () => {
	const session = await openRepositoryLixSession(options());
	switchFailures = pendingSwitchFailures();
	await assert.rejects(
		session.switchBranch("draft"),
		(error) =>
			(error as { code: string }).code === "LIX_PARTIAL_BRANCH_SWITCH_PENDING",
	);
	assert.equal(session.activeBranchSnapshot(), "main");
	assert.equal(currentHandle.closeCalls, 0);
	await session.close();
});

await test("retry after exhausted create admission reuses the created branch ID", async () => {
	const session = await openRepositoryLixSession(options());
	switchFailures = pendingSwitchFailures();
	await assert.rejects(
		session.createBranch("draft"),
		(error) =>
			(error as { code: string }).code === "LIX_PARTIAL_BRANCH_SWITCH_PENDING",
	);
	assert.equal(createCalls, 1);
	assert.equal(session.activeBranchSnapshot(), "main");
	assert.equal(await session.createBranch("draft"), "created");
	assert.equal(createCalls, 1);
	assert.equal(switchCalls, 8);
	assert.equal(currentHandle.closeCalls, 0);
	await session.close();
});

await test("a retained creation does not consume another name's action", async () => {
	const session = await openRepositoryLixSession(options());
	switchFailures = [new Error("switch transport unavailable")];
	await assert.rejects(
		session.createBranch("first"),
		/switch transport unavailable/,
	);
	assert.equal(await session.createBranch("second"), "created");
	assert.equal(createCalls, 2);
	await session.switchBranch("main");
	assert.equal(await session.createBranch("first"), "created");
	assert.equal(
		createCalls,
		2,
		"the original source/name retry still owns its first receipt",
	);
	await session.close();
});

await test("published-path sessions remain remote and avoid native storage and GLOBAL queries", async () => {
	const session = await openRepositoryLixSession({
		...options(),
		publicPath: "/published.md",
		allowAnonymous: true,
		getAccessToken: async () => null,
	});
	assert.equal(opens[0].server.mode, "remote");
	assert.equal(opens[0].storage, undefined);
	assert.equal(defaultSessionCalls, 0);
	assert.deepEqual(await opens[0].server.headers(), {
		"X-Lixray-Public-Path": "/published.md",
	});
	await session.close();
});

await test("read expiration is not replayed by the frontend or used to replace the persistent cache", async () => {
	const expired = Object.assign(new Error("read expired"), {
		code: "LIX_STORAGE_READ_EXPIRED",
	});
	failures = Array.from({ length: 7 }, () => expired);
	await assert.rejects(
		openRepositoryLixSession(options()),
		(error) => error === expired,
	);
	assert.equal(opens.length, 1);
	assert.ok(
		opens.every(
			(open) => open.storage!.options.name === opens[0].storage!.options.name,
		),
	);
});

await test("expired default-branch execution marked completed is never replayed", async () => {
	defaultQueryError = Object.assign(new Error("completion failed"), {
		code: "LIX_STORAGE_READ_EXPIRED",
		details: { nonRetryableAfterExecution: true },
	});
	await assert.rejects(
		openRepositoryLixSession(options()),
		(error) => error === defaultQueryError,
	);
	assert.equal(defaultQueries.length, 1);
	assert.equal(defaultSessionCloses, 1);
	assert.deepEqual(
		handles.map((handle) => handle.closeCalls),
		[1],
	);
});
