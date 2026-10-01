/**
 * A small, text-file working set for browser prototypes.
 *
 * The server remains authoritative. Opening a warm working set reads only its
 * local snapshot and outbox; `sync()` is the explicit network boundary. The
 * outbox keeps its base revision and base text independently of the disposable
 * cache snapshot, so clearing a cache epoch cannot discard an offline edit.
 */

export interface PrototypeWorkingSetScope {
	accountId: string;
	repositoryId: string;
	branchId: string;
	fileId: string;
}

export interface PrototypeCommittedFile {
	revision: string;
	content: string;
}

export interface PrototypePendingEdit {
	operationId: string;
	/** Revision expected by this operation when it is sent. */
	baseRevision: string;
	/** Base text is durable outbox data, not part of the disposable cache. */
	baseContent: string;
	content: string;
	/** Once true, retries must keep this operation ID and its exact payload. */
	attempted: boolean;
}

export interface PrototypeWorkingSetConflict {
	operationId: string;
	baseRevision: string;
	baseContent: string;
	localContent: string;
	actual: PrototypeCommittedFile;
}

export interface PrototypeStoredWorkingSet {
	key: string;
	scope: PrototypeWorkingSetScope;
	/** Disposable cache snapshot. Pending operations carry their own bases. */
	snapshot: PrototypeCommittedFile | null;
	pending: PrototypePendingEdit[];
	conflict: PrototypeWorkingSetConflict | null;
}

export interface PrototypePublishRequest {
	operationId: string;
	baseRevision: string;
	baseContent: string;
	content: string;
}

export type PrototypePublishResult =
	| { status: "committed"; revision: string }
	| { status: "conflict"; actual: PrototypeCommittedFile };

/** The adapter owns server reads, CAS semantics, and idempotency receipts. */
export interface PrototypeWorkingSetRemote {
	read(scope: PrototypeWorkingSetScope): Promise<PrototypeCommittedFile>;
	compareAndSet(
		scope: PrototypeWorkingSetScope,
		request: PrototypePublishRequest,
	): Promise<PrototypePublishResult>;
}

// Short public names keep the adapter contract readable at call sites.
export type WorkingSetScope = PrototypeWorkingSetScope;
export type WorkingSetRemote = PrototypeWorkingSetRemote;
export type WorkingSetPublishRequest = PrototypePublishRequest;
export type WorkingSetPublishResult = PrototypePublishResult;

export interface PrototypeWorkingSetStore {
	load(key: string): Promise<PrototypeStoredWorkingSet | undefined>;
	transact<T>(
		key: string,
		update: (current: PrototypeStoredWorkingSet | undefined) => {
			next: PrototypeStoredWorkingSet | undefined;
			result: T;
		},
	): Promise<T>;
}

export interface OpenPrototypeWorkingSetOptions {
	scope: PrototypeWorkingSetScope;
	store: PrototypeWorkingSetStore;
	remote: PrototypeWorkingSetRemote;
	/** Must return globally unique IDs; retried IDs are immutable. */
	createOperationId?: () => string;
}

export interface PrototypeWorkingSetView {
	scope: PrototypeWorkingSetScope;
	committed: PrototypeCommittedFile | null;
	content: string | null;
	pending: PrototypePendingEdit[];
	conflict: PrototypeWorkingSetConflict | null;
	status: "clean" | "pending" | "conflict";
}

export type PrototypeWorkingSetSyncResult =
	| { status: "synced"; committed: PrototypeCommittedFile; pendingCount: 0 }
	| { status: "clean"; committed: PrototypeCommittedFile; pendingCount: 0 }
	| {
			status: "offline";
			committed: PrototypeCommittedFile | null;
			pendingCount: number;
			error: unknown;
	  }
	| { status: "conflict"; conflict: PrototypeWorkingSetConflict };

/** Use this for known offline failures; other remote errors stay visible. */
export class PrototypeWorkingSetOfflineError extends Error {
	constructor(
		message = "The server is temporarily unreachable.",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PrototypeWorkingSetOfflineError";
	}
}

export class PrototypeWorkingSetStaleDraftError extends Error {
	readonly expectedContent: string;
	readonly currentContent: string;

