import {
	openLix,
	networkFetch,
	type Lix,
	type LixOpenProgress,
	type RemoteLixFetch,
	type PartialReplicaLixServerOptions,
} from "@lix-js/sdk";
import { OpfsStorage } from "@lix-js/storage-opfs";
import { currentReplicaStorage } from "./repository-migration.ts";
import { captureExceptionTelemetry } from "./telemetry.ts";
import { acquireManagedRepositoryResource } from "./repository-session-manager.ts";
import { waitForLixPrewarm } from "./lix-prewarm.ts";
import {
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "./repository-opfs-cache.ts";
import {
	markRepositoryOpenPerformance,
	REPOSITORY_OPEN_MARKS,
} from "./repository-open-performance.ts";

const GLOBAL_BRANCH_ID = "ffffffff-ffff-7fff-bfff-ffffffffffff";

type TokenProvider = () => Promise<string | null>;

export interface OpenRepositoryLixSessionOptions {
	namespace: string;
	repositorySlug: string;
	repositoryId: string;
	getAccessToken: TokenProvider;
	/** Refreshes the auth session before retrying an expired-token request. */
	refreshAccessToken?: TokenProvider;
	/**
	 * Opens the session without an Authorization header when no access token
	 * is available. The worker only serves such requests through its public,
	 * read-only repository transport.
	 */
	allowAnonymous?: boolean;
	/** Limits an anonymous session to one control-plane-published path. */
	publicPath?: string;
	initialBranchId?: string | null;
	origin?: string | URL;
	fetch?: RemoteLixFetch;
	/**
	 * Isolates protocol clients by host principal. The protocol binds each
	 * session id to Anonymous or Authenticated at handshake. Reusing one id
	 * after the worker starts injecting the other principal is 403
	 * ACCOUNT_MISMATCH, not 410 SESSION_GONE. This is not a session store:
	 * the server HashMap stays ephemeral.
	 */
	authIdentity: string;
	onMigration?: (state: RepositoryMigrationState | null) => void;
	signal?: AbortSignal;
}

/**
 * Opens an isolated server-backed handle for diagnostics. Unlike the primary
 * repository session this has no local storage and does not participate in
 * replica sync; callers own and must close the returned handle.
 */
export function openRepositoryRemoteLix(
	options: OpenRepositoryLixSessionOptions,
): Promise<Lix> {
	return openLix({
		server: {
			mode: "remote",
			url: repositoryUrl(options),
			headers: async () => repositoryRequestHeaders(options),
			fetch: createTelemetryFetch(options.fetch ?? networkFetch, {
				repositoryId: options.repositoryId,
				refreshAccessToken: options.refreshAccessToken,
			}),
		},
	});
}

type ResolvedOpenRepositoryLixSessionOptions =
	OpenRepositoryLixSessionOptions & { replicaId: string };

const OPEN_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];
const MIGRATION_ERROR_CODE = "LIX_ERROR_MIGRATING";

interface MigrationProgress {
	state: RepositoryMigrationState | null;
	listeners: Set<(state: RepositoryMigrationState | null) => void>;
}

const migrationProgressBySession = new Map<string, MigrationProgress>();

export interface RepositoryLixSession {
	readonly lix: Lix;
	activeBranchSnapshot(): string;
	defaultBranchSnapshot(): string;
	subscribeActiveBranch(listener: () => void): () => void;
	createBranch(name: string): Promise<string>;
	switchBranch(branchId: string): Promise<string>;
	close(): Promise<void>;
}

export interface RepositoryMigrationState {
	fromVersion?: number;
	toVersion?: number;
	phase?: "migrating" | "validating" | "opening";
}

export async function openRepositoryLixSession(
	options: OpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	const sessionKey = repositorySessionKey(options);
	const unsubscribe = options.onMigration
		? subscribeToMigrationProgress(sessionKey, options.onMigration)
		: undefined;
	try {
		const lease = await acquireManagedRepositoryResource(
			sessionKey,
			async (signal) => {
				const replicaId = options.publicPath
					? "remote-public-path"
					: await repositoryBrowserReplicaId(options);
				markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.replicaIdentified);
				try {
					return await openRepositoryLixSessionWithRetry({
						...options,
						replicaId,
						signal,
					});
				} finally {
					publishMigrationProgress(sessionKey, null);
				}
			},
			{ signal: options.signal },
		);
		return new RepositoryLixSessionLease(lease.resource, () => lease.release());
	} finally {
		unsubscribe?.();
	}
}

