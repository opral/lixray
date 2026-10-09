import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveredNetworkChangeTracker } from "./recovered-network-change-tracker.ts";

const request = (url: string) => ({ url: () => url });

void test("recovers an exact online network-change console error after a completed reload", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const failed = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(failed);
	tracker.failed(failed);
	const failureId = tracker.console(failed.url());
	assert.notEqual(failureId, null);

	const reload = request(failed.url());
	tracker.started(reload);
	assert.equal(tracker.completedReload(reload), failureId);
	assert.equal(tracker.recovered(failureId!), true);
});

void test("does not recover a network-change console error without a matching completed reload", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const failed = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(failed);
	tracker.failed(failed);
	const failureId = tracker.console(failed.url());
	assert.notEqual(failureId, null);
	assert.equal(tracker.recovered(failureId!), false);
});

void test("does not correlate a different console URL or reload URL", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const failed = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(failed);
	tracker.failed(failed);
	assert.equal(tracker.console("http://127.0.0.1:18873/assets/other.js"), null);

	const otherReload = request("http://127.0.0.1:18873/assets/other.js");
	tracker.started(otherReload);
	assert.equal(tracker.completedReload(otherReload), null);

	const failureId = tracker.console(failed.url());
	assert.notEqual(failureId, null);
	assert.equal(tracker.recovered(failureId!), false);
});

void test("does not let an in-flight request started before the failure excuse it", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const inFlight = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(inFlight);

	const failed = request(inFlight.url());
	tracker.started(failed);
	tracker.failed(failed);
	const failureId = tracker.console(failed.url());
	assert.notEqual(failureId, null);

	assert.equal(tracker.completedReload(inFlight), null);
	assert.equal(tracker.recovered(failureId!), false);
});

void test("does not let a retry started before the console failure count as recovery", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const failed = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(failed);
	tracker.failed(failed);
	const earlyReload = request(failed.url());
	tracker.started(earlyReload);
	const failureId = tracker.console(failed.url());
	assert.notEqual(failureId, null);

	assert.equal(tracker.completedReload(earlyReload), null);
	assert.equal(tracker.recovered(failureId!), false);
});

void test("one same-URL reload recovers only one failed request", () => {
	const tracker = createRecoveredNetworkChangeTracker();
	const firstFailure = request("http://127.0.0.1:18873/assets/chunk.js");
	tracker.started(firstFailure);
	tracker.failed(firstFailure);
	const firstFailureId = tracker.console(firstFailure.url());
	assert.notEqual(firstFailureId, null);

	const secondFailure = request(firstFailure.url());
	tracker.started(secondFailure);
	tracker.failed(secondFailure);
	const secondFailureId = tracker.console(secondFailure.url());
	assert.notEqual(secondFailureId, null);

	const firstReload = request(firstFailure.url());
	tracker.started(firstReload);
	assert.equal(tracker.completedReload(firstReload), firstFailureId);
	assert.equal(tracker.recovered(firstFailureId!), true);
	assert.equal(tracker.recovered(secondFailureId!), false);
});

void test("trackers do not correlate identical URLs across pages", () => {
	const left = createRecoveredNetworkChangeTracker();
	const right = createRecoveredNetworkChangeTracker();
	const failed = request("http://127.0.0.1:18873/assets/chunk.js");
	left.started(failed);
	left.failed(failed);
	const failureId = left.console(failed.url());
	assert.notEqual(failureId, null);

	const rightReload = request(failed.url());
	right.started(rightReload);
	assert.equal(right.completedReload(rightReload), null);
	assert.equal(left.recovered(failureId!), false);
});