	constructor(expectedContent: string, currentContent: string) {
		super(
			"This draft is stale. Read the latest working set before editing again.",
		);
		this.name = "PrototypeWorkingSetStaleDraftError";
		this.expectedContent = expectedContent;
		this.currentContent = currentContent;
	}
}

type PreparedAttempt =
	| { kind: "empty" }
	| { kind: "conflict"; conflict: PrototypeWorkingSetConflict }
	| { kind: "publish"; edit: PrototypePendingEdit };

type RecordedCommit =
	| { kind: "committed"; file: PrototypeCommittedFile }
	| { kind: "pending" }
	| { kind: "conflict"; conflict: PrototypeWorkingSetConflict };

type RecordedConflict =
	| { kind: "conflict"; conflict: PrototypeWorkingSetConflict }
	| { kind: "stale" };

const DATABASE_VERSION = 1;
const DATABASE_STORE = "working_sets";

/** Stable tuple encoding keeps accounts, repositories, branches, and files apart. */
export function prototypeWorkingSetKey(
	scope: PrototypeWorkingSetScope,
): string {
	return JSON.stringify([
		scope.accountId,
		scope.repositoryId,
		scope.branchId,
		scope.fileId,
	]);
}

/**
 * IndexedDB persistence for browser use. The injectable factory keeps this
 * module usable in tests and in browser environments with a custom IDB shim.
 */
export class IndexedDbPrototypeWorkingSetStore implements PrototypeWorkingSetStore {
	private database: Promise<IDBDatabase> | undefined;
	private readonly factory: IDBFactory;
	private readonly databaseName: string;

	constructor(options: { indexedDB?: IDBFactory; databaseName?: string } = {}) {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (!factory) {
			throw new Error("IndexedDB is unavailable in this environment.");
		}
		this.factory = factory;
		this.databaseName =
			options.databaseName ?? "lixray-prototype-working-set-v1";
	}

	async load(key: string): Promise<PrototypeStoredWorkingSet | undefined> {
		const database = await this.openDatabase();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction(DATABASE_STORE, "readonly");
			const request = transaction.objectStore(DATABASE_STORE).get(key);
			request.onsuccess = () => {
				resolve(
					request.result === undefined
						? undefined
						: cloneStoredWorkingSet(
								request.result as PrototypeStoredWorkingSet,
							),
				);
			};
			request.onerror = () =>
				reject(
					asError(
						request.error ?? transaction.error,
						"IndexedDB read request failed.",
					),
				);
			transaction.onabort = () =>
				reject(
					asError(transaction.error, "IndexedDB read transaction aborted."),
				);
		});
	}

	async transact<T>(
		key: string,
		update: (current: PrototypeStoredWorkingSet | undefined) => {
			next: PrototypeStoredWorkingSet | undefined;
			result: T;
		},
	): Promise<T> {
		const database = await this.openDatabase();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction(DATABASE_STORE, "readwrite", {
				durability: "strict",
			});
			const objectStore = transaction.objectStore(DATABASE_STORE);
			const request = objectStore.get(key);
			let result: T;
			let updateError: unknown;

			request.onsuccess = () => {
				try {
					const current =
						request.result === undefined
							? undefined
							: cloneStoredWorkingSet(
									request.result as PrototypeStoredWorkingSet,
								);
					const outcome = update(current);
					result = outcome.result;
					if (outcome.next === undefined) objectStore.delete(key);
					else objectStore.put(outcome.next, key);
				} catch (error) {
					updateError = error;
					transaction.abort();
				}
			};
			request.onerror = () =>
				reject(
					asError(
						request.error ?? transaction.error,
						"IndexedDB write request failed.",
					),
				);
			transaction.oncomplete = () => resolve(cloneValue(result));
			transaction.onabort = () =>
				reject(
					asError(
						updateError ?? transaction.error,
						"IndexedDB write transaction aborted.",
					),
				);
		});
	}

	private openDatabase(): Promise<IDBDatabase> {
		if (this.database) return this.database;
		this.database = new Promise((resolve, reject) => {
			const request = this.factory.open(this.databaseName, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(DATABASE_STORE)) {
					request.result.createObjectStore(DATABASE_STORE);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(asError(request.error, "IndexedDB database open failed."));
		});
		return this.database;
	}
}

