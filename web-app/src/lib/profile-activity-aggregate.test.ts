import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePublicProfileActivity } from "./profile-activity-aggregate.ts";

void test("aggregates real file paths into the profile file mix", () => {
	const activity = aggregatePublicProfileActivity([
		{
			repository: {
				id: "lix-a",
				name: "Launch",
				slug: "launch",
				namespaceHandle: "samuel",
			},
			paths: [
				"/README.md",
				"/src/index.ts",
				"/data/leads.csv",
				"/deck/pitch.pptx",
				"/assets/logo.png",
			],
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
	const activity = aggregatePublicProfileActivity([
		{
			repository: {
				id: "lix-a",
				name: "Available",
				slug: "available",
				namespaceHandle: "samuel",
			},
			paths: ["/README.md", "/notes.txt", "/image.webp"],
		},
		{
			repository: {
				id: "lix-b",
				name: "Recovering",
				slug: "recovering",
				namespaceHandle: "samuel",
			},
			paths: null,
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
