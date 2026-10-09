import assert from "node:assert/strict";
import test from "node:test";
import { createTrackedOfflineContexts } from "./tracked-offline-contexts.ts";

void test("tracks offline before the browser transition and clears after reconnect", async () => {
	const tracker = createTrackedOfflineContexts<object>();
	const context = {};
	let finishOffline!: () => void;
	const turningOffline = tracker.setOffline(
		context,
		true,
		() =>
			new Promise<void>((resolve) => {
				finishOffline = resolve;
			}),
	);
	assert.equal(tracker.has(context), true);
	finishOffline();
	await turningOffline;

	let finishOnline!: () => void;
	const turningOnline = tracker.setOffline(
		context,
		false,
		() =>
			new Promise<void>((resolve) => {
				finishOnline = resolve;
			}),
	);
	assert.equal(tracker.has(context), true);
	finishOnline();
	await turningOnline;
	assert.equal(tracker.has(context), false);
});

void test("keeps the offline guard when returning online fails", async () => {
	const tracker = createTrackedOfflineContexts<object>();
	const context = {};
	await tracker.setOffline(context, true, async () => {});
	await assert.rejects(
		tracker.setOffline(context, false, async () => {
			throw new Error("offline transition failed");
		}),
	);
	assert.equal(tracker.has(context), true);
});
