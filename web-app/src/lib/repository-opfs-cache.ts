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

export const BROWSER_REPLICA_STORAGE_KEY_PREFIX = "lixray:browser-replica:v2:";

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
}

export interface BrowserReplicaLockManager {
	request(
		name: string,
		options: { mode: "exclusive"; ifAvailable?: true },
		callback: (lock: object | null) => Promise<void>,
	): Promise<void>;
}

const volatileBrowserReplicaIds = new WeakMap<object, Map<string, string[]>>();
const volatileBrowserReplicaIdsWithoutStorage = new Map<string, string[]>();
let unlockedBrowserReplicaTabId: string | undefined;
const claimedBrowserReplicaIds = new Set<string>();
const browserReplicaClaims = new Map<string, Promise<boolean>>();
const browserReplicaClaimReleases = new Map<string, () => void>();

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
	const existingIds = readBrowserReplicaIds(storage, storageKey, scopeKey);
	let browserId = existingIds[0];
	if (!browserId) {
		browserId = (
			environment.createId ?? (() => globalThis.crypto.randomUUID())
		)();
		persistBrowserReplicaIds(storage, storageKey, scopeKey, [browserId]);
	}
	return `${scope.authIdentity}:${browserId}`;
}

export function rotateRepositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaIdEnvironment = {},
): string {
	const storage = browserReplicaStorage(environment);
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const storageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	const browserId = (
		environment.createId ?? (() => globalThis.crypto.randomUUID())
	)();
	const existingIds = readBrowserReplicaIds(storage, storageKey, scopeKey);
	persistBrowserReplicaIds(storage, storageKey, scopeKey, [
		...existingIds,
		browserId,
	]);
	return `${scope.authIdentity}:${browserId}`;
}

export async function claimRepositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaClaimEnvironment = {},
): Promise<string> {
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const lockManager =
		environment.lockManager === undefined
			? browserReplicaLockManager()
			: environment.lockManager;
	if (!lockManager) {
		unlockedBrowserReplicaTabId ??= globalThis.crypto.randomUUID();
		return `${scope.authIdentity}:${unlockedBrowserReplicaTabId}`;
	}
	return withBrowserReplicaAllocationLock(scopeKey, lockManager, async () => {
		return claimRepositoryBrowserReplicaIdFromPool(
			scope,
			scopeKey,
			lockManager,
			environment,
		);
	});
}

async function claimRepositoryBrowserReplicaIdFromPool(
	scope: RepositoryBrowserReplicaScope,
	scopeKey: string,
	lockManager: BrowserReplicaLockManager,
	environment: BrowserReplicaClaimEnvironment,
): Promise<string> {
	const storage = browserReplicaStorage(environment);
	const storageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	const savedIds = readBrowserReplicaIds(storage, storageKey, scopeKey);
	if (savedIds.length === 0) {
		savedIds.push(
			repositoryBrowserReplicaId(scope, environment).slice(
				scope.authIdentity.length + 1,
			),
		);
	}
	const newestFirstIds = [...savedIds].reverse();
	for (let candidate = 0; candidate < 8; candidate += 1) {
		const replicaId =
			candidate < newestFirstIds.length
				? `${scope.authIdentity}:${newestFirstIds[candidate]}`
				: rotateRepositoryBrowserReplicaId(scope, environment);
		const claimKey = `${scopeKey}:${replicaId}`;
		if (claimedBrowserReplicaIds.has(claimKey)) return replicaId;
		let claim = browserReplicaClaims.get(claimKey);
		if (!claim) {
			claim = tryClaimBrowserReplicaIdLock(claimKey, lockManager);
			browserReplicaClaims.set(claimKey, claim);
		}
		const acquired = await claim.finally(() => {
			browserReplicaClaims.delete(claimKey);
		});
		if (acquired) {
			claimedBrowserReplicaIds.add(claimKey);
			promoteBrowserReplicaId(
				storage,
				storageKey,
				scopeKey,
				replicaId.slice(scope.authIdentity.length + 1),
			);
			return replicaId;
		}
	}
	throw new Error("Unable to claim an exclusive browser replica identity.");
}