/** In-memory store seam for tests and non-browser prototypes. */
export class MemoryPrototypeWorkingSetStore implements PrototypeWorkingSetStore {
	private readonly values = new Map<string, PrototypeStoredWorkingSet>();
	private transactionQueue: Promise<void> = Promise.resolve();

	async load(key: string): Promise<PrototypeStoredWorkingSet | undefined> {
		await this.transactionQueue;
		const value = this.values.get(key);
		return value ? cloneStoredWorkingSet(value) : undefined;
	}

	transact<T>(
		key: string,
		update: (current: PrototypeStoredWorkingSet | undefined) => {
			next: PrototypeStoredWorkingSet | undefined;
			result: T;
		},
	): Promise<T> {
		const task = this.transactionQueue.then(() => {
			const current = this.values.get(key);
			const outcome = update(
				current ? cloneStoredWorkingSet(current) : undefined,
			);
			if (outcome.next === undefined) this.values.delete(key);
			else this.values.set(key, cloneStoredWorkingSet(outcome.next));
			return cloneValue(outcome.result);
		});
		this.transactionQueue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
}

/**
 * Local-first text working set. `open()` fetches only when there is no warm
 * snapshot or durable pending edit. Network publication happens only in
 * `sync()` and uses compare-and-set plus a stable operation ID.
 */
export class PrototypeWorkingSet {
	readonly scope: PrototypeWorkingSetScope;
	readonly key: string;
	private readonly store: PrototypeWorkingSetStore;
	private readonly remote: PrototypeWorkingSetRemote;
	private readonly createOperationId: () => string;
	private syncPromise: Promise<PrototypeWorkingSetSyncResult> | undefined;

	private constructor(options: OpenPrototypeWorkingSetOptions) {
		this.scope = Object.freeze({ ...options.scope });
		this.key = prototypeWorkingSetKey(options.scope);
		this.store = options.store;
		this.remote = options.remote;
		this.createOperationId = options.createOperationId ?? defaultOperationId;
	}

	static async open(
		options: OpenPrototypeWorkingSetOptions,
	): Promise<PrototypeWorkingSet> {
		const stableOptions = {
			...options,
			scope: { ...options.scope },
		};
		validateScope(stableOptions.scope);
		const workingSet = new PrototypeWorkingSet(stableOptions);
		const stored = await options.store.load(workingSet.key);
		if (stored && hasWarmData(stored)) return workingSet;

		// A cache miss is the sole implicit server read. Warm sessions and
		// outbox-only sessions never make a network request during open().
		const committed = await options.remote.read(stableOptions.scope);
		validateCommittedFile(committed);
		await options.store.transact(workingSet.key, (current) => {
			if (current && hasWarmData(current)) {
				return { next: current, result: undefined };
			}
			const next: PrototypeStoredWorkingSet = current
				? { ...current, snapshot: cloneCommittedFile(committed) }
				: {
						key: workingSet.key,
						scope: { ...stableOptions.scope },
						snapshot: cloneCommittedFile(committed),
						pending: [],
						conflict: null,
					};
			return { next, result: undefined };
		});
		return workingSet;
	}

	async read(): Promise<PrototypeWorkingSetView> {
		const stored = await this.store.load(this.key);
		if (!stored) {
			throw new Error("The working set has not been initialized.");
		}
		const committed = knownCommittedFile(stored);
		const pending = stored.pending.map(clonePendingEdit);
		return {
			scope: { ...stored.scope },
			committed,
			content: pending.at(-1)?.content ?? committed?.content ?? null,
			pending,
			conflict: stored.conflict ? cloneConflict(stored.conflict) : null,
			status: stored.conflict
				? "conflict"
				: pending.length > 0
					? "pending"
					: "clean",
		};
	}

