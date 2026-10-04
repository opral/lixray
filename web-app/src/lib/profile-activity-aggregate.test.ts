import assert from "node:assert/strict";
import test from "node:test";
import { openLix } from "@lix-js/sdk";
import {
	aggregatePublicProfileActivityFromCounts,
	publicProfileActivityAggregateSql,
} from "./profile-activity-aggregate.ts";

import { aggregatePublicProfileActivity } from "../../tests/fixtures/profile-activity-baseline.ts";

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

void test("SQL profile aggregation matches JavaScript category semantics", async (t) => {
	const lix = await openLix();
	t.after(() => lix.close());
	const before = await lix.execute(publicProfileActivityAggregateSql());
	const paths = [
		"/bare/md",
		"/bare/csv",
		"/bare/json",
		"/bare/ts",
		"/bare/mdx",
		"/bare/txt",
		"/bare/pptx",
		"/folder.with.dot/README.MD",
		"/.MD",
		"/file.",
		"/archive.tar.GZ",
		"/slides/PITCH.PPTX",
		"/assets/logo.png",
		...Array.from({ length: 192 }, (_, index) => {
			const extension = ["md", "CSV", "json", "Ts", "pptx", "webp", ""][
				index % 7
			]!;
			const name =
				index % 5 === 0
					? extension || `plain-${index}`
					: `file-${index}.${extension}`;
			return `/folder-${index}/${name}`;
		}),
	];
	const values = paths.flatMap((path) => [path, new Uint8Array([1])]);
	const placeholders = paths
		.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
		.join(", ");
	await lix.execute(
		`INSERT INTO lix_file(path, content) VALUES ${placeholders}`,
		values,
	);
	const result = await lix.execute(publicProfileActivityAggregateSql());
	assert.equal(result.rows.length, 1);
	const expected = aggregatePublicProfileActivity([
		{
			repository: {
				id: "lix-a",
				name: "Parity",
				slug: "parity",
				namespaceHandle: "samuel",
			},
			paths,
		},
	]);
	const row = result.rows[0]!;
	assert.equal(
		Number(row.total_files) - Number(before.rows[0]!.total_files),
		expected.totalFiles,
	);
	assert.deepEqual(
		expected.fileMix.map(
			(_, index) =>
				Number(row[`category_${index}`]) -
				Number(before.rows[0]![`category_${index}`]),
		),
		expected.fileMix.map(({ count }) => count),
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
