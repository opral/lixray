import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_REPLICA_STORAGE_KEY_PREFIX,
	REPOSITORY_OPFS_CACHE_NAMESPACE,
	deleteRepositoryOpfsReplica,
	opfsReplicaDirectoryName,
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

void test("persists one warm-reopen replica per repository", async () => {
	const browserStorage = new Map<string, string>();
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});

	const replicaA = await repositoryBrowserReplicaId(browserScope, {
		storage: storage(browserStorage),
		createId: () => "browser-a",
		requestExclusive: async (_name, callback) => callback(),
	});
	assert.equal(replicaA, "account-123:browser-a");
	assert.equal(browserStorage.get(browserStorageKey), "browser-a");
	assert.equal(
		await repositoryBrowserReplicaId(browserScope, {
			storage: storage(browserStorage),
			createId: () => "unused",
			requestExclusive: async (_name, callback) => callback(),
		}),
		replicaA,
	);
});

void test("keeps durable warm replicas independent across repositories", async () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const otherScope = {
		...browserScope,
		repositoryId: "22222222-2222-4222-8222-222222222222",
	};
	const requestExclusive = async <T>(_name: string, callback: () => T) =>
		callback();
	const first = await repositoryBrowserReplicaId(browserScope, {
		storage,
		createId: () => "website-replica",
		requestExclusive,
	});
	const other = await repositoryBrowserReplicaId(otherScope, {
		storage,
		createId: () => "other-replica",
		requestExclusive,
	});

	assert.equal(first, "account-123:website-replica");
	assert.equal(other, "account-123:other-replica");
	assert.equal(
		await repositoryBrowserReplicaId(browserScope, {
			storage,
			createId: () => "must-not-replace-website",
			requestExclusive,
		}),
		first,
	);
});

void test("fails closed when durable replica storage cannot be read or written", async () => {
	const requestExclusive = async <T>(_name: string, callback: () => T) =>
		callback();
	await assert.rejects(
		async () =>
			repositoryBrowserReplicaId(browserScope, {
				storage: {
					getItem: () => {
						throw new Error("storage read denied");
					},
					setItem: () => undefined,
				},
				createId: () => "must-not-fallback",
				requestExclusive,
			}),
		/storage read denied/,
	);
	await assert.rejects(
		async () =>
			repositoryBrowserReplicaId(browserScope, {
				storage: {
					getItem: () => null,
					setItem: () => {
						throw new Error("storage write denied");
					},
				},
				createId: () => "must-not-fallback",
				requestExclusive,
			}),
		/storage write denied/,
	);
});

void test("serializes first-open identity creation across tabs", async () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	let tail = Promise.resolve();
	const requestExclusive = async <T>(_name: string, callback: () => T) => {
		const previous = tail;
		let release!: () => void;
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return callback();
		} finally {
			release();
		}
	};
	const [first, second] = await Promise.all([
		repositoryBrowserReplicaId(browserScope, {
			storage,
			createId: () => "first-tab",
			requestExclusive,
		}),
		repositoryBrowserReplicaId(browserScope, {
			storage,
			createId: () => "second-tab",
			requestExclusive,
		}),
	]);

	assert.equal(first, "account-123:first-tab");
	assert.equal(second, first);
});

void test("replica directory name freezes the storage-opfs base64url encoding", () => {
	// Golden values: must match @lix-js/storage-opfs's fileName() so deletion
	// targets the directory the provider actually writes.
	const name = repositoryOpfsCacheName({
		repositoryId: "repo-1",
		replicaId: "account-123:tab-1",
	});
	assert.equal(
		opfsReplicaDirectoryName(name),
		Buffer.from(name, "utf8").toString("base64url"),
	);
	// Padding is stripped, +/ become -_ (base64url), non-ASCII survives.
	assert.equal(opfsReplicaDirectoryName("a"), "YQ");
	assert.equal(opfsReplicaDirectoryName("sync✓"), "c3luY-Kckw");
});

void test("deletes exactly the named replica directory from the OPFS pool", async () => {
	const removed: Array<{ name: string; recursive: boolean }> = [];
	const pool = {
		removeEntry: async (name: string, options: { recursive: boolean }) => {
			removed.push({ name, recursive: options.recursive });
		},
	};
	const lix = {
		getDirectoryHandle: async (name: string) => {
			assert.equal(name, "sqlite-sahpool");
			return pool;
		},
	};
	const root = {
		getDirectoryHandle: async (name: string) => {
			assert.equal(name, "lix");
			return lix;
		},
	} as unknown as FileSystemDirectoryHandle;

	const cacheName = repositoryOpfsCacheName({
		repositoryId: "repo-1",
		replicaId: "account-123:tab-1",
	});
	assert.equal(await deleteRepositoryOpfsReplica(cacheName, root), true);
	assert.deepEqual(removed, [
		{ name: opfsReplicaDirectoryName(cacheName), recursive: true },
	]);
});

void test("a missing replica directory is a no-op", async () => {
	const notFoundRoot = {
		getDirectoryHandle: async () => {
			throw new DOMException("missing", "NotFoundError");
		},
	} as unknown as FileSystemDirectoryHandle;
	assert.equal(await deleteRepositoryOpfsReplica("gone", notFoundRoot), false);
});

void test("outwaits the storage layer's warm-idle handles, bounded", async () => {
	// storage-opfs keeps closed backends warm (handles held) for 30s; the
	// wipe retries through that window and succeeds once handles release.
	let locked = 3;
	const pool = {
		removeEntry: async () => {
			if (locked > 0) {
				locked -= 1;
				throw new DOMException("held", "NoModificationAllowedError");
			}
		},
	};
	const dir = { getDirectoryHandle: async () => dir, ...pool };
	const root = {
		getDirectoryHandle: async () => dir,
	} as unknown as FileSystemDirectoryHandle;
	let clock = 0;
	const waits: number[] = [];
	assert.equal(
		await deleteRepositoryOpfsReplica("held", root, {
			wait: async (milliseconds) => {
				waits.push(milliseconds);
				clock += milliseconds;
			},
			now: () => clock,
		}),
		true,
	);
	assert.deepEqual(waits, [500, 500, 500]);

	// A wipe that never unblocks stops at the deadline and surfaces the error.
	locked = Number.POSITIVE_INFINITY;
	clock = 0;
	await assert.rejects(
		() =>
			deleteRepositoryOpfsReplica("stuck", root, {
				wait: async (milliseconds) => {
					clock += milliseconds;
				},
				now: () => clock,
			}),
		(error: unknown) =>
			error instanceof DOMException &&
			error.name === "NoModificationAllowedError",
	);
});
