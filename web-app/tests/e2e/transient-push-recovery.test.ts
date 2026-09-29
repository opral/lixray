import assert from "node:assert/strict";
import test from "node:test";
import { createTransientPushRecoveryTracker } from "./transient-push-recovery.ts";

const url = "http://127.0.0.1:8790/lix/v1/repository/sync/push";
const storageFailure = JSON.stringify({
	error: { code: "LIX_STORAGE_IO_UNAVAILABLE" },
});
const payload = new TextEncoder().encode('{"commits":["same"]}');
const response = (status: number, overrides: Record<string, unknown> = {}) => ({
	source: "right",
	replicaId: "replica-a",
	method: "POST",
	url,
	status,
	body: payload,
	...overrides,
});

void test("typed storage 503 recovers only after the same push succeeds", () => {
	const tracker = createTransientPushRecoveryTracker();
	const failed = tracker.observe(response(503));
	tracker.classify(failed, storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${url}`]);
	tracker.observe(response(200));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 1);
});

void test("a successful push before the 503 is not recovery", () => {
	const tracker = createTransientPushRecoveryTracker();
	tracker.observe(response(200));
	tracker.classify(tracker.observe(response(503)), storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${url}`]);
});

void test("a different payload, page, endpoint, or status does not recover a push", () => {
	for (const replacement of [
		response(200, { body: new TextEncoder().encode("different") }),
		response(200, { source: "left" }),
		response(200, { replicaId: "replica-b" }),
		response(200, { url: url.replace("repository", "other") }),
		response(409),
	]) {
		const tracker = createTransientPushRecoveryTracker();
		tracker.classify(tracker.observe(response(503)), storageFailure);
		tracker.observe(replacement);
		assert.deepEqual(tracker.failures(), [`503 ${url}`]);
	}
});

void test("untyped, unreadable, and unretried storage failures remain fatal", () => {
	for (const body of [
		"",
		"not json",
		JSON.stringify({ error: { code: "LIX_STORAGE_CORRUPTION" } }),
	]) {
		const tracker = createTransientPushRecoveryTracker();
		tracker.classify(tracker.observe(response(503)), body);
		tracker.observe(response(200));
		assert.deepEqual(tracker.failures(), [`503 ${url}`]);
	}
	const tracker = createTransientPushRecoveryTracker();
	tracker.classify(tracker.observe(response(503)), storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${url}`]);
});

void test("a push without a replica identity cannot be declared recovered", () => {
	const tracker = createTransientPushRecoveryTracker();
	tracker.classify(
		tracker.observe(response(503, { replicaId: null })),
		storageFailure,
	);
	tracker.observe(response(200, { replicaId: null }));
	assert.deepEqual(tracker.failures(), [`503 ${url}`]);
});

void test("a delayed body classification still sees an earlier observed replay", () => {
	const tracker = createTransientPushRecoveryTracker();
	const failed = tracker.observe(response(503));
	tracker.observe(response(200));
	tracker.classify(failed, storageFailure);
	assert.deepEqual(tracker.failures(), []);
});

void test("one successful replay resolves repeated failures of the same operation", () => {
	const tracker = createTransientPushRecoveryTracker();
	tracker.classify(tracker.observe(response(503)), storageFailure);
	tracker.classify(tracker.observe(response(503)), storageFailure);
	tracker.observe(response(200));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 2);
});
