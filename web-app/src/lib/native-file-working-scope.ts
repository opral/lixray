import type { Lix } from "@lix-js/sdk";

const FILE_CONTENT_SCOPE_SQL = "SELECT id, content FROM lix_file WHERE id = $1";
const ACTIVE_BRANCH_HEAD_SQL =
	"SELECT lix_active_branch_commit_id() AS commit_id";

const SCOPE_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000] as const;
const TRANSIENT_SCOPE_ERROR_CODES = new Set([
	"LIX_ERROR_RECOVERING",
	"LIX_PARTIAL_REPLICA_OFFLINE",
	"LIX_TRANSPORT_NETWORK",
	"LIX_TRANSPORT_UNAVAILABLE",
]);
const INVALIDATING_SQL_FUNCTIONS =
	/\b(?:lix_create_checkpoint|lix_restore)\s*\(/i;

export const NATIVE_FILE_SCOPE_UNAVAILABLE_CODE =
	"LIX_NATIVE_FILE_SCOPE_UNAVAILABLE";

export class NativeFileWorkingScopeUnavailableError extends Error {
	readonly code = NATIVE_FILE_SCOPE_UNAVAILABLE_CODE;

	constructor() {
		super("The selected document is unavailable on this branch.");
		this.name = "NativeFileWorkingScopeUnavailableError";
	}
}

export interface NativeFileWorkingScopeOptions {
	/** Stable identity of the existing file being opened. */
	fileId: string | undefined;
	/** Retry delays for read-only preparation failures. */
	retryDelaysMs?: readonly number[];
	/** Injectable delay keeps retry behavior testable without wall-clock waits. */
	delay?: (milliseconds: number) => Promise<void>;
}

/**
 * Gate Atelier's document Lix calls on one exact existing file and the active
 * native branch write frontier. The supported offline write is updating the
 * selected existing file's `lix_file.content`, as the built-in text and
 * Markdown editors do. CSV metadata, conversation records, plugin-owned
 * tables, file creation, renames, and directory operations need their own
 * inputs and are not certified here.
 *
 * A preparation failure happens before the caller's SQL runs. Transient
 * offline/recovery failures retry only the idempotent file read and frontier
 * preparation. The failed branch promise is discarded so a later open can
 * retry, and no OPFS state or pending native work is cleared.
 */
export function withNativeFileWorkingScope(
	lix: Lix,
	options: NativeFileWorkingScopeOptions,
): Lix {
	const retryDelays = options.retryDelaysMs ?? SCOPE_RETRY_DELAYS_MS;
	const delay = options.delay ?? sleep;
	const readyHeads = new Map<string, string>();
	const preparingBranches = new Map<string, Promise<string | false>>();

	const prepareBranch = async (
		branchId: string,
		fileId: string,
	): Promise<string | false> => {
		let retryAttempt = 0;
		for (;;) {
			try {
				if ((await lix.activeBranchId()) !== branchId) return false;
				const beforeHead = await readActiveBranchHead(lix, branchId);
				if (beforeHead === false) return false;
				const file = await lix.execute<{ id: string; content: unknown }>(
					FILE_CONTENT_SCOPE_SQL,
					[fileId],
				);
				if ((await lix.activeBranchId()) !== branchId) return false;
				if (file.rows.length === 0)
					throw new NativeFileWorkingScopeUnavailableError();
				if (file.rows.length !== 1 || file.rows[0]?.id !== fileId)
					throw new Error("The selected document query returned invalid data.");
				await lix.prepareOfflineEditing();
				const afterHead = await readActiveBranchHead(lix, branchId);
				if (afterHead === false) return false;
				// A native pull can advance the selected branch while the graph
				// frontier is being prepared. Repeat against the new head before
				// reporting the editor ready.
				if (afterHead !== beforeHead) continue;
				return afterHead;
			} catch (error) {
				if (
					!isRetryableScopePreparationError(error) ||
					retryAttempt >= retryDelays.length
				) {
					throw error;
				}
				await delay(retryDelays[retryAttempt]!);
				retryAttempt += 1;
			}
		}
	};

	const ensureReady = async (
		checkHead: boolean,
		allowMissingCurrentFile = false,
	): Promise<string> => {
		const fileId = options.fileId;
		if (!fileId) {
			throw new Error(
				"Native document editing requires a stable file identity.",
			);
		}
		for (;;) {
			const branchId = await lix.activeBranchId();
			const readyHead = readyHeads.get(branchId);
			if (readyHead !== undefined) {
				if (!checkHead) return branchId;
				const actualHead = await readActiveBranchHead(lix, branchId);
				if (actualHead === false) continue;
				if (actualHead === readyHead) return branchId;
				readyHeads.delete(branchId);
			}
			let preparation = preparingBranches.get(branchId);
			if (!preparation) {
				preparation = prepareBranch(branchId, fileId);
				preparingBranches.set(branchId, preparation);
				void preparation.then(
					(head) => {
						if (preparingBranches.get(branchId) === preparation)
							preparingBranches.delete(branchId);
						if (typeof head === "string") readyHeads.set(branchId, head);
					},
					() => {
						if (preparingBranches.get(branchId) === preparation)
							preparingBranches.delete(branchId);
					},
				);
			}
			let head: string | false;
			try {
				head = await preparation;
			} catch (error) {
				if (preparingBranches.get(branchId) === preparation)
					preparingBranches.delete(branchId);
				if (
					allowMissingCurrentFile &&
					error instanceof NativeFileWorkingScopeUnavailableError
				) {
					if ((await lix.activeBranchId()) !== branchId) continue;
					return branchId;
				}
				throw error;
			}
			if (typeof head === "string") {
				if ((await lix.activeBranchId()) !== branchId) continue;
				if (checkHead) {
					const actualHead = await readActiveBranchHead(lix, branchId);
					if (actualHead === false) continue;
					if (actualHead !== head) {
						readyHeads.delete(branchId);
						continue;
					}
				}
				return branchId;
			}
		}
	};

	const afterSuccessfulMutation = <T>(
		result: T,
		branchId: string,
		invalidate: boolean,
	): T => {
		if (invalidate) {
			readyHeads.delete(branchId);
			return result;
		}
		const commit =
			typeof result === "object" && result !== null && "commit" in result
				? result.commit
				: undefined;
		if (
			typeof commit === "object" &&
			commit !== null &&
			"after" in commit &&
			typeof commit.after === "string"
		) {
			readyHeads.set(branchId, commit.after);
		}
		return result;
	};

	return new Proxy(lix, {
		get(target, key) {
			const method = Reflect.get(target, key, target) as unknown;
			if (typeof method !== "function") return method;

			if (key === "observe") {
				return (...args: unknown[]) => {
					let iterator: AsyncIterableIterator<unknown> | undefined;
					let finished = false;
					const getIterator = async () => {
						if (finished) return undefined;
						if (iterator) return iterator;
						try {
							await ensureReady(false, true);
						} catch (error) {
							if (!(error instanceof NativeFileWorkingScopeUnavailableError))
								throw error;
						}
						// return() may run while readiness is still pending. Do not
						// start a raw observer after its consumer has already left.
						if (finished) return undefined;
						iterator ??= Reflect.apply(
							method,
							target,
							args,
						) as AsyncIterableIterator<unknown>;
						return iterator;
					};
					const wrapped: AsyncIterableIterator<unknown> = {
						[Symbol.asyncIterator]() {
							return this;
						},
						async next(value?: unknown) {
							const source = await getIterator();
							return source
								? source.next(value)
								: { done: true, value: undefined };
						},
						async return(value?: unknown) {
							finished = true;
							return iterator?.return
								? iterator.return(value)
								: { done: true, value };
						},
						async throw(error?: unknown) {
							const source = await getIterator();
							if (source?.throw) return source.throw(error);
							throw error;
						},
					};
					return wrapped;
				};
			}

			if (
				key === "execute" ||
				key === "executeBatch" ||
				key === "beginTransaction" ||
				key === "transaction"
			) {
				return (...args: unknown[]) => {
					const sql = typeof args[0] === "string" ? args[0] : undefined;
					const checkHead =
						key !== "execute" || (sql !== undefined && mayWriteSql(sql));
					const invalidate =
						key === "executeBatch" ||
						key === "transaction" ||
						(sql !== undefined && invalidatesScopeForSql(sql));
					return ensureReady(checkHead, !checkHead).then((branchId) => {
						const result = Reflect.apply(method, target, args) as unknown;
						return Promise.resolve(result).then((value) =>
							afterSuccessfulMutation(value, branchId, invalidate),
						);
					});
				};
			}

			if (
				key === "switchBranch" ||
				key === "createBranch" ||
				key === "createCheckpoint" ||
				key === "undo" ||
				key === "redo" ||
				key === "restore"
			) {
				return (...args: unknown[]) => {
					readyHeads.clear();
					const result = Reflect.apply(method, target, args) as unknown;
					return isPromiseLike(result)
						? Promise.resolve(result).finally(() => readyHeads.clear())
						: (readyHeads.clear(), result);
				};
			}

			return (...args: unknown[]): unknown =>
				Reflect.apply(method, target, args) as unknown;
		},
	}) as Lix;
}

async function readActiveBranchHead(
	lix: Lix,
	branchId: string,
): Promise<string | false> {
	if ((await lix.activeBranchId()) !== branchId) return false;
	const result = await lix.execute<{ commit_id: unknown }>(
		ACTIVE_BRANCH_HEAD_SQL,
	);
	if ((await lix.activeBranchId()) !== branchId) return false;
	const head = result.rows[0]?.commit_id;
	if (typeof head !== "string" || head.length === 0) {
		throw new Error("The active branch head is unavailable.");
	}
	return head;
}

function mayWriteSql(sql: string): boolean {
	const withoutLeadingComments = sql.replace(
		/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/g,
		"",
	);
	return (
		invalidatesScopeForSql(withoutLeadingComments) ||
		!/^(?:select|values)\b/i.test(withoutLeadingComments.trim())
	);
}

function invalidatesScopeForSql(sql: string): boolean {
	return INVALIDATING_SQL_FUNCTIONS.test(sql);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) ||
			typeof value === "function") &&
		"then" in value
	);
}

function isRetryableScopePreparationError(error: unknown): boolean {
	const details =
		typeof error === "object" && error !== null && "details" in error
			? error.details
			: undefined;
	if (
		typeof details === "object" &&
		details !== null &&
		(("nonRetryableAfterCommit" in details &&
			details.nonRetryableAfterCommit === true) ||
			("nonRetryableAfterExecution" in details &&
				details.nonRetryableAfterExecution === true))
	)
		return false;
	if (typeof error !== "object" || error === null || !("code" in error))
		return false;
	const code = error.code;
	return typeof code === "string" && TRANSIENT_SCOPE_ERROR_CODES.has(code);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
