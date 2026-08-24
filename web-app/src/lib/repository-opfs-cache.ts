export interface RepositoryOpfsCacheIdentity {
	namespace: string;
	repositorySlug: string;
	repositoryId?: string;
	replicaId: string;
}

// Hard-cut this prefix whenever an unshipped sync protocol or durable replica
// layout changes. Reusing the old `lixray:` names would let incompatible OPFS
// rows participate in bootstrap before the new server can repair them.
export const REPOSITORY_OPFS_CACHE_NAMESPACE = "lixray:sync-protocol-v3";

export const BROWSER_REPLICA_STORAGE_KEY_PREFIX = "lixray:browser-replica:v3:";
export const BROWSER_TAB_REPLICA_STORAGE_KEY_PREFIX =
	"lixray:browser-replica-tab:v1:";

export interface RepositoryBrowserReplicaScope {
	authIdentity: string;
	namespace: string;
	repositorySlug: string;
	repositoryId?: string;
}

type BrowserReplicaStorage = Pick<Storage, "getItem" | "setItem">;

interface BrowserReplicaIdEnvironment {
	storage?: BrowserReplicaStorage | null;
	createId?: () => string;
}

interface BrowserReplicaClaimEnvironment extends BrowserReplicaIdEnvironment {
	lockManager?: BrowserReplicaLockManager | null;
	tabStorage?: BrowserReplicaStorage | null;
}

export interface BrowserReplicaLockManager {
	request(
		name: string,
		options: { mode: "exclusive"; ifAvailable?: true },
		callback: (lock: object | null) => Promise<void>,
	): Promise<void>;
}

export interface BrowserReplicaClaim {
	replicaId: string;
	release(): void;
}

const volatileBrowserReplicaIds = new WeakMap<object, Map<string, string>>();
const volatileBrowserReplicaIdsWithoutStorage = new Map<string, string>();

/**
 * Returns a durable replica identity for this browser profile.
 *
 * OPFS SQLite is a mutable replica, so separate top-level browsing contexts
 * must not open the same file concurrently. localStorage preserves the identity
 * after every tab closes; a Web Lock rejects concurrent reuse and lets the
 * later tab claim another durable replica from the repository's saved pool.
 * Authentication remains a separate server principal.
 */
