import assert from "node:assert/strict";
import test from "node:test";
import {
	createR2WorkspaceRuntime,
	type MemoryLixBinding,
	type OpenMemoryLix,
} from "./workspace-runtime.ts";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const MAIN_BRANCH = "33333333-3333-4333-8333-333333333333";
const HOST_A = "branch-preview.example.workers.dev";
const HOST_B = "version-preview.example.workers.dev";

void test("independent runtimes share exact R2 state and revisions", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const first = runtime(openMemoryLix);
	const second = runtime(openMemoryLix);

	await expectOk(
		first.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	await setValue(first, storage, HOST_A, WORKSPACE_A, "shared", "first");

	const result = await getValue(second, storage, HOST_A, WORKSPACE_A, "shared");
	assert.deepEqual(result, { key: "shared", value: "first", revision: 1 });
	assert.ok(storage.has(`lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`));
});

void test("explicit preview hostname keeps synthetic MCP requests coherent and isolated", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());

	await expectOk(
		execute(
			service,
			storage,
			HOST_A,
			WORKSPACE_A,
			"SET",
			[text("from-mcp"), text("visible-to-api")],
			"lixray-container.invalid",
		),
	);
	assert.deepEqual(
		await getValue(service, storage, HOST_A, WORKSPACE_A, "from-mcp"),
		{ key: "from-mcp", value: "visible-to-api", revision: 1 },
	);
	assert.equal(
		await getValue(service, storage, HOST_B, WORKSPACE_A, "from-mcp"),
		null,
	);
	assert.equal(
		storage.has(
			`lixray-preview/v1/lixray-container.invalid/${WORKSPACE_A}.snapshot`,
		),
		false,
	);
});

void test("preview hostnames and workspace ids are isolated", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());

	await setValue(service, storage, HOST_A, WORKSPACE_A, "only", "host-a");
	assert.equal(
		await getValue(service, storage, HOST_B, WORKSPACE_A, "only"),
		null,
	);
	assert.equal(
		await getValue(service, storage, HOST_A, WORKSPACE_B, "only"),
		null,
	);
});

void test("bootstrap and concurrent conditional writes converge without loss", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const first = runtime(openMemoryLix);
	const second = runtime(openMemoryLix);

	await Promise.all([
		expectOk(
			first.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
		),
		expectOk(
			second.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
		),
	]);
	await Promise.all([
		setValue(first, storage, HOST_A, WORKSPACE_A, "left", "A"),
		setValue(second, storage, HOST_A, WORKSPACE_A, "right", "B"),
	]);

	const verifier = runtime(openMemoryLix);
	const left = await getValue(verifier, storage, HOST_A, WORKSPACE_A, "left");
	const right = await getValue(verifier, storage, HOST_A, WORKSPACE_A, "right");
	assert.ok(left && right);
	assert.deepEqual(
		{ key: left.key, value: left.value },
		{ key: "left", value: "A" },
	);
	assert.deepEqual(
		{ key: right.key, value: right.value },
		{ key: "right", value: "B" },
	);
	assert.deepEqual(new Set([left.revision, right.revision]), new Set([1, 2]));
});

void test("concurrent writes in one isolate replay the losing mutation", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const service = runtime(openMemoryLix);
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	storage.resetMetrics();

	await Promise.all([
		setValue(service, storage, HOST_A, WORKSPACE_A, "left", "A"),
		setValue(service, storage, HOST_A, WORKSPACE_A, "right", "B"),
	]);

	assert.equal(storage.putCalls.length, 3);
	assert.equal(
		storage.putCalls[0].etagMatches,
		storage.putCalls[1].etagMatches,
	);
	const left = await getValue(service, storage, HOST_A, WORKSPACE_A, "left");
	const right = await getValue(service, storage, HOST_A, WORKSPACE_A, "right");
	assert.ok(left && right);
	assert.deepEqual(new Set([left.revision, right.revision]), new Set([1, 2]));
});

