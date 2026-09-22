import assert from "node:assert/strict";
import test from "node:test";
import {
	repositoryOpenDiagnostics,
	reportRepositoryOpenFailure,
} from "./repository-open-telemetry.ts";

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
			servingGeneration: "123",
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
