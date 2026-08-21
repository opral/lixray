import assert from "node:assert/strict";
import test from "node:test";
import type { PublicProfileActivity } from "./profile-activity-aggregate.ts";
import { resolvePublicProfileActivity } from "./public-profile-activity.ts";

const NOW = 1_800_000_000_000;

void test("returns a fresh browser-cached activity without fetching", async () => {
	const storage = memoryStorage(
		JSON.stringify({ cachedAt: NOW - 60_000, activity: activity(12) }),
	);
	let fetchCount = 0;

	const result = await resolvePublicProfileActivity(
		{ namespaceId: "namespace-a" },
		{
			storage,
			now: () => NOW,
			fetcher: async () => {
				fetchCount += 1;
				return Response.json(activity(99));
			},
		},
	);

	assert.equal(result.totalFiles, 12);
	assert.equal(fetchCount, 0);
});

void test("refreshes a stale browser cache and stores the result", async () => {
	const storage = memoryStorage(
		JSON.stringify({ cachedAt: NOW - 10 * 60_000, activity: activity(12) }),
	);

	const result = await resolvePublicProfileActivity(
		{ namespaceId: "namespace-a" },
		{
			storage,
			now: () => NOW,
			fetcher: async () => Response.json(activity(24)),
		},
	);

	assert.equal(result.totalFiles, 24);
	assert.equal(
		storage.value,
		JSON.stringify({ cachedAt: NOW, activity: activity(24) }),
	);
});

void test("uses a recent stale cache when refreshing fails", async () => {
	const storage = memoryStorage(
		JSON.stringify({ cachedAt: NOW - 10 * 60_000, activity: activity(12) }),
	);

	const result = await resolvePublicProfileActivity(
		{ namespaceId: "namespace-a" },
		{
			storage,
			now: () => NOW,
			fetcher: async () => new Response(null, { status: 503 }),
		},
	);

	assert.equal(result.totalFiles, 12);
});

void test("rejects when an expired cache cannot be refreshed", async () => {
	const storage = memoryStorage(
		JSON.stringify({
			cachedAt: NOW - 25 * 60 * 60_000,
			activity: activity(12),
		}),
	);

	await assert.rejects(
		resolvePublicProfileActivity(
			{ namespaceId: "namespace-a" },
			{
				storage,
				now: () => NOW,
				fetcher: async () => new Response(null, { status: 503 }),
			},
		),
		/Unable to load public repositories/,
	);
});

function memoryStorage(initialValue: string | null) {
	return {
		value: initialValue,
		getItem() {
			return this.value;
		},
		setItem(_key: string, value: string) {
			this.value = value;
		},
	};
}

function activity(totalFiles: number): PublicProfileActivity {
	return {
		totalFiles,
		failedRepositories: 0,
		repositories: [
			{
				id: "repository-a",
				name: "Repository A",
				slug: "repository-a",
				namespaceHandle: "samuel",
				fileCount: totalFiles,
			},
		],
		fileMix: [
			{
				label: "Docs",
				examples: "markdown, text",
				count: totalFiles,
				percentage: 100,
				color: "#b9aa8f",
			},
		],
	};
}
