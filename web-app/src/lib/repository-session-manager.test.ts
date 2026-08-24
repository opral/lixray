import assert from "node:assert/strict";
import test from "node:test";
import {
	acquireManagedRepositoryResource,
	closeManagedRepositoryResourcesForPageUnload,
} from "./repository-session-manager.ts";

void test("reuses a repository resource while Strict Mode remounts", async () => {
	let openCount = 0;
	let closeCount = 0;
	const open = async () => {
		openCount += 1;
		return {
			async close() {
				closeCount += 1;
			},
		};
	};

	const first = await acquireManagedRepositoryResource("repository-1", open);
	first.release();
	const second = await acquireManagedRepositoryResource("repository-1", open);

	assert.equal(second.resource, first.resource);
	assert.equal(openCount, 1);
	assert.equal(closeCount, 0);

	second.release();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(closeCount, 1);
});

void test("starts one close lifecycle during a real page unload", async () => {
	let closeCount = 0;
	let finishClose!: () => void;
	const lease = await acquireManagedRepositoryResource(
		"repository-page-unload",
		async () => ({
			async close() {
				closeCount += 1;
				await new Promise<void>((resolve) => {
					finishClose = resolve;
				});
			},
		}),
	);

	closeManagedRepositoryResourcesForPageUnload();
	assert.equal(closeCount, 1);
	lease.release();
	closeManagedRepositoryResourcesForPageUnload();
	assert.equal(closeCount, 1);
	finishClose();
	await new Promise((resolve) => setTimeout(resolve, 0));
});

void test("aborts a pending open only after its last waiter leaves", async () => {
	const firstController = new AbortController();
	const secondController = new AbortController();
	let sharedSignal: AbortSignal | undefined;
	const open = async (signal: AbortSignal) => {
		sharedSignal = signal;
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(abortError(signal)), {
				once: true,
			});
		});
		throw new Error("unreachable");
	};

	const first = acquireManagedRepositoryResource("repository-pending", open, {
		signal: firstController.signal,
	});
	const second = acquireManagedRepositoryResource("repository-pending", open, {
		signal: secondController.signal,
	});
	firstController.abort();
	await assert.rejects(first, { name: "AbortError" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sharedSignal?.aborted, false);

	secondController.abort();
	await assert.rejects(second, { name: "AbortError" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sharedSignal?.aborted, true);
});

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted.", "AbortError");
}
