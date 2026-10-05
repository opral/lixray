import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePublicProfileActivityFromCounts } from "./profile-activity-aggregate.ts";

void test("aggregates exact file counts into the profile file mix", () => {
	const activity = aggregatePublicProfileActivityFromCounts([
		{
			repository: {
				id: "lix-a",
				name: "Launch",
				slug: "launch",
				namespaceHandle: "samuel",
			},
			totalFiles: 5,
			categoryCounts: [1, 1, 1, 1, 1],
		},
	]);

	assert.equal(activity.totalFiles, 5);
	assert.equal(activity.failedRepositories, 0);
	assert.equal(activity.repositories[0].fileCount, 5);
	assert.deepEqual(
		activity.fileMix.map(({ count, percentage }) => ({ count, percentage })),
		[
			{ count: 1, percentage: 20 },
			{ count: 1, percentage: 20 },
			{ count: 1, percentage: 20 },
			{ count: 1, percentage: 20 },
			{ count: 1, percentage: 20 },
		],
	);
});

void test("keeps repositories visible when one file query fails", () => {
	const activity = aggregatePublicProfileActivityFromCounts([
		{
			repository: {
				id: "lix-a",
				name: "Available",
				slug: "available",
				namespaceHandle: "samuel",
			},
			totalFiles: 3,
			categoryCounts: [2, 0, 0, 1, 0],
		},
		{
			repository: {
				id: "lix-b",
				name: "Recovering",
				slug: "recovering",
				namespaceHandle: "samuel",
			},
			totalFiles: null,
			categoryCounts: null,
		},
	]);

	assert.equal(activity.totalFiles, 3);
	assert.equal(activity.failedRepositories, 1);
	assert.equal(activity.repositories.length, 2);
	assert.equal(activity.repositories[1].fileCount, null);
	assert.equal(
		activity.fileMix.reduce((sum, segment) => sum + segment.percentage, 0),
		100,
	);
});

void test("invalid or inconsistent counts leave the repository unavailable", () => {
	const repository = {
		id: "invalid",
		name: "Invalid",
		slug: "invalid",
		namespaceHandle: "test",
	};
	for (const categoryCounts of [
		[1, 0, 0, 0, 0],
		[2, -1, 0, 0, 1],
		[Number.MAX_SAFE_INTEGER + 1, 0, 0, 0, 0],
	]) {
		const activity = aggregatePublicProfileActivityFromCounts([
			{ repository, totalFiles: 2, categoryCounts },
		]);
		assert.equal(activity.totalFiles, 0);
		assert.equal(activity.failedRepositories, 1);
		assert.equal(activity.repositories[0].fileCount, null);
	}
});

void test("cross-repository overflow never rounds a published file count", () => {
	const inputs = [Number.MAX_SAFE_INTEGER, 1].map((totalFiles, index) => ({
		repository: {
			id: `repo-${index}`,
			name: `Repo ${index}`,
			slug: `repo-${index}`,
			namespaceHandle: "test",
		},
		totalFiles,
		categoryCounts: [totalFiles, 0, 0, 0, 0],
	}));
	const activity = aggregatePublicProfileActivityFromCounts(inputs);
	assert.equal(activity.totalFiles, Number.MAX_SAFE_INTEGER);
	assert.equal(activity.failedRepositories, 1);
	assert.equal(activity.repositories[1].fileCount, null);
});
