import assert from "node:assert/strict";
import test from "node:test";
import {
	createMergeReplayTracker,
	createRetainedBodyRecoveryTracker,
} from "./retained-body-recovery.ts";

const url = "https://example.test/lix/v1/repository/sync/retained-bodies";
const body = Buffer.from('{"request":{"attemptId":"a"},"bodies":[1]}');
const conflict = { method: "POST", url, body, status: 409 };
const success = { ...conflict, status: 200 };

void test("only a later byte-identical successful wave resolves a recorded failure", () => {
	const tracker = createRetainedBodyRecoveryTracker();
	assert.equal(tracker.observe(conflict), true);
	assert.deepEqual(tracker.failures(), [`409 ${url}`]);
	assert.equal(tracker.observe(success), false);
	assert.deepEqual(tracker.failures(), []);
	assert.deepEqual(tracker.recovered(), [
		{
			url,
			requestBodyBytes: body.length,
			requestBodySha256:
				"1174b7e74509891a16a74c7a9cfba053fa057f1949a5e81c2af7db48c573038b",
			failureSequence: 1,
			successSequence: 2,
		},
	]);
});

for (const [name, response] of Object.entries({
	"different bytes, same JSON": {
		...success,
		body: Buffer.from(`${body.toString()} `),
	},
	"different URL": { ...success, url: url.replace("repository", "other") },
	"different method": { ...success, method: "GET" },
	"different success status": { ...success, status: 201 },
	"empty success": { ...success, status: 204 },
	"server error": { ...success, status: 500 },
	"missing body": { ...success, body: null },
})) {
	void test(`${name} cannot clear a failed wave`, () => {
		const tracker = createRetainedBodyRecoveryTracker();
		tracker.observe(conflict);
		assert.equal(tracker.observe(response), false);
		assert.deepEqual(tracker.failures(), [`409 ${url}`]);
		assert.deepEqual(tracker.recovered(), []);
	});
}

for (const [name, response] of Object.entries({
	"GET conflict": { ...conflict, method: "GET" },
	"other endpoint": {
		...conflict,
		url: url.replace("retained-bodies", "merge"),
	},
	"query parameter": { ...conflict, url: `${url}?other=true` },
	"query masquerading as the endpoint": {
		...conflict,
		url: "https://example.test/other?next=/lix/v1/repository/sync/retained-bodies",
	},
	"invalid URL": {
		...conflict,
		url: "/lix/v1/repository/sync/retained-bodies",
	},
	"empty body": { ...conflict, body: Buffer.alloc(0) },
	"absent body": { ...conflict, body: null },
	"other error": { ...conflict, status: 500 },
})) {
	void test(`${name} remains an ordinary response failure`, () => {
		const tracker = createRetainedBodyRecoveryTracker();
		assert.equal(
			tracker.observe(response),
			false,
			"caller must keep reporting this error",
		);
		assert.deepEqual(tracker.recovered(), []);
	});
}

void test("success before failure cannot acknowledge a later conflict", () => {
	const tracker = createRetainedBodyRecoveryTracker();
	tracker.observe(success);
	tracker.observe(conflict);
	assert.deepEqual(tracker.failures(), [`409 ${url}`]);
	assert.deepEqual(tracker.recovered(), []);
});

void test("an exact successful merge replay recovers a prior 409", () => {
	const tracker = createMergeReplayTracker();
	const mergeUrl = "https://example.test/lix/v1/repository/sync/merge";
	const request = { method: "POST", url: mergeUrl, body, status: 409 };
	assert.equal(tracker.observe(request), true);
	assert.deepEqual(tracker.failures(), [`409 ${mergeUrl}`]);
	assert.equal(tracker.observe({ ...request, status: 200 }), false);
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered(), 1);
});

void test("a merge success cannot recover different bytes or a later conflict", () => {
	const tracker = createMergeReplayTracker();
	const mergeUrl = "https://example.test/lix/v1/repository/sync/merge";
	const request = { method: "POST", url: mergeUrl, body, status: 409 };
	assert.equal(tracker.observe({ ...request, status: 200 }), false);
	assert.equal(tracker.observe(request), true);
	assert.equal(
		tracker.observe({ ...request, status: 200, body: Buffer.from("other") }),
		false,
	);
	assert.equal(tracker.recovered(), 0);
	assert.deepEqual(tracker.failures(), [`409 ${mergeUrl}`]);
});

void test("a typed merge conflict cannot clear another request on replay", () => {
	const tracker = createMergeReplayTracker();
	const mergeUrl = "https://example.test/lix/v1/repository/sync/merge";
	const typed = { method: "POST", url: mergeUrl, body, status: 409 };
	const unmatched = { ...typed, body: Buffer.from("different attempt") };
	tracker.observe(typed);
	tracker.observe(unmatched);
	assert.equal(tracker.classifyConflict(typed, true), true);
	assert.equal(tracker.observe({ ...typed, status: 200 }), false);
	assert.deepEqual(tracker.failures(), [`409 ${mergeUrl}`]);
	assert.equal(tracker.observe({ ...unmatched, status: 200 }), false);
	assert.deepEqual(tracker.failures(), []);
	assert.equal(tracker.recovered(), 1);
});

void test("a readable nonretryable merge 409 remains a failure after exact replay", () => {
	const tracker = createMergeReplayTracker();
	const mergeUrl = "https://example.test/lix/v1/repository/sync/merge";
	const request = { method: "POST", url: mergeUrl, body, status: 409 };
	assert.equal(tracker.observe(request), true);
	assert.equal(tracker.classifyConflict(request, false), true);
	tracker.observe({ ...request, status: 200 });
	assert.deepEqual(tracker.failures(), [`409 ${mergeUrl}`]);
});

void test("unmatched conflicts survive another wave's successful recovery", () => {
	const tracker = createRetainedBodyRecoveryTracker();
	const other = { ...conflict, body: Buffer.from("another wave") };
	tracker.observe(conflict);
	tracker.observe(other);
	tracker.observe(success);
	assert.deepEqual(tracker.failures(), [`409 ${url}`]);
	assert.equal(tracker.recovered().length, 1);
	tracker.observe(conflict);
	assert.equal(tracker.failures().length, 2, "earlier success is not cached");
});

void test("merge retries require the exact endpoint, method, status, and transaction-conflict code", async () => {
	const { isRetryableMergeConflict } =
		await import("./retained-body-recovery.ts");
	const url = "https://lixray.test/lix/v1/repository/sync/merge";
	const body = { error: { code: "LIX_TRANSACTION_CONFLICT" } };
	assert.equal(isRetryableMergeConflict("POST", url, 409, body), true);
	for (const [method, target, status, response] of [
		["GET", url, 409, body],
		["POST", url, 500, body],
		["POST", url + "?other=1", 409, body],
		["POST", url.replace("merge", "retained-bodies"), 409, body],
		["POST", url, 409, { error: { code: "LIX_STORAGE_FENCED" } }],
		["POST", url, 409, { error: { code: "LIX_SYNC_IDEMPOTENCY_KEY_REUSED" } }],
		["POST", url, 409, null],
		["POST", url, 409, { code: "LIX_TRANSACTION_CONFLICT" }],
	] as const)
		assert.equal(
			isRetryableMergeConflict(method, target, status, response),
			false,
		);
});
