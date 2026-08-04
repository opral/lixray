import {
	openLix,
	type Lix,
	type LixSnapshotStorage,
	type RemoteLixFetch,
} from "@lix-js/sdk";
import { LocalStorage } from "@lix-js/sdk/local-storage-adapter";

type TokenProvider = () => Promise<string | null>;

interface OpenWorkspaceLixSessionOptions {
	namespace: string;
	workspaceSlug: string;
	getAccessToken: TokenProvider;
	/**
	 * Opens the session without an Authorization header when no access token
	 * is available. The worker only serves such requests through its public,
	 * read-only workspace transport.
	 */
	allowAnonymous?: boolean;
	initialBranchId?: string | null;
	/** Prefixes this browser client's private Lix snapshot (for account isolation). */
	clientStoragePrefix?: string;
	clientStorage?: LixSnapshotStorage;
	origin?: string | URL;
	fetch?: RemoteLixFetch;
}

const RECOVERING_OPEN_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];

export interface WorkspaceLixSession {
	readonly lix: Lix;
	activeBranchSnapshot(): string;
	defaultBranchSnapshot(): string;
	subscribeActiveBranch(listener: () => void): () => void;
	createBranch(name: string): Promise<string>;
	switchBranch(branchId: string): Promise<string>;
	close(): Promise<void>;
}

export async function openWorkspaceLixSession(
	options: OpenWorkspaceLixSessionOptions,
): Promise<WorkspaceLixSession> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await openWorkspaceLixSessionOnce(options);
		} catch (error) {
			const retryDelay = RECOVERING_OPEN_RETRY_DELAYS_MS[attempt];
			if (!isLixRecoveringError(error) || retryDelay === undefined) {
				throw error;
			}
			await delay(retryDelay);
		}
	}
}

async function openWorkspaceLixSessionOnce(
	options: OpenWorkspaceLixSessionOptions,
): Promise<WorkspaceLixSession> {
	const clientStorage =
		options.clientStorage ??
		(typeof globalThis.localStorage === "undefined"
			? undefined
			: new LocalStorage({
					...(options.clientStoragePrefix
						? { prefix: options.clientStoragePrefix }
						: {}),
				}));
	const lix = await openLix({
		server: {
			mode: "remote",
			url: workspaceUrl(options),
			headers: async (): Promise<Record<string, string>> => {
				const token = await options.getAccessToken();
				if (token) return { Authorization: `Bearer ${token}` };
				if (options.allowAnonymous) return {};
				throw new Error("A repository access token is required.");
			},
			...(options.fetch ? { fetch: options.fetch } : {}),
		},
		...(clientStorage ? { storage: clientStorage } : {}),
	});

	try {
		const defaultBranchId = await lix.activeBranchId();
		const session = new RemoteWorkspaceLixSession(lix, defaultBranchId);
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

class RemoteWorkspaceLixSession implements WorkspaceLixSession {
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

function workspaceUrl(options: OpenWorkspaceLixSessionOptions): URL {
	const origin = options.origin ?? globalThis.location?.origin;
	if (!origin) throw new Error("A repository server origin is required.");
	return new URL(
		`/@${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.workspaceSlug)}`,
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
