export interface RepositoryOpfsCacheIdentity {
	repositoryId: string;
	replicaId: string;
}

// Hard-cut this prefix whenever an unshipped sync protocol or durable replica
// layout changes. Reusing the old `lixray:` names would let incompatible OPFS
// rows participate in bootstrap before the new server can repair them.
export const REPOSITORY_OPFS_CACHE_NAMESPACE = "lixray:sync-protocol-v3";

export const BROWSER_REPLICA_STORAGE_KEY_PREFIX = "lixray:browser-replica:v3:";

export interface RepositoryBrowserReplicaScope {
	authIdentity: string;
	repositoryId: string;
}

type BrowserReplicaStorage = Pick<Storage, "getItem" | "setItem">;

interface BrowserReplicaIdEnvironment {
	storage?: BrowserReplicaStorage;
	createId?: () => string;
}

interface BrowserReplicaClaimEnvironment extends BrowserReplicaIdEnvironment {
	lockManager?: BrowserReplicaLockManager | null;
}

export interface BrowserReplicaLockManager {
	request(
		name: string,
		options: { mode: "exclusive" },
		callback: (lock: object) => Promise<void>,
	): Promise<void>;
}

export interface BrowserReplicaClaim {
	replicaId: string;
	release(): void;
}

/**
 * Returns a durable replica identity for this browser profile.
 *
 * OPFS SQLite is a mutable replica, so separate top-level browsing contexts
 * must not open the same file concurrently. localStorage preserves the identity
 * after every tab closes; a Web Lock serializes concurrent ownership of that
 * one durable replica. Authentication remains a separate server principal.
 */
export function repositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaIdEnvironment = {},
): string {
	const storage = browserReplicaStorage(environment);
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const storageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	let browserId = storage.getItem(storageKey) ?? undefined;
	if (!browserId) {
		browserId = (
			environment.createId ?? (() => globalThis.crypto.randomUUID())
		)();
		storage.setItem(storageKey, browserId);
	}
	return `${scope.authIdentity}:${browserId}`;
}

export async function claimRepositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaClaimEnvironment = {},
): Promise<BrowserReplicaClaim> {
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const lockManager =
		environment.lockManager === undefined
			? browserReplicaLockManager()
			: environment.lockManager;
	if (!lockManager) {
		throw new Error(
			"Opening a durable browser repository requires the Web Locks API.",
		);
	}
	const durableReplicaId = repositoryBrowserReplicaId(scope, environment);
	const release = await claimBrowserReplicaIdLock(
		`${scopeKey}:${durableReplicaId}`,
		lockManager,
	);
	return { replicaId: durableReplicaId, release };
}

function claimBrowserReplicaIdLock(
	claimKey: string,
	lockManager: BrowserReplicaLockManager,
): Promise<() => void> {
	return new Promise<() => void>((resolve, reject) => {
		try {
			const request = lockManager.request(
				`lixray:opfs-replica:${claimKey}`,
				{ mode: "exclusive" },
				async () => {
					let releaseLock!: () => void;
					let released = false;
					const held = new Promise<void>((release) => {
						releaseLock = release;
					});
					resolve(() => {
						if (released) return;
						released = true;
						releaseLock();
					});
					await held;
				},
			);
			void request.catch((error: unknown) =>
				reject(error instanceof Error ? error : new Error(String(error))),
			);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function repositoryBrowserReplicaScopeKey(
	scope: RepositoryBrowserReplicaScope,
): string {
	return `${scope.authIdentity}:${scope.repositoryId}`;
}

function browserReplicaLockManager(): BrowserReplicaLockManager | null {
	try {
		return (
			(globalThis.navigator?.locks as BrowserReplicaLockManager | undefined) ??
			null
		);
	} catch {
		return null;
	}
}

function browserReplicaStorage(
	environment: BrowserReplicaIdEnvironment,
): BrowserReplicaStorage {
	if (environment.storage !== undefined) return environment.storage;
	if (typeof globalThis.localStorage === "undefined") {
		throw new Error(
			"Opening a durable browser repository requires localStorage.",
		);
	}
	return globalThis.localStorage;
}

export function repositoryOpfsCacheName(
	identity: RepositoryOpfsCacheIdentity,
): string {
	return `${REPOSITORY_OPFS_CACHE_NAMESPACE}:${identity.repositoryId}:${identity.replicaId}`;
}
