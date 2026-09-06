import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import type { Lix } from "@lix-js/sdk";
import { buildRepositoryReproduction } from "./repository-reproduction.ts";

void test("builds the four-file reproduction archive", async () => {
	const localSnapshot = new Uint8Array([1, 2, 3]);
	const remoteSnapshot = new Uint8Array([4, 5, 6]);
	const archive = await buildRepositoryReproduction({
		localLix: {
			exportSnapshot: () => streamBytes(localSnapshot),
		} as Lix,
		remoteSnapshot: async () => new Blob([remoteSnapshot]),
		query: "SELECT 1",
		diffCsv: '"kind"\n"row"\n',
	});
	const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));

	assert.deepEqual(Object.keys(entries).sort(), [
		"diff.csv",
		"local.lixsnap",
		"query.sql",
		"remote.lixsnap",
	]);
	assert.equal(strFromU8(entries["query.sql"]!), "SELECT 1\n");
	assert.deepEqual(entries["local.lixsnap"], localSnapshot);
	assert.deepEqual(entries["remote.lixsnap"], remoteSnapshot);
});

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
