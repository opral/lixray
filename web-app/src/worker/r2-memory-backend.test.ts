import assert from "node:assert/strict";
import test from "node:test";
import {
	createR2WorkspaceBackend,
	type MemoryLixBinding,
	type OpenMemoryLix,
} from "./memory-backend.ts";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const MAIN_BRANCH = "33333333-3333-4333-8333-333333333333";
const HOST_A = "branch-preview.example.workers.dev";
const HOST_B = "version-preview.example.workers.dev";

void test("independent backends share exact R2 state and revisions", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const first = backend(openMemoryLix);
	const second = backend(openMemoryLix);

	await expectOk(
		first.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branches"),
		),
	);
	await setValue(first, storage, HOST_A, WORKSPACE_A, "shared", "first");

	const result = await getValue(second, storage, HOST_A, WORKSPACE_A, "shared");
	assert.deepEqual(result, { key: "shared", value: "first", revision: 1 });
	assert.ok(storage.has(`lixray-preview/v1/${HOST_A}/${WORKSPACE_A}.snapshot`));
});

void test("explicit preview hostname keeps synthetic MCP requests coherent and isolated", async () => {
	const storage = new FakeR2Bucket();
	const service = backend(snapshotBindingFactory());

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
	const service = backend(snapshotBindingFactory());

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
	const first = backend(openMemoryLix);
	const second = backend(openMemoryLix);

	await Promise.all([
		expectOk(
			first.fetch(
				storage.bucket,
				HOST_A,
				WORKSPACE_A,
				request(HOST_A, "/branches"),
			),
		),
		expectOk(
			second.fetch(
				storage.bucket,
				HOST_A,
				WORKSPACE_A,
				request(HOST_A, "/branches"),
			),
		),
	]);
	await Promise.all([
		setValue(first, storage, HOST_A, WORKSPACE_A, "left", "A"),
		setValue(second, storage, HOST_A, WORKSPACE_A, "right", "B"),
	]);

	const verifier = backend(openMemoryLix);
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

void test("retry exhaustion returns a retryable 503 and preserves state", async () => {
	const storage = new FakeR2Bucket();
	const service = backend(snapshotBindingFactory());
	await expectOk(
		service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branches"),
		),
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
			backend(snapshotBindingFactory()),
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
	const service = backend(snapshotBindingFactory());
	const failed = await service.fetch(
		unavailable.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/branches"),
	);
	assert.equal(failed.status, 503);
	assert.equal(await errorCode(failed), "PREVIEW_STORAGE_UNAVAILABLE");

	const failedPutStorage = new FakeR2Bucket();
	const failedPutService = backend(snapshotBindingFactory());
	await expectOk(
		failedPutService.fetch(
			failedPutStorage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branches"),
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
	const invalid = await backend(snapshotBindingFactory()).fetch(
		corrupt.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/branches"),
	);
	assert.equal(invalid.status, 503);
	assert.equal(await errorCode(invalid), "PREVIEW_SNAPSHOT_INVALID");
	assert.deepEqual(corrupt.bytes(key), before);
});

void test("failed API operations never overwrite the committed snapshot", async () => {
	const storage = new FakeR2Bucket();
	const service = backend(snapshotBindingFactory());
	await expectOk(
		service.fetch(
			storage.bucket,
			HOST_A,
			WORKSPACE_A,
			request(HOST_A, "/branches"),
		),
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

void test("single and multiplexed observers receive cross-isolate changes once", async () => {
	const storage = new FakeR2Bucket();
	const openMemoryLix = snapshotBindingFactory();
	const observerBackend = backend(openMemoryLix);
	const writerBackend = backend(openMemoryLix);

	const singleResponse = await observerBackend.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/observe", {
			branchId: MAIN_BRANCH,
			sql: "GET",
			params: [wireText("single")],
		}),
	);
	const single = new SseReader(singleResponse);
	assert.equal((await single.next()).sequence, 0);
	await setValue(writerBackend, storage, HOST_A, WORKSPACE_A, "single", "one");
	const changed = await single.next();
	assert.equal(changed.sequence, 1);
	assert.equal(changed.result.rows[0][1].value, "one");
	await setValue(writerBackend, storage, HOST_A, WORKSPACE_A, "single", "two");
	const changedAgain = await single.next();
	assert.equal(changedAgain.sequence, 2);
	assert.equal(changedAgain.result.rows[0][1].value, "two");
	await single.close();

	const multiplexResponse = await observerBackend.fetch(
		storage.bucket,
		HOST_A,
		WORKSPACE_A,
		request(HOST_A, "/observe/multiplex", {
			branchId: MAIN_BRANCH,
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
		writerBackend,
		storage,
		HOST_A,
		WORKSPACE_A,
		"left-watch",
		"L",
	);
	assert.equal((await multiplex.next()).subscriptionId, "left");
	await setValue(
		writerBackend,
		storage,
		HOST_A,
		WORKSPACE_A,
		"right-watch",
		"R",
	);
	assert.equal((await multiplex.next()).subscriptionId, "right");
	await multiplex.close();
});

function backend(openMemoryLix: OpenMemoryLix) {
	return createR2WorkspaceBackend(openMemoryLix, { mainBranchId: MAIN_BRANCH });
}

async function setValue(
	service: ReturnType<typeof backend>,
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
	service: ReturnType<typeof backend>,
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
	assert.ok(isRecord(body) && Array.isArray(body.rows));
	const rows: unknown[] = body.rows;
	const row: unknown = rows[0];
	if (row === undefined) return null;
	assert.ok(Array.isArray(row) && row.length === 3);
	return {
		key: wireString(row[0]),
		value: wireString(row[1]),
		revision: wireNumber(row[2]),
	};
}

function execute(
	service: ReturnType<typeof backend>,
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
			branchId: MAIN_BRANCH,
			sql,
			params: params.map(nativeToWire),
		}),
	);
}

function request(hostname: string, path: string, body?: unknown) {
	return new Request(`https://${hostname}/v1${path}`, {
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
				if (sql === "FAIL") {
					throw Object.assign(new Error("deliberate failure"), {
						code: "LIX_INVALID_ARGUMENT",
					});
				}
				return result([], []);
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
	#revision = 0;
	#objects = new Map<string, { bytes: Uint8Array; etag: string }>();

	has(key: string) {
		return this.#objects.has(key);
	}

	bytes(key: string) {
		return this.#objects.get(key)?.bytes.slice();
	}

	async putRaw(key: string, bytes: Uint8Array) {
		await this.put(key, bytes);
	}

	async get(key: string, options?: R2GetOptions) {
		if (this.failGets) throw new Error("R2 get failed");
		const stored = this.#objects.get(key);
		if (!stored) return null;
		const conditional = options?.onlyIf as R2Conditional | undefined;
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
		const current = this.#objects.get(key);
		const conditional = options?.onlyIf as R2Conditional | undefined;
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
						arrayBuffer: async () =>
							stored.bytes.buffer.slice(
								stored.bytes.byteOffset,
								stored.bytes.byteOffset + stored.bytes.byteLength,
							),
					}
				: {}),
		};
	}
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