void test("retry exhaustion returns a retryable 503 and preserves state", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	storage.conflictsRemaining = 5;

	const response = await execute(service, storage, HOST_A, WORKSPACE_A, "SET", [
		text("lost"),
		text("no"),
	]);
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("retry-after"), "1");
	assert.equal(await errorCode(response), "PREVIEW_STORAGE_CONFLICT");
	assert.equal(
		await getValue(
			runtime(snapshotBindingFactory()),
			storage,
			HOST_A,
			WORKSPACE_A,
			"lost",
		),
		null,
	);
});

void test("R2 failures and corrupt snapshots return distinct 503 errors", async () => {
	const unavailable = new FakeR2Bucket();
	unavailable.failGets = true;
	const service = runtime(snapshotBindingFactory());
	const failed = await service.fetch(
		unavailable.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/"),
	);
	assert.equal(failed.status, 503);
	assert.equal(await errorCode(failed), "PREVIEW_STORAGE_UNAVAILABLE");

	const failedPutStorage = new FakeR2Bucket();
	const failedPutService = runtime(snapshotBindingFactory());
	await expectOk(
		failedPutService.fetch(
			failedPutStorage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/"),
		),
	);
	failedPutStorage.failPuts = true;
	const failedPut = await execute(
		failedPutService,
		failedPutStorage,
		HOST_A,
		WORKSPACE_A,
		"SET",
		[text("not-committed"), text("value")],
	);
	assert.equal(failedPut.status, 503);
	assert.equal(await errorCode(failedPut), "PREVIEW_STORAGE_UNAVAILABLE");
	failedPutStorage.failPuts = false;
	assert.equal(
		await getValue(
			failedPutService,
			failedPutStorage,
			HOST_A,
			WORKSPACE_A,
			"not-committed",
		),
		null,
	);

	const corrupt = new FakeR2Bucket();
	const key = `lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`;
	await corrupt.putRaw(key, new Uint8Array([1, 2, 3]));
	const before = corrupt.bytes(key);
	const invalid = await runtime(snapshotBindingFactory()).fetch(
		corrupt.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/"),
	);
	assert.equal(invalid.status, 503);
	assert.equal(await errorCode(invalid), "PREVIEW_SNAPSHOT_INVALID");
	assert.deepEqual(corrupt.bytes(key), before);
});

void test("failed API operations never overwrite the committed snapshot", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	const key = `lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`;
	const before = storage.bytes(key);

	const failed = await execute(
		service,
		storage,
		HOST_A,
		WORKSPACE_A,
		"FAIL",
		[],
	);
	assert.equal(failed.status, 400);
	assert.equal(await errorCode(failed), "LIX_INVALID_ARGUMENT");
	assert.deepEqual(storage.bytes(key), before);
});

void test("active branch is shared and persisted across remote clients", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const first = runtime(openMemoryLix);
	const draftBranchId = "44444444-4444-4444-8444-444444444444";

	await expectOk(
		first.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branch/create", {
				id: draftBranchId,
				name: "Draft",
			}),
		),
	);
	await expectOk(
		first.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branch/switch", { branchId: draftBranchId }),
		),
	);

	const second = runtime(openMemoryLix);
	const handshake = await expectOk(
		second.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	assert.deepEqual(await handshake.json(), {
		protocolVersion: 1,
		activeBranchId: draftBranchId,
	});
	const active = await execute(
		second,
		storage,
		HOST_A,
		WORKSPACE_A,
		"ACTIVE_BRANCH",
		[],
	);
	await expectOk(active);
	const activeRows = singleExecuteRows(await active.json());
	assert.ok(Array.isArray(activeRows[0]));
	assert.equal(wireString(activeRows[0][0]), draftBranchId);

	const snapshotBytes = storage.bytes(
		`lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`,
	);
	assert.ok(snapshotBytes);
	const persisted = JSON.parse(
		new TextDecoder().decode(snapshotBytes),
	) as FakeState;
	assert.equal(persisted.activeBranchId, draftBranchId);
});

