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

void test("terminates live repository resources during a real page unload", async () => {
	let closeCount = 0;
	let terminateCount = 0;
	const lease = await acquireManagedRepositoryResource(
		"repository-page-unload",
		async () => ({
			terminateForPageUnload() {
				terminateCount += 1;
			},
			async close() {
				closeCount += 1;
			},
		}),
	);

	closeManagedRepositoryResourcesForPageUnload();
	assert.equal(terminateCount, 1);
	assert.equal(closeCount, 0);
	lease.release();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(terminateCount, 1);
	assert.equal(closeCount, 0);
});