function subscribeToMigrationProgress(
	key: string,
	listener: (state: RepositoryMigrationState | null) => void,
): () => void {
	let progress = migrationProgressBySession.get(key);
	if (!progress) {
		progress = { state: null, listeners: new Set() };
		migrationProgressBySession.set(key, progress);
	}
	progress.listeners.add(listener);
	if (progress.state) listener(progress.state);
	return () => {
		progress?.listeners.delete(listener);
		if (progress?.listeners.size === 0 && !progress.state) {
			migrationProgressBySession.delete(key);
		}
	};
}

function publishMigrationProgress(
	key: string,
	state: RepositoryMigrationState | null,
): void {
	const progress = migrationProgressBySession.get(key);
	if (!progress) return;
	progress.state = state;
	for (const listener of progress.listeners) listener(state);
	if (progress.listeners.size === 0 && !state) {
		migrationProgressBySession.delete(key);
	}
}

async function openRepositoryLixSessionWithRetry(
	options: ResolvedOpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	for (let attempt = 0; ; attempt += 1) {
		options.signal?.throwIfAborted();
		try {
			const session = await openRepositoryLixSessionOnce(options);
			if (options.signal?.aborted) {
				await session.close();
				options.signal.throwIfAborted();
			}
			return session;
		} catch (error) {
			options.signal?.throwIfAborted();
			const retryDelay = OPEN_RETRY_DELAYS_MS[attempt];
			if (!isRetryableRepositoryOpenError(error) || retryDelay === undefined) {
				throw error;
			}
			await delay(retryDelay, options.signal);
		}
	}
}

async function openRepositoryLixSessionOnce(
	options: ResolvedOpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	const requestFailureReporting = { enabled: false };
	const lix = await openOpfsSyncSession(options, requestFailureReporting);
	markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.lixOpened);

	try {
		const activeBranchId = await lix.activeBranchId();
		// Read the canonical tracked, fileless GLOBAL setting independently
		// of the resumed branch. Native uniqueness prevents an untracked row
		// from shadowing a tracked identity; the explicit retention predicate
		// also refuses any noncanonical untracked setting.
		let defaultBranchId: unknown = activeBranchId;
		if (!options.publicPath) {
			const defaultSession = await lix.openAnotherSession({
				branchId: GLOBAL_BRANCH_ID,
			});
			try {
				const defaults = await defaultSession.execute(
					"SELECT value FROM lix_key_value WHERE key = $1 AND lixcol_file_id IS NULL AND lixcol_untracked = false",
					["lix_default_branch_id"],
				);
				defaultBranchId =
					defaults.rows.length === 1 ? defaults.rows[0].value : undefined;
			} finally {
				await defaultSession.close();
			}
		}
		if (typeof defaultBranchId !== "string" || !defaultBranchId) {
			throw new Error("The repository has no valid default branch.");
		}
		const session = new ManagedRepositoryLixSession(
			lix,
			defaultBranchId,
			activeBranchId,
		);
		const requestedBranchId = options.initialBranchId ?? defaultBranchId;
		if (requestedBranchId !== activeBranchId) {
			try {
				await session.switchBranch(requestedBranchId);
			} catch (error) {
				// Offline or slow pending uploads must not hide the cached branch.
				// An explicit later switch still reports its failure to the caller.
				if (isErrorCode(error, "LIX_PARTIAL_BRANCH_SWITCH_PENDING")) {
					markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.branchReady);
					requestFailureReporting.enabled = true;
					return session;
				}
				if (!isBranchNotFoundError(error)) throw error;
				if (session.activeBranchSnapshot() !== defaultBranchId) {
					try {
						await session.switchBranch(defaultBranchId);
					} catch (fallbackError) {
						if (
							!isErrorCode(fallbackError, "LIX_PARTIAL_BRANCH_SWITCH_PENDING")
						)
							throw fallbackError;
					}
				}
			}
		}
		markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.branchReady);
		requestFailureReporting.enabled = true;
		return session;
	} catch (error) {
		await lix.close().catch(() => undefined);
		throw error;
	}
}

