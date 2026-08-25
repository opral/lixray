import assert from "node:assert/strict";
import test from "node:test";
import { createLixPrewarmer } from "./lix-prewarm.ts";

void test("prewarms one in-memory Lix and reuses completed warmups", async () => {
	let opens = 0;
	let closes = 0;
	const { prewarmLix } = createLixPrewarmer(async () => {
		opens += 1;
		return {
			async close() {
				closes += 1;
			},
		};
	});

	const first = prewarmLix();
	const second = prewarmLix();
	assert.equal(first, second);
	await Promise.all([first, second]);
	await prewarmLix();

	assert.equal(opens, 1);
	assert.equal(closes, 1);
});

void test("waits until the prewarmed Lix is closed and its worker is idle", async () => {
	let finishClose!: () => void;
	let closeStarted!: () => void;
	let waitFinished = false;
	const closing = new Promise<void>((resolve) => {
		finishClose = resolve;
	});
	const startedClosing = new Promise<void>((resolve) => {
		closeStarted = resolve;
	});
	const { prewarmLix, waitForLixPrewarm } = createLixPrewarmer(async () => ({
		close: async () => {
			closeStarted();
			await closing;
		},
	}));

	const prewarming = prewarmLix();
	const waiting = waitForLixPrewarm().then(() => {
		waitFinished = true;
	});
	await startedClosing;
	assert.equal(waitFinished, false);

	finishClose();
	await Promise.all([prewarming, waiting]);
	assert.equal(waitFinished, true);
});

void test("does not start a warmup when a repository opens directly", async () => {
	let opens = 0;
	const { waitForLixPrewarm } = createLixPrewarmer(async () => {
		opens += 1;
		return { close: async () => undefined };
	});

	await waitForLixPrewarm();
	assert.equal(opens, 0);
});

void test("lets repository opening continue when prewarming fails", async () => {
	let rejectOpen!: (error: Error) => void;
	const opening = new Promise<{ close: () => Promise<void> }>(
		(_resolve, reject) => {
			rejectOpen = reject;
		},
	);
	const { prewarmLix, waitForLixPrewarm } = createLixPrewarmer(() => opening);
	const prewarming = prewarmLix();
	const waiting = waitForLixPrewarm();

	rejectOpen(new Error("WASM download failed"));
	await assert.rejects(prewarming, /WASM download failed/);
	await assert.doesNotReject(waiting);
});

void test("retries a later warmup after opening the in-memory Lix fails", async () => {
	let opens = 0;
	let closes = 0;
	const { prewarmLix } = createLixPrewarmer(async () => {
		opens += 1;
		if (opens === 1) throw new Error("temporary failure");
		return {
			async close() {
				closes += 1;
			},
		};
	});

	await assert.rejects(prewarmLix(), /temporary failure/);
	await prewarmLix();
	assert.equal(opens, 2);
	assert.equal(closes, 1);
});

void test("retries a later warmup after closing the in-memory Lix fails", async () => {
	let opens = 0;
	let closes = 0;
	const { prewarmLix } = createLixPrewarmer(async () => {
		opens += 1;
		return {
			async close() {
				closes += 1;
				if (closes === 1) throw new Error("temporary close failure");
			},
		};
	});

	await assert.rejects(prewarmLix(), /temporary close failure/);
	await prewarmLix();
	assert.equal(opens, 2);
	assert.equal(closes, 2);
});
