import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_STORAGE_KEY_PREFIX,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "./repository-opfs-cache.ts";

const browserScope = {
	authIdentity: "account-123",
	repositoryId: "11111111-1111-4111-8111-111111111111",
};
const browserStorageKey = `${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent(`${browserScope.authIdentity}:${browserScope.repositoryId}`)}`;

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
