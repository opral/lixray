import assert from "node:assert/strict";
import test from "node:test";
import {
	createTransientPublicationRecoveryTracker,
	MAX_PUBLICATION_REPLAY_REQUEST_BYTES,
	MAX_TRACKED_PUBLICATION_FAILURES,
} from "./transient-push-recovery.ts";

const pushUrl = "http://127.0.0.1:8790/lix/v1/repository/sync/push";
const retainedBodiesUrl =
	"http://127.0.0.1:8790/lix/v1/repository/sync/retained-bodies";
const storageFailure = JSON.stringify({
	error: { code: "LIX_STORAGE_IO_UNAVAILABLE" },
});
const payload = new TextEncoder().encode('{"commits":["same"]}');
const response = (status: number, overrides: Record<string, unknown> = {}) => ({
	source: "right",
	replicaId: "replica-a",
	sessionId: "session-a",
	baselineLeaseId: "lease-a",
	method: "POST",
	url: pushUrl,
	status,
	body: payload,
	...overrides,
});

void test("typed storage 503 recovers only after the same push succeeds", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	const failed = tracker.observe(response(503));
	tracker.classify(failed, storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
	tracker.observe(response(200));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 1);
});

void test("typed storage 503 recovers a retained-body wave after its exact replay", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	const failed = tracker.observe(response(503, { url: retainedBodiesUrl }));
	tracker.classify(failed, storageFailure);
	tracker.observe(response(200, { url: retainedBodiesUrl }));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 1);
});

void test("a successful push before the 503 is not recovery", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	tracker.observe(response(200));
	tracker.classify(tracker.observe(response(503)), storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
});

void test("a different payload, page, endpoint, or identity does not recover publication", () => {
	for (const replacement of [
		response(200, { body: new TextEncoder().encode("different") }),
		response(200, { source: "left" }),
		response(200, { replicaId: "replica-b" }),
		response(200, { sessionId: "session-b" }),
		response(200, { url: pushUrl.replace("repository", "other") }),
		response(200, { url: retainedBodiesUrl }),
		response(409),
	]) {
		const tracker = createTransientPublicationRecoveryTracker();
		tracker.classify(tracker.observe(response(503)), storageFailure);
		tracker.observe(replacement);
		assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
	}
});

void test("a renewed or missing read lease does not change publication identity", () => {
	for (const url of [pushUrl, retainedBodiesUrl]) {
		for (const [failedLease, successfulLease] of [
			["lease-a", "lease-b"],
			["lease-a", null],
			[null, "lease-b"],
		] as const) {
			const tracker = createTransientPublicationRecoveryTracker();
			const failed = tracker.observe(
				response(503, { url, baselineLeaseId: failedLease }),
			);
			tracker.classify(failed, storageFailure);
			const successful = tracker.observe(
				response(200, { url, baselineLeaseId: successfulLease }),
			);
			assert.equal(failed.baselineLeaseId, failedLease);
			assert.equal(successful.baselineLeaseId, successfulLease);
			assert.deepEqual(tracker.failures(), []);
			const [recovered] = tracker.recovered();
			assert.equal(recovered?.baselineLeasePresent, failedLease !== null);
			assert.equal(
				recovered?.baselineLeaseChanged,
				failedLease !== successfulLease,
			);
			assert.equal(
				recovered?.successBaselineLeasePresent,
				successfulLease !== null,
			);
			assert.equal(recovered?.successSequence, 2);
			assert.equal(Object.hasOwn(recovered ?? {}, "baselineLeaseId"), false);
		}
	}
});

void test("a missing optional baseline lease does not prevent exact publication recovery", () => {
	for (const url of [pushUrl, retainedBodiesUrl]) {
		const tracker = createTransientPublicationRecoveryTracker();
		const failed = tracker.observe(
			response(503, { url, baselineLeaseId: null }),
		);
		tracker.classify(failed, storageFailure);
		tracker.observe(response(200, { url, baselineLeaseId: null }));
		assert.deepEqual(tracker.failures(), []);
		assert.equal(tracker.recovered().length, 1);
		assert.equal(tracker.recovered()[0]?.baselineLeasePresent, false);
		assert.equal(tracker.recovered()[0]?.baselineLeaseChanged, false);
		assert.equal(tracker.recovered()[0]?.successBaselineLeasePresent, false);
	}
});

