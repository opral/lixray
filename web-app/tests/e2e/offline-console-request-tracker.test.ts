import assert from "node:assert/strict";
import test from "node:test";
import { createOfflineConsoleRequestTracker } from "./offline-console-request-tracker.ts";

const request = (value: string) => ({ url: () => value });

void test("a delayed offline console error still belongs to its original request", () => {
	const tracker = createOfflineConsoleRequestTracker();
	tracker.started(request("https://example.test/offline"));
	// The browser may come back online before it emits the console error.
	assert.equal(tracker.consume("https://example.test/offline"), true);
	assert.equal(tracker.consume("https://example.test/offline"), false);
});

void test("an unrelated console URL does not consume an offline request", () => {
	const tracker = createOfflineConsoleRequestTracker();
	tracker.started(request("https://example.test/offline"));
	assert.equal(tracker.consume("https://example.test/unrelated"), false);
	assert.equal(tracker.consume("https://example.test/offline"), true);
});

void test("concurrent requests to one URL each allow one console error", () => {
	const tracker = createOfflineConsoleRequestTracker();
	tracker.started(request("https://example.test/offline"));
	tracker.started(request("https://example.test/offline"));
	assert.equal(tracker.consume("https://example.test/offline"), true);
	assert.equal(tracker.consume("https://example.test/offline"), true);
	assert.equal(tracker.consume("https://example.test/offline"), false);
});

void test("a completed request cannot excuse a later console error", () => {
	const tracker = createOfflineConsoleRequestTracker();
	const completed = request("https://example.test/online");
	tracker.started(completed);
	tracker.finished(completed);
	assert.equal(tracker.consume(completed.url()), false);
});
