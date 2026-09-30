import assert from "node:assert/strict";
import test from "node:test";
import {
	repositoryOpenDiagnostics,
	reportRepositoryOpenFailure,
} from "./repository-open-telemetry.ts";

void test("payload provenance diagnostics accept only bounded structural states", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadStandaloneStatus: "matched",
				payloadPhysicalStatus: "lifetime_mismatch",
				payloadSourceDeferred: true,
				payloadPhysicalConflict: false,
				changeId: "11111111-1111-4111-8111-111111111111",
				sourceCommitId: "private document content",
				snapshot: "secret",
			},
		}),
		{
			payloadStandaloneStatus: "matched",
			payloadPhysicalStatus: "lifetime_mismatch",
			payloadSourceDeferred: true,
			payloadPhysicalConflict: false,
			changeId: "11111111-1111-4111-8111-111111111111",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadStandaloneStatus: "secret",
				payloadPhysicalStatus: "https://private/?token=secret",
				payloadSourceDeferred: "true",
				payloadPhysicalConflict: 1,
			},
		}),
		{},
	);
});

void test("opening diagnostics retain coordinates and exclude arbitrary private data", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_PARTIAL_REPLICA_ADMISSION_MISMATCH",
			message: "secret",
			details: {
				branchId: id,
				rootCommitId: null,
				servingGeneration: "123",
				expectedStorageEpoch: 82,
				token: "secret",
				headCommitId: "https://private",
			},
		}),
		{
			lix_error_code: "LIX_PARTIAL_REPLICA_ADMISSION_MISMATCH",
			branchId: id,
			rootCommitId: null,
			servingGeneration: 123,
			expectedStorageEpoch: 82,
		},
	);
});

void test("non-Lix repository opening failures use the independent first-party path", async () => {
	let sent: Record<string, unknown> | undefined;
	await reportRepositoryOpenFailure(
		new TypeError("private data"),
		{
			repositoryId: "id",
			release: "build",
			getAccessToken: async () => "test-token",
		},
		async (url, init) => {
			assert.equal(url, "/api/repository-open-diagnostics");
			sent = JSON.parse(init?.body as string) as Record<string, unknown>;
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer test-token",
			);
			return new Response(null);
		},
	);
	assert.deepEqual(sent, {
		repositoryId: "id",
		release: "build",
		diagnostic: { error_kind: "TypeError" },
		frames: [],
	});
});

void test("failed telemetry does not throw or retry opening", async () => {
	await reportRepositoryOpenFailure(
		"failure",
		{
			repositoryId: "id",
			release: "build",
			getAccessToken: async () => "token",
		},
		async () => {
			throw new Error("network unavailable");
		},
	);
});

void test("first-party reports preserve browser frames without messages, queries or page URLs", async () => {
	const error = new Error("private document text");
	error.stack =
		"Error: private document text\n    at decode (https://lixray.com/assets/worker-Abc123.js?token=secret:12:34)\n    at open (https://lixray.com/assets/app-Xyz.js:56:78)\n    at privatePage (https://lixray.com/@private/document:1:2)";
	let payload: Record<string, unknown> = {};
	await reportRepositoryOpenFailure(
		error,
		{ repositoryId: "id", release: "build", getAccessToken: async () => null },
		async (_url, init) => {
			payload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(null);
		},
	);
	assert.deepEqual(payload.frames, [
		{
			platform: "web:javascript",
			filename: "/assets/app-Xyz.js",
			function: "open",
			lineno: 56,
			colno: 78,
			in_app: true,
		},
		{
			platform: "web:javascript",
			filename: "/assets/worker-Abc123.js",
			function: "decode",
			lineno: 12,
			colno: 34,
			in_app: true,
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(payload),
		/secret|private document|@private/,
	);
});

void test("first-party diagnostics retain receipt versions and recovery stage without response content", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			name: "LixError",
			code: "LIX_REPLICA_RECOVERY_FAILED",
			details: {
				receiptVersion: 2,
				expectedReceiptVersion: 3,
				recoveryStage: "admission",
				recoveryAttempts: 7,
				httpStatus: 503,
				message: "private",
				responseBody: "secret",
			},
		}),
		{
			error_kind: "LixError",
			lix_error_code: "LIX_REPLICA_RECOVERY_FAILED",
			receiptVersion: 2,
			expectedReceiptVersion: 3,
			recoveryStage: "admission",
			recoveryAttempts: 7,
			httpStatus: 503,
		},
	);
});

void test("first-party failure diagnostics preserve valid trace correlation and reject invalid identifiers", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				telemetryTraceId: "a".repeat(32),
				telemetrySpanId: "b".repeat(16),
			},
		}),
		{ $otel_trace_id: "a".repeat(32), $otel_span_id: "b".repeat(16) },
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				telemetryTraceId: "0".repeat(32),
				telemetrySpanId: "token-secret",
			},
		}),
		{},
	);
});