void test("filesystem sidecar restores the shared active branch", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	const draftBranchId = "44444444-4444-4444-8444-444444444445";

	await expectOk(
		service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branch/create", {
				id: draftBranchId,
				name: "Draft",
			}),
		),
	);
	await expectOk(
		service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branch/switch", { branchId: draftBranchId }),
		),
	);
	const mutation = await service.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/filesystem/mutate", {
			branchId: MAIN_BRANCH,
			kind: "file",
			path: "/missing.md",
			expectedRevision: "missing-revision",
			mutation: { type: "delete" },
		}),
	);
	assert.deepEqual(await mutation.json(), { outcome: "conflict" });
	const handshake = await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	const handshakeBody: unknown = await handshake.json();
	assert.ok(isRecord(handshakeBody));
	assert.equal(handshakeBody.activeBranchId, draftBranchId);
});

void test("conditional reads reuse cached snapshots without redundant writes", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const service = runtime(openMemoryLix);
	const key = `lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`;

	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	const initialEtag = storage.etag(key);
	storage.resetMetrics();

	assert.equal(
		await getValue(service, storage, HOST_A, WORKSPACE_A, "missing"),
		null,
	);
	assert.equal(storage.getCalls.length, 1);
	assert.equal(storage.getCalls[0].etagDoesNotMatch, initialEtag);
	assert.equal(storage.bodyReads, 0);
	assert.equal(storage.putCalls.length, 0);

	await setValue(
		runtime(openMemoryLix),
		storage,
		HOST_A,
		WORKSPACE_A,
		"shared",
		"new",
	);
	storage.resetMetrics();

	assert.deepEqual(
		await getValue(service, storage, HOST_A, WORKSPACE_A, "shared"),
		{ key: "shared", value: "new", revision: 1 },
	);
	assert.equal(storage.bodyReads, 1);
	assert.equal(storage.putCalls.length, 0);
	assert.equal(storage.getCalls[0].etagDoesNotMatch, initialEtag);

	await getValue(service, storage, HOST_A, WORKSPACE_A, "shared");
	assert.equal(storage.bodyReads, 1);
	assert.equal(storage.putCalls.length, 0);
});

void test("a stalled snapshot read does not block another request", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	storage.resetMetrics();
	const gate = storage.blockNextGet();

	const stalled = service.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/"),
	);
	await withTimeout(gate.started, 250);
	const concurrent = await withTimeout(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
		250,
	);
	assert.equal(concurrent.status, 200);
	assert.equal(storage.getCalls.length, 2);

	gate.release();
	await expectOk(stalled);
});

void test("an old snapshot response cannot regress the isolate cache", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	const gate = storage.blockNextGet();
	const staleRead = service.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/"),
	);
	await withTimeout(gate.started, 250);
	await setValue(service, storage, HOST_A, WORKSPACE_A, "newer", "state");
	const latestEtag = storage.etag(
		`lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`,
	);

	gate.release();
	await expectOk(staleRead);
	storage.resetMetrics();
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	assert.equal(storage.getCalls[0].etagDoesNotMatch, latestEtag);
});

void test("a stalled snapshot write does not block concurrent reads", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory());
	await expectOk(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
	);
	storage.resetMetrics();
	const gate = storage.blockNextPut();
	const stalled = execute(service, storage, HOST_A, WORKSPACE_A, "SET", [
		text("blocked"),
		text("write"),
	]);
	await withTimeout(gate.started, 250);

	const concurrent = await withTimeout(
		service.fetch(storage.bucket, HOST_A, WORKSPACE_A, request(HOST_A, "/")),
		250,
	);
	assert.equal(concurrent.status, 200);

	gate.release();
	await expectOk(stalled);
});

