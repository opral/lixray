import {
	openLix,
	type Lix,
	type LixOpenProgress,
	type RemoteLixFetch,
} from "@lix-js/sdk";
import { OpfsStorage } from "@lix-js/storage-opfs";
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
			fetch: createTelemetryFetch(options.fetch, {
				repositoryId: options.repositoryId,
				refreshAccessToken: options.refreshAccessToken,
			}),
		},
	});
}

type ResolvedOpenRepositoryLixSessionOptions =
	OpenRepositoryLixSessionOptions & { replicaId: string };

const OPEN_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];
const MIGRATION_ERROR_CODE = "LIX_ERROR_LIX_MIGRATING";
const MIGRATION_RETRY_DELAY_MS = 1_000;

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
	fromVersion: number;
	toVersion: number;
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
				const replicaId = await repositoryBrowserReplicaId(options);
				markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.replicaIdentified);
				try {
					return await retryRepositoryOpenDuringMigration({
						open: () =>
							openRepositoryLixSessionWithRetry({
								...options,
								replicaId,
								signal,
							}),
						onMigration: (state) => publishMigrationProgress(sessionKey, state),
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

export async function retryRepositoryOpenDuringMigration<T>({
	open,
	onMigration,
	wait = delay,
	signal,
}: {
	open: () => Promise<T>;
	onMigration?: (state: RepositoryMigrationState | null) => void;
	wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}): Promise<T> {
	let observedMigration = false;
	try {
		for (;;) {
			signal?.throwIfAborted();
			try {
				const session = await open();
				return session;
			} catch (error) {
				signal?.throwIfAborted();
				const migration = repositoryMigrationStateFromError(error);
				if (!migration) throw error;
				observedMigration = true;
				onMigration?.(migration);
				await wait(MIGRATION_RETRY_DELAY_MS, signal);
			}
		}
	} finally {
		if (observedMigration) onMigration?.(null);
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
		const defaultBranchId = await lix.activeBranchId();
		markRepositoryOpenPerformance(REPOSITORY_OPEN_MARKS.branchReady);
		const session = new RemoteRepositoryLixSession(lix, defaultBranchId);
		if (
			options.initialBranchId &&
			options.initialBranchId !== defaultBranchId
		) {
			try {
				await session.switchBranch(options.initialBranchId);
			} catch (error) {
				if (!isBranchNotFoundError(error)) throw error;
			}
		}
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
	return openLix({
		storage: new OpfsStorage({
			name: repositoryOpfsCacheName(options),
		}),
		server: {
			mode: "sync",
			url: repositoryUrl(options),
			headers: async () => repositoryRequestHeaders(options),
			fetch: createTelemetryFetch(options.fetch, {
				repositoryId: options.repositoryId,
				refreshAccessToken: options.refreshAccessToken,
				signal: options.signal,
				shouldCaptureRequestFailures: () => requestFailureReporting.enabled,
			}),
		},
		onProgress: (progress) =>
			publishLocalOpenProgress(repositorySessionKey(options), progress),
	});
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
	if (progress.fromFormat === undefined) return undefined;
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
	const fetcher = customFetch ?? globalThis.fetch?.bind(globalThis);
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
		code === "LIX_ERROR_LIX_RECOVERING" ||
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
): error is Error & { code: "LIX_ERROR_LIX_RECOVERING" } {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "LIX_ERROR_LIX_RECOVERING"
	);
}

export function repositoryMigrationStateFromError(
	error: unknown,
): RepositoryMigrationState | null {
	if (!(error instanceof Error) || !("code" in error)) return null;
	if (error.code !== MIGRATION_ERROR_CODE || !("details" in error)) {
		return null;
	}
	const details = error.details;
	if (!isRecord(details)) return null;
	const { fromVersion, toVersion } = details;
	if (
		typeof fromVersion !== "number" ||
		!Number.isInteger(fromVersion) ||
		typeof toVersion !== "number" ||
		!Number.isInteger(toVersion)
	) {
		return null;
	}
	return { fromVersion, toVersion };
}

export function isRetryableRepositoryOpenError(error: unknown): boolean {
	if (isLixRecoveringError(error)) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	return (
		error.message === "Failed to fetch" ||
		error.message === "browser sync fetch failed: Failed to fetch" ||
		error.message === "browser sync fetch failed: The operation was aborted"
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

export class RemoteRepositoryLixSession implements RepositoryLixSession {
	readonly lix: Lix;
	readonly #listeners = new Set<() => void>();
	readonly #defaultBranchId: string;
	#activeBranchId: string;
	#closed = false;

	constructor(lix: Lix, defaultBranchId: string) {
		this.lix = lix;
		this.#defaultBranchId = defaultBranchId;
		this.#activeBranchId = defaultBranchId;
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
		const branch = await this.lix.createBranch({ name });
		await this.switchBranch(branch.id);
		return branch.id;
	}

	async switchBranch(branchId: string): Promise<string> {
		this.#assertOpen();
		if (branchId === this.#activeBranchId) return branchId;
		const switched = await this.lix.switchBranch({ branchId });
		this.#activeBranchId = switched.branchId;
		for (const listener of [...this.#listeners]) listener();
		return switched.branchId;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#listeners.clear();
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