export function repositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaIdEnvironment = {},
): string {
	const storage = browserReplicaStorage(environment);
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const storageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	let browserId = readBrowserReplicaId(storage, storageKey, scopeKey);
	if (!browserId) {
		browserId = (
			environment.createId ?? (() => globalThis.crypto.randomUUID())
		)();
		persistBrowserReplicaId(storage, storageKey, scopeKey, browserId);
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
	const tabStorage = browserReplicaTabStorage(environment);
	const fallbackStorageKey = `${BROWSER_TAB_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	const pinnedBrowserId = readBrowserReplicaId(
		tabStorage,
		fallbackStorageKey,
		scopeKey,
	);
	if (pinnedBrowserId) {
		const pinnedReplicaId = `${scope.authIdentity}:${pinnedBrowserId}`;
		return {
			replicaId: pinnedReplicaId,
			release: await waitForBrowserReplicaIdLock(
				`${scopeKey}:${pinnedReplicaId}`,
				lockManager,
			),
		};
	}
	const durableReplicaId = repositoryBrowserReplicaId(scope, environment);
	const durableRelease = await tryClaimBrowserReplicaIdLock(
		`${scopeKey}:${durableReplicaId}`,
		lockManager,
	);
	if (durableRelease) {
		return { replicaId: durableReplicaId, release: durableRelease };
	}

	// Concurrent tabs must not share one mutable OPFS database. Pin the later
	// tab to its own replica so reloads cannot strand an offline outbox by
	// switching back to the profile replica. A reload waits for its old document
	// to finish closing that same replica.
	const fallbackBrowserId = (
		environment.createId ?? (() => globalThis.crypto.randomUUID())
	)();
	persistBrowserReplicaId(
		tabStorage,
		fallbackStorageKey,
		scopeKey,
		fallbackBrowserId,
	);
	const fallbackReplicaId = `${scope.authIdentity}:${fallbackBrowserId}`;
	const fallbackRelease = await waitForBrowserReplicaIdLock(
		`${scopeKey}:${fallbackReplicaId}`,
		lockManager,
	);
	return { replicaId: fallbackReplicaId, release: fallbackRelease };
}

function readBrowserReplicaId(
	storage: BrowserReplicaStorage | null,
	storageKey: string,
	scopeKey: string,
): string | undefined {
	let storedValue: string | null = null;
	try {
		storedValue = storage?.getItem(storageKey) ?? null;
	} catch {
		// Restricted browser storage falls through to the page-scoped pool.
	}
	if (storedValue) return storedValue;
	return storage
		? volatileBrowserReplicaIds.get(storage)?.get(scopeKey)
		: volatileBrowserReplicaIdsWithoutStorage.get(scopeKey);
}

function persistBrowserReplicaId(
	storage: BrowserReplicaStorage | null,
	storageKey: string,
	scopeKey: string,
	id: string,
): void {
	if (storage) {
		let byScope = volatileBrowserReplicaIds.get(storage);
		if (!byScope) {
			byScope = new Map();
			volatileBrowserReplicaIds.set(storage, byScope);
		}
		byScope.set(scopeKey, id);
	} else {
		volatileBrowserReplicaIdsWithoutStorage.set(scopeKey, id);
	}
	try {
		storage?.setItem(storageKey, id);
	} catch {
		// The page-scoped fallback remains stable until navigation.
	}
}

export async function tryClaimBrowserReplicaIdLock(
	claimKey: string,
	lockManager: BrowserReplicaLockManager | null = browserReplicaLockManager(),
): Promise<(() => void) | null> {
	if (!lockManager) return () => undefined;
	return claimBrowserReplicaIdLock(claimKey, lockManager, true);
}

async function waitForBrowserReplicaIdLock(
	claimKey: string,
	lockManager: BrowserReplicaLockManager,
): Promise<() => void> {
	const release = await claimBrowserReplicaIdLock(claimKey, lockManager, false);
	if (!release)
		throw new Error("Browser replica lock wait ended without a lock.");
	return release;
}

function claimBrowserReplicaIdLock(
	claimKey: string,
	lockManager: BrowserReplicaLockManager,
	ifAvailable: boolean,
): Promise<(() => void) | null> {
	return new Promise<(() => void) | null>((resolve, reject) => {
		try {
			const request = lockManager.request(
				`lixray:opfs-replica:${claimKey}`,
				ifAvailable
					? { mode: "exclusive", ifAvailable: true }
					: { mode: "exclusive" },
				async (lock) => {
					if (!lock) {
						resolve(null);
						return;
					}
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
	const repository =
		scope.repositoryId ?? `${scope.namespace}/${scope.repositorySlug}`;
	return `${scope.authIdentity}:${repository}`;
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
): BrowserReplicaStorage | null {
	if (environment.storage !== undefined) return environment.storage;
	try {
		return typeof globalThis.localStorage === "undefined"
			? null
			: globalThis.localStorage;
	} catch {
		return null;
	}
}

function browserReplicaTabStorage(
	environment: BrowserReplicaClaimEnvironment,
): BrowserReplicaStorage | null {
	if (environment.tabStorage !== undefined) return environment.tabStorage;
	try {
		return typeof globalThis.sessionStorage === "undefined"
			? null
			: globalThis.sessionStorage;
	} catch {
		return null;
	}
}

export function repositoryOpfsCacheName(
	identity: RepositoryOpfsCacheIdentity,
): string {
	const repository =
		identity.repositoryId ?? `${identity.namespace}/${identity.repositorySlug}`;
	return `${REPOSITORY_OPFS_CACHE_NAMESPACE}:${repository}:${identity.replicaId}`;
}