void test("single and multiplexed observers receive cross-isolate changes once", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const observerRuntime = runtime(openMemoryLix, 20);
	const writerRuntime = runtime(openMemoryLix);

	const singleResponse = await observerRuntime.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/observe", {
			sql: "GET",
			params: [wireText("single")],
		}),
	);
	const single = new SseReader(singleResponse);
	assert.equal((await single.next()).sequence, 0);
	await setValue(writerRuntime, storage, HOST_A, WORKSPACE_A, "single", "one");
	const changed = await single.next();
	assert.equal(changed.sequence, 1);
	assert.equal(changed.result.rows[0][1].value, "one");
	await setValue(writerRuntime, storage, HOST_A, WORKSPACE_A, "single", "two");
	const changedAgain = await single.next();
	assert.equal(changedAgain.sequence, 2);
	assert.equal(changedAgain.result.rows[0][1].value, "two");
	await single.close();

	const multiplexResponse = await observerRuntime.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/observe/multiplex", {
			subscriptions: [
				{ id: "left", sql: "GET", params: [wireText("left-watch")] },
				{ id: "right", sql: "GET", params: [wireText("right-watch")] },
			],
		}),
	);
	const multiplex = new SseReader(multiplexResponse);
	assert.deepEqual(
		new Set([
			(await multiplex.next()).subscriptionId,
			(await multiplex.next()).subscriptionId,
		]),
		new Set(["left", "right"]),
	);
	await setValue(
		writerRuntime,
		storage,
		HOST_A,
		WORKSPACE_A,
		"left-watch",
		"L",
	);
	assert.equal((await multiplex.next()).subscriptionId, "left");
	await setValue(
		writerRuntime,
		storage,
		HOST_A,
		WORKSPACE_A,
		"right-watch",
		"R",
	);
	assert.equal((await multiplex.next()).subscriptionId, "right");
	await multiplex.close();
});

void test("observer polling is shared, single-flight, and never queues ticks", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory(), 20);
	const first = new SseReader(
		await service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/observe", {
				sql: "GET",
				params: [wireText("watch")],
			}),
		),
	);
	const second = new SseReader(
		await service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/observe", {
				sql: "GET",
				params: [wireText("watch")],
			}),
		),
	);
	try {
		await first.next();
		await second.next();
		storage.resetMetrics();
		const gate = storage.blockNextGet();
		await withTimeout(gate.started, 250);
		await delay(70);
		assert.equal(storage.getCalls.length, 1);

		gate.release();
		await delay(5);
		assert.equal(storage.getCalls.length, 1);
		await delay(30);
		assert.ok(storage.getCalls.length >= 2);
		assert.ok(storage.getCalls.length <= 3);
	} finally {
		await first.close();
		await second.close();
	}
});

void test("local commits notify observers without an R2 wake poll", async () => {
	const storage = new FakeR2Bucket();
	const service = runtime(snapshotBindingFactory(), 60_000);
	const observer = new SseReader(
		await service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/observe", {
				sql: "GET",
				params: [wireText("local")],
			}),
		),
	);
	try {
		await observer.next();
		storage.resetMetrics();

		await setValue(service, storage, HOST_A, WORKSPACE_A, "local", "one");
		assert.equal((await observer.next()).result.rows[0][1].value, "one");
		assert.equal(storage.getCalls.length, 1);

		storage.resetMetrics();
		await setValue(service, storage, HOST_A, WORKSPACE_A, "local", "two");
		assert.equal((await observer.next()).result.rows[0][1].value, "two");
		assert.equal(storage.getCalls.length, 1);
	} finally {
		await observer.close();
	}
});

void test("a disconnected observer cannot stop updates for live subscribers", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const observerRuntime = runtime(openMemoryLix, 20);
	const writerRuntime = runtime(openMemoryLix);
	const observationRequest = () =>
		request(HOST_A, "/observe", {
			sql: "GET",
			params: [wireText("disconnect")],
		});
	const observe = (observation: Request = observationRequest()) =>
		observerRuntime.fetch(storage.bucket, HOST_A, WORKSPACE_A, observation);

	// Construct the body stream before replacing ReadableStream so the test
	// double can only intercept the SSE response stream.
	const disconnectedRequest = observationRequest();
	const restoreReadableStream = failNextStreamAfterFirstEnqueue();
	let disconnected: SseReader | undefined;
	try {
		disconnected = new SseReader(await observe(disconnectedRequest));
	} finally {
		restoreReadableStream();
	}
	assert.ok(disconnected);
	const healthy = new SseReader(await observe());
	try {
		await disconnected.next();
		await healthy.next();

		await setValue(
			writerRuntime,
			storage,
			HOST_A,
			WORKSPACE_A,
			"disconnect",
			"one",
		);
		assert.equal((await healthy.next()).result.rows[0][1].value, "one");

		await setValue(
			writerRuntime,
			storage,
			HOST_A,
			WORKSPACE_A,
			"disconnect",
			"two",
		);
		assert.equal((await healthy.next()).result.rows[0][1].value, "two");
	} finally {
		await disconnected.close();
		await healthy.close();
	}
});

