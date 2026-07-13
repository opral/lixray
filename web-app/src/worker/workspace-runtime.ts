import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";

type NativeValue =
	| { kind: "null"; value?: null }
	| { kind: "boolean"; value: boolean }
	| { kind: "integer"; value: number }
	| { kind: "real"; value: number }
	| { kind: "text"; value: string }
	| { kind: "blob"; value?: null; blob: Uint8Array }
	| { kind: "json"; value: unknown };

type WireValue =
	| { kind: "null"; value: null }
	| { kind: "bool"; value: boolean }
	| { kind: "int"; value: number }
	| { kind: "float"; value: number }
	| { kind: "text"; value: string }
	| { kind: "blob"; base64: string }
	| { kind: "json"; value: unknown };

interface ExecuteResult {
	columns: string[];
	rows: NativeValue[][];
	rowsAffected: number;
	notices: Array<{ code: string; message: string; hint?: string }>;
}

interface ObserveEvent {
	sequence: number;
	mutationSequence: number;
	rows: ExecuteResult;
}

interface ObserveEvents {
	next(): Promise<ObserveEvent | null | undefined>;
	close(): void;
}

interface LixTransaction {
	execute(
		sql: string,
		params: NativeValue[],
		options?: { originKey?: string },
	): Promise<ExecuteResult>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface MemoryLixBinding {
	execute(
		sql: string,
		params: NativeValue[],
		options?: { originKey?: string },
	): Promise<ExecuteResult>;
	observe(sql: string, params: NativeValue[]): Promise<ObserveEvents>;
	beginTransaction(): Promise<LixTransaction>;
	activeBranchId(): Promise<string>;
	createBranch(options: {
		id?: string;
		name: string;
		fromCommitId?: string;
	}): Promise<{ id: string; name: string; hidden: boolean; commitId: string }>;
	switchBranch(options: { branchId: string }): Promise<{ branchId: string }>;
	exportSnapshot(): Promise<Uint8Array>;
	close(): Promise<void>;
}

export type OpenMemoryLix = (options?: {
	snapshot?: Uint8Array;
}) => Promise<MemoryLixBinding>;

interface WorkspaceRuntime {
	lix: MemoryLixBinding;
	finiteQueue: Promise<void>;
}

interface WorkspaceRuntimeOptions {
	mainBranchId: string;
	previewPollIntervalMs?: number;
}

interface PersistentSnapshot {
	etag: string;
	bytes: Uint8Array;
}

type PersistentObserverUpdate =
	{ snapshot: PersistentSnapshot } | { error: unknown };

interface PersistentWorkspaceState {
	key: string;
	bucket: R2Bucket;
	cache?: PersistentSnapshot;
	observerSnapshot?: PersistentSnapshot;
	generation: number;
	subscribers: Set<(update: PersistentObserverUpdate) => void>;
	poller?: ReturnType<typeof setTimeout>;
	polling: boolean;
	pollAgain: boolean;
	pollGeneration: number;
}

const NOT_FOUND_CODES = new Set([
	"LIX_BRANCH_NOT_FOUND",
	"LIX_COMMIT_NOT_FOUND",
	"LIX_TABLE_NOT_FOUND",
	"LIX_COLUMN_NOT_FOUND",
]);

const BAD_REQUEST_CODES = new Set([
	"LIX_INVALID_ARGUMENT",
	"LIX_INVALID_PARAM",
	"LIX_PARSE_ERROR",
	"LIX_BINDING_ERROR",
	"LIX_TYPE_MISMATCH",
	"LIX_DIALECT_UNSUPPORTED",
	"LIX_UNSUPPORTED_SQL",
	"LIX_UNSUPPORTED_SQL_RUNTIME_PLAN",
	"LIX_CONSTRAINT_VIOLATION",
	"LIX_READ_ONLY",
	"LIX_SCHEMA_VALIDATION",
	"LIX_FOREIGN_KEY",
	"LIX_FILE_NOT_FOUND",
	"LIX_UNIQUE",
	"LIX_UNSUPPORTED_WRITE_EXPRESSION",
	"LIX_SCHEMA_DEFINITION",
	"LIX_INVALID_STORAGE_SCOPE",
	"LIX_AMBIGUOUS_MERGE_BASE",
	"LIX_INVALID_MERGE",
]);

const SSE_HEADERS = {
	"Cache-Control": "no-cache",
	"Content-Type": "text/event-stream",
};

const MAIN_BRANCH_BOOTSTRAP_NAME = "lixray-demo-main-bootstrap";
const PREVIEW_SNAPSHOT_PREFIX = "lixray-preview/v1";
const PREVIEW_POLL_INTERVAL_MS = 1_000;
const PREVIEW_WRITE_ATTEMPTS = 5;

export function createMemoryWorkspaceRuntime(
	openMemoryLix: OpenMemoryLix,
	options: WorkspaceRuntimeOptions,
) {
	const runtimes = new Map<string, Promise<WorkspaceRuntime>>();

	return {
		fetch: async (workspaceId: string, request: Request): Promise<Response> => {
			try {
				return await routeRequest(
					request,
					await workspaceRuntime(
						workspaceId,
						openMemoryLix,
						options.mainBranchId,
						runtimes,
					),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
		workspaceCount: () => runtimes.size,
	};
}

export function createR2WorkspaceRuntime(
	openMemoryLix: OpenMemoryLix,
	options: WorkspaceRuntimeOptions,
) {
	const workspaces = new Map<string, PersistentWorkspaceState>();
	const pollIntervalMs =
		options.previewPollIntervalMs ?? PREVIEW_POLL_INTERVAL_MS;

	return {
		fetch: async (
			bucket: R2Bucket,
			previewHostname: string,
			workspaceId: string,
			request: Request,
		): Promise<Response> => {
			const { pathname } = new URL(request.url);
			if (pathname === "/v1/container-health") {
				return request.method === "GET"
					? json({ ok: true, service: "lixray-container" })
					: methodNotAllowed();
			}
			const key = `${PREVIEW_SNAPSHOT_PREFIX}/${previewHostname.toLowerCase()}/${workspaceId}.snapshot`;
			let state = workspaces.get(key);
			if (!state) {
				state = {
					key,
					bucket,
					generation: 0,
					subscribers: new Set(),
					polling: false,
					pollAgain: false,
					pollGeneration: 0,
				};
				workspaces.set(key, state);
			}
			try {
				if (
					pathname === "/v1/observe" ||
					pathname === "/v1/observe/multiplex"
				) {
					if (request.method !== "POST") return methodNotAllowed();
					const body = await requestBody(request);
					const loaded = await loadPersistentRuntime(
						state,
						openMemoryLix,
						options.mainBranchId,
					);
					await closeQuietly(loaded.runtime.lix);
					return persistentObservationResponse(
						state,
						body,
						pathname === "/v1/observe/multiplex",
						loaded.snapshot,
						openMemoryLix,
						options.mainBranchId,
						pollIntervalMs,
					);
				}

				const replay = await replayableRequest(request);
				for (let attempt = 0; attempt < PREVIEW_WRITE_ATTEMPTS; attempt += 1) {
					const loaded = await loadPersistentRuntime(
						state,
						openMemoryLix,
						options.mainBranchId,
					);
					const { runtime } = loaded;
					try {
						const response = await routeRequest(replay(), runtime, {
							skipRedundantBranchSwitch: true,
						});
						if (
							!response.ok ||
							!(await shouldPersistMutation(pathname, response))
						) {
							return response;
						}

						const bytes = await runtime.lix.exportSnapshot();
						if (equalBytes(bytes, loaded.snapshot.bytes)) return response;

						const cacheToken = state.cache;
						const committed = await storageCall(() =>
							state.bucket.put(state.key, bytes, {
								onlyIf: { etagMatches: loaded.snapshot.etag },
							}),
						);
						if (committed) {
							const snapshot = { etag: committed.etag, bytes };
							if (state.cache === cacheToken) state.cache = snapshot;
							wakePersistentObservers(
								state,
								openMemoryLix,
								options.mainBranchId,
								pollIntervalMs,
							);
							return response;
						}
					} finally {
						await closeQuietly(runtime.lix);
					}

					if (attempt + 1 < PREVIEW_WRITE_ATTEMPTS) {
						await conflictJitter(attempt);
					}
				}
				throw previewError(
					"PREVIEW_STORAGE_CONFLICT",
					"preview state changed too frequently; retry the request",
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
		workspaceCount: () => workspaces.size,
	};
}

async function loadPersistentRuntime(
	state: PersistentWorkspaceState,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
): Promise<{ snapshot: PersistentSnapshot; runtime: WorkspaceRuntime }> {
	const cached = state.cache;
	const snapshot = await fetchPersistentSnapshot(
		state,
		cached,
		openMemoryLix,
		mainBranchId,
	);
	const runtime = await openPersistentRuntime(openMemoryLix, snapshot.bytes);
	if (state.cache === cached) state.cache = snapshot;
	return { snapshot, runtime };
}

async function fetchPersistentSnapshot(
	state: PersistentWorkspaceState,
	cached: PersistentSnapshot | undefined,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
): Promise<PersistentSnapshot> {
	const object = cached
		? await storageCall(() =>
				state.bucket.get(state.key, {
					onlyIf: { etagDoesNotMatch: cached.etag },
				}),
			)
		: await storageCall(() => state.bucket.get(state.key));

	if (object && !hasR2Body(object)) {
		if (!cached) {
			throw previewError(
				"PREVIEW_STORAGE_UNAVAILABLE",
				"preview storage returned snapshot metadata without cached bytes",
			);
		}
		return cached;
	}
	if (object) {
		return {
			etag: object.etag,
			bytes: new Uint8Array(await storageCall(() => object.arrayBuffer())),
		};
	}

	return bootstrapPersistentSnapshot(state, openMemoryLix, mainBranchId);
}

async function bootstrapPersistentSnapshot(
	state: PersistentWorkspaceState,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
): Promise<PersistentSnapshot> {
	const runtime = await openWorkspaceRuntime(openMemoryLix, mainBranchId);
	let created: R2Object | null;
	let bytes: Uint8Array;
	try {
		bytes = await runtime.lix.exportSnapshot();
		created = await storageCall(() =>
			state.bucket.put(state.key, bytes, {
				onlyIf: { etagDoesNotMatch: "*" },
			}),
		);
	} finally {
		await closeQuietly(runtime.lix);
	}
	if (created) {
		return { etag: created.etag, bytes };
	}

	const winner = await storageCall(() => state.bucket.get(state.key));
	if (!winner || !hasR2Body(winner)) {
		throw previewError(
			"PREVIEW_STORAGE_UNAVAILABLE",
			"preview state disappeared during initialization",
		);
	}
	return {
		etag: winner.etag,
		bytes: new Uint8Array(await storageCall(() => winner.arrayBuffer())),
	};
}

async function openPersistentRuntime(
	openMemoryLix: OpenMemoryLix,
	bytes: Uint8Array,
): Promise<WorkspaceRuntime> {
	let winnerLix: MemoryLixBinding;
	try {
		winnerLix = await openMemoryLix({ snapshot: bytes });
	} catch (error) {
		throw previewError(
			"PREVIEW_SNAPSHOT_INVALID",
			"stored preview snapshot is invalid",
			error,
		);
	}
	return { lix: winnerLix, finiteQueue: Promise.resolve() };
}

function hasR2Body(object: R2Object): object is R2ObjectBody {
	return typeof (object as R2ObjectBody).arrayBuffer === "function";
}

async function closeQuietly(lix: MemoryLixBinding): Promise<void> {
	try {
		await lix.close();
	} catch {
		// Closing a request-local runtime is best-effort.
	}
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return left.every((value, index) => value === right[index]);
}

async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (isPreviewError(error)) throw error;
		throw previewError(
			"PREVIEW_STORAGE_UNAVAILABLE",
			"preview storage is unavailable",
			error,
		);
	}
}

async function shouldPersistMutation(
	pathname: string,
	response: Response,
): Promise<boolean> {
	if (pathname !== "/v1/filesystem/mutate") return true;
	const body: unknown = await response.clone().json();
	return (
		typeof body === "object" &&
		body !== null &&
		"outcome" in body &&
		body.outcome === "applied"
	);
}

async function replayableRequest(request: Request): Promise<() => Request> {
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.clone().arrayBuffer();
	return () =>
		new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body,
			signal: request.signal,
		});
}

function conflictJitter(attempt: number): Promise<void> {
	const maximum = Math.min(50, 5 * 2 ** attempt);
	return new Promise((resolve) =>
		setTimeout(resolve, Math.floor(Math.random() * (maximum + 1))),
	);
}

async function workspaceRuntime(
	workspaceId: string,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	runtimes: Map<string, Promise<WorkspaceRuntime>>,
): Promise<WorkspaceRuntime> {
	let runtime = runtimes.get(workspaceId);
	if (!runtime) {
		runtime = openWorkspaceRuntime(openMemoryLix, mainBranchId);
		runtimes.set(workspaceId, runtime);
		runtime.catch(() => {
			if (runtimes.get(workspaceId) === runtime) runtimes.delete(workspaceId);
		});
	}
	return runtime;
}

async function openWorkspaceRuntime(
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
): Promise<WorkspaceRuntime> {
	const lix = await openMemoryLix();
	try {
		await ensureCanonicalMainBranch(lix, mainBranchId);
		return { lix, finiteQueue: Promise.resolve() };
	} catch (error) {
		try {
			await lix.close();
		} catch {
			// Preserve the initialization error if closing also fails.
		}
		throw error;
	}
}

async function ensureCanonicalMainBranch(
	lix: MemoryLixBinding,
	mainBranchId: string,
): Promise<void> {
	const generatedMainBranchId = await lix.activeBranchId();
	if (generatedMainBranchId === mainBranchId) return;

	await lix.createBranch({
		id: mainBranchId,
		name: MAIN_BRANCH_BOOTSTRAP_NAME,
	});
	await lix.switchBranch({ branchId: mainBranchId });
	const deleted = await lix.execute("DELETE FROM lix_branch WHERE id = $1", [
		{ kind: "text", value: generatedMainBranchId },
	]);
	if (deleted.rowsAffected !== 1) {
		throw lixError(
			"LIX_INTERNAL_ERROR",
			"failed to replace the generated demo main branch",
		);
	}
	const renamed = await lix.execute(
		"UPDATE lix_branch SET name = $1 WHERE id = $2",
		[
			{ kind: "text", value: "main" },
			{ kind: "text", value: mainBranchId },
		],
	);
	if (renamed.rowsAffected !== 1) {
		throw lixError(
			"LIX_INTERNAL_ERROR",
			"failed to name the canonical demo main branch",
		);
	}
}

async function switchBranchIfNeeded(
	lix: MemoryLixBinding,
	branchId: string,
): Promise<void> {
	if ((await lix.activeBranchId()) === branchId) return;
	await lix.switchBranch({ branchId });
}

async function switchRequestBranch(
	lix: MemoryLixBinding,
	branchId: string,
	options: { skipRedundantBranchSwitch?: boolean },
): Promise<void> {
	if (options.skipRedundantBranchSwitch) {
		await switchBranchIfNeeded(lix, branchId);
		return;
	}
	await lix.switchBranch({ branchId });
}

async function routeRequest(
	request: Request,
	runtime: WorkspaceRuntime,
	options: { skipRedundantBranchSwitch?: boolean } = {},
): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/v1/container-health") {
		return request.method === "GET"
			? json({ ok: true, service: "lixray-container" })
			: methodNotAllowed();
	}
	if (pathname === "/v1/branches") {
		if (request.method !== "GET") return methodNotAllowed();
		return json(
			await serialize(runtime, async () => {
				const result = await runtime.lix.execute(
					"SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id",
					[],
				);
				return {
					branches: result.rows.map((row) => ({
						id: requiredNativeText(result, row, "id"),
						name: requiredNativeText(result, row, "name"),
						hidden: requiredNativeBoolean(result, row, "hidden"),
						commitId: requiredNativeText(result, row, "commit_id"),
					})),
				};
			}),
		);
	}
	if (pathname === "/v1/createBranch") {
		if (request.method !== "POST") return methodNotAllowed();
		const body = await requestBody(request);
		const branchId = requiredString(body, "branchId");
		const name = requiredString(body, "name");
		const id = optionalString(body, "id");
		const fromCommitId = optionalString(body, "fromCommitId");
		return json(
			await serialize(runtime, async () => {
				await switchRequestBranch(runtime.lix, branchId, options);
				return runtime.lix.createBranch({
					...(id ? { id } : {}),
					name,
					...(fromCommitId ? { fromCommitId } : {}),
				});
			}),
		);
	}
	if (pathname === "/v1/execute") {
		if (request.method !== "POST") return methodNotAllowed();
		const body = await requestBody(request);
		const branchId = requiredString(body, "branchId");
		const sql = requiredString(body, "sql");
		const params = decodeParams(body.params);
		const originKey = executeOriginKey(body.options);
		return json(
			await serialize(runtime, async () => {
				await switchRequestBranch(runtime.lix, branchId, options);
				return encodeExecuteResult(
					await runtime.lix.execute(
						sql,
						params,
						originKey ? { originKey } : undefined,
					),
				);
			}),
		);
	}
	if (pathname === "/v1/filesystem/mutate") {
		if (request.method !== "POST") return methodNotAllowed();
		return json(
			await mutateFilesystem(runtime, await requestBody(request), options),
		);
	}
	if (pathname === "/v1/observe") {
		if (request.method !== "POST") return methodNotAllowed();
		const body = await requestBody(request);
		const observation = await openObservation(runtime, body);
		return observationResponse([observation], false);
	}
	if (pathname === "/v1/observe/multiplex") {
		if (request.method !== "POST") return methodNotAllowed();
		const body = await requestBody(request);
		const branchId = requiredString(body, "branchId");
		if (!Array.isArray(body.subscriptions)) {
			throw invalidArgument("subscriptions is required");
		}
		const subscriptions = body.subscriptions.map((subscription) => {
			const value = requestObject(subscription, "subscriptions[]");
			return {
				id: requiredString(value, "id", "subscriptions[].id"),
				sql: requiredString(value, "sql", "subscriptions[].sql"),
				params: decodeParams(value.params),
			};
		});
		const observations = await serialize(runtime, async () => {
			await switchRequestBranch(runtime.lix, branchId, options);
			const opened: Array<{ id: string; events: ObserveEvents }> = [];
			for (const { id, sql, params } of subscriptions) {
				opened.push({
					id,
					events: await runtime.lix.observe(sql, params),
				});
			}
			return opened;
		});
		return observationResponse(observations, true);
	}
	return new Response("Not found\n", { status: 404 });
}

interface PersistentObservationQuery {
	id?: string;
	sql: string;
	params: NativeValue[];
}

function persistentObservationResponse(
	state: PersistentWorkspaceState,
	body: Record<string, unknown>,
	multiplex: boolean,
	initialSnapshot: PersistentSnapshot,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	pollIntervalMs: number,
): Response {
	const branchId = requiredString(body, "branchId");
	let queries: PersistentObservationQuery[];
	if (multiplex) {
		if (!Array.isArray(body.subscriptions)) {
			throw invalidArgument("subscriptions is required");
		}
		queries = body.subscriptions.map((subscription) => {
			const value = requestObject(subscription, "subscriptions[]");
			return {
				id: requiredString(value, "id", "subscriptions[].id"),
				sql: requiredString(value, "sql", "subscriptions[].sql"),
				params: decodeParams(value.params),
			};
		});
	} else {
		queries = [
			{
				sql: requiredString(body, "sql"),
				params: decodeParams(body.params),
			},
		];
	}

	const encoder = new TextEncoder();
	const previous = new Array<string | undefined>(queries.length);
	const sequences = new Array<number>(queries.length).fill(0);
	let cancelled = false;
	let running = false;
	let pending = false;
	let latestSnapshot = initialSnapshot;
	let lastEvaluatedEtag: string | undefined;
	let pendingError: { value: unknown } | undefined;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const finish = (close: boolean) => {
				if (cancelled) return;
				cancelled = true;
				if (keepAlive) clearInterval(keepAlive);
				unsubscribe?.();
				if (close) controller.close();
			};
			const schedule = (update: PersistentObserverUpdate) => {
				if ("snapshot" in update) latestSnapshot = update.snapshot;
				else pendingError = { value: update.error };
				if (cancelled) return;
				if (running) {
					pending = true;
					return;
				}
				if (
					pendingError === undefined &&
					lastEvaluatedEtag === latestSnapshot.etag
				) {
					return;
				}
				running = true;
				const snapshotToRead = latestSnapshot;
				const pollError = pendingError;
				pendingError = undefined;
				void (async () => {
					if (pollError) {
						throw pollError.value instanceof Error
							? pollError.value
							: new Error("preview observer polling failed", {
									cause: pollError.value,
								});
					}
					const runtime = await openPersistentRuntime(
						openMemoryLix,
						snapshotToRead.bytes,
					);
					try {
						return await serialize(runtime, async () => {
							await switchBranchIfNeeded(runtime.lix, branchId);
							const results = [];
							for (const query of queries) {
								results.push(
									encodeExecuteResult(
										await runtime.lix.execute(query.sql, query.params),
									),
								);
							}
							return results;
						});
					} finally {
						await closeQuietly(runtime.lix);
					}
				})()
					.then((results) => {
						if (cancelled) return;
						lastEvaluatedEtag = snapshotToRead.etag;
						results.forEach((result, index) => {
							const serialized = JSON.stringify(result);
							if (serialized === previous[index]) return;
							previous[index] = serialized;
							const payload = {
								...(multiplex ? { subscriptionId: queries[index].id } : {}),
								sequence: sequences[index]++,
								mutationSequence: state.generation,
								result,
							};
							controller.enqueue(encoder.encode(sseFrame("next", payload)));
						});
					})
					.catch((error) => {
						if (cancelled) return;
						controller.enqueue(
							encoder.encode(sseFrame("error", errorEnvelope(error))),
						);
						finish(true);
					})
					.finally(() => {
						running = false;
						if (pending && !cancelled) {
							pending = false;
							schedule({ snapshot: latestSnapshot });
						}
					});
			};

			unsubscribe = subscribePersistentObserver(
				state,
				schedule,
				initialSnapshot,
				openMemoryLix,
				mainBranchId,
				pollIntervalMs,
			);
			keepAlive = setInterval(() => {
				if (!cancelled) controller.enqueue(encoder.encode(": keep-alive\n\n"));
			}, 15_000);
			schedule({ snapshot: initialSnapshot });
		},
		cancel() {
			cancelled = true;
			if (keepAlive) clearInterval(keepAlive);
			unsubscribe?.();
		},
	});
	return new Response(stream, { headers: SSE_HEADERS });
}