async function openOpfsSyncSession(
	options: ResolvedOpenRepositoryLixSessionOptions,
	requestFailureReporting: { enabled: boolean },
): Promise<Lix> {
	await waitForLixPrewarm();
	options.signal?.throwIfAborted();
	const fetcher = createTelemetryFetch(options.fetch ?? networkFetch, {
		repositoryId: options.repositoryId,
		refreshAccessToken: options.refreshAccessToken,
		signal: options.signal,
		shouldCaptureRequestFailures: () => requestFailureReporting.enabled,
	});
	const commonServer = {
		url: repositoryUrl(options),
		headers: async () => repositoryRequestHeaders(options),
		fetch: fetcher,
	};
	const onProgress = (progress: LixOpenProgress) =>
		publishLocalOpenProgress(repositorySessionKey(options), progress);
	// Native chunks may contain data outside a published path. Keep path-scoped
	// public access on the worker's SQL-authorized remote transport.
	if (options.publicPath)
		return openLix({ server: { ...commonServer, mode: "remote" }, onProgress });
	const storageName = await currentReplicaStorage(
		repositoryOpfsCacheName(options),
		{
			url: String(commonServer.url),
			headers: Object.entries(await repositoryRequestHeaders(options)),
		},
	);
	const storage = new OpfsStorage({ name: storageName });
	const server: PartialReplicaLixServerOptions = {
		...commonServer,
		mode: "partial_replica",
	};
	return openLix({ storage, server, onProgress });
}

async function repositoryRequestHeaders(
	options: OpenRepositoryLixSessionOptions,
): Promise<Record<string, string>> {
	const currentToken = await options.getAccessToken();
	const publicPathHeaders: Record<string, string> = {};
	if (options.publicPath) {
		publicPathHeaders["X-Lixray-Public-Path"] = options.publicPath;
	}
	if (currentToken) {
		return {
			Authorization: `Bearer ${currentToken}`,
			...publicPathHeaders,
		};
	}
	if (options.allowAnonymous) return publicPathHeaders;
	throw new Error("A repository access token is required.");
}

function publishLocalOpenProgress(
	key: string,
	progress: LixOpenProgress,
): void {
	const update = repositoryMigrationStateFromOpenProgress(progress);
	if (update !== undefined) publishMigrationProgress(key, update);
}

export function repositoryMigrationStateFromOpenProgress(
	progress: LixOpenProgress,
): RepositoryMigrationState | null | undefined {
	if (progress.phase === "complete") return null;
	if (
		progress.fromFormat === undefined &&
		progress.phase !== "migrating" &&
		progress.scope !== "authority"
	)
		return undefined;
	if (
		progress.phase !== "migrating" &&
		progress.phase !== "validating" &&
		progress.phase !== "opening"
	) {
		return undefined;
	}
	return {
		fromVersion: progress.fromFormat,
		toVersion: progress.toFormat,
		phase: progress.phase,
	};
}