void test("reopened observers never replay a stale cursor", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const observerRuntime = runtime(openMemoryLix, 20);
	const writerRuntime = runtime(openMemoryLix);
	const observe = () =>
		observerRuntime.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/observe", {
				sql: "GET",
				params: [wireText("reopen")],
			}),
		);

	const first = new SseReader(await observe());
	assert.equal((await first.next()).result.rows.length, 0);
	await first.close();
	await setValue(writerRuntime, storage, HOST_A, WORKSPACE_A, "reopen", "one");

	const reopened = new SseReader(await observe());
	try {
		assert.equal((await reopened.next()).result.rows[0][1].value, "one");
		await delay(60);
		await setValue(
			writerRuntime,
			storage,
			HOST_A,
			WORKSPACE_A,
			"reopen",
			"two",
		);
		assert.equal((await reopened.next()).result.rows[0][1].value, "two");
	} finally {
		await reopened.close();
	}
});

function runtime(openMemoryLix: OpenMemoryLix, previewPollIntervalMs?: number) {
	return createR2WorkspaceRuntime(openMemoryLix, {
		mainBranchId: MAIN_BRANCH,
		previewPollIntervalMs,
	});
}

async function setValue(
	service: ReturnType<typeof runtime>,
	storage: FakeR2Bucket,
	hostname: string,
	workspaceId: string,
	key: string,
	value: string,
) {
	await expectOk(
		execute(service, storage, hostname, workspaceId, "SET", [
			text(key),
			text(value),
		]),
	);
}

async function getValue(
	service: ReturnType<typeof runtime>,
	storage: FakeR2Bucket,
	hostname: string,
	workspaceId: string,
	key: string,
): Promise<{ key: string; value: string; revision: number } | null> {
	const response = await execute(
		service,
		storage,
		hostname,
		workspaceId,
		"GET",
		[text(key)],
	);
	await expectOk(response);
	const body: unknown = await response.json();
	const rows = singleExecuteRows(body);
	const row: unknown = rows[0];
	if (row === undefined) return null;
	assert.ok(Array.isArray(row) && row.length === 3);
	return {
		key: wireString(row[0]),
		value: wireString(row[1]),
		revision: wireNumber(row[2]),
	};
}

function singleExecuteRows(body: unknown): unknown[] {
	assert.ok(isRecord(body) && Array.isArray(body.rows));
	return body.rows;
}

function execute(
	service: ReturnType<typeof runtime>,
	storage: FakeR2Bucket,
	hostname: string,
	workspaceId: string,
	sql: string,
	params: unknown[],
	requestHostname = hostname,
) {
	return service.fetch(
		storage.bucket,
		hostname,
		workspaceId,
		request(requestHostname, "/execute", {
			sql,
			params: params.map(nativeToWire),
		}),
	);
}

