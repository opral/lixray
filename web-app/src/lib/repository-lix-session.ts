import { openLix, type Lix, type RemoteLixFetch } from "@lix-js/sdk";
import { OpfsStorage } from "@lix-js/storage-opfs";
import { captureTelemetry } from "./telemetry.ts";
import { acquireManagedRepositoryResource } from "./repository-session-manager.ts";
import {
	claimRepositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "./repository-opfs-cache.ts";

type TokenProvider = () => Promise<string | null>;

interface OpenRepositoryLixSessionOptions {
	namespace: string;
	repositorySlug: string;
	repositoryId?: string;
	/** Separates durable browser replicas for different signed-in identities. */
	replicaId: string;
	getAccessToken: TokenProvider;
	/** Refreshes the auth session before retrying an expired-token request. */
	refreshAccessToken?: TokenProvider;
	/**
	 * Opens the session without an Authorization header when no access token
	 * is available. The worker only serves such requests through its public,
	 * read-only repository transport.
	 */
	allowAnonymous?: boolean;
	initialBranchId?: string | null;
	origin?: string | URL;
	fetch?: RemoteLixFetch;
}

const RECOVERING_OPEN_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];

export interface RepositoryLixSession {
	readonly lix: Lix;
	/** Resolves only when the session's observer channel stops unexpectedly. */
	waitForSyncFailure(): Promise<unknown | null>;
	activeBranchSnapshot(): string;
	defaultBranchSnapshot(): string;
	subscribeActiveBranch(listener: () => void): () => void;
	createBranch(name: string): Promise<string>;
	switchBranch(branchId: string): Promise<string>;
	/** Immediately cancels browser sync when a non-BFCache page unloads. */
	terminateForPageUnload?(): void;
	close(): Promise<void>;
}

export async function openRepositoryLixSession(
	options: OpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	const resolvedOptions = options.authIdentity
		? {
				...options,
				replicaId: await claimRepositoryBrowserReplicaId(options.authIdentity),
			}
		: options;
	const lease = await acquireManagedRepositoryResource(
		repositorySessionKey(resolvedOptions),
		() => openRepositoryLixSessionWithRetry(resolvedOptions),
	);
	return new RepositoryLixSessionLease(lease.resource, () => lease.release());
}

async function openRepositoryLixSessionWithRetry(
	options: OpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await openRepositoryLixSessionOnce(options);
		} catch (error) {
			const retryDelay = RECOVERING_OPEN_RETRY_DELAYS_MS[attempt];
			if (!isLixRecoveringError(error) || retryDelay === undefined) {
				throw error;
			}
			await delay(retryDelay);
		}
	}
}

async function openRepositoryLixSessionOnce(
	options: OpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	const lix = await openOpfsSyncSession(options);

	try {
		const defaultBranchId = await lix.activeBranchId();
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
		return session;
	} catch (error) {
		await lix.close().catch(() => undefined);
		throw error;
	}
}

async function openOpfsSyncSession(
	options: OpenRepositoryLixSessionOptions,
): Promise<Lix> {
	return openLix({
		storage: new OpfsStorage({
			name: repositoryOpfsCacheName(options),
		}),
		server: {
			mode: "sync",
			url: repositoryUrl(options),
			headers: async (): Promise<Record<string, string>> => {
				const currentToken = await options.getAccessToken();
				if (currentToken) return { Authorization: `Bearer ${currentToken}` };
				if (options.allowAnonymous) return {};
				throw new Error("A repository access token is required.");
			},
			fetch: createTelemetryFetch(options.fetch, {
				repositoryId: options.repositoryId,
				refreshAccessToken: options.refreshAccessToken,
			}),
		},
	});
}

export function createTelemetryFetch(
	customFetch: RemoteLixFetch | undefined,
	context: {
		repositoryId?: string;
		refreshAccessToken?: TokenProvider;
	},
): RemoteLixFetch {
	const fetcher = customFetch ?? globalThis.fetch?.bind(globalThis);
	if (!fetcher) {
		throw new TypeError("A fetch implementation is required for a repository.");
	}

	return async (input, init) => {
		let response = await fetcher(input, init);
		if (
			response.status === 401 &&
			context.refreshAccessToken &&
			init?.method !== "DELETE"
		) {
			try {
				const token = await context.refreshAccessToken();
				if (token) {
					const headers = new Headers(init?.headers);
					headers.set("Authorization", `Bearer ${token}`);
					response = await fetcher(input, { ...init, headers });
				}
			} catch {
				// Preserve the original auth response when the refresh itself fails.
			}
		}
		recordLixrayServerTiming(response, input);
		if (!response.ok) {
			void reportLixRequestFailure(response, input, init, context);
		}
		return response;
	};
}

