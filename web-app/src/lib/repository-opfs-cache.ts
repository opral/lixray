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

// Mirrors @lix-js/storage-opfs's on-disk layout (provider.ts): each storage
// name owns the OPFS directory /lix/sqlite-sahpool/<base64url(name)>. The
// encoding is frozen by a golden test; if the provider ever moves its files,
// deletion becomes a NotFound no-op and the open error surfaces instead of
// looping — never silent data loss.
const OPFS_SQLITE_POOL_PATH = ["lix", "sqlite-sahpool"] as const;

export function opfsReplicaDirectoryName(name: string): string {
	const bytes = new TextEncoder().encode(name);
	let encoded = "";
	for (const byte of bytes) encoded += String.fromCharCode(byte);
	return btoa(encoded)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

// storage-opfs keeps a closed backend warm — SQLite access handles held — for
// 30s (owner.ts scheduleIdleClose) to make close/reopen cheap. Deleting the
// files during that window is NoModificationAllowedError, so the wipe waits
// it out with a hard bound above the warm-idle timeout.
const REPLICA_DELETE_RETRY_DELAY_MS = 500;
const REPLICA_DELETE_TIMEOUT_MS = 40_000;

/**
 * Deletes one repository replica from OPFS so the next open bootstraps it
 * fresh from the server. Returns false when no replica directory exists.
 */
export async function deleteRepositoryOpfsReplica(
	name: string,
	root?: FileSystemDirectoryHandle,
	environment: {
		wait?: (milliseconds: number) => Promise<void>;
		now?: () => number;
	} = {},
): Promise<boolean> {
	const wait = environment.wait ?? delay;
	const now = environment.now ?? Date.now;
	const rootDirectory =
		root ?? (await globalThis.navigator.storage.getDirectory());
	const deadline = now() + REPLICA_DELETE_TIMEOUT_MS;
	for (;;) {
		try {
			let directory = rootDirectory;
			for (const segment of OPFS_SQLITE_POOL_PATH) {
				directory = await directory.getDirectoryHandle(segment);
			}
			await directory.removeEntry(opfsReplicaDirectoryName(name), {
				recursive: true,
			});
			return true;
		} catch (error) {
			if (error instanceof DOMException && error.name === "NotFoundError") {
				return false;
			}
			if (
				error instanceof DOMException &&
				error.name === "NoModificationAllowedError" &&
				now() < deadline
			) {
				await wait(REPLICA_DELETE_RETRY_DELAY_MS);
				continue;
			}
			throw error;
		}
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
