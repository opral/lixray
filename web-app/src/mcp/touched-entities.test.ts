import assert from "node:assert/strict";
import test from "node:test";
import {
	deletedFileNames,
	describeTouched,
	directoryPaths,
	directoryPathsSql,
	mcpOriginKey,
	mimeTypeForPath,
	touchedFromChanges,
} from "./touched-entities.ts";

const text = (value: string) => ({ kind: "text" as const, value });
const json = (value: unknown) => ({ kind: "json" as const, value });
const nul = { kind: "null" as const };
const COLUMNS = ["schema_key", "file_id", "row_pk", "snapshot", "file_path"];

void test("every call gets its own origin key; a supplied one becomes its prefix", () => {
	assert.equal(mcpOriginKey("req-1"), "mcp:req-1");
	assert.equal(mcpOriginKey("req-1", "codex"), "codex:mcp:req-1");
});

void test("a descriptor change is a write, content alone is an update, a null descriptor is a delete", () => {
	const touched = touchedFromChanges({
		columns: COLUMNS,
		rows: [
			// created: descriptor + blob
			[
				text("lix_file_descriptor"),
				text("f1"),
				json(["f1"]),
				text('{"name":"a.md"}'),
				text("/docs/a.md"),
			],
			[
				text("lix_binary_blob_ref"),
				text("f1"),
				json(["f1"]),
				text('{"blob_hash":"x"}'),
				text("/docs/a.md"),
			],
			// updated: blob only
			[
				text("lix_binary_blob_ref"),
				text("f2"),
				json(["f2"]),
				text('{"blob_hash":"y"}'),
				text("/leads.csv"),
			],
			// plugin entity change counts as an update of its file
			[
				text("csv_cell"),
				text("f3"),
				json(["f3", "r1", "c1"]),
				text('{"v":"1"}'),
				text("/data.csv"),
			],
			// deleted: descriptor null, file gone
			[text("lix_file_descriptor"), text("f4"), json(["f4"]), nul, nul],
			[text("lix_binary_blob_ref"), text("f4"), json(["f4"]), nul, nul],
			// directory created, directory deleted
			[
				text("lix_directory_descriptor"),
				nul,
				json(["d1"]),
				text('{"id":"d1","name":"sales"}'),
				nul,
			],
			[text("lix_directory_descriptor"), nul, json(["d2"]), nul, nul],
		],
	});
	assert.deepEqual(touched.files, [
		{ kind: "file", path: "/docs/a.md", action: "wrote" },
		{ kind: "file", path: "/leads.csv", action: "updated" },
		{ kind: "file", path: "/data.csv", action: "updated" },
	]);
	assert.deepEqual(touched.deletedFileIds, ["f4"]);
	assert.deepEqual(touched.directoryIds, ["d1"]);
	assert.equal(touched.deletedDirectoryCount, 1);
});

void test("row_pk and snapshots arrive as json or text alike", () => {
	const touched = touchedFromChanges({
		columns: COLUMNS,
		rows: [
			[
				text("lix_directory_descriptor"),
				nul,
				text('["d9"]'),
				json({ id: "d9", name: "x" }),
				nul,
			],
		],
	});
	assert.deepEqual(touched.directoryIds, ["d9"]);
});

void test("follow-up reads resolve deleted file names and directory paths", () => {
	assert.deepEqual(
		[
			...deletedFileNames({
				columns: ["file_id", "snapshot"],
				rows: [
					[text("f4"), text('{"name":"gone.md"}')],
					[text("f4"), text('{"name":"older-name.md"}')],
				],
			}),
		],
		[["f4", "gone.md"]],
	);
	assert.equal(
		directoryPathsSql(2),
		"SELECT id, path FROM lix_directory WHERE id IN ($1, $2)",
	);
	assert.deepEqual(
		[
			...directoryPaths({
				columns: ["id", "path"],
				rows: [[text("d1"), text("/sales")]],
			}),
		],
		[["d1", "/sales"]],
	);
});

void test("describes the batch by action, then rows", () => {
	assert.equal(
		describeTouched(
			[
				{ kind: "file", path: "/sales/lead-research.md", action: "wrote" },
				{ kind: "file", path: "/gtm/leads.csv", action: "updated" },
				{ kind: "file", path: "gone.md", action: "deleted" },
				{ kind: "directory", path: "/sales", action: "wrote" },
			],
			7,
			1,
		),
		"Wrote sales/lead-research.md, sales · Updated gtm/leads.csv · Deleted gone.md · Deleted 1 folder · 7 rows affected",
	);
	assert.equal(describeTouched([], 1), "1 row affected");
	assert.equal(mimeTypeForPath("/x/notes.MD"), "text/markdown");
	assert.equal(mimeTypeForPath("/x/Makefile"), undefined);
});
