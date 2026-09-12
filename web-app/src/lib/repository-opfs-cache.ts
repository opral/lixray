export interface RepositoryOpfsCacheIdentity {
	repositoryId: string;
	replicaId: string;
}

// Keep this namespace stable across upgrades. Convert supported replica layouts
// in the same OPFS storage so cached data and pending local edits are preserved.
export const REPOSITORY_OPFS_CACHE_NAMESPACE = "lixray:local-first-v1";

export const BROWSER_REPLICA_STORAGE_KEY_PREFIX = "lixray:browser-replica:v3:";

export interface RepositoryBrowserReplicaScope {
	authIdentity: string;
	repositoryId: string;
}

type BrowserReplicaStorage = Pick<Storage, "getItem" | "setItem">;

interface BrowserReplicaIdEnvironment {
	storage?: BrowserReplicaStorage;
	createId?: () => string;
	requestExclusive?: <T>(name: string, callback: () => T) => Promise<T>;
}

/**
 * Returns a durable replica identity for this browser profile.
 *
 * localStorage preserves one replica identity across tabs and browser sessions.
 * Every tab deliberately opens that same storage name: `OpfsStorage` owns the
 * single-writer fence and routes all clients through its elected owner worker.
 * Authentication remains a separate server principal.
 */
export async function repositoryBrowserReplicaId(
	scope: RepositoryBrowserReplicaScope,
	environment: BrowserReplicaIdEnvironment = {},
): Promise<string> {
	const storage = browserReplicaStorage(environment);
	const scopeKey = repositoryBrowserReplicaScopeKey(scope);
	const storageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
	const requestExclusive =
		environment.requestExclusive ?? browserReplicaLockRequest();
	return requestExclusive(`lixray:browser-replica-id:v3:${scopeKey}`, () => {
		let browserId = storage.getItem(storageKey) ?? undefined;
		if (!browserId) {
			browserId = (
				environment.createId ?? (() => globalThis.crypto.randomUUID())
			)();
			storage.setItem(storageKey, browserId);
		}
		return `${scope.authIdentity}:${browserId}`;
	});
}

function browserReplicaLockRequest(): <T>(
	name: string,
	callback: () => T,
) => Promise<T> {
	if (typeof globalThis.navigator?.locks?.request !== "function") {
		throw new Error(
			"Opening a durable browser repository requires the Web Locks API.",
		);
	}
	return (name, callback) => globalThis.navigator.locks.request(name, callback);
}

function repositoryBrowserReplicaScopeKey(
	scope: RepositoryBrowserReplicaScope,
): string {
	return `${scope.authIdentity}:${scope.repositoryId}`;
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
