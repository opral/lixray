import assert from "node:assert/strict";
import test from "node:test";
import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";
import { PublicProfileActivityCache } from "./profile-activity-cache.ts";

void test("shares a fresh profile activity result across visitors", async () => {
	const cache = new PublicProfileActivityCache();
	let loads = 0;
	const load = async () => {
		loads += 1;
		return activity(loads);
	};

	const first = await cache.resolve("namespace-a", load);
	const second = await cache.resolve("namespace-a", load);

	assert.equal(first.totalFiles, 1);
	assert.equal(second.totalFiles, 1);
	assert.equal(loads, 1);
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
