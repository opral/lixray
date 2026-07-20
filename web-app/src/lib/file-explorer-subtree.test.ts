import assert from "node:assert/strict";
import test from "node:test";
import {
	parseSubtreeListBatchResults,
	parseSubtreeListResults,
	subtreeListStatements,
} from "./file-explorer-subtree.ts";

void test("subtree listing uses two path-range statements in one batch", () => {
	const statements = subtreeListStatements("/assets/");
	assert.deepEqual(statements, [
		{
			sql: "SELECT path FROM lix_directory WHERE path >= $1 AND path < $2 ORDER BY path",
			params: [
				{ kind: "text", value: "/assets/" },
				{ kind: "text", value: "/assets0" },
			],
		},
		{
			sql: "SELECT id, path FROM lix_file WHERE path >= $1 AND path < $2 ORDER BY path",
			params: [
				{ kind: "text", value: "/assets/" },
				{ kind: "text", value: "/assets0" },
			],
		},
	]);
});

void test("subtree listing parses the two ordered result sets", () => {
	assert.deepEqual(
		parseSubtreeListResults([
			{
				columns: ["path"],
				rows: [
					[{ kind: "text", value: "/assets/icons/" }],
					[{ kind: "text", value: "/assets/images/" }],
				],
				rowsAffected: 0,
				notices: [],
			},
			{
				columns: ["id", "path"],
				rows: [
					[
						{ kind: "text", value: "file-logo" },
						{ kind: "text", value: "/assets/logo.svg" },
					],
				],
				rowsAffected: 0,
				notices: [],
			},
		]),
		{
			directoryPaths: ["/assets/icons/", "/assets/images/"],
			files: [{ id: "file-logo", path: "/assets/logo.svg" }],
		},
	);
});

void test("subtree listing rejects an incomplete batch response", () => {
	assert.throws(() => parseSubtreeListResults([]), {
		message: "Subtree listing did not return both result sets.",
	});
});

void test("subtree listing groups multiple directories from one batch", () => {
	const results = [
		{
			columns: ["path"],
			rows: [[{ kind: "text" as const, value: "/assets/icons/" }]],
			rowsAffected: 0,
			notices: [],
		},
		{
			columns: ["id", "path"],
			rows: [],
			rowsAffected: 0,
			notices: [],
		},
		{
			columns: ["path"],
			rows: [],
			rowsAffected: 0,
			notices: [],
		},
		{
			columns: ["id", "path"],
			rows: [
				[
					{ kind: "text" as const, value: "file-doc" },
					{ kind: "text" as const, value: "/docs/readme.md" },
				],
			],
			rowsAffected: 0,
			notices: [],
		},
	];
	assert.deepEqual(parseSubtreeListBatchResults(results, 2), [
		{
			directoryPaths: ["/assets/icons/"],
			files: [],
		},
		{
			directoryPaths: [],
			files: [{ id: "file-doc", path: "/docs/readme.md" }],
		},
	]);
});

void test("subtree listing rejects a partial multi-directory batch", () => {
	assert.throws(() => parseSubtreeListBatchResults([], 1), {
		message: "Subtree listing did not return every result set.",
	});
});
