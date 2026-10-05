import assert from "node:assert/strict";
import test from "node:test";
import { openLix } from "@lix-js/sdk";
import { publicProfileActivityAggregateSql } from "./profile-activity-aggregate.ts";

import { aggregatePublicProfileActivity } from "../../tests/fixtures/profile-activity-baseline.ts";

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
