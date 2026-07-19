import assert from "node:assert/strict";
import test from "node:test";
import { fetchZipEntriesInBatches } from "./file-download-batches.ts";

void test("ZIP reads use bounded unique path batches and preserve entry order", async () => {
	const calls: Array<Array<string>> = [];
	const bytesByPath = new Map([
		["/a.txt", new Uint8Array([1])],
		["/b.txt", new Uint8Array([2])],
		["/c.txt", new Uint8Array([3])],
	]);

	const entries = await fetchZipEntriesInBatches(
		[
			{ path: "/a.txt", zipPath: "a.txt" },
			{ path: "/b.txt", zipPath: "b.txt" },
			{ path: "/a.txt", zipPath: "copied/a.txt" },
			{ path: "/c.txt", zipPath: "c.txt" },
		],
		async (paths) => {
			calls.push(paths);
			return new Map(
				paths.map((path) => [path, bytesByPath.get(path) ?? new Uint8Array()]),
			);
		},
		2,
	);

	assert.deepEqual(calls, [["/a.txt", "/b.txt"], ["/c.txt"]]);
	assert.deepEqual(Object.keys(entries), [
		"a.txt",
		"b.txt",
		"copied/a.txt",
		"c.txt",
	]);
	assert.deepEqual(entries["copied/a.txt"], new Uint8Array([1]));
});

void test("ZIP reads retain the existing missing-file error", async () => {
	await assert.rejects(
		fetchZipEntriesInBatches(
			[{ path: "/missing.txt", zipPath: "missing.txt" }],
			async () => new Map(),
		),
		{ message: "File data not found." },
	);
});