function subscribePersistentObserver(
	state: PersistentWorkspaceState,
	subscriber: (update: PersistentObserverUpdate) => void,
	initialSnapshot: PersistentSnapshot,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	pollIntervalMs: number,
): () => void {
	const wasEmpty = state.subscribers.size === 0;
	state.subscribers.add(subscriber);
	if (wasEmpty) state.observerSnapshot = initialSnapshot;
	schedulePersistentPoll(
		state,
		openMemoryLix,
		mainBranchId,
		pollIntervalMs,
		pollIntervalMs,
	);
	return () => {
		state.subscribers.delete(subscriber);
		if (state.subscribers.size === 0) {
			if (state.poller) clearTimeout(state.poller);
			state.poller = undefined;
			state.pollAgain = false;
			state.observerSnapshot = undefined;
			state.pollGeneration += 1;
		}
	};
}

function wakePersistentObservers(
	state: PersistentWorkspaceState,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	pollIntervalMs: number,
): void {
	if (state.subscribers.size === 0) return;
	schedulePersistentPoll(state, openMemoryLix, mainBranchId, pollIntervalMs, 0);
}

function schedulePersistentPoll(
	state: PersistentWorkspaceState,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	pollIntervalMs: number,
	delayMs: number,
): void {
	if (state.subscribers.size === 0) return;
	if (state.polling) {
		state.pollAgain = true;
		return;
	}
	if (state.poller) {
		if (delayMs !== 0) return;
		clearTimeout(state.poller);
	}
	const generation = state.pollGeneration;
	state.poller = setTimeout(() => {
		state.poller = undefined;
		if (generation !== state.pollGeneration || state.subscribers.size === 0) {
			return;
		}
		state.polling = true;
		void pollPersistentObservers(state, openMemoryLix, mainBranchId, generation)
			.catch((error) => {
				if (generation !== state.pollGeneration) return;
				notifyPersistentObservers(state, { error });
			})
			.finally(() => {
				state.polling = false;
				if (state.subscribers.size === 0) return;
				if (generation !== state.pollGeneration) {
					state.pollAgain = false;
					schedulePersistentPoll(
						state,
						openMemoryLix,
						mainBranchId,
						pollIntervalMs,
						pollIntervalMs,
					);
					return;
				}
				const nextDelay = state.pollAgain ? 0 : pollIntervalMs;
				state.pollAgain = false;
				schedulePersistentPoll(
					state,
					openMemoryLix,
					mainBranchId,
					pollIntervalMs,
					nextDelay,
				);
			});
	}, delayMs);
}