	/**
	 * Persist a full text draft locally; this method never calls the server.
	 * `expectedCurrentContent` makes a stale editor fail rather than replacing a
	 * newer draft written by another tab.
	 */
	async edit(
		content: string,
		expectedCurrentContent: string,
	): Promise<PrototypeWorkingSetView> {
		await this.store.transact(this.key, (stored) => {
			if (!stored) throw new Error("The working set has not been initialized.");
			const next = cloneStoredWorkingSet(stored);
			const last = next.pending.at(-1);
			const visibleBefore = last?.content ?? knownCommittedFile(next)?.content;
			if (visibleBefore === undefined || visibleBefore === null) {
				throw new Error("The working set has no committed base text.");
			}
			if (expectedCurrentContent !== visibleBefore) {
				throw new PrototypeWorkingSetStaleDraftError(
					expectedCurrentContent,
					visibleBefore,
				);
			}

			const operationId = this.createOperationId();
			if (last && !last.attempted) {
				// An unsent full-text draft can be coalesced. Give the replacement
				// payload a fresh id so an idempotency receipt can never mismatch.
				next.pending[next.pending.length - 1] = {
					...last,
					operationId,
					content,
				};
			} else {
				const parent = last;
				const committed = knownCommittedFile(next);
				if (!parent && !committed) {
					throw new Error("The working set has no committed base revision.");
				}
				next.pending.push({
					operationId,
					baseRevision: parent?.baseRevision ?? committed!.revision,
					// Until the preceding attempted edit is acknowledged, this
					// operation is still based on the last known server version.
					// `recordCommit` advances it to the preceding edit's result.
					baseContent: parent?.baseContent ?? visibleBefore,
					content,
					attempted: false,
				});
			}
			return { next, result: undefined };
		});
		return this.read();
	}

	/**
	 * Clear only the disposable committed snapshot. Pending bases and conflict
	 * data stay in the outbox and are enough to reopen offline.
	 */
	async resetCache(): Promise<void> {
		await this.store.transact(this.key, (stored) => {
			if (!stored) return { next: stored, result: undefined };
			return {
				next: { ...stored, snapshot: null },
				result: undefined,
			};
		});
	}

	/** Explicitly refresh a clean cache from the server. Never drops local edits. */
	async refresh(): Promise<PrototypeWorkingSetView> {
		const before = await this.store.load(this.key);
		if (!before) throw new Error("The working set has not been initialized.");
		if (before.pending.length > 0 || before.conflict) return this.read();
		const previousRevision = before.snapshot?.revision ?? null;

		const committed = await this.remote.read(this.scope);
		validateCommittedFile(committed);
		await this.store.transact(this.key, (current) => {
			if (!current)
				throw new Error("The working set has not been initialized.");
			if (current.pending.length > 0 || current.conflict) {
				return { next: current, result: undefined };
			}
			if ((current.snapshot?.revision ?? null) !== previousRevision) {
				// A local commit or a newer refresh completed while this read was
				// in flight. Never let an older response roll the cache backward.
				return { next: current, result: undefined };
			}
			return {
				next: { ...current, snapshot: cloneCommittedFile(committed) },
				result: undefined,
			};
		});
		return this.read();
	}

	/**
	 * Publish queued full-text edits in order. An attempted operation is retried
	 * with its original ID and payload, including after a lost acknowledgement.
	 */
	sync(): Promise<PrototypeWorkingSetSyncResult> {
		if (this.syncPromise) return this.syncPromise;
		const syncing = this.runSync();
		this.syncPromise = syncing;
		void syncing.then(
			() => {
				if (this.syncPromise === syncing) this.syncPromise = undefined;
			},
			() => {
				if (this.syncPromise === syncing) this.syncPromise = undefined;
			},
		);
		return syncing;
	}

	/** Resolve a conflict by saving the caller's merged full-text result. */
	async resolveConflict(
		mergedContent: string,
	): Promise<PrototypeWorkingSetView> {
		await this.store.transact(this.key, (stored) => {
			if (!stored?.conflict) {
				throw new Error("There is no working set conflict to resolve.");
			}
			const actual = stored.conflict.actual;
			const next = cloneStoredWorkingSet(stored);
			next.snapshot = cloneCommittedFile(actual);
			next.conflict = null;
			next.pending =
				mergedContent === actual.content
					? []
					: [
							{
								operationId: this.createOperationId(),
								baseRevision: actual.revision,
								baseContent: actual.content,
								content: mergedContent,
								attempted: false,
							},
						];
			return { next, result: undefined };
		});
		return this.read();
	}