export function createTelemetryFetch(
	customFetch: RemoteLixFetch | undefined,
	context: {
		repositoryId: string;
		refreshAccessToken?: TokenProvider;
		signal?: AbortSignal;
		shouldCaptureRequestFailures?: () => boolean;
	},
	dependencies: {
		captureException?: typeof captureExceptionTelemetry;
	} = {},
): RemoteLixFetch {
	const fetcher = customFetch ?? networkFetch;
	if (!fetcher) {
		throw new TypeError("A fetch implementation is required for a repository.");
	}
	const captureException =
		dependencies.captureException ?? captureExceptionTelemetry;
	const reportedFailures = new Map<string, string>();

	return async (input, init) => {
		const requestSignal = input instanceof Request ? input.signal : undefined;
		const signals = [context.signal, init?.signal, requestSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const requestInit =
			signals.length > 0 ? { ...init, signal: AbortSignal.any(signals) } : init;
		let response: Response;
		try {
			response = await fetcher(input, requestInit);
		} catch (error) {
			if (
				context.shouldCaptureRequestFailures?.() !== false &&
				!requestInit?.signal?.aborted &&
				!(error instanceof Error && error.name === "AbortError")
			) {
				reportLixTransportFailure(
					error,
					input,
					requestInit,
					context,
					reportedFailures,
					captureException,
				);
			}
			throw error;
		}
		if (
			response.status === 401 &&
			context.refreshAccessToken &&
			requestInit?.method !== "DELETE"
		) {
			try {
				const token = await context.refreshAccessToken();
				if (token) {
					const headers = new Headers(requestInit?.headers);
					headers.set("Authorization", `Bearer ${token}`);
					response = await fetcher(input, { ...requestInit, headers });
				}
			} catch {
				// Preserve the original auth response when the refresh itself fails.
			}
		}
		if (response.ok) {
			reportedFailures.delete(lixRequestKey(input, requestInit));
		} else if (context.shouldCaptureRequestFailures?.() !== false) {
			await reportLixRequestFailure(
				response,
				input,
				requestInit,
				context,
				reportedFailures,
				captureException,
			);
		}
		return response;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function reportLixRequestFailure(
	response: Response,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	context: { repositoryId: string },
	reportedFailures: Map<string, string>,
	captureException: typeof captureExceptionTelemetry,
): Promise<void> {
	let code: string | undefined;
	try {
		const body: unknown = await response.clone().json();
		const error = isRecord(body) ? body.error : undefined;
		if (isRecord(error) && typeof error.code === "string") {
			code = error.code;
		}
	} catch {
		// The SDK will report malformed/non-JSON responses separately.
	}
	const method = lixRequestMethod(input, init);
	if (
		code === MIGRATION_ERROR_CODE ||
		code === "LIX_REPOSITORY_MIGRATING" ||
		code === "LIX_ERROR_RECOVERING" ||
		(response.status === 404 &&
			method === "GET" &&
			lixRequestPath(input).endsWith("/sync/chunk"))
	) {
		return;
	}

	const endpoint = lixRequestEndpoint(input);
	const key = lixRequestKey(input, init);
	const fingerprint = `${response.status}:${code ?? "unknown"}`;
	if (reportedFailures.get(key) === fingerprint) return;
	reportedFailures.set(key, fingerprint);

	const error = Object.assign(
		new Error(
			`${method} ${endpoint} failed with HTTP ${response.status}${
				code ? ` (${code})` : ""
			}`,
		),
		{
			name: "LixRequestError",
			status: response.status,
			...(code ? { code } : {}),
		},
	);
	captureException(error, {
		operation: "repository_request",
		lix_request_endpoint: endpoint,
		lix_request_method: method,
		lix_http_status: response.status,
		...(code ? { lix_error_code: code } : {}),
		lix_id: context.repositoryId,
	});
}

function reportLixTransportFailure(
	error: unknown,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	context: { repositoryId: string },
	reportedFailures: Map<string, string>,
	captureException: typeof captureExceptionTelemetry,
): void {
	const exception =
		error instanceof Error ? error : new Error("Lix repository request failed");
	const code =
		"code" in exception && typeof exception.code === "string"
			? exception.code
			: undefined;
	const key = lixRequestKey(input, init);
	const fingerprint = `transport:${exception.name}:${code ?? "unknown"}`;
	if (reportedFailures.get(key) === fingerprint) return;
	reportedFailures.set(key, fingerprint);
	captureException(exception, {
		operation: "repository_request",
		lix_request_endpoint: lixRequestEndpoint(input),
		lix_request_method: lixRequestMethod(input, init),
		...(code ? { lix_error_code: code } : {}),
		lix_id: context.repositoryId,
	});
}

function lixRequestKey(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): string {
	const path = lixRequestPath(input).match(
		/^\/lix\/v1\/[0-9a-f-]+\/?(.*)$/,
	)?.[1];
	return `${lixRequestMethod(input, init)}:${path ?? lixRequestEndpoint(input)}`;
}

function lixRequestMethod(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): string {
	return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function lixRequestPath(input: RequestInfo | URL): string {
	const raw =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	try {
		return new URL(raw, globalThis.location?.origin).pathname;
	} catch {
		return "";
	}
}

function lixRequestEndpoint(input: RequestInfo | URL): string {
	try {
		const path = lixRequestPath(input);
		const endpoint = path
			.match(/^\/lix\/v1\/[0-9a-f-]+\/?(.*)$/)?.[1]
			?.split("/", 1)[0];
		return endpoint || "unknown";
	} catch {
		return "unknown";
	}
}

function isLixRecoveringError(
	error: unknown,
): error is Error & { code: "LIX_ERROR_RECOVERING" } {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "LIX_ERROR_RECOVERING"
	);
}

export function isRetryableRepositoryOpenError(error: unknown): boolean {
	// A completed mutation/execution must never be replayed, even if its
	// completion error otherwise looks transient.
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
	// Storage coherence belongs to the engine; configuration/authentication and
	// cancelled operations are not network retries. The SDK owns migration waits.
	return (
		isLixRecoveringError(error) || isErrorCode(error, "LIX_TRANSPORT_NETWORK")
	);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (!signal)
		return new Promise((resolve) => setTimeout(resolve, milliseconds));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		const abort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted.", "AbortError");
}

export class ManagedRepositoryLixSession implements RepositoryLixSession {
	readonly lix: Lix;
	readonly #listeners = new Set<() => void>();
	readonly #pendingCreations = new Map<string, Promise<string>>();
	readonly #defaultBranchId: string;
	#activeBranchId: string;
	#closed = false;

	constructor(
		lix: Lix,
		defaultBranchId: string,
		activeBranchId = defaultBranchId,
	) {
		this.lix = lix;
		this.#defaultBranchId = defaultBranchId;
		this.#activeBranchId = activeBranchId;
	}

	activeBranchSnapshot(): string {
		this.#assertOpen();
		return this.#activeBranchId;
	}

	defaultBranchSnapshot(): string {
		this.#assertOpen();
		return this.#defaultBranchId;
	}

	subscribeActiveBranch(listener: () => void): () => void {
		this.#assertOpen();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async createBranch(name: string): Promise<string> {
		this.#assertOpen();
		// A retry belongs to the same source branch and exact requested name.
		// Share an in-flight creation too, before its durable ID is available.
		const key = JSON.stringify([this.#activeBranchId, name]);
		let creation = this.#pendingCreations.get(key);
		if (!creation) {
			creation = this.lix.createBranch({ name }).then((branch) => branch.id);
			this.#pendingCreations.set(key, creation);
		}
		let branchId: string;
		try {
			branchId = await creation;
		} catch (error) {
			if (this.#pendingCreations.get(key) === creation)
				this.#pendingCreations.delete(key);
			throw error;
		}
		await this.switchBranch(branchId);
		if (this.#pendingCreations.get(key) === creation)
			this.#pendingCreations.delete(key);
		return branchId;
	}

	async switchBranch(branchId: string): Promise<string> {
		this.#assertOpen();
		if (branchId === this.#activeBranchId) return branchId;
		for (let attempt = 0; ; attempt += 1) {
			this.#assertOpen();
			try {
				const switched = await this.lix.switchBranch({ branchId });
				this.#activeBranchId = switched.branchId;
				for (const listener of [...this.#listeners]) listener();
				return switched.branchId;
			} catch (error) {
				const retryDelay = OPEN_RETRY_DELAYS_MS[attempt];
				if (
					!isErrorCode(error, "LIX_PARTIAL_BRANCH_SWITCH_PENDING") ||
					retryDelay === undefined
				)
					throw error;
				// Keep this handle and its sync worker alive while pending edits
				// upload. Creating a branch is never repeated by this retry.
				await delay(retryDelay);
			}
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#listeners.clear();
		this.#pendingCreations.clear();
		await this.lix.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("The repository Lix session is closed.");
	}
}

class RepositoryLixSessionLease implements RepositoryLixSession {
	readonly lix: Lix;
	readonly #session: RepositoryLixSession;
	readonly #subscriptions = new Set<() => void>();
	readonly #release: () => void;
	#closed = false;

	constructor(session: RepositoryLixSession, release: () => void) {
		this.lix = session.lix;
		this.#session = session;
		this.#release = release;
	}

	activeBranchSnapshot(): string {
		this.#assertOpen();
		return this.#session.activeBranchSnapshot();
	}

	defaultBranchSnapshot(): string {
		this.#assertOpen();
		return this.#session.defaultBranchSnapshot();
	}

	subscribeActiveBranch(listener: () => void): () => void {
		this.#assertOpen();
		const unsubscribe = this.#session.subscribeActiveBranch(listener);
		this.#subscriptions.add(unsubscribe);
		return () => {
			this.#subscriptions.delete(unsubscribe);
			unsubscribe();
		};
	}

	createBranch(name: string): Promise<string> {
		this.#assertOpen();
		return this.#session.createBranch(name);
	}

	switchBranch(branchId: string): Promise<string> {
		this.#assertOpen();
		return this.#session.switchBranch(branchId);
	}

	close(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#closed = true;
		for (const unsubscribe of this.#subscriptions) unsubscribe();
		this.#subscriptions.clear();
		this.#release();
		return Promise.resolve();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("The repository Lix session is closed.");
	}
}

export function repositorySessionKey(
	options: OpenRepositoryLixSessionOptions,
): string {
	const href = repositoryUrl(options).href;
	return JSON.stringify({
		href,
		repositoryId: options.repositoryId,
		identity: options.authIdentity,
		publicPath: options.publicPath ?? null,
	});
}

function repositoryUrl(options: OpenRepositoryLixSessionOptions): URL {
	const origin = options.origin ?? globalThis.location?.origin;
	if (!origin) throw new Error("A repository server origin is required.");
	return new URL(`/lix/${encodeURIComponent(options.repositoryId)}`, origin);
}

function isBranchNotFoundError(
	error: unknown,
): error is Error & { code: "LIX_BRANCH_NOT_FOUND" } {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "LIX_BRANCH_NOT_FOUND"
	);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
