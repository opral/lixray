import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

interface MockOpenOptions {
	onProgress?: (progress: { phase: "migrating"; toFormat: number }) => void;
	storage?: { options: { name: string } };
	server: { mode: string; headers: () => Promise<Record<string, string>> };
	telemetry?: { parentContext?: () => { traceparent: string } | undefined };
}
let activeTelemetryParent: { traceparent: string } | undefined;
let observedOpeningParent: { traceparent: string } | undefined;
const opens: MockOpenOptions[] = [];
const routedNames: string[] = [];
let replacementName: string | undefined;
let replacements = 0;
let failures: Error[] = [];
let emitMigration = false;
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
			observedOpeningParent = options.telemetry?.parentContext?.();
			if (emitMigration)
				options.onProgress?.({ phase: "migrating", toFormat: 81 });
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
mock.module("../browser-telemetry.ts", {
	namedExports: {
		lixTelemetryParentContext: () => activeTelemetryParent,
		createLixTelemetryOptions: () => ({
			onExport() {},
			parentContext: () => activeTelemetryParent,
		}),
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
		currentReplicaStorage: (name: string) => {
			routedNames.push(name);
			return `${name}:format81:current`;
		},
	},
});
mock.module("./repository-replica-replacement.ts", {
	namedExports: {
		activeReplicaStorage: (name: string) => replacementName ?? name,
		retainedReplicaCount: () => replacements,
		replaceRepositoryReplica: async ({ source }: { source: string }) => {
			replacements++;
			return (replacementName = `${source}:replacement:test`);
		},
	},
});
const { openRepositoryLixSession } =
	await import("./repository-lix-session.ts");
beforeEach(() => {
	activeTelemetryParent = undefined;
	observedOpeningParent = undefined;
	replacementName = undefined;
	replacements = 0;
	opens.length = 0;
	emitMigration = false;
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

await test("startup retains its parent across replica identity await, then releases it", async () => {
	const parent = {
		traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
	};
	activeTelemetryParent = parent;
	const opening = openRepositoryLixSession(options());
	const unrelatedParent = {
		traceparent: "00-22222222222222222222222222222222-2222222222222222-01",
	};
	activeTelemetryParent = unrelatedParent;
	const session = await opening;
	assert.deepEqual(observedOpeningParent, parent);
	assert.deepEqual(opens[0]?.telemetry?.parentContext?.(), unrelatedParent);
	activeTelemetryParent = undefined;
	await session.close();
});

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
		"lix-replica-id": opens[0].storage!.options.name,
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

await test("SDK server upgrade progress reaches UI and clears after success or failure", async () => {
	for (const publicPath of [undefined, "README.md"]) {
		for (const fail of [false, true]) {
			emitMigration = true;
			if (fail)
				failures.push(
					Object.assign(new Error("upgrade failed"), {
						code: "LIX_REPOSITORY_OPEN_FAILED",
					}),
				);
			const updates: unknown[] = [];
			const pending = openRepositoryLixSession({
				...options(),
				publicPath,
				onMigration: (state) => updates.push(state),
			});
			if (fail) await assert.rejects(pending, /upgrade failed/);
			else await (await pending).close();
			assert.deepEqual(updates, [
				{ fromVersion: undefined, toVersion: 81, phase: "migrating" },
				null,
			]);
		}
	}
});

await test("opens the same replica after a temporary storage owner releases its lock", async () => {
	const locked = Object.assign(new Error("owned elsewhere"), {
		code: "LIX_STORAGE_IN_USE",
	});
	failures = [locked, locked];
	const session = await openRepositoryLixSession(options());
	assert.equal(opens.length, 3);
	assert.equal(
		new Set(opens.map((open) => open.storage!.options.name)).size,
		1,
	);
	assert.equal(handles.length, 1);
	assert.equal(session.activeBranchSnapshot(), "main");
	await session.close();
});
await test("persistent ownership replaces once and stops if the replacement cannot open", async () => {
	const locked = Object.assign(new Error("owned elsewhere"), {
		code: "LIX_STORAGE_IN_USE",
	});
	failures = Array.from({ length: 8 }, () => locked);
	await assert.rejects(
		openRepositoryLixSession(options()),
		(error) => error === locked,
	);
	assert.equal(opens.length, 8);
	assert.equal(replacements, 1);
	assert.equal(failures.length, 0);
	assert.equal(
		new Set(opens.map((open) => open.storage!.options.name)).size,
		2,
	);
	assert.equal(handles.length, 0);
});
await test("cancelling storage-lock backoff stops retries", async () => {
	const controller = new AbortController();
	failures = [
		Object.assign(new Error("owned elsewhere"), { code: "LIX_STORAGE_IN_USE" }),
	];
	const opening = openRepositoryLixSession({
		...options(),
		signal: controller.signal,
	});
	const rejected = assert.rejects(opening, { name: "AbortError" });
	while (opens.length === 0)
		await new Promise((resolve) => setTimeout(resolve, 1));
	controller.abort();
	await rejected;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(opens.length, 1);
	assert.equal(handles.length, 0);
});
await test("unrelated storage failures are not retried", async () => {
	const fenced = Object.assign(new Error("fenced"), {
		code: "LIX_STORAGE_UNSUPPORTED",
	});
	failures = [fenced];
	await assert.rejects(
		openRepositoryLixSession(options()),
		(error) => error === fenced,
	);
	assert.equal(opens.length, 1);
	assert.equal(handles.length, 0);
});

await test("persistent compatible-owner fencing opens a fresh server-backed replica", async () => {
	failures = Array.from({ length: 7 }, () =>
		Object.assign(new Error("compatible owner"), {
			code: "LIX_STORAGE_FENCED",
		}),
	);
	const session = await openRepositoryLixSession(options());
	assert.equal(replacements, 1);
	assert.equal(opens.length, 8);
	assert.equal(opens[7].storage!.options.name, replacementName);
	assert.equal(
		(await opens[7].server.headers())["lix-replica-id"],
		replacementName,
	);
	assert.equal(session.retainedReplicaCount, 1);
	await session.close();
});
