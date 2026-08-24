import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_STORAGE_KEY_PREFIX,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	claimRepositoryBrowserReplicaId,
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
	tryClaimBrowserReplicaIdLock,
	type BrowserReplicaLockManager,
} from "./repository-opfs-cache.ts";

const browserScope = {
	authIdentity: "account-123",
	namespace: "acme",
	repositorySlug: "website",
	repositoryId: "11111111-1111-4111-8111-111111111111",
};
const browserStorageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(`${browserScope.authIdentity}:${browserScope.repositoryId}`)}`;

function createLockManager(): BrowserReplicaLockManager {
	const held = new Set<string>();
	const waiters = new Map<string, Array<() => void>>();
	return {
		async request(name, options, callback) {
			while (held.has(name)) {
				if (options.ifAvailable) {
					await callback(null);
					return;
				}
				await new Promise<void>((resolve) => {
					const queue = waiters.get(name) ?? [];
					queue.push(resolve);
					waiters.set(name, queue);
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
		namespace: "atelier",
		repositorySlug: "website",
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

void test("keeps anonymous repository and replica caches isolated", () => {
	const base = {
		namespace: "atelier",
		repositorySlug: "website",
		replicaId: "anonymous-a",
	};
	assert.equal(
		repositoryOpfsCacheName(base),
		`${REPOSITORY_OPFS_CACHE_NAMESPACE}:atelier/website:anonymous-a`,
	);
	assert.notEqual(
		repositoryOpfsCacheName(base),
		repositoryOpfsCacheName({ ...base, replicaId: "anonymous-b" }),
	);
	assert.notEqual(
		repositoryOpfsCacheName(base),
		repositoryOpfsCacheName({ ...base, repositorySlug: "other" }),
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
		repositorySlug: "other",
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

void test("fails closed when exclusive browser replica ownership is unavailable", async () => {
	await assert.rejects(
		claimRepositoryBrowserReplicaId(browserScope, { lockManager: null }),
		/requires the Web Locks API/,
	);
});

void test("gives a concurrent tab a reload-stable replica", async () => {
	const values = new Map([[browserStorageKey, "warm-browser"]]);
	const tabValues = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const tabStorage = {
		getItem: (key: string) => tabValues.get(key) ?? null,
		setItem: (key: string, value: string) => tabValues.set(key, value),
	};
	const locks = createLockManager();
	const environment = {
		storage,
		tabStorage,
		lockManager: locks,
		createId: () => "secondary-tab",
	};
	const first = await claimRepositoryBrowserReplicaId(
		browserScope,
		environment,
	);
	const second = await claimRepositoryBrowserReplicaId(
		browserScope,
		environment,
	);
	assert.equal(first.replicaId, "account-123:warm-browser");
	assert.equal(second.replicaId, "account-123:secondary-tab");
	assert.equal(values.get(browserStorageKey), "warm-browser");
	const overlappingReopen = claimRepositoryBrowserReplicaId(browserScope, {
		...environment,
		createId: () => "must-not-replace-secondary-tab",
	});
	let overlapSettled = false;
	void overlappingReopen.then(() => {
		overlapSettled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(overlapSettled, false, "reload waits for the old document lock");
	second.release();
	const reopenedSecond = await overlappingReopen;
	assert.equal(reopenedSecond.replicaId, second.replicaId);
	first.release();
	reopenedSecond.release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const reopenedAfterPrimaryExit = await claimRepositoryBrowserReplicaId(
		browserScope,
		{
			...environment,
			createId: () => "must-not-switch-back-to-primary",
		},
	);
	assert.equal(reopenedAfterPrimaryExit.replicaId, second.replicaId);
	reopenedAfterPrimaryExit.release();
});

void test("holds the exclusive lock until its resource releases it", async () => {
	const locks = createLockManager();
	const release = await tryClaimBrowserReplicaIdLock("copied", locks);
	assert.equal(typeof release, "function");
	assert.equal(await tryClaimBrowserReplicaIdLock("copied", locks), null);
	release?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		typeof (await tryClaimBrowserReplicaIdLock("copied", locks)),
		"function",
	);
});
