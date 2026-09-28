import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	addedFirstFile,
	captureFirstFileAdded,
} from "./first-file-telemetry.ts";

const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

void test("first-file detection requires a committed zero-to-nonempty transition", async () => {
	const calls: string[] = [];
	const reader = {
		execute: async (
			_lixId: string,
			request: { sql: string; params?: Array<{ value: string }> },
		) => {
			const commit = request.params?.[0]?.value ?? "";
			calls.push(commit);
			return (
				request.sql.includes("COUNT")
					? { rows: [[{ kind: "int", value: commit === "empty" ? 0 : 1 }]] }
					: { rows: [[{ kind: "text", value: "/private/first.md" }]] }
			) as never;
		},
	};
	assert.equal(
		await addedFirstFile(reader, REPOSITORY_ID, {
			before: "empty",
			after: "one",
		}),
		"/private/first.md",
	);
	assert.equal(
		await addedFirstFile(reader, REPOSITORY_ID, {
			before: "one",
			after: "two",
		}),
		null,
	);
	assert.deepEqual(calls, ["empty", "one", "one"]);
});

void test("first-file capture uses repository UUID for cross-surface deduplication", async () => {
	const captured: EventMessage[] = [];
	await captureFirstFileAdded(
		{ POSTHOG_PROJECT_TOKEN: "test-token", POSTHOG_ENVIRONMENT: "production" },
		{
			userId: "account-1",
			repositoryId: REPOSITORY_ID,
			fileExtension: "md",
			surface: "mcp",
		},
		() =>
			({
				captureImmediate: async (event: EventMessage) => {
					captured.push(event);
				},
				shutdown: async () => undefined,
			}) as never,
	);
	assert.equal(captured[0]?.uuid, REPOSITORY_ID);
	assert.equal(captured[0]?.properties?.telemetry_schema_version, 2);
	assert.equal(captured[0]?.properties?.file_extension, "md");
	assert.equal(captured[0]?.properties?.file_path, undefined);
});