async function pollPersistentObservers(
	state: PersistentWorkspaceState,
	openMemoryLix: OpenMemoryLix,
	mainBranchId: string,
	generation: number,
): Promise<void> {
	const previous = state.observerSnapshot;
	const cacheToken = state.cache;
	const snapshot = await fetchPersistentSnapshot(
		state,
		previous,
		openMemoryLix,
		mainBranchId,
	);
	if (snapshot !== previous) {
		const runtime = await openPersistentRuntime(openMemoryLix, snapshot.bytes);
		await closeQuietly(runtime.lix);
	}
	if (generation !== state.pollGeneration || state.subscribers.size === 0) {
		return;
	}
	if (snapshot !== previous) {
		state.observerSnapshot = snapshot;
		if (state.cache === cacheToken) state.cache = snapshot;
		state.generation += 1;
	}
	notifyPersistentObservers(state, { snapshot });
}

function notifyPersistentObservers(
	state: PersistentWorkspaceState,
	update: PersistentObserverUpdate,
): void {
	for (const subscriber of state.subscribers) subscriber(update);
}

async function openObservation(
	runtime: WorkspaceRuntime,
	body: Record<string, unknown>,
): Promise<{ id?: string; events: ObserveEvents }> {
	const branchId = requiredString(body, "branchId");
	const sql = requiredString(body, "sql");
	const params = decodeParams(body.params);
	return serialize(runtime, async () => {
		await runtime.lix.switchBranch({ branchId });
		return { events: await runtime.lix.observe(sql, params) };
	});
}

