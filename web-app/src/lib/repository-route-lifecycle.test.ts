import assert from "node:assert/strict";
import test from "node:test";
import {
	createRepositoryRouteLifecycle,
	readRepositoryRoute,
} from "./repository-route-lifecycle.ts";

void test("user navigation cancels a held initial entity lookup before it can reopen the file", async () => {
	const lifecycle = createRepositoryRouteLifecycle();
	const route = lifecycle.begin();
	let release!: (path: string) => void;
	let visibleView = "restored-file";
	const pending = readRepositoryRoute(
		route.signal,
		() =>
			new Promise<string>((resolve) => {
				release = resolve;
			}),
	).then((path) => {
		visibleView = path;
	});
	const rejected = assert.rejects(pending, { name: "AbortError" });
	assert.equal(visibleView, "restored-file");
	lifecycle.cancel();
	visibleView = "home";
	release("requested-file");
	await rejected;
	assert.equal(visibleView, "home");
});

void test("an incoming deep link still applies when no user navigation supersedes it", async () => {
	const lifecycle = createRepositoryRouteLifecycle();
	const route = lifecycle.begin();
	assert.equal(
		await readRepositoryRoute(route.signal, async () => "requested-file"),
		"requested-file",
	);
	assert.equal(route.signal.aborted, false);
	route.abort();
});

void test("user navigation aborts commands that already passed entity lookup", async () => {
	const lifecycle = createRepositoryRouteLifecycle();
	const route = lifecycle.begin();
	await readRepositoryRoute(route.signal, async () => "requested-file");
	const pending = new Promise<void>((_, reject) =>
		route.signal.addEventListener(
			"abort",
			() => reject(route.signal.reason as Error),
			{
				once: true,
			},
		),
	);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	lifecycle.cancel();
	await rejected;
	// A later browser navigation receives a fresh signal, not the canceled one.
	assert.equal(lifecycle.begin().signal.aborted, false);
});