	private async runSync(): Promise<PrototypeWorkingSetSyncResult> {
		while (true) {
			const attempt = await this.prepareAttempt();
			if (attempt.kind === "conflict") {
				return { status: "conflict", conflict: attempt.conflict };
			}
			if (attempt.kind === "empty") {
				const committed = await this.readCommitted();
				return { status: "clean", committed, pendingCount: 0 };
			}

			let result: PrototypePublishResult;
			try {
				result = await this.remote.compareAndSet(this.scope, {
					operationId: attempt.edit.operationId,
					baseRevision: attempt.edit.baseRevision,
					baseContent: attempt.edit.baseContent,
					content: attempt.edit.content,
				});
			} catch (error) {
				if (!isTransientNetworkFailure(error)) throw error;
				const view = await this.read();
				return {
					status: "offline",
					committed: view.committed,
					pendingCount: view.pending.length,
					error,
				};
			}

			if (result.status === "conflict") {
				validateCommittedFile(result.actual);
				const recorded = await this.recordConflict(attempt.edit, result.actual);
				if (recorded.kind === "stale") continue;
				return { status: "conflict", conflict: recorded.conflict };
			}

			const committed = await this.recordCommit(attempt.edit, result.revision);
			if (committed.kind === "conflict") {
				return { status: "conflict", conflict: committed.conflict };
			}
			if (committed.kind === "pending") continue;
			return { status: "synced", committed: committed.file, pendingCount: 0 };
		}
	}

	private async prepareAttempt(): Promise<PreparedAttempt> {
		return this.store.transact<PreparedAttempt>(this.key, (stored) => {
			if (!stored) throw new Error("The working set has not been initialized.");
			if (stored.conflict) {
				return {
					next: stored,
					result: {
						kind: "conflict",
						conflict: cloneConflict(stored.conflict),
					},
				};
			}
			const head = stored.pending[0];
			if (!head) return { next: stored, result: { kind: "empty" } };

			const next = cloneStoredWorkingSet(stored);
			let operation = next.pending[0];
			if (!operation.attempted) {
				const base = knownCommittedFile(next);
				if (!base) throw new Error("The outbox has no committed base file.");
				operation = {
					...operation,
					baseRevision: base.revision,
					baseContent: base.content,
					attempted: true,
				};
				next.pending[0] = operation;
			}
			return {
				next,
				result: { kind: "publish", edit: clonePendingEdit(operation) },
			};
		});
	}

	private async recordCommit(
		attempt: PrototypePendingEdit,
		revision: string,
	): Promise<RecordedCommit> {
		if (!revision) throw new Error("The server returned an empty revision.");
		return this.store.transact<RecordedCommit>(this.key, (stored) => {
			if (!stored) throw new Error("The working set has not been initialized.");
			if (stored.conflict) {
				return {
					next: stored,
					result: {
						kind: "conflict",
						conflict: cloneConflict(stored.conflict),
					},
				};
			}
			const head = stored.pending[0];
			if (!head || head.operationId !== attempt.operationId) {
				// Another tab may have applied this idempotent operation first.
				if (stored.snapshot?.revision === revision) {
					return { next: stored, result: { kind: "pending" } };
				}
				return { next: stored, result: { kind: "pending" } };
			}

			const next = cloneStoredWorkingSet(stored);
			const file = { revision, content: attempt.content };
			next.snapshot = file;
			next.pending.shift();
			if (next.pending[0]) {
				next.pending[0] = {
					...next.pending[0],
					baseRevision: revision,
					baseContent: attempt.content,
					attempted: false,
				};
				return { next, result: { kind: "pending" } };
			}
			return { next, result: { kind: "committed", file } };
		});
	}

	private async recordConflict(
		attempt: PrototypePendingEdit,
		actual: PrototypeCommittedFile,
	): Promise<RecordedConflict> {
		return this.store.transact<RecordedConflict>(this.key, (stored) => {
			if (!stored) throw new Error("The working set has not been initialized.");
			if (stored.conflict) {
				return {
					next: stored,
					result: {
						kind: "conflict",
						conflict: cloneConflict(stored.conflict),
					},
				};
			}
			if (stored.pending[0]?.operationId !== attempt.operationId) {
				// A different tab may have already settled this operation. Its stale
				// CAS response must not mark the newer local state as conflicted.
				return { next: stored, result: { kind: "stale" } };
			}
			const next = cloneStoredWorkingSet(stored);
			const conflict: PrototypeWorkingSetConflict = {
				operationId: attempt.operationId,
				baseRevision: attempt.baseRevision,
				baseContent: attempt.baseContent,
				localContent: next.pending.at(-1)?.content ?? attempt.content,
				actual: cloneCommittedFile(actual),
			};
			next.snapshot = cloneCommittedFile(actual);
			next.conflict = conflict;
			return {
				next,
				result: { kind: "conflict", conflict: cloneConflict(conflict) },
			};
		});
	}