function observationResponse(
	observations: Array<{ id?: string; events: ObserveEvents }>,
	multiplex: boolean,
): Response {
	const encoder = new TextEncoder();
	let cancelled = false;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			keepAlive = setInterval(() => {
				if (!cancelled) controller.enqueue(encoder.encode(": keep-alive\n\n"));
			}, 15_000);
			void pumpObservations(
				observations,
				multiplex,
				controller,
				encoder,
				() => cancelled,
			)
				.catch((error) => {
					if (!cancelled) {
						controller.enqueue(
							encoder.encode(sseFrame("error", errorEnvelope(error))),
						);
					}
				})
				.finally(() => {
					if (keepAlive) clearInterval(keepAlive);
					for (const observation of observations) observation.events.close();
					if (!cancelled) controller.close();
				});
		},
		cancel() {
			cancelled = true;
			if (keepAlive) clearInterval(keepAlive);
			for (const observation of observations) observation.events.close();
		},
	});
	return new Response(stream, { headers: SSE_HEADERS });
}

async function pumpObservations(
	observations: Array<{ id?: string; events: ObserveEvents }>,
	multiplex: boolean,
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	isCancelled: () => boolean,
): Promise<void> {
	const pending = new Map<
		number,
		Promise<{ index: number; event?: ObserveEvent | null; error?: unknown }>
	>();
	const arm = (index: number) => {
		pending.set(
			index,
			observations[index].events.next().then(
				(event) => ({ index, event }),
				(error: unknown) => ({ index, error }),
			),
		);
	};
	observations.forEach((_observation, index) => arm(index));

	while (pending.size > 0) {
		const settled = await Promise.race(pending.values());
		if (isCancelled()) return;
		pending.delete(settled.index);
		const observation = observations[settled.index];
		if (settled.error) {
			controller.enqueue(
				encoder.encode(
					sseFrame(
						"error",
						multiplex
							? {
									subscriptionId: observation.id,
									...errorEnvelope(settled.error),
								}
							: errorEnvelope(settled.error),
					),
				),
			);
			observation.events.close();
			continue;
		}
		if (!settled.event) {
			observation.events.close();
			continue;
		}
		const payload = {
			...(multiplex ? { subscriptionId: observation.id } : {}),
			sequence: settled.event.sequence,
			mutationSequence: settled.event.mutationSequence,
			result: encodeExecuteResult(settled.event.rows),
		};
		controller.enqueue(encoder.encode(sseFrame("next", payload)));
		arm(settled.index);
	}
}

