import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_STORAGE_KEY_PREFIX,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	claimRepositoryBrowserReplicaId,
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
	type BrowserReplicaLockManager,
} from "./repository-opfs-cache.ts";

const browserScope = {
	authIdentity: "account-123",
	repositoryId: "11111111-1111-4111-8111-111111111111",
};
const browserStorageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(`${browserScope.authIdentity}:${browserScope.repositoryId}`)}`;

function createLockManager(): BrowserReplicaLockManager {
	const held = new Set<string>();
	const waiters = new Map<string, Array<() => void>>();
	return {
		async request(name, options, callback) {
			options.signal?.throwIfAborted();
			while (held.has(name)) {
				await new Promise<void>((resolve, reject) => {
					const queue = waiters.get(name) ?? [];
					const wake = () => {
						options.signal?.removeEventListener("abort", abort);
						resolve();
					};
					const abort = () => {
						const index = queue.indexOf(wake);
						if (index >= 0) queue.splice(index, 1);
						reject(
							options.signal?.reason instanceof Error
								? options.signal.reason
								: new DOMException("The operation was aborted.", "AbortError"),
						);
					};
					queue.push(wake);
					waiters.set(name, queue);
					options.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			held.add(name);
			try {
				await callback({});
			} finally {
				held.delete(name);
				waiters.get(name)?.shift()?.();
			}
		},
	};
}

void test("hard-cuts replicas created before selected-change locators", () => {
	assert.equal(REPOSITORY_OPFS_CACHE_NAMESPACE, "lixray:sync-protocol-v3");
	const identity = {
		repositoryId: "11111111-1111-4111-8111-111111111111",
		replicaId: "22222222-2222-4222-8222-222222222222",
	};
	const name = repositoryOpfsCacheName(identity);

	assert.equal(
		name,
		`${REPOSITORY_OPFS_CACHE_NAMESPACE}:${identity.repositoryId}:${identity.replicaId}`,
	);
	assert.notEqual(
		name,
		`lixray:${identity.repositoryId}:${identity.replicaId}`,
	);
	assert.notEqual(
		name,
		`lixray:sync-protocol-v1:${identity.repositoryId}:${identity.replicaId}`,
	);
	assert.notEqual(
		name,
		`lixray:sync-protocol-v2:${identity.repositoryId}:${identity.replicaId}`,
	);
});

void test("keys repository and replica caches by stable repository id", () => {
	const base = {
		repositoryId: "11111111-1111-4111-8111-111111111111",
		replicaId: "anonymous-a",
	};
	assert.equal(
		repositoryOpfsCacheName(base),
		`${REPOSITORY_OPFS_CACHE_NAMESPACE}:${base.repositoryId}:anonymous-a`,
	);
	assert.notEqual(
		repositoryOpfsCacheName(base),
		repositoryOpfsCacheName({ ...base, replicaId: "anonymous-b" }),
	);
	assert.notEqual(
		repositoryOpfsCacheName(base),
		repositoryOpfsCacheName({
			...base,
			repositoryId: "22222222-2222-4222-8222-222222222222",
		}),
	);
});

void test("persists one warm-reopen replica per repository", () => {
	const browserStorage = new Map<string, string>();
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});

	const replicaA = repositoryBrowserReplicaId(browserScope, {
		storage: storage(browserStorage),
		createId: () => "browser-a",
	});
	assert.equal(replicaA, "account-123:browser-a");
	assert.equal(browserStorage.get(browserStorageKey), "browser-a");
	assert.equal(
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(browserStorage),
			createId: () => "unused",
		}),
		replicaA,
	);
});

void test("keeps durable warm replicas independent across repositories", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const otherScope = {
		...browserScope,
		repositoryId: "22222222-2222-4222-8222-222222222222",
	};
	const first = repositoryBrowserReplicaId(browserScope, {
		storage,
		createId: () => "website-replica",
	});
	const other = repositoryBrowserReplicaId(otherScope, {
		storage,
		createId: () => "other-replica",
	});

	assert.equal(first, "account-123:website-replica");
	assert.equal(other, "account-123:other-replica");
	assert.equal(
		repositoryBrowserReplicaId(browserScope, {
			storage,
			createId: () => "must-not-replace-website",
		}),
		first,
	);
});

void test("fails closed when durable replica storage cannot be read or written", () => {
	assert.throws(
		() =>
			repositoryBrowserReplicaId(browserScope, {
				storage: {
					getItem: () => {
						throw new Error("storage read denied");
					},
					setItem: () => undefined,
				},
				createId: () => "must-not-fallback",
			}),
		/storage read denied/,
	);
	assert.throws(
		() =>
			repositoryBrowserReplicaId(browserScope, {
				storage: {
					getItem: () => null,
					setItem: () => {
						throw new Error("storage write denied");
					},
				},
				createId: () => "must-not-fallback",
			}),
		/storage write denied/,
	);
});

void test("fails closed when exclusive browser replica ownership is unavailable", async () => {
	await assert.rejects(
		claimRepositoryBrowserReplicaId(browserScope, { lockManager: null }),
		/requires the Web Locks API/,
	);
});

void test("queues concurrent opens on the same durable replica", async () => {
	const values = new Map([[browserStorageKey, "warm-browser"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const locks = createLockManager();
	const environment = {
		storage,
		lockManager: locks,
		createId: () => "must-not-replace-warm-browser",
	};
	const first = await claimRepositoryBrowserReplicaId(
		browserScope,
		environment,
	);
	assert.equal(first.replicaId, "account-123:warm-browser");
	const secondOpen = claimRepositoryBrowserReplicaId(browserScope, environment);
	let secondSettled = false;
	void secondOpen.then(() => {
		secondSettled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(secondSettled, false, "the later open waits for ownership");
	first.release();
	const second = await secondOpen;
	assert.equal(second.replicaId, first.replicaId);
	assert.equal(values.get(browserStorageKey), "warm-browser");
	second.release();
});

void test("cancels a queued replica claim before the owner releases", async () => {
	const values = new Map([[browserStorageKey, "warm-browser"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const lockManager = createLockManager();
	const first = await claimRepositoryBrowserReplicaId(browserScope, {
		storage,
		lockManager,
	});
	const controller = new AbortController();
	const queued = claimRepositoryBrowserReplicaId(browserScope, {
		storage,
		lockManager,
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(queued, { name: "AbortError" });
	first.release();
});