void test("untyped, unreadable, and unretried storage failures remain fatal", () => {
	for (const body of [
		"",
		"not json",
		JSON.stringify({ error: { code: "LIX_STORAGE_CORRUPTION" } }),
	]) {
		const tracker = createTransientPublicationRecoveryTracker();
		tracker.classify(tracker.observe(response(503)), body);
		tracker.observe(response(200));
		assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
	}
	const tracker = createTransientPublicationRecoveryTracker();
	tracker.classify(tracker.observe(response(503)), storageFailure);
	assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
});

void test("a publication without a replica or session identity cannot be declared recovered", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	tracker.classify(
		tracker.observe(response(503, { replicaId: null })),
		storageFailure,
	);
	tracker.observe(response(200, { replicaId: null }));
	assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`]);
	tracker.classify(
		tracker.observe(response(503, { sessionId: null })),
		storageFailure,
	);
	tracker.observe(response(200, { sessionId: null }));
	assert.deepEqual(tracker.failures(), [`503 ${pushUrl}`, `503 ${pushUrl}`]);
});

void test("a delayed body classification still sees an earlier observed replay", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	const failed = tracker.observe(response(503));
	tracker.observe(response(200));
	tracker.classify(failed, storageFailure);
	assert.deepEqual(tracker.failures(), []);
});

void test("one successful replay resolves repeated failures of the same operation", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	tracker.classify(tracker.observe(response(503)), storageFailure);
	tracker.classify(tracker.observe(response(503)), storageFailure);
	tracker.observe(response(200));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 2);
});

void test("oversized request bodies cannot be retained for replay classification", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	const oversizedBody = {
		byteLength: MAX_PUBLICATION_REPLAY_REQUEST_BYTES + 1,
	} as unknown as Uint8Array;
	const failed = tracker.observe(response(503, { body: oversizedBody }));
	tracker.classify(failed, storageFailure);
	tracker.observe(response(200, { body: oversizedBody }));
	assert.deepEqual(tracker.recovered(), []);
	assert.match(tracker.failures()[0]!, /exceeded exact-replay tracking bounds/);
});

void test("publication failure tracking has a finite pending-operation bound", () => {
	const tracker = createTransientPublicationRecoveryTracker();
	for (
		let index = 0;
		index < MAX_TRACKED_PUBLICATION_FAILURES + 1;
		index += 1
	) {
		tracker.classify(tracker.observe(response(503)), storageFailure);
	}
	tracker.observe(response(200));
	assert.equal(tracker.recovered().length, MAX_TRACKED_PUBLICATION_FAILURES);
	assert.deepEqual(tracker.failures(), [
		"1 additional 503 publication response(s) exceeded exact-replay tracking bounds",
	]);
});

void test("typed merge storage 503 recovers only after the exact body and lease replay", () => {
	const url = pushUrl.replace("/push", "/merge");
	const tracker = createTransientPublicationRecoveryTracker();
	tracker.classify(tracker.observe(response(503, { url })), storageFailure);
	for (const replacement of [
		response(200, { url, body: new TextEncoder().encode("different") }),
		response(200, { url, source: "left" }),
		response(200, { url, sessionId: "session-b" }),
		response(200, { url, replicaId: "replica-b" }),
		response(200, { url, baselineLeaseId: "lease-b" }),
		response(200, { url, baselineLeaseId: null }),
	]) {
		tracker.observe(replacement);
		assert.deepEqual(tracker.failures(), [`503 ${url}`]);
	}
	tracker.observe(response(200, { url }));
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered().length, 1);
});
