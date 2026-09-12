import assert from "node:assert/strict";
import test from "node:test";
import {
	createShellNavigationQueue,
	createShellRouteHydrationGuard,
} from "./shell-navigation-queue.ts";
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

void test("replayed shell directory effect cannot hydrate an older folder over a newer click", async () => {
	const guard = createShellRouteHydrationGuard();
	const owner = {};
	let marker: string | null = "target";
	let activeFolder = "target/child";
	let lookups = 0;
	const effect = async () => {
		if (
			guard.isShellIssued(owner, "target:main", () => {
				const matches = marker === "target";
				marker = null;
				return matches;
			})
		)
			return;
		lookups += 1;
		await Promise.resolve();
		activeFolder = "target";
	};
	await effect();
	await effect(); // StrictMode setup/cleanup/setup, or changed callback dependency.
	assert.equal(lookups, 0);
	assert.equal(activeFolder, "target/child");
});

void test("shell hydration guard preserves external routes, branch changes and new instances", () => {
	const guard = createShellRouteHydrationGuard();
	const owner = {};
	assert.equal(
		guard.isShellIssued(owner, "target:main", () => true),
		true,
	);
	assert.equal(
		guard.isShellIssued(owner, "other:main", () => false),
		false,
	);
	assert.equal(
		guard.isShellIssued(owner, "target:main", () => false),
		false,
	);
	assert.equal(
		guard.isShellIssued(owner, "target:main", () => true),
		true,
	);
	assert.equal(
		guard.isShellIssued(owner, "target:other", () => false),
		false,
	);
	assert.equal(
		guard.isShellIssued(owner, "target:other", () => true),
		true,
	);
	assert.equal(
		guard.isShellIssued({}, "target:other", () => false),
		false,
	);
});

void test("same entity in a new history visit is hydrated rather than consuming an old marker", () => {
	const guard = createShellRouteHydrationGuard();
	const owner = {};
	assert.equal(
		guard.isShellIssued(owner, "entry-1:directory:A", () => true),
		true,
	);
	assert.equal(
		guard.isShellIssued(owner, "entry-1:directory:A", () => false),
		true,
	);
	assert.equal(
		guard.isShellIssued(owner, "entry-2:directory:A", () => false),
		false,
	);
	assert.equal(
		guard.isShellIssued(owner, "entry-1:directory:A", () => false),
		false,
	);
});

void test("leaving a shell route without a consumer clears its decision before browser Back", () => {
	const guard = createShellRouteHydrationGuard();
	const owner = {};
	assert.equal(
		guard.isShellIssued(owner, "entry-A", () => true),
		true,
	);
	// The location layout effect runs even when the next route cannot hydrate.
	guard.reset();
	// No consumer runs on B. Returning to A must apply the external URL.
	guard.reset();
	assert.equal(
		guard.isShellIssued(owner, "entry-A", () => false),
		false,
	);
});