function request(hostname: string, path: string, body?: unknown) {
	const pathname =
		path === "/filesystem/mutate" || path === "/container-health"
			? `/v1${path}`
			: `/lix/v1${path}`;
	return new Request(`https://${hostname}${pathname}`, {
		method: body === undefined ? "GET" : "POST",
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function expectOk(response: Response | Promise<Response>) {
	const resolved = await response;
	assert.equal(resolved.status, 200, await resolved.clone().text());
	return resolved;
}

async function errorCode(response: Response): Promise<string> {
	const body: unknown = await response.json();
	assert.ok(isRecord(body) && isRecord(body.error));
	return wireString(body.error, "code");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireString(value: unknown, key = "value"): string {
	assert.ok(isRecord(value) && typeof value[key] === "string");
	return value[key];
}

function wireNumber(value: unknown, key = "value"): number {
	assert.ok(isRecord(value) && typeof value[key] === "number");
	return value[key];
}

type FakeState = {
	activeBranchId: string;
	branches: Record<string, { name: string; hidden: boolean; commitId: string }>;
	values: Record<string, { value: string; revision: number }>;
	revision: number;
};

function snapshotBindingFactory(): OpenMemoryLix {
	let generated = 0;
	return async (options = {}) => {
		let state: FakeState;
		if (options.snapshot) {
			try {
				state = JSON.parse(
					new TextDecoder().decode(options.snapshot),
				) as FakeState;
				if (!state || typeof state !== "object" || !state.branches)
					throw new Error();
			} catch {
				throw new Error("invalid in-memory snapshot");
			}
		} else {
			const id = `generated-${++generated}`;
			state = {
				activeBranchId: id,
				branches: {
					global: { name: "global", hidden: true, commitId: "commit-0" },
					[id]: { name: "main", hidden: false, commitId: "commit-0" },
				},
				values: {},
				revision: 0,
			};
		}

		const binding: MemoryLixBinding = {
			execute: async (sql, params) => {
				if (sql.startsWith("DELETE FROM lix_branch")) {
					const id = nativeText(params[0]);
					const existed = Boolean(state.branches[id]);
					delete state.branches[id];
					return result([], [], existed ? 1 : 0);
				}
				if (sql.startsWith("UPDATE lix_branch SET name")) {
					const branch = state.branches[nativeText(params[1])];
					if (branch) branch.name = nativeText(params[0]);
					return result([], [], branch ? 1 : 0);
				}
				if (sql.includes("FROM lix_branch")) {
					return result(
						["id", "name", "hidden", "commit_id"],
						Object.entries(state.branches)
							.sort((a, b) => a[1].name.localeCompare(b[1].name))
							.map(([id, branch]) => [
								text(id),
								text(branch.name),
								{ kind: "boolean", value: branch.hidden },
								text(branch.commitId),
							]),
					);
				}
				if (sql === "SET") {
					const key = nativeText(params[0]);
					state.revision += 1;
					state.values[key] = {
						value: nativeText(params[1]),
						revision: state.revision,
					};
					state.branches[state.activeBranchId].commitId =
						`commit-${state.revision}`;
					return result([], [], 1);
				}
				if (sql === "GET") {
					const key = nativeText(params[0]);
					const value = state.values[key];
					return result(
						["key", "value", "revision"],
						value
							? [[text(key), text(value.value), integer(value.revision)]]
							: [],
					);
				}
				if (sql === "ACTIVE_BRANCH") {
					return result(["branch_id"], [[text(state.activeBranchId)]]);
				}
				if (sql === "FAIL") {
					throw Object.assign(new Error("deliberate failure"), {
						code: "LIX_INVALID_ARGUMENT",
					});
				}
				return result([], []);
			},
			executeBatch: async (statements, options) => {
				const results = [];
				for (const statement of statements) {
					results.push(
						await binding.execute(statement.sql, statement.params, options),
					);
				}
				return results;
			},
			observe: async () => ({ close: () => undefined, next: async () => null }),
			beginTransaction: async () => ({
				execute: async () => result([], []),
				commit: async () => undefined,
				rollback: async () => undefined,
			}),
			activeBranchId: async () => state.activeBranchId,
			createBranch: async ({ id = `branch-${++generated}`, name }) => {
				if (state.branches[id]) {
					throw Object.assign(new Error("branch exists"), {
						code: "LIX_INVALID_ARGUMENT",
					});
				}
				const commitId = state.branches[state.activeBranchId].commitId;
				state.branches[id] = { name, hidden: false, commitId };
				return { id, name, hidden: false, commitId };
			},
			switchBranch: async ({ branchId }) => {
				if (!state.branches[branchId]) {
					throw Object.assign(new Error("branch missing"), {
						code: "LIX_BRANCH_NOT_FOUND",
					});
				}
				state.activeBranchId = branchId;
				return { branchId };
			},
			exportSnapshot: async () =>
				new TextEncoder().encode(JSON.stringify(state)),
			close: async () => undefined,
		};
		return binding;
	};
}

function result(
	columns: string[],
	rows: Array<Array<Record<string, unknown>>>,
	rowsAffected = 0,
) {
	return { columns, rows, rowsAffected, notices: [] } as never;
}

function text(value: string) {
	return { kind: "text" as const, value };
}

function integer(value: number) {
	return { kind: "integer" as const, value };
}

function nativeText(value: unknown): string {
	assert.ok(
		typeof value === "object" &&
			value !== null &&
			"kind" in value &&
			value.kind === "text" &&
			"value" in value &&
			typeof value.value === "string",
	);
	return value.value;
}

function nativeToWire(value: unknown) {
	const native = value as { kind: string; value: unknown };
	return native.kind === "integer"
		? { kind: "int", value: native.value }
		: { kind: native.kind, value: native.value };
}

function wireText(value: string) {
	return { kind: "text", value };
}

function copyBufferSource(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	return new Uint8Array(
		value.buffer,
		value.byteOffset,
		value.byteLength,
	).slice();
}

class FakeR2Bucket {
	readonly bucket = this as unknown as R2Bucket;
	conflictsRemaining = 0;
	failGets = false;
	failPuts = false;
	getCalls: Array<{ key: string; etagDoesNotMatch?: string }> = [];
	putCalls: Array<{
		key: string;
		etagMatches?: string;
		etagDoesNotMatch?: string;
	}> = [];
	bodyReads = 0;
	#revision = 0;
	#objects = new Map<string, { bytes: Uint8Array; etag: string }>();
	#nextGetGate?: OperationGate;
	#nextPutGate?: OperationGate;

	has(key: string) {
		return this.#objects.has(key);
	}

	bytes(key: string) {
		return this.#objects.get(key)?.bytes.slice();
	}

	etag(key: string) {
		return this.#objects.get(key)?.etag;
	}

	resetMetrics() {
		this.getCalls = [];
		this.putCalls = [];
		this.bodyReads = 0;
	}

	blockNextGet() {
		const gate = operationGate();
		this.#nextGetGate = gate;
		return gate.public;
	}

	blockNextPut() {
		const gate = operationGate();
		this.#nextPutGate = gate;
		return gate.public;
	}

	async putRaw(key: string, bytes: Uint8Array) {
		await this.put(key, bytes);
	}

	async get(key: string, options?: R2GetOptions) {
		if (this.failGets) throw new Error("R2 get failed");
		const conditional = options?.onlyIf as R2Conditional | undefined;
		this.getCalls.push({
			key,
			etagDoesNotMatch: conditional?.etagDoesNotMatch,
		});
		const stored = this.#objects.get(key);
		const gate = this.#nextGetGate;
		if (gate) {
			this.#nextGetGate = undefined;
			gate.start();
			await gate.wait;
		}
		if (!stored) return null;
		if (conditional?.etagDoesNotMatch === stored.etag) {
			return this.object(key, stored, false);
		}
		return this.object(key, stored, true);
	}

	async put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | null,
		options?: R2PutOptions,
	) {
		if (this.failPuts) throw new Error("R2 put failed");
		const conditional = options?.onlyIf as R2Conditional | undefined;
		this.putCalls.push({
			key,
			etagMatches: conditional?.etagMatches,
			etagDoesNotMatch: conditional?.etagDoesNotMatch,
		});
		const gate = this.#nextPutGate;
		if (gate) {
			this.#nextPutGate = undefined;
			gate.start();
			await gate.wait;
		}
		const current = this.#objects.get(key);
		if (
			this.conflictsRemaining > 0 ||
			(conditional?.etagDoesNotMatch === "*" && current) ||
			(conditional?.etagMatches !== undefined &&
				conditional.etagMatches !== current?.etag)
		) {
			if (this.conflictsRemaining > 0) this.conflictsRemaining -= 1;
			return null;
		}
		const bytes =
			typeof value === "string"
				? new TextEncoder().encode(value)
				: value === null
					? new Uint8Array()
					: copyBufferSource(value);
		const stored = { bytes, etag: `etag-${++this.#revision}` };
		this.#objects.set(key, stored);
		return this.object(key, stored, false);
	}

	private object(
		key: string,
		stored: { bytes: Uint8Array; etag: string },
		body: boolean,
	) {
		return {
			key,
			etag: stored.etag,
			size: stored.bytes.byteLength,
			...(body
				? {
						arrayBuffer: async () => {
							this.bodyReads += 1;
							return stored.bytes.buffer.slice(
								stored.bytes.byteOffset,
								stored.bytes.byteOffset + stored.bytes.byteLength,
							);
						},
					}
				: {}),
		};
	}
}

interface OperationGate {
	public: { started: Promise<void>; release: () => void };
	start: () => void;
	wait: Promise<void>;
}

function operationGate(): OperationGate {
	let start = () => undefined;
	let release = () => undefined;
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { public: { started, release }, start, wait };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface SsePayload {
	sequence: number;
	subscriptionId?: string;
	result: { rows: Array<Array<{ value?: unknown }>> };
}

class SseReader {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#buffer = "";

	constructor(response: Response) {
		assert.match(
			response.headers.get("content-type") ?? "",
			/text\/event-stream/,
		);
		assert.ok(response.body);
		this.#reader = response.body.getReader();
	}

	async next(): Promise<SsePayload> {
		const deadline = Date.now() + 3_000;
		for (;;) {
			const boundary = this.#buffer.indexOf("\n\n");
			if (boundary >= 0) {
				const frame = this.#buffer.slice(0, boundary);
				this.#buffer = this.#buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (data) {
					const payload: unknown = JSON.parse(data.slice(6));
					assert.ok(
						isRecord(payload) &&
							typeof payload.sequence === "number" &&
							isRecord(payload.result) &&
							Array.isArray(payload.result.rows),
					);
					return payload as unknown as SsePayload;
				}
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("timed out waiting for SSE event");
			const chunk = await withTimeout(this.#reader.read(), remaining);
			if (chunk.done) throw new Error("SSE stream ended");
			this.#buffer += new TextDecoder().decode(chunk.value, { stream: true });
		}
	}

	async close() {
		await this.#reader.cancel();
	}
}

function failNextStreamAfterFirstEnqueue(): () => void {
	const OriginalReadableStream = globalThis.ReadableStream;
	let replaceNext = true;
	const FailingReadableStream = function <R>(
		source: UnderlyingDefaultSource<R> = {},
		strategy?: QueuingStrategy<R>,
	): ReadableStream<R> {
		if (!replaceNext) return new OriginalReadableStream(source, strategy);
		replaceNext = false;
		let enqueueCount = 0;
		return new OriginalReadableStream<R>(
			{
				start(controller) {
					const wrapped: ReadableStreamDefaultController<R> = {
						get desiredSize() {
							return controller.desiredSize;
						},
						close: () => controller.close(),
						enqueue: (chunk) => {
							enqueueCount += 1;
							if (enqueueCount > 1) {
								throw new Error("Network connection lost.");
							}
							controller.enqueue(chunk);
						},
						error: (reason) => controller.error(reason),
					};
					source.start?.(wrapped);
				},
				cancel(reason) {
					source.cancel?.(reason);
				},
			},
			strategy,
		);
	} as unknown as typeof ReadableStream;

	Object.defineProperty(globalThis, "ReadableStream", {
		configurable: true,
		writable: true,
		value: FailingReadableStream,
	});
	return () => {
		Object.defineProperty(globalThis, "ReadableStream", {
			configurable: true,
			writable: true,
			value: OriginalReadableStream,
		});
	};
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("timed out waiting for SSE event")),
			timeoutMs,
		);
		operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(
					error instanceof Error
						? error
						: new Error("SSE read failed", { cause: error }),
				);
			},
		);
	});
}
