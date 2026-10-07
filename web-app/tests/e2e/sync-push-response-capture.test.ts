import assert from "node:assert/strict";
import test from "node:test";
import {
	captureSyncPushError,
	MAX_SYNC_PUSH_ERROR_BODY_BYTES,
	isSyncPushProtocolRequest,
	isClientCanceledSyncProxyRequest,
} from "./sync-push-response-capture.ts";
import { createTransientPushRecoveryTracker } from "./transient-push-recovery.ts";

const typedStorageError = Buffer.from(
	JSON.stringify({ error: { code: "LIX_STORAGE_IO_UNAVAILABLE" } }),
);

function response(
	body: () => Promise<Uint8Array>,
	headers: Record<string, string> = {},
) {
	return { status: () => 503, headers: () => headers, body };
}

void test("captures only the typed code from a bounded 503 JSON body", async () => {
	const capture = await captureSyncPushError(
		response(async () => typedStorageError, {
			"content-length": String(typedStorageError.byteLength),
		}),
	);
	assert.deepEqual(capture, {
		errorCode: "LIX_STORAGE_IO_UNAVAILABLE",
		bodyIssue: null,
	});
});

void test("does not read a response declared larger than the classification bound", async () => {
	let bodyRead = false;
	const capture = await captureSyncPushError(
		response(
			async () => {
				bodyRead = true;
				return typedStorageError;
			},
			{
				"content-length": String(MAX_SYNC_PUSH_ERROR_BODY_BYTES + 1),
			},
		),
	);
	assert.equal(bodyRead, false);
	assert.deepEqual(capture, {
		errorCode: null,
		bodyIssue: `response body exceeds ${MAX_SYNC_PUSH_ERROR_BODY_BYTES}-byte classification limit`,
	});
});

void test("does not retain a body that exceeds the bound without a content length", async () => {
	const body = Buffer.from(
		JSON.stringify({
			error: { code: "LIX_STORAGE_IO_UNAVAILABLE", detail: "x".repeat(5_000) },
		}),
	);
	const capture = await captureSyncPushError(response(async () => body));
	assert.ok(body.byteLength > MAX_SYNC_PUSH_ERROR_BODY_BYTES);
	assert.deepEqual(capture, {
		errorCode: null,
		bodyIssue: `response body exceeds ${MAX_SYNC_PUSH_ERROR_BODY_BYTES}-byte classification limit`,
	});
});

void test("does not read successful push response bodies", async () => {
	let bodyRead = false;
	const capture = await captureSyncPushError({
		...response(async () => {
			bodyRead = true;
			return typedStorageError;
		}),
		status: () => 200,
	});
	assert.equal(bodyRead, false);
	assert.deepEqual(capture, {
		errorCode: null,
		bodyIssue: "response is not a 503",
	});
});

void test("intercepts only exact protocol push requests", () => {
	assert.equal(
		isSyncPushProtocolRequest(
			"POST",
			"http://127.0.0.1:8790/lix/v1/repository/sync/push",
		),
		true,
	);
	assert.equal(
		isSyncPushProtocolRequest("POST", "http://127.0.0.1:8790/other/sync/push"),
		false,
	);
	assert.equal(
		isSyncPushProtocolRequest(
			"POST",
			"http://127.0.0.1:8790/lix/v1/repository/sync/push?retry=1",
		),
		false,
	);
	assert.equal(
		isSyncPushProtocolRequest(
			"GET",
			"http://127.0.0.1:8790/lix/v1/repository/sync/push",
		),
		false,
	);
});

void test("keeps an aborted or unavailable body untyped", async () => {
	const abort = Object.assign(new Error("response was canceled"), {
		name: "AbortError",
	});
	const capture = await captureSyncPushError(
		response(async () => {
			throw abort;
		}),
	);
	assert.deepEqual(capture, {
		errorCode: null,
		bodyIssue: "response body unavailable (AbortError)",
	});
});

void test("a canceled 503 with an unavailable body stays unresolved after exact replay", async () => {
	const tracker = createTransientPushRecoveryTracker();
	const failed = tracker.observe({
		source: "right",
		replicaId: "replica-a",
		method: "POST",
		url: "http://127.0.0.1:8790/lix/v1/repository/sync/push",
		status: 503,
		body: new TextEncoder().encode('{"commits":["same"]}'),
	});
	const capture = await captureSyncPushError(
		response(async () => {
			throw Object.assign(new Error("response canceled"), {
				name: "AbortError",
			});
		}),
	);
	assert.equal(
		isClientCanceledSyncProxyRequest(
			new Error("route canceled"),
			"net::ERR_ABORTED",
		),
		true,
	);
	tracker.classifyCode(failed, capture.errorCode);
	tracker.observe({
		source: "right",
		replicaId: "replica-a",
		method: "POST",
		url: "http://127.0.0.1:8790/lix/v1/repository/sync/push",
		status: 200,
		body: new TextEncoder().encode('{"commits":["same"]}'),
	});
	assert.deepEqual(tracker.failures(), [
		"503 http://127.0.0.1:8790/lix/v1/repository/sync/push",
	]);
});

void test("does not classify malformed or unknown error envelopes as storage unavailable", async () => {
	for (const [body, expectedCode] of [
		[Buffer.from("not json"), null],
		[
			Buffer.from(
				JSON.stringify({ error: { code: "LIX_STORAGE_CORRUPTION" } }),
			),
			"LIX_STORAGE_CORRUPTION",
		],
		[
			Buffer.from(
				JSON.stringify({ error: { code: "private detail with spaces" } }),
			),
			null,
		],
	] as const) {
		const capture = await captureSyncPushError(response(async () => body));
		assert.equal(capture.errorCode, expectedCode);
		if (!expectedCode) {
			assert.equal(
				capture.bodyIssue,
				"response body did not contain a recognized error code",
			);
		}
		const tracker = createTransientPushRecoveryTracker();
		const failed = tracker.observe({
			source: "writer-a",
			replicaId: "replica-a",
			method: "POST",
			url: "http://127.0.0.1:8790/lix/v1/repository/sync/push",
			status: 503,
			body: new TextEncoder().encode('{"commits":["same"]}'),
		});
		tracker.classifyCode(failed, capture.errorCode);
		tracker.observe({
			source: "writer-a",
			replicaId: "replica-a",
			method: "POST",
			url: "http://127.0.0.1:8790/lix/v1/repository/sync/push",
			status: 200,
			body: new TextEncoder().encode('{"commits":["same"]}'),
		});
		assert.deepEqual(tracker.failures(), [
			"503 http://127.0.0.1:8790/lix/v1/repository/sync/push",
		]);
	}
});

void test("recognizes client route cancellation without hiding other failures", () => {
	assert.equal(
		isClientCanceledSyncProxyRequest(
			new Error("route canceled"),
			"net::ERR_ABORTED",
		),
		true,
	);
	assert.equal(
		isClientCanceledSyncProxyRequest(
			new Error("Target page, context or browser has been closed"),
			null,
		),
		true,
	);
	assert.equal(
		isClientCanceledSyncProxyRequest(
			new Error("upstream connection refused"),
			null,
		),
		false,
	);
});
