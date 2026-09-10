import assert from "node:assert/strict";
import test from "node:test";
import { createShellNavigationQueue } from "./shell-navigation-queue.ts";
void test("newest activation waits for an earlier shell commit before capturing its path", async () => {
	const queue = createShellNavigationQueue();
	let path = "/a";
	let release!: () => void;
	const commit = queue.navigate(
		"/b",
		() =>
			new Promise<void>((resolve) => {
				release = () => {
					path = "/b";
					resolve();
				};
			}),
	);
	const latest = queue.settle(() => path);
	await Promise.resolve();
	release();
	assert.equal(await latest, "/b");
	await commit;
});
void test("an external navigation while waiting cancels the activation", async () => {
	const queue = createShellNavigationQueue();
	let path = "/a";
	let release!: () => void;
	const commit = queue.navigate(
		"/b",
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const latest = queue.settle(() => path);
	await Promise.resolve();
	path = "/external";
	release();
	assert.equal(await latest, null);
	await commit;
});