	private async readCommitted(): Promise<PrototypeCommittedFile> {
		const view = await this.read();
		if (!view.committed)
			throw new Error("The working set has no committed file.");
		return view.committed;
	}
}

export function createIndexedDbPrototypeWorkingSetStore(): PrototypeWorkingSetStore {
	return new IndexedDbPrototypeWorkingSetStore();
}

export { PrototypeWorkingSet as WorkingSet };

function validateScope(scope: PrototypeWorkingSetScope): void {
	for (const [name, value] of [
		["accountId", scope.accountId],
		["repositoryId", scope.repositoryId],
		["branchId", scope.branchId],
		["fileId", scope.fileId],
	] as const) {
		if (!value.trim())
			throw new Error(`Working set ${name} must not be empty.`);
	}
}

function asError(error: unknown, message: string): Error {
	return error instanceof Error ? error : new Error(message, { cause: error });
}

function validateCommittedFile(file: PrototypeCommittedFile): void {
	if (!file.revision) throw new Error("A committed file must have a revision.");
	if (typeof file.content !== "string") {
		throw new Error("The prototype working set supports text files only.");
	}
}

function hasWarmData(stored: PrototypeStoredWorkingSet): boolean {
	return (
		stored.snapshot !== null ||
		stored.pending.length > 0 ||
		stored.conflict !== null
	);
}

function knownCommittedFile(
	stored: PrototypeStoredWorkingSet,
): PrototypeCommittedFile | null {
	if (stored.conflict) return cloneCommittedFile(stored.conflict.actual);
	if (stored.snapshot) return cloneCommittedFile(stored.snapshot);
	const head = stored.pending[0];
	if (head) {
		return { revision: head.baseRevision, content: head.baseContent };
	}
	return null;
}

function defaultOperationId(): string {
	if (typeof globalThis.crypto?.randomUUID !== "function") {
		throw new Error("A secure random UUID generator is required for edits.");
	}
	return globalThis.crypto.randomUUID();
}

function isTransientNetworkFailure(error: unknown): boolean {
	if (error instanceof PrototypeWorkingSetOfflineError) return true;
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		name?: unknown;
		message?: unknown;
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		cause?: unknown;
	};
	if (typeof candidate.code === "string") {
		return candidate.code === "LIX_TRANSPORT_NETWORK";
	}
	if (
		typeof candidate.status === "number" ||
		typeof candidate.statusCode === "number"
	) {
		return false;
	}
	const message =
		typeof candidate.message === "string" ? candidate.message : "";
	const networkError =
		candidate.name === "NetworkError" ||
		(candidate.name === "TypeError" &&
			/failed to fetch|fetch failed|network error|network request failed|network disconnected|load failed|connection (?:closed|reset|refused)|dropped .*acknowledg|acknowledg(?:e|ment)? .*lost|offline/i.test(
				message,
			));
	if (networkError) return true;
	return (
		candidate.cause !== undefined && isTransientNetworkFailure(candidate.cause)
	);
}

function cloneStoredWorkingSet(
	stored: PrototypeStoredWorkingSet,
): PrototypeStoredWorkingSet {
	return {
		key: stored.key,
		scope: { ...stored.scope },
		snapshot: stored.snapshot ? cloneCommittedFile(stored.snapshot) : null,
		pending: stored.pending.map(clonePendingEdit),
		conflict: stored.conflict ? cloneConflict(stored.conflict) : null,
	};
}

function clonePendingEdit(edit: PrototypePendingEdit): PrototypePendingEdit {
	return { ...edit };
}

function cloneCommittedFile(
	file: PrototypeCommittedFile,
): PrototypeCommittedFile {
	return { ...file };
}

function cloneConflict(
	conflict: PrototypeWorkingSetConflict,
): PrototypeWorkingSetConflict {
	return {
		...conflict,
		actual: cloneCommittedFile(conflict.actual),
	};
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}
