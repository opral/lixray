import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import type { Lix } from "@lix-js/sdk";
import { buildRepositoryReproduction } from "./repository-reproduction.ts";

void test("builds the reproduction archive with snapshot branch and time context", async () => {
	const localSnapshot = new Uint8Array([1, 2, 3]);
	const remoteSnapshot = new Uint8Array([4, 5, 6]);
	const archive = await buildRepositoryReproduction({
		localLix: {
			exportSnapshot: () => streamBytes(localSnapshot),
		} as Lix,
		remoteSnapshot: async () => new Blob([remoteSnapshot]),
		selectedBranchIdAtSnapshotStart: "selected-branch",
		query: "SELECT 1",
		diffCsv: '"kind"\n"row"\n',
	});
	const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));

	assert.deepEqual(Object.keys(entries).sort(), [
		"context.json",
		"diff.csv",
		"local.lixsnap",
		"query.sql",
		"remote.lixsnap",
	]);
	const context = JSON.parse(strFromU8(entries["context.json"]!)) as {
		selectedBranchIdAtSnapshotStart: string;
		comparisonBranchId: null;
		comparisonCapturedAt: null;
		snapshotCaptureStartedAt: string;
		snapshotCaptureCompletedAt: string;
	};
	assert.equal(context.selectedBranchIdAtSnapshotStart, "selected-branch");
	assert.equal(context.comparisonBranchId, null);
	assert.equal(context.comparisonCapturedAt, null);
	assert.ok(Number.isFinite(Date.parse(context.snapshotCaptureStartedAt)));
	assert.ok(
		Date.parse(context.snapshotCaptureCompletedAt) >=
			Date.parse(context.snapshotCaptureStartedAt),
	);
	assert.equal(strFromU8(entries["query.sql"]!), "SELECT 1\n");
	assert.deepEqual(entries["local.lixsnap"], localSnapshot);
	assert.deepEqual(entries["remote.lixsnap"], remoteSnapshot);
});

void test("retains local evidence when the remote snapshot fetch fails", async () => {
	const archive = await buildRepositoryReproduction({
		localLix: { exportSnapshot: () => streamBytes(new Uint8Array([1])) } as Lix,
		remoteSnapshot: async () => {
			throw new TypeError("Failed to fetch");
		},
		query: "SELECT * FROM lix_file",
		diffCsv: "local,remote\n1,2\n",
	});
	const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
	assert.deepEqual(entries["local.lixsnap"], new Uint8Array([1]));
	assert.equal(entries["remote.lixsnap"], undefined);
	assert.equal(strFromU8(entries["query.sql"]!), "SELECT * FROM lix_file\n");
	assert.equal(strFromU8(entries["diff.csv"]!), "local,remote\n1,2\n");
	assert.deepEqual(JSON.parse(strFromU8(entries["export-errors.json"]!)), {
		remote: "Failed to fetch",
	});
});

void test("retains remote evidence when the local export stream fails", async () => {
	const archive = await buildRepositoryReproduction({
		localLix: {
			exportSnapshot: () =>
				new ReadableStream({
					start(controller) {
						controller.error(new Error("local export failed"));
					},
				}),
		} as Lix,
		remoteSnapshot: async () => new Blob([new Uint8Array([2])]),
		query: "SELECT 1",
		diffCsv: "diff",
	});
	const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
	assert.deepEqual(entries["remote.lixsnap"], new Uint8Array([2]));
	assert.equal(entries["local.lixsnap"], undefined);
	assert.deepEqual(JSON.parse(strFromU8(entries["export-errors.json"]!)), {
		local: "local export failed",
	});
});

void test("retains the query and diff when both exports fail synchronously", async () => {
	const archive = await buildRepositoryReproduction({
		localLix: {
			exportSnapshot: () => {
				throw new Error("local closed");
			},
		} as unknown as Lix,
		remoteSnapshot: () => {
			throw new Error("remote closed");
		},
		query: " SELECT 1 ",
		diffCsv: "diff",
	});
	const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
	assert.equal(strFromU8(entries["query.sql"]!), "SELECT 1\n");
	assert.equal(strFromU8(entries["diff.csv"]!), "diff");
	assert.deepEqual(JSON.parse(strFromU8(entries["export-errors.json"]!)), {
		local: "local closed",
		remote: "remote closed",
	});
});

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
