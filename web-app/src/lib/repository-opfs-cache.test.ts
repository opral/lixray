import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_STORAGE_KEY_PREFIX,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	claimRepositoryBrowserReplicaId,
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
	releaseRepositoryBrowserReplicaClaimsForPageUnload,
	rotateRepositoryBrowserReplicaId,
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

void test("uses one warm-reopen replica across browser tabs", () => {
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
	assert.equal(browserStorage.get(browserStorageKey), '["browser-a"]');
	assert.equal(
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(browserStorage),
			createId: () => "unused",
		}),
		replicaA,
	);
	assert.equal(
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(browserStorage),
			createId: () => "unused-in-second-tab",
		}),
		replicaA,
	);
	assert.equal(
		rotateRepositoryBrowserReplicaId(browserScope, {
			storage: storage(browserStorage),
			createId: () => "browser-rotated",
		}),
		"account-123:browser-rotated",
	);
	assert.equal(
		browserStorage.get(browserStorageKey),
		'["browser-a","browser-rotated"]',
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

void test("rotates a localStorage identity when its Web Lock is held", () => {
	const originalTab = new Map([[browserStorageKey, "copied"]]);
	const duplicatedTab = new Map(originalTab);
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	assert.equal(
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(originalTab),
		}),
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(duplicatedTab),
		}),
	);
	assert.notEqual(
		repositoryBrowserReplicaId(browserScope, {
			storage: storage(originalTab),
		}),
		rotateRepositoryBrowserReplicaId(browserScope, {
			storage: storage(duplicatedTab),
			createId: () => "rotated-copy",
		}),
	);
});

void test("keeps a durable pool when two tabs claim the same repository", async () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const held = new Set<string>();
	const requestedLocks: string[] = [];
	const locks: BrowserReplicaLockManager = {
		async request(name, _options, callback) {
			requestedLocks.push(name);
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
	const ids = ["tab-a", "tab-b"];
	const environment = {
		storage,
		lockManager: locks,
		createId: () => ids.shift() ?? "unexpected-tab",
	};

	const firstReplica = repositoryBrowserReplicaId(browserScope, environment);
	assert.equal(firstReplica, "account-123:tab-a");
	const scopeKey = `${browserScope.authIdentity}:${browserScope.repositoryId}`;
	assert.equal(
		await tryClaimBrowserReplicaIdLock(`${scopeKey}:${firstReplica}`, locks),
		true,
	);
	assert.equal(
		await claimRepositoryBrowserReplicaId(browserScope, environment),
		"account-123:tab-b",
		"the second tab claims another saved replica without replacing the first",
	);
	assert.equal(values.get(browserStorageKey), '["tab-a","tab-b"]');
	assert.ok(
		requestedLocks.includes(
			`lixray:opfs-replica-pool:${browserScope.authIdentity}:${browserScope.repositoryId}`,
		),
		"pool selection is serialized before claiming a replica",
	);

	releaseRepositoryBrowserReplicaClaimsForPageUnload();
	await Promise.resolve();
	await Promise.resolve();
});

void test("reopens the most recently claimed saved replica first", async () => {
	const values = new Map([
		[browserStorageKey, '["older-replica","newer-replica"]'],
	]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const locks: BrowserReplicaLockManager = {
		async request(_name, _options, callback) {
			await callback({});
		},
	};

	assert.equal(
		await claimRepositoryBrowserReplicaId(browserScope, {
			storage,
			lockManager: locks,
		}),
		"account-123:newer-replica",
	);
	releaseRepositoryBrowserReplicaClaimsForPageUnload();
	await Promise.resolve();
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
	const values = new Map([[browserStorageKey, "warm-browser"]]);
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
	const beforeReload = repositoryBrowserReplicaId(browserScope, { storage });
	assert.equal(beforeReload, "account-123:warm-browser");
	assert.equal(await tryClaimBrowserReplicaIdLock(beforeReload, locks), true);

	releaseRepositoryBrowserReplicaClaimsForPageUnload();
	await Promise.resolve();
	await Promise.resolve();

	const afterReload = repositoryBrowserReplicaId(browserScope, { storage });
	assert.equal(afterReload, beforeReload);
	assert.equal(await tryClaimBrowserReplicaIdLock(afterReload, locks), true);
	releaseRepositoryBrowserReplicaClaimsForPageUnload();
});