async function mutateFilesystem(
	runtime: WorkspaceRuntime,
	body: Record<string, unknown>,
	options: { skipRedundantBranchSwitch?: boolean } = {},
): Promise<{ outcome: "applied" | "conflict" | "already_exists" }> {
	const branchId = requiredString(body, "branchId");
	const path = requiredString(body, "path");
	const expectedRevision = requiredString(body, "expectedRevision");
	const kind = body.kind;
	if (kind !== "file" && kind !== "directory") {
		throw invalidArgument("kind must be file or directory");
	}
	const mutation = requestObject(body.mutation, "mutation");
	const mutationType = mutation.type;
	if (
		mutationType !== "replace_file" &&
		mutationType !== "move" &&
		mutationType !== "delete"
	) {
		throw invalidArgument("mutation type is invalid");
	}

	return serialize(runtime, async () => {
		await switchRequestBranch(runtime.lix, branchId, options);
		const transaction = await runtime.lix.beginTransaction();
		try {
			const table = kind === "file" ? "lix_file" : "lix_directory";
			const current = await transaction.execute(
				`SELECT id, lixcol_change_id FROM ${table} WHERE path = $1`,
				[{ kind: "text", value: path }],
			);
			if (!current.rows[0])
				return await rollbackOutcome(transaction, "conflict");
			const id = requiredNativeText(current, current.rows[0], "id");
			const revision = requiredNativeText(
				current,
				current.rows[0],
				"lixcol_change_id",
			);
			if (revision !== expectedRevision) {
				return await rollbackOutcome(transaction, "conflict");
			}

			let result: ExecuteResult;
			if (mutationType === "replace_file") {
				if (kind !== "file") {
					throw lixError(
						"LIX_INVALID_PARAM",
						"replace_file requires a file entry",
					);
				}
				result = await transaction.execute(
					"UPDATE lix_file SET data = $1, lixcol_metadata = $2 WHERE id = $3",
					[
						decodeWireValue(mutation.data, 0),
						decodeWireValue(mutation.metadata, 1),
						{ kind: "text", value: id },
					],
				);
			} else if (mutationType === "move") {
				const destinationPath = requiredString(mutation, "destinationPath");
				const filePath = destinationPath.replace(/\/+$/, "");
				const directoryPath = `${filePath}/`;
				const fileCollision = await transaction.execute(
					"SELECT id FROM lix_file WHERE path = $1",
					[{ kind: "text", value: filePath }],
				);
				const directoryCollision = await transaction.execute(
					"SELECT id FROM lix_directory WHERE path = $1",
					[{ kind: "text", value: directoryPath }],
				);
				if (fileCollision.rows.length || directoryCollision.rows.length) {
					return await rollbackOutcome(transaction, "already_exists");
				}
				result = await transaction.execute(
					`UPDATE ${table} SET path = $1 WHERE id = $2`,
					[
						{ kind: "text", value: destinationPath },
						{ kind: "text", value: id },
					],
				);
			} else {
				result = await transaction.execute(
					`DELETE FROM ${table} WHERE id = $1`,
					[{ kind: "text", value: id }],
				);
			}
			if (result.rowsAffected !== 1) {
				return await rollbackOutcome(transaction, "conflict");
			}
			await transaction.commit();
			return { outcome: "applied" };
		} catch (error) {
			try {
				await transaction.rollback();
			} catch {
				// Preserve the operation error if rollback also fails.
			}
			throw error;
		}
	});
}

