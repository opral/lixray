import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_TAB_STORAGE_KEY,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
	releaseRepositoryBrowserReplicaClaimsForPageUnload,
	rotateRepositoryBrowserReplicaId,
	tryClaimBrowserReplicaIdLock,
	type BrowserReplicaLockManager,
} from "./repository-opfs-cache.ts";

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

void test("uses one warm-reopen replica per browser tab", () => {
	const tabA = new Map<string, string>();
	const tabB = new Map<string, string>();
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});

	const replicaA = repositoryBrowserReplicaId("account-123", {
		storage: storage(tabA),
		createId: () => "tab-a",
	});
	assert.equal(replicaA, "account-123:tab-a");
	assert.equal(tabA.get(BROWSER_REPLICA_TAB_STORAGE_KEY), "tab-a");
	assert.equal(
		repositoryBrowserReplicaId("account-123", {
			storage: storage(tabA),
			createId: () => "unused",
		}),
		replicaA,
	);
	assert.equal(
		repositoryBrowserReplicaId("account-123", {
			storage: storage(tabB),
			createId: () => "tab-b",
		}),
		"account-123:tab-b",
	);
	assert.notEqual(replicaA, "account-123:tab-b");
	assert.equal(
		rotateRepositoryBrowserReplicaId("account-123", {
			storage: storage(tabA),
			createId: () => "tab-a-rotated",
		}),
		"account-123:tab-a-rotated",
	);
	assert.equal(tabA.get(BROWSER_REPLICA_TAB_STORAGE_KEY), "tab-a-rotated");
});

void test("rotates a sessionStorage identity copied into another tab", () => {
	const originalTab = new Map([[BROWSER_REPLICA_TAB_STORAGE_KEY, "copied"]]);
	const duplicatedTab = new Map(originalTab);
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	assert.equal(
		repositoryBrowserReplicaId("account-123", {
			storage: storage(originalTab),
		}),
		repositoryBrowserReplicaId("account-123", {
			storage: storage(duplicatedTab),
		}),
	);
	assert.notEqual(
		repositoryBrowserReplicaId("account-123", {
			storage: storage(originalTab),
		}),
		rotateRepositoryBrowserReplicaId("account-123", {
			storage: storage(duplicatedTab),
			createId: () => "rotated-copy",
		}),
	);
});

void test("exclusively claims a copied browser replica identity", async () => {
	const held = new Set<string>();
	const locks: BrowserReplicaLockManager = {
		async request(name, _options, callback) {
			if (held.has(name)) {
				await callback(null);
				return;
			}
			held.add(name);
			await callback({});
		},
	};
	assert.equal(await tryClaimBrowserReplicaIdLock("copied", locks), true);
	assert.equal(await tryClaimBrowserReplicaIdLock("copied", locks), false);
	releaseRepositoryBrowserReplicaClaimsForPageUnload();
});

void test("releases a replica lock so reload preserves its identity", async () => {
	const values = new Map([[BROWSER_REPLICA_TAB_STORAGE_KEY, "warm-tab"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const held = new Set<string>();
	const locks: BrowserReplicaLockManager = {
		async request(name, _options, callback) {
			if (held.has(name)) {
				await callback(null);
				return;
			}
			held.add(name);
			try {
				await callback({});
			} finally {
				held.delete(name);
			}
		},
	};
	const beforeReload = repositoryBrowserReplicaId("account-123", { storage });
	assert.equal(beforeReload, "account-123:warm-tab");
	assert.equal(await tryClaimBrowserReplicaIdLock(beforeReload, locks), true);

	releaseRepositoryBrowserReplicaClaimsForPageUnload();
	await Promise.resolve();
	await Promise.resolve();

	const afterReload = repositoryBrowserReplicaId("account-123", { storage });
	assert.equal(afterReload, beforeReload);
	assert.equal(await tryClaimBrowserReplicaIdLock(afterReload, locks), true);
	releaseRepositoryBrowserReplicaClaimsForPageUnload();
});
