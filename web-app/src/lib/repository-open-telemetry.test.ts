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