const LIXRAY_SERVER_TIMING_NAMES = [
	"lixray-web-auth",
	"lixray-web-resolve",
	"lixray-server-roundtrip",
	"lix-server-protocol",
] as const;

type LixrayServerTimingName = (typeof LIXRAY_SERVER_TIMING_NAMES)[number];

export type LixrayServerTimings = Partial<
	Record<LixrayServerTimingName, number>
>;

export function parseLixrayServerTiming(raw: string): LixrayServerTimings {
	const durations: LixrayServerTimings = {};
	for (const entry of raw.split(",")) {
		const [rawName, ...parameters] = entry.split(";");
		const name = rawName?.trim();
		if (!isLixrayServerTimingName(name)) continue;
		const duration = parameters
			.map((parameter) => parameter.trim())
			.find((parameter) => parameter.startsWith("dur="))
			?.slice("dur=".length);
		const parsed = duration === undefined ? Number.NaN : Number(duration);
		if (!Number.isFinite(parsed) || parsed < 0) continue;
		durations[name] = (durations[name] ?? 0) + parsed;
	}
	return durations;
}

function isLixrayServerTimingName(
	name: string | undefined,
): name is LixrayServerTimingName {
	return LIXRAY_SERVER_TIMING_NAMES.some((candidate) => candidate === name);
}

function recordLixrayServerTiming(
	response: Response,
	input: RequestInfo | URL,
): void {
	const endpoint = lixRequestEndpoint(input);
	if (endpoint === "unknown") return;
	const raw = response.headers.get("server-timing");
	if (!raw || typeof window === "undefined") return;
	const durationsMs = parseLixrayServerTiming(raw);
	if (Object.keys(durationsMs).length === 0) return;
	window.dispatchEvent(
		new CustomEvent("lixray-server-timing", {
			detail: { endpoint, durationsMs },
		}),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function reportLixRequestFailure(
	response: Response,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	context: { repositoryId?: string },
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

	captureTelemetry("lix_request_failed", {
		lix_request_endpoint: lixRequestEndpoint(input),
		lix_request_method: init?.method ?? "GET",
		lix_http_status: response.status,
		...(code ? { lix_error_code: code } : {}),
		...(context.repositoryId ? { lix_id: context.repositoryId } : {}),
	});
}

function lixRequestEndpoint(input: RequestInfo | URL): string {
	const raw =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	try {
		const path = new URL(raw, globalThis.location?.origin).pathname;
		const marker = "/lix/v1/";
		const endpoint = path.split(marker, 2)[1]?.split("/", 1)[0];
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

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RemoteRepositoryLixSession implements RepositoryLixSession {
	readonly lix: Lix;
	readonly #listeners = new Set<() => void>();
	readonly #syncObserver: ReturnType<Lix["observe"]>;
	readonly #syncFailure: Promise<unknown | null>;
	readonly #defaultBranchId: string;
	#activeBranchId: string;
	#closed = false;

	constructor(lix: Lix, defaultBranchId: string) {
		this.lix = lix;
		this.#defaultBranchId = defaultBranchId;
		this.#activeBranchId = defaultBranchId;
		this.#syncObserver = lix.observe("SELECT 1", []);
		this.#syncFailure = this.#monitorSync();
	}

	waitForSyncFailure(): Promise<unknown | null> {
		return this.#syncFailure;
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
		this.#syncObserver.close();
		await this.lix.close();
	}

	terminateForPageUnload(): void {
		this.#closed = true;
		this.#listeners.clear();
		this.#syncObserver.close();
		this.lix.terminateForPageUnload();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("The repository Lix session is closed.");
	}

	async #monitorSync(): Promise<unknown | null> {
		try {
			while ((await this.#syncObserver.next()) !== undefined) {
				// The result is irrelevant: the observer is the session health signal.
			}
			return this.#closed
				? null
				: new Error("The repository sync observer stopped unexpectedly.");
		} catch (error) {
			return this.#closed ? null : error;
		}
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

	waitForSyncFailure(): Promise<unknown | null> {
		return this.#session.waitForSyncFailure();
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
	return `${repositoryUrl(options).href}\n${options.replicaId}`;
}

function repositoryUrl(options: OpenRepositoryLixSessionOptions): URL {
	const origin = options.origin ?? globalThis.location?.origin;
	if (!origin) throw new Error("A repository server origin is required.");
	return new URL(
		`/@${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.repositorySlug)}`,
		origin,
	);
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
