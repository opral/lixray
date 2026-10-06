import assert from "node:assert/strict";
import test from "node:test";
import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";
import { PublicProfileActivityCache } from "./profile-activity-cache.ts";

void test("shares a fresh profile activity result across visitors", async () => {
	let now = 1_800_000_000_000;
	const cache = new PublicProfileActivityCache({ now: () => now });
	let loads = 0;
	const load = async () => {
		loads += 1;
		return activity(loads);
	};

	const first = await cache.resolve("namespace-a", load);
	now += 23 * 60 * 60 * 1000;
	const second = await cache.resolve("namespace-a", load);
	now += 2 * 60 * 60 * 1000;
	const refreshed = await cache.resolve("namespace-a", load);

	assert.equal(first.totalFiles, 1);
	assert.equal(second.totalFiles, 1);
	assert.equal(refreshed.totalFiles, 2);
	assert.equal(loads, 2);
});

void test("deduplicates simultaneous profile activity scans", async () => {
	const cache = new PublicProfileActivityCache();
	let release: ((value: PublicProfileActivity) => void) | undefined;
	let loads = 0;
	const pending = new Promise<PublicProfileActivity>((resolve) => {
		release = resolve;
	});
	const load = () => {
		loads += 1;
		return pending;
	};

	const first = cache.resolve("namespace-a", load);
	const second = cache.resolve("namespace-a", load);
	release?.(activity(2));

	assert.equal((await first).totalFiles, 2);
	assert.equal((await second).totalFiles, 2);
	assert.equal(loads, 1);
});

void test("does not let a pre-invalidation scan repopulate the cache", async () => {
	const cache = new PublicProfileActivityCache();
	let releaseOld!: (value: PublicProfileActivity) => void;
	const oldScan = cache.resolve(
		"namespace-a",
		() => new Promise((resolve) => (releaseOld = resolve)),
	);

	cache.invalidate("namespace-a");
	const fresh = await cache.resolve("namespace-a", async () => activity(9));
	assert.equal(fresh.totalFiles, 9);
	releaseOld(activity(1));
	assert.equal((await oldScan).totalFiles, 1);

	let loads = 0;
	const cached = await cache.resolve("namespace-a", async () => {
		loads++;
		return activity(10);
	});
	assert.equal(cached.totalFiles, 9);
	assert.equal(loads, 0);
});

void test("retries after a loader throws synchronously", async () => {
	const cache = new PublicProfileActivityCache();
	await assert.rejects(
		cache.resolve("namespace-a", () => {
			throw new Error("synchronous scan setup failure");
		}),
		/synchronous scan setup failure/,
	);
	const recovered = await cache.resolve("namespace-a", async () => activity(7));
	assert.equal(recovered.totalFiles, 7);
});

void test("expires old keys and evicts least-recently-used entries at capacity", async () => {
	let now = 1_800_000_000_000;
	const cache = new PublicProfileActivityCache({
		maxEntries: 2,
		freshForMs: 100,
		fallbackForMs: 200,
		now: () => now,
	});
	await cache.resolve("a", async () => activity(1));
	await cache.resolve("b", async () => activity(2));
	await cache.resolve("a", async () => activity(3)); // Make a most recently used.
	await cache.resolve("c", async () => activity(4));
	assert.equal(cache.size, 2);
	let loads = 0;
	await cache.resolve("b", async () => {
		loads++;
		return activity(5);
	});
	assert.equal(loads, 1, "least-recently-used b should have been evicted");

	now += 60_001;
	await cache.resolve("d", async () => activity(6));
	assert.equal(cache.size, 1, "expired entries should be purged on access");
});

void test("serves a stale server result when refreshing fails", async () => {
	let now = 1_800_000_000_000;
	const cache = new PublicProfileActivityCache({
		freshForMs: 100,
		fallbackForMs: 1_000,
		now: () => now,
	});
	await cache.resolve("namespace-a", async () => activity(3));
	now += 200;

	const result = await cache.resolve("namespace-a", async () => {
		throw new Error("temporarily unavailable");
	});

	assert.equal(result.totalFiles, 3);
});

void test("does not serve a server result beyond the fallback window", async () => {
	let now = 1_800_000_000_000;
	const cache = new PublicProfileActivityCache({
		freshForMs: 100,
		fallbackForMs: 1_000,
		now: () => now,
	});
	await cache.resolve("namespace-a", async () => activity(3));
	now += 1_001;

	await assert.rejects(
		cache.resolve("namespace-a", async () => {
			throw new Error("temporarily unavailable");
		}),
		/temporarily unavailable/,
	);
});

function activity(totalFiles: number): PublicProfileActivity {
	return {
		totalFiles,
		failedRepositories: 0,
		repositories: [],
		fileMix: [],
	};
}