async function rollbackOutcome(
	transaction: LixTransaction,
	outcome: "conflict" | "already_exists",
) {
	await transaction.rollback();
	return { outcome };
}

function serialize<T>(
	runtime: WorkspaceRuntime,
	operation: () => Promise<T>,
): Promise<T> {
	const result = runtime.finiteQueue.then(operation, operation);
	runtime.finiteQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function encodeExecuteResult(result: ExecuteResult) {
	return {
		columns: result.columns,
		rows: result.rows.map((row) => row.map(encodeWireValue)),
		rowsAffected: result.rowsAffected,
		notices: result.notices,
	};
}

export function encodeWireValue(value: NativeValue): WireValue {
	switch (value.kind) {
		case "null":
			return { kind: "null", value: null };
		case "boolean":
			return { kind: "bool", value: value.value };
		case "integer":
			return { kind: "int", value: value.value };
		case "real":
			return { kind: "float", value: value.value };
		case "text":
			return { kind: "text", value: value.value };
		case "blob":
			return { kind: "blob", base64: bytesToBase64(value.blob) };
		case "json":
			return { kind: "json", value: value.value };
	}
}

function decodeParams(value: unknown): NativeValue[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw invalidArgument("params must be an array");
	return value.map(decodeWireValue);
}

export function decodeWireValue(value: unknown, index = 0): NativeValue {
	try {
		const wire = objectValue(value, `params[${index}]`);
		switch (wire.kind) {
			case "null":
				return { kind: "null", value: null };
			case "bool":
				if (typeof wire.value !== "boolean")
					throw new TypeError("expected bool");
				return { kind: "boolean", value: wire.value };
			case "int":
				if (!Number.isSafeInteger(wire.value))
					throw new TypeError("expected int");
				return { kind: "integer", value: wire.value as number };
			case "float":
				if (typeof wire.value !== "number" || !Number.isFinite(wire.value)) {
					throw new TypeError("expected float");
				}
				return { kind: "real", value: wire.value };
			case "text":
				if (typeof wire.value !== "string")
					throw new TypeError("expected text");
				return { kind: "text", value: wire.value };
			case "blob":
				if (typeof wire.base64 !== "string")
					throw new TypeError("expected blob");
				return { kind: "blob", value: null, blob: base64ToBytes(wire.base64) };
			case "json":
				if (!("value" in wire)) throw new TypeError("expected json");
				return { kind: "json", value: wire.value };
			default:
				throw new TypeError("unknown kind");
		}
	} catch (error) {
		if (isLixError(error)) throw error;
		throw lixError(
			"LIX_INVALID_PARAM",
			`invalid SQL parameter at index ${index}: ${errorMessage(error)}`,
			undefined,
			{ parameter_index: index, source_code: "LIX_INVALID_PARAM" },
		);
	}
}

function requiredNativeText(
	result: ExecuteResult,
	row: NativeValue[],
	column: string,
): string {
	const value = row[result.columns.indexOf(column)];
	if (value?.kind !== "text") {
		throw lixError("LIX_TYPE_MISMATCH", `expected text column ${column}`);
	}
	return value.value;
}

function requiredNativeBoolean(
	result: ExecuteResult,
	row: NativeValue[],
	column: string,
): boolean {
	const value = row[result.columns.indexOf(column)];
	if (value?.kind !== "boolean") {
		throw lixError("LIX_TYPE_MISMATCH", `expected bool column ${column}`);
	}
	return value.value;
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
	try {
		return objectValue(await request.json(), "request body");
	} catch (error) {
		if (isLixError(error)) throw error;
		throw invalidArgument(`invalid JSON body: ${errorMessage(error)}`);
	}
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requestObject(value: unknown, label: string): Record<string, unknown> {
	try {
		return objectValue(value, label);
	} catch (error) {
		throw invalidArgument(errorMessage(error));
	}
}

function requiredString(
	value: Record<string, unknown>,
	key: string,
	label = key,
): string {
	const field = value[key];
	if (typeof field !== "string" || field.trim().length === 0) {
		throw invalidArgument(`${label} is required`);
	}
	return field;
}

function optionalString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	if (field === undefined || field === null) return undefined;
	if (typeof field !== "string")
		throw invalidArgument(`${key} must be a string`);
	return field;
}

function executeOriginKey(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	return optionalString(requestObject(value, "options"), "originKey");
}

function methodNotAllowed() {
	return new Response("Method not allowed\n", { status: 405 });
}

function json(value: unknown, status = 200) {
	return Response.json(value, { status });
}

function sseFrame(event: string, value: unknown) {
	return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function invalidArgument(message: string) {
	return lixError("LIX_INVALID_ARGUMENT", message);
}

function lixError(
	code: string,
	message: string,
	hint?: string,
	details?: unknown,
) {
	return Object.assign(new Error(message), { code, hint, details });
}

function previewError(code: string, message: string, cause?: unknown) {
	return Object.assign(new Error(message, { cause }), { code });
}

function isPreviewError(error: unknown): error is Error & { code: string } {
	return isLixError(error) && error.code.startsWith("PREVIEW_");
}

function isLixError(error: unknown): error is Error & { code: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	);
}

function errorEnvelope(error: unknown) {
	const record =
		typeof error === "object" && error !== null
			? (error as Record<string, unknown>)
			: {};
	const code =
		typeof record.code === "string" ? record.code : "LIX_INTERNAL_ERROR";
	const message =
		typeof record.code === "string" && typeof record.message === "string"
			? record.message
			: "internal server error";
	return {
		error: {
			code,
			message,
			...(typeof record.hint === "string" ? { hint: record.hint } : {}),
			...(record.details !== undefined ? { details: record.details } : {}),
		},
	};
}

function errorResponse(error: unknown) {
	const envelope = errorEnvelope(error);
	const { code } = envelope.error;
	const status = code.startsWith("PREVIEW_")
		? 503
		: NOT_FOUND_CODES.has(code)
			? 404
			: BAD_REQUEST_CODES.has(code)
				? 400
				: code === "LIX_CLOSED" || code === "LIX_ERROR_CLOSED"
					? 409
					: 500;
	const response = json(envelope, status);
	if (code === "PREVIEW_STORAGE_CONFLICT") {
		response.headers.set("Retry-After", "1");
	}
	return response;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
