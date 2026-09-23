import assert from "node:assert/strict";
import test from "node:test";
import {
	consumeObservedRowsWithRetry,
	isRetryableObserveError,
} from "./observe-retry.ts";

async function* failedAfterFrame(): AsyncIterableIterator<string> {
	yield "cached";
	throw Object.assign(new Error("HTTP network request failed"), {
		code: "LIX_TRANSPORT_NETWORK",
	});
}

async function* recovered(): AsyncIterableIterator<string> {
	yield "recovered";
}

void test("reopens a failed observation and publishes its recovered frame", async () => {
	const frames: string[] = [];
	const errors: unknown[] = [];
	const retries: number[] = [];
	let opens = 0;
	await consumeObservedRowsWithRetry({
		observe: () => (++opens === 1 ? failedAfterFrame() : recovered()),
		onFrame: (frame) => frames.push(frame),
		onError: (error) => errors.push(error),
		signal: new AbortController().signal,
		wait: async (attempt) => {
			retries.push(attempt);
		},
	});
	assert.equal(opens, 2);
	assert.deepEqual(frames, ["cached", "recovered"]);
	assert.deepEqual(retries, [0]);
	assert.deepEqual(errors, []);
});

void test("retries a network failure delivered after connectivity returns", async () => {
	// Retry depends on the typed error, not navigator.onLine at delivery time.
	assert.equal(
		isRetryableObserveError(
			Object.assign(new Error("HTTP network request failed"), {
				code: "LIX_TRANSPORT_NETWORK",
			}),
		),
		true,
	);
});

void test("surfaces non-network query errors without retrying", async () => {
	const failure = Object.assign(new Error("invalid SQL"), {
		code: "LIX_SQL_ERROR",
	});
	let opens = 0;
	const errors: unknown[] = [];
	await consumeObservedRowsWithRetry({
		observe: () => {
			opens += 1;
			return (async function* () {
				yield await Promise.reject(failure);
			})() as AsyncIterableIterator<string>;
		},
		onFrame: () => assert.fail("unexpected frame"),
		onError: (error) => errors.push(error),
		signal: new AbortController().signal,
		wait: async () => assert.fail("unexpected retry"),
	});
	assert.equal(opens, 1);
	assert.deepEqual(errors, [failure]);
});

void test("retries a synchronous transport failure while opening an observer", async () => {
	let opens = 0;
	const frames: string[] = [];
	await consumeObservedRowsWithRetry({
		observe: () => {
			if (++opens === 1)
				throw Object.assign(new Error("offline"), {
					code: "LIX_TRANSPORT_NETWORK",
				});
			return recovered();
		},
		onFrame: (frame) => frames.push(frame),
		onError: () => assert.fail("transient error surfaced"),
		signal: new AbortController().signal,
		wait: async () => {},
	});
	assert.equal(opens, 2);
	assert.deepEqual(frames, ["recovered"]);
});

void test("aborting during a reconnect wait prevents another observer", async () => {
	const controller = new AbortController();
	let opens = 0;
	await consumeObservedRowsWithRetry({
		observe: () => {
			opens += 1;
			return failedAfterFrame();
		},
		onFrame: () => {},
		onError: () => assert.fail("transient error surfaced"),
		signal: controller.signal,
		wait: async () => controller.abort(),
	});
	assert.equal(opens, 1);
});
