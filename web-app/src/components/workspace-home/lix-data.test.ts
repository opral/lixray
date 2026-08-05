import assert from "node:assert/strict";
import test from "node:test";
import { workspaceHasNoFiles } from "./lix-data.ts";

void test("workspaceHasNoFiles reports an empty workspace", async () => {
	const lix = {
		execute: async () => ({ rows: [] }),
	} as never;

	assert.equal(await workspaceHasNoFiles(lix), true);
});

void test("workspaceHasNoFiles preserves SQL failures for boot error UI", async () => {
	const failure = new Error("workspace query failed");
	const lix = {
		execute: async () => {
			throw failure;
		},
	} as never;

	await assert.rejects(
		workspaceHasNoFiles(lix),
		(caught) => caught === failure,
	);
});
