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

export const BROWSER_REPLICA_TAB_STORAGE_KEY = "lixray:browser-replica-tab:v1";

type BrowserReplicaStorage = Pick<Storage, "getItem" | "setItem">;

interface BrowserReplicaIdEnvironment {
	storage?: BrowserReplicaStorage | null;
	createId?: () => string;
}

export interface BrowserReplicaLockManager {
	request(
		name: string,
		options: { mode: "exclusive"; ifAvailable: true },
		callback: (lock: object | null) => Promise<void>,
	): Promise<void>;
}

const volatileBrowserReplicaTabIds = new WeakMap<object, string>();
let volatileBrowserReplicaTabIdWithoutStorage: string | undefined;
let unlockedBrowserReplicaTabId: string | undefined;
const claimedBrowserReplicaIds = new Set<string>();
const browserReplicaClaims = new Map<string, Promise<boolean>>();
const browserReplicaClaimReleases = new Map<string, () => void>();

/**
 * Returns a durable replica identity for this browser tab.
 *
 * OPFS SQLite is a mutable replica, so separate top-level browsing contexts
 * must not open the same file. sessionStorage is scoped to one tab and survives
 * reloads, preserving warm OPFS reopen without coupling the replica to account
 * identity. Authentication remains a separate server principal.
 */
export function repositoryBrowserReplicaId(
	authIdentity: string,
	environment: BrowserReplicaIdEnvironment = {},
): string {
	const storage = browserReplicaStorage(environment);
	let tabId: string | null = null;
	try {
		tabId = storage?.getItem(BROWSER_REPLICA_TAB_STORAGE_KEY) ?? null;
	} catch {
		// Restricted browser storage still gets a stable identity for this page.
	}
	if (!tabId && storage) {
		tabId = volatileBrowserReplicaTabIds.get(storage) ?? null;
	}
	if (!tabId) {
		tabId =
			(storage ? undefined : volatileBrowserReplicaTabIdWithoutStorage) ??
			(environment.createId ?? (() => globalThis.crypto.randomUUID()))();
		if (storage) {
			volatileBrowserReplicaTabIds.set(storage, tabId);
		} else {
			volatileBrowserReplicaTabIdWithoutStorage = tabId;
		}
		try {
			storage?.setItem(BROWSER_REPLICA_TAB_STORAGE_KEY, tabId);
		} catch {
			// The page-scoped fallback above remains stable until navigation.
		}
	}
	return `${authIdentity}:${tabId}`;
}

export function rotateRepositoryBrowserReplicaId(
	authIdentity: string,
	environment: BrowserReplicaIdEnvironment = {},
): string {
	const storage = browserReplicaStorage(environment);
	const tabId = (
		environment.createId ?? (() => globalThis.crypto.randomUUID())
	)();
	if (storage) volatileBrowserReplicaTabIds.set(storage, tabId);
	else volatileBrowserReplicaTabIdWithoutStorage = tabId;
	try {
		storage?.setItem(BROWSER_REPLICA_TAB_STORAGE_KEY, tabId);
	} catch {
		// The page-scoped fallback remains stable until navigation.
	}
	return `${authIdentity}:${tabId}`;
}

export async function claimRepositoryBrowserReplicaId(
	authIdentity: string,
): Promise<string> {
	const lockManager = browserReplicaLockManager();
	if (!lockManager) {
		unlockedBrowserReplicaTabId ??= globalThis.crypto.randomUUID();
		return `${authIdentity}:${unlockedBrowserReplicaTabId}`;
	}
	for (let collision = 0; collision < 8; collision += 1) {
		const replicaId =
			collision === 0
				? repositoryBrowserReplicaId(authIdentity)
				: rotateRepositoryBrowserReplicaId(authIdentity);
		if (claimedBrowserReplicaIds.has(replicaId)) return replicaId;
		let claim = browserReplicaClaims.get(replicaId);
		if (!claim) {
			claim = tryClaimBrowserReplicaIdLock(replicaId, lockManager);
			browserReplicaClaims.set(replicaId, claim);
		}
		const acquired = await claim.finally(() => {
			browserReplicaClaims.delete(replicaId);
		});
		if (acquired) {
			claimedBrowserReplicaIds.add(replicaId);
			return replicaId;
		}
	}
	throw new Error("Unable to claim an exclusive browser replica identity.");
}

export async function tryClaimBrowserReplicaIdLock(
	replicaId: string,
	lockManager: BrowserReplicaLockManager | null = browserReplicaLockManager(),
): Promise<boolean> {
	if (!lockManager) return true;
	return new Promise<boolean>((resolve, reject) => {
		try {
			const request = lockManager.request(
				`lixray:opfs-replica:${replicaId}`,
				{ mode: "exclusive", ifAvailable: true },
				async (lock) => {
					if (!lock) {
						resolve(false);
						return;
					}
					let releaseLock!: () => void;
					const held = new Promise<void>((release) => {
						releaseLock = release;
					});
					browserReplicaClaimReleases.set(replicaId, releaseLock);
					resolve(true);
					try {
						await held;
					} finally {
						if (browserReplicaClaimReleases.get(replicaId) === releaseLock) {
							browserReplicaClaimReleases.delete(replicaId);
						}
						claimedBrowserReplicaIds.delete(replicaId);
					}
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

/** Releases page-owned OPFS replica locks before a real document unload. */
export function releaseRepositoryBrowserReplicaClaimsForPageUnload(): void {
	for (const [replicaId, release] of browserReplicaClaimReleases) {
		browserReplicaClaimReleases.delete(replicaId);
		claimedBrowserReplicaIds.delete(replicaId);
		release();
	}
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
