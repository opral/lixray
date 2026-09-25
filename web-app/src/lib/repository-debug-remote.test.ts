import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import { createRepositoryDebugRemote } from "./repository-debug-remote.ts";

void test("a failed remote open does not poison later snapshot downloads", async () => {
	let attempts = 0;
	let branchCalls = 0;
	const remote = {
		activeBranchId: async () => {
			branchCalls += 1;
			return "main";
		},
		exportSnapshot: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			}),
		close: async () => undefined,
	} as unknown as Lix;
	const session = createRepositoryDebugRemote(
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary 404");
			return remote;
		},
		() => "main",
	);
	await assert.rejects(session.selectedBranch(), /temporary 404/);
	const snapshot = await session.snapshot();
	assert.deepEqual(
		new Uint8Array(await snapshot.arrayBuffer()),
		new Uint8Array([1, 2, 3]),
	);
	assert.equal(attempts, 2);
	assert.equal(branchCalls, 0);
	await session.close();
});

void test("snapshot export failure closes the handle and retries on next download", async () => {
	let opens = 0;
	let closes = 0;
	const session = createRepositoryDebugRemote(
		async () => {
			opens += 1;
			const attempt = opens;
			return {
				exportSnapshot: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							if (attempt === 1) controller.error(new Error("temporary 404"));
							else {
								controller.enqueue(new Uint8Array([4]));
								controller.close();
							}
						},
					}),
				close: async () => {
					closes += 1;
				},
			} as unknown as Lix;
		},
		() => "main",
	);
	await assert.rejects(session.snapshot(), /temporary 404/);
	assert.deepEqual(
		new Uint8Array(await (await session.snapshot()).arrayBuffer()),
		new Uint8Array([4]),
	);
	assert.equal(opens, 2);
	await session.close();
	assert.equal(closes, 2);
});

void test("a branch-switch failure cannot block repository-wide snapshot export", async () => {
	let opens = 0;
	let switches = 0;
	const session = createRepositoryDebugRemote(
		async () => {
			opens += 1;
			return {
				activeBranchId: async () => "other",
				switchBranch: async () => {
					switches += 1;
					throw new Error("branch switch failed");
				},
				exportSnapshot: () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([9]));
							controller.close();
						},
					}),
				close: async () => undefined,
			} as unknown as Lix;
		},
		() => "main",
	);
	await assert.rejects(session.selectedBranch(), /branch switch failed/);
	assert.equal(switches, 1);
	assert.deepEqual(
		new Uint8Array(await (await session.snapshot()).arrayBuffer()),
		new Uint8Array([9]),
	);
	assert.equal(opens, 2);
	assert.equal(switches, 1);
	await session.close();
});
