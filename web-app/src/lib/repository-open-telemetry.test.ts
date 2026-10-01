import assert from "node:assert/strict";
import test from "node:test";
import {
	repositoryOpenDiagnostics,
	repositoryOpenFailureMessage,
	reportRepositoryOpenFailure,
} from "./repository-open-telemetry.ts";

void test("conversion recovery reports bounded preservation state without journal contents", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				failureReason: "pending_conversion_journal",
				migrationPhase: "candidate_format_migration",
				sourcePreserved: true,
				journal: "private pending work",
				sourceBank: "private-bank",
			},
		}),
		{
			failureReason: "pending_conversion_journal",
			migrationPhase: "candidate_format_migration",
			sourcePreserved: true,
		},
	);
});

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
				payloadFailureReason: "selected_change_payload_recipe_mismatch",
				request: "private recipe data",
			},
		}),
		{
			payloadPhase: "read_fulfillment_validation",
			payloadFailureReason: "selected_change_payload_recipe_mismatch",
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

void test("read fulfillment recipe diagnostics retain bounded schema and mask", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_READ_FULFILLMENT_INVALID",
			details: {
				payloadFailureReason: "selected_change_payload_recipe_mismatch",
				payloadSchemaKind: "file_descriptor",
				payloadRecipeMask: 129,
				payloadRecipeCount: 2,
				payloadRequiredInputCount: 17,
				payload: "private recipe",
			},
		}),
		{
			lix_error_code: "LIX_READ_FULFILLMENT_INVALID",
			payloadFailureReason: "selected_change_payload_recipe_mismatch",
			payloadSchemaKind: "file_descriptor",
			payloadRecipeMask: 129,
			payloadRecipeCount: 2,
			payloadRequiredInputCount: 17,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_READ_FULFILLMENT_INVALID",
			details: {
				payloadSchemaKind: "private_schema_name",
				payloadRecipeMask: 256,
			},
		}),
		{ lix_error_code: "LIX_READ_FULFILLMENT_INVALID" },
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_INTERNAL_ERROR",
			details: {
				payloadSchemaKind: "file_descriptor",
				payloadRecipeMask: 129,
			},
		}),
		{ lix_error_code: "LIX_INTERNAL_ERROR" },
	);
});

void test("native read recipe diagnostics require a matching marker and stay numeric", () => {
	const error = {
		code: "LIX_INTERNAL_ERROR",
		details: {
			readFulfillment: {
				interests: [
					{
						kind: "exact",
						schema_key: "private_schema",
						row_pk: "private_row",
					},
					{ kind: "diff", relation: "private_relation" },
				],
			},
			nativeReadRecipeCount: 2,
			nativeReadRecipeMask: 129,
		},
	};
	assert.deepEqual(repositoryOpenDiagnostics(error), {
		lix_error_code: "LIX_INTERNAL_ERROR",
		nativeReadRecipeCount: 2,
		nativeReadRecipeMask: 129,
	});
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_INTERNAL_ERROR",
			details: {
				readFulfillment: { interests: [{ kind: "exact" }, { kind: "diff" }] },
				nativeReadRecipeCount: 1,
				nativeReadRecipeMask: 129,
			},
		}),
		{ lix_error_code: "LIX_INTERNAL_ERROR" },
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_INTERNAL_ERROR",
			details: { nativeReadRecipeCount: 2, nativeReadRecipeMask: 129 },
		}),
		{
			lix_error_code: "LIX_INTERNAL_ERROR",
			nativeReadRecipeCount: 2,
			nativeReadRecipeMask: 129,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "ERR_OTHER",
			details: { nativeReadRecipeCount: 2, nativeReadRecipeMask: 129 },
		}),
		{},
	);
	assert.doesNotMatch(
		JSON.stringify(repositoryOpenDiagnostics(error)),
		/private/,
	);
});

void test("WASM asset diagnostics are code-gated and content-free", () => {
	const details = {
		phase: "wasm_compile",
		cacheStatus: "corrupt",
		httpStatus: 503,
		url: "https://private.example/asset.wasm?token=secret",
		body: "private response",
		cause: "native parser details",
	};
	assert.deepEqual(
		repositoryOpenDiagnostics({
			name: "LixError",
			code: "LIX_WASM_ASSET_UNAVAILABLE",
			details,
		}),
		{
			error_kind: "LixError",
			lix_error_code: "LIX_WASM_ASSET_UNAVAILABLE",
			wasmAssetPhase: "wasm_compile",
			wasmAssetCacheStatus: "corrupt",
			httpStatus: 503,
		},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_INTERNAL_ERROR",
			details,
		}),
		{ lix_error_code: "LIX_INTERNAL_ERROR", httpStatus: 503 },
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			code: "LIX_WASM_ASSET_UNAVAILABLE",
			details: { phase: "wasm_link", cacheStatus: "private" },
		}),
		{ lix_error_code: "LIX_WASM_ASSET_UNAVAILABLE" },
	);
});

void test("client read-fulfillment diagnostics preserve bounded causes after a successful server response", () => {
	for (const reason of [
		"selected_change_payload_identity_or_lifetime_mismatch",
		"selected_change_payload_locator_missing",
		"selected_change_payload_source_mismatch",
		"selected_change_payload_outside_descriptor_scope",
		"read_fulfillment_resident_input_conflict",
	]) {
		assert.deepEqual(
			repositoryOpenDiagnostics({
				code: "LIX_READ_FULFILLMENT_INVALID",
				details: {
					payloadPhase: "read_fulfillment_install",
					payloadFailureReason: reason,
					payload: "private document bytes",
				},
			}),
			{
				lix_error_code: "LIX_READ_FULFILLMENT_INVALID",
				payloadPhase: "read_fulfillment_install",
				payloadFailureReason: reason,
			},
		);
	}
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

void test("WASM asset diagnostics reach the first-party worker as bounded fields", async () => {
	let sent: Record<string, unknown> | undefined;
	const error = Object.assign(new Error("private wasm failure"), {
		name: "LixError",
		code: "LIX_WASM_ASSET_UNAVAILABLE",
		details: {
			phase: "wasm_fetch",
			cacheStatus: "unavailable",
			httpStatus: 502,
			url: "https://private.example/asset.wasm?token=secret",
			body: "private response",
		},
	});
	await reportRepositoryOpenFailure(
		error,
		{
			repositoryId: "id",
			release: "build",
			getAccessToken: async () => "test-token",
		},
		async (_url, init) => {
			sent = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(null);
		},
	);
	assert.deepEqual(sent?.diagnostic, {
		error_kind: "LixError",
		lix_error_code: "LIX_WASM_ASSET_UNAVAILABLE",
		wasmAssetPhase: "wasm_fetch",
		wasmAssetCacheStatus: "unavailable",
		httpStatus: 502,
	});
	assert.doesNotMatch(JSON.stringify(sent), /private|secret/);
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
