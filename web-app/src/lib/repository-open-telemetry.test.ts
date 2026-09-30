import assert from "node:assert/strict";
import test from "node:test";
import {
	repositoryOpenDiagnostics,
	repositoryOpenFailureMessage,
	reportRepositoryOpenFailure,
} from "./repository-open-telemetry.ts";

void test("payload provenance diagnostics accept only bounded structural states", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadStandaloneStatus: "matched",
				payloadPhysicalStatus: "missing_snapshot",
				payloadFailureReason: "selected_change_payload_unavailable",
				payloadSourceDeferred: true,
				payloadPhysicalConflict: false,
				changeId: "11111111-1111-4111-8111-111111111111",
				sourceCommitId: "private document content",
				snapshot: "secret",
			},
		}),
		{
			payloadStandaloneStatus: "matched",
			payloadPhysicalStatus: "missing_snapshot",
			payloadFailureReason: "selected_change_payload_unavailable",
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
				payloadFailureReason: "private failure reason",
				payloadSourceDeferred: "true",
				payloadPhysicalConflict: 1,
			},
		}),
		{},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadFailureReason: "exact_owner_point_read_budget_exhausted",
				attempted: 65_537,
				budget: "65536",
				secret: "private",
			},
		}),
		{
			payloadFailureReason: "exact_owner_point_read_budget_exhausted",
			attempted: 65_537,
			budget: 65_536,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadFailureReason: "exact_owner_point_read_budget_exhausted",
				attempted: 65_538,
				budget: 65_536,
			},
		}),
		{
			payloadFailureReason: "exact_owner_point_read_budget_exhausted",
		},
	);
});

void test("pre-request catalog operations accept only fixed phase and operation values", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadPhase: "pre_request_catalog",
				payloadOperation: "registered_schema_identity_scan",
				payloadFailureReason: "selected_change_payload_unavailable",
				private: "document bytes",
			},
		}),
		{
			payloadFailureReason: "selected_change_payload_unavailable",
			payloadPhase: "pre_request_catalog",
			payloadOperation: "registered_schema_identity_scan",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadPhase: "private phase",
				payloadOperation: "private operation",
			},
		}),
		{},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadPhase: "pre_request_catalog",
				payloadOperation: "registered_schema_snapshot_load",
			},
		}),
		{
			payloadPhase: "pre_request_catalog",
			payloadOperation: "registered_schema_snapshot_load",
		},
	);
});

void test("read fulfillment failures accept only the fixed validation diagnosis", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadPhase: "read_fulfillment_validation",
				payloadFailureReason: "change_payload_not_selected_by_exact_recipe",
				request: "private recipe data",
			},
		}),
		{
			payloadPhase: "read_fulfillment_validation",
			payloadFailureReason: "change_payload_not_selected_by_exact_recipe",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				payloadPhase: "read_fulfillment_validation",
				payloadFailureReason: "raw validator detail",
			},
		}),
		{ payloadPhase: "read_fulfillment_validation" },
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

void test("migration parser diagnostics retain only known reason and receipt paths", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				receiptVersion: 2,
				migrationPhase: "partial_receipt",
				failureReason: "v2_branch_incarnation_mismatch",
				failurePath: "$.descriptor.selectedBranch.createdAt",
				parserMessage: "contains private receipt bytes",
			},
		}),
		{
			receiptVersion: 2,
			migrationPhase: "partial_receipt",
			failureReason: "v2_branch_incarnation_mismatch",
			failurePath: "$.descriptor.selectedBranch.createdAt",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				migrationPhase: "private_parser_stage",
				failureReason: "serde said private data",
				failurePath: "$.privateValue.token",
			},
		}),
		{},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				receiptVersion: 2,
				migrationPhase: "partial_receipt",
				failureReason: "v2_receipt_json_data",
				failurePath: "$",
				jsonLine: "12",
				jsonColumn: 5,
				missingField: "activeAccountId",
			},
		}),
		{
			receiptVersion: 2,
			migrationPhase: "partial_receipt",
			failureReason: "v2_receipt_json_data",
			failurePath: "$",
			jsonLine: 12,
			jsonColumn: 5,
			missingField: "activeAccountId",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				receiptVersion: 2,
				failureReason: "v2_receipt_json_other",
				failurePath: "$",
				jsonLine: 16_385,
				jsonColumn: 0,
				missingField: "authorId",
			},
		}),
		{
			failureReason: "v2_receipt_json_other",
			failurePath: "$",
			receiptVersion: 2,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				receiptVersion: 1,
				migrationPhase: "partial_receipt",
				failureReason: "receipt_json_data",
				failurePath: "$",
				missingField: "archivedBranchIds",
			},
		}),
		{
			receiptVersion: 1,
			migrationPhase: "partial_receipt",
			failureReason: "receipt_json_data",
			failurePath: "$",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				receiptVersion: 3,
				migrationPhase: "partial_receipt",
				failureReason: "receipt_json_data",
				failurePath: "$",
				jsonLine: 3,
				jsonColumn: 14,
				missingField: "authorId",
			},
		}),
		{
			receiptVersion: 3,
			migrationPhase: "partial_receipt",
			failureReason: "receipt_json_data",
			failurePath: "$",
			jsonLine: 3,
			jsonColumn: 14,
			missingField: "authorId",
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				migrationPhase: "partial_receipt",
				failureReason: "receipt_validation_failed",
				failurePath: "$.baselineLease",
				receiptVersion: 2,
				expectedReceiptVersion: 3,
			},
		}),
		{
			migrationPhase: "partial_receipt",
			failureReason: "receipt_validation_failed",
			failurePath: "$.baselineLease",
			receiptVersion: 2,
			expectedReceiptVersion: 3,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: { migrationPhase: "private_parser_stage" },
		}),
		{},
	);
	assert.equal(
		repositoryOpenFailureMessage(
			{
				details: {
					failureReason: "v2_branch_incarnation_mismatch",
					failurePath: "$.descriptor.selectedBranch.createdAt",
				},
			},
			"Repository opening failed",
		),
		"Repository opening failed: v2_branch_incarnation_mismatch at $.descriptor.selectedBranch.createdAt",
	);
	assert.equal(
		repositoryOpenFailureMessage(
			{
				details: {
					payloadFailureReason: "selected_change_payload_unavailable",
				},
			},
			"Repository opening failed",
		),
		"Repository opening failed: selected_change_payload_unavailable",
	);
	assert.equal(
		repositoryOpenFailureMessage(
			{ details: { failureReason: "arbitrary private text" } },
			"Repository opening failed",
		),
		"Repository opening failed",
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
