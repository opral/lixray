import assert from "node:assert/strict";
import test from "node:test";
import {
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	repositoryOpfsCacheName,
} from "./repository-opfs-cache.ts";

void test("hard-cuts repository replicas away from the pre-protocol cache", () => {
	assert.equal(REPOSITORY_OPFS_CACHE_NAMESPACE, "lixray:sync-protocol-v2");
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