async function withBrowserReplicaAllocationLock<TResult>(
	scopeKey: string,
	lockManager: BrowserReplicaLockManager,
	operation: () => Promise<TResult>,
): Promise<TResult> {
	return new Promise<TResult>((resolve, reject) => {
		try {
			const request = lockManager.request(
				`lixray:opfs-replica-pool:${scopeKey}`,
				{ mode: "exclusive" },
				async () => {
					try {
						resolve(await operation());
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				},
			);
			void request.catch(reject);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function readBrowserReplicaIds(
	storage: BrowserReplicaStorage | null,
	storageKey: string,
	scopeKey: string,
): string[] {
	let storedValue: string | null = null;
	try {
		storedValue = storage?.getItem(storageKey) ?? null;
	} catch {
		// Restricted browser storage falls through to the page-scoped pool.
	}
	if (storedValue) {
		try {
			const parsed: unknown = JSON.parse(storedValue);
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(value, index): value is string =>
						typeof value === "string" &&
						value.length > 0 &&
						parsed.indexOf(value) === index,
				);
			}
		} catch {
			// A v2 single-id value is migrated lazily into the replica pool.
		}
		return [storedValue];
	}
	return storage
		? [...(volatileBrowserReplicaIds.get(storage)?.get(scopeKey) ?? [])]
		: [...(volatileBrowserReplicaIdsWithoutStorage.get(scopeKey) ?? [])];
}

function persistBrowserReplicaIds(
	storage: BrowserReplicaStorage | null,
	storageKey: string,
	scopeKey: string,
	ids: string[],
): void {
	const uniqueIds = [...new Set(ids)];
	if (storage) {
		let byScope = volatileBrowserReplicaIds.get(storage);
		if (!byScope) {
			byScope = new Map();
			volatileBrowserReplicaIds.set(storage, byScope);
		}
		byScope.set(scopeKey, uniqueIds);
	} else {
		volatileBrowserReplicaIdsWithoutStorage.set(scopeKey, uniqueIds);
	}
	try {
		storage?.setItem(storageKey, JSON.stringify(uniqueIds));
	} catch {
		// The page-scoped fallback remains stable until navigation.
	}
}

function promoteBrowserReplicaId(
	storage: BrowserReplicaStorage | null,
	storageKey: string,
	scopeKey: string,
	replicaId: string,
): void {
	const ids = readBrowserReplicaIds(storage, storageKey, scopeKey);
	persistBrowserReplicaIds(storage, storageKey, scopeKey, [
		...ids.filter((id) => id !== replicaId),
		replicaId,
	]);
}

export async function tryClaimBrowserReplicaIdLock(
	claimKey: string,
	lockManager: BrowserReplicaLockManager | null = browserReplicaLockManager(),
): Promise<boolean> {
	if (!lockManager) return true;
	return new Promise<boolean>((resolve, reject) => {
		try {
			const request = lockManager.request(
				`lixray:opfs-replica:${claimKey}`,
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
					browserReplicaClaimReleases.set(claimKey, releaseLock);
					resolve(true);
					try {
						await held;
					} finally {
						if (browserReplicaClaimReleases.get(claimKey) === releaseLock) {
							browserReplicaClaimReleases.delete(claimKey);
						}
						claimedBrowserReplicaIds.delete(claimKey);
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

function repositoryBrowserReplicaScopeKey(
	scope: RepositoryBrowserReplicaScope,
): string {
	const repository =
		scope.repositoryId ?? `${scope.namespace}/${scope.repositorySlug}`;
	return `${scope.authIdentity}:${repository}`;
}

/** Releases page-owned OPFS replica locks before a real document unload. */
export function releaseRepositoryBrowserReplicaClaimsForPageUnload(): void {
	for (const [claimKey, release] of browserReplicaClaimReleases) {
		browserReplicaClaimReleases.delete(claimKey);
		claimedBrowserReplicaIds.delete(claimKey);
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
		return typeof globalThis.localStorage === "undefined"
			? null
			: globalThis.localStorage;
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
