import {
	IndexedDbStorage,
	openLix,
	type Lix,
	type RemoteLixFetch,
} from "@lix-js/sdk";
import { captureTelemetry } from "./telemetry.ts";
import { acquireManagedRepositoryResource } from "./repository-session-manager.ts";

type TokenProvider = () => Promise<string | null>;

interface OpenRepositoryLixSessionOptions {
	namespace: string;
	repositorySlug: string;
	repositoryId?: string;
	getAccessToken: TokenProvider;
	/**
	 * Opens the session without an Authorization header when no access token
	 * is available. The worker only serves such requests through its public,
	 * read-only repository transport.
	 */
	allowAnonymous?: boolean;
	initialBranchId?: string | null;
	/** Prefixes this browser client's repository-scoped Lix client-state database. */
	clientStoragePrefix?: string;
	clientStorage?: IndexedDbStorage;
	origin?: string | URL;
	fetch?: RemoteLixFetch;
}

const RECOVERING_OPEN_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];

export interface RepositoryLixSession {
	readonly lix: Lix;
	activeBranchSnapshot(): string;
	defaultBranchSnapshot(): string;
	subscribeActiveBranch(listener: () => void): () => void;
	createBranch(name: string): Promise<string>;
	switchBranch(branchId: string): Promise<string>;
	close(): Promise<void>;
}

export async function openRepositoryLixSession(
	options: OpenRepositoryLixSessionOptions,
): Promise<RepositoryLixSession> {
	if (options.clientStorage) {
		return openRepositoryLixSessionWithRetry(options);
	}

	const lease = await acquireManagedRepositoryResource(
		repositorySessionKey(options),
		() => openRepositoryLixSessionWithRetry(options),
	);
	return new RepositoryLixSessionLease(lease.resource, lease.release);
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
	const clientStorage =
		options.clientStorage ??
		(typeof globalThis.indexedDB === "undefined"
			? undefined
			: new IndexedDbStorage({
					name: repositoryClientStorageName(options),
				}));
	const lix = await openLix({
		server: {
			mode: "remote",
			url: repositoryUrl(options),
			headers: async (): Promise<Record<string, string>> => {
				const token = await options.getAccessToken();
				if (token) return { Authorization: `Bearer ${token}` };
				if (options.allowAnonymous) return {};
				throw new Error("A repository access token is required.");
			},
			fetch: createTelemetryFetch(options.fetch, {
				repositoryId: options.repositoryId,
			}),
		},
		...(clientStorage ? { storage: clientStorage } : {}),
	});

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

function createTelemetryFetch(
	customFetch: RemoteLixFetch | undefined,
	context: { repositoryId?: string },
): RemoteLixFetch {
	const fetcher = customFetch ?? globalThis.fetch?.bind(globalThis);
	if (!fetcher) {
		throw new TypeError("A fetch implementation is required for a repository.");
	}

	return async (input, init) => {
		const response = await fetcher(input, init);
		if (!response.ok) {
			void reportLixRequestFailure(response, input, init, context);
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

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const unsubscribe of this.#subscriptions) unsubscribe();
		this.#subscriptions.clear();
		this.#release();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("The repository Lix session is closed.");
	}
}

function repositoryClientStorageName(
	options: OpenRepositoryLixSessionOptions,
): string {
	const prefix = options.clientStoragePrefix ?? "lixray.client.v2";
	const repository =
		options.repositoryId ?? `${options.namespace}:${options.repositorySlug}`;
	return `${prefix}:${repository}`;
}

function repositorySessionKey(
	options: OpenRepositoryLixSessionOptions,
): string {
	return `${repositoryUrl(options).href}\n${repositoryClientStorageName(options)}`;
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
