import assert from "node:assert/strict";
import test from "node:test";
import {
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
