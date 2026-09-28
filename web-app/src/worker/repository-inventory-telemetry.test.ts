import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	captureRepositoryInventory,
	readRepositoryInventory,
} from "./repository-inventory-telemetry.ts";

const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

void test("deferred history uses live inventory only for the requested head", async () => {
	const deferred = Object.assign(new Error("history deferred"), {
		code: "LIX_SYNC_HISTORY_REQUIRED",
	});
	let head = "commit-1";
	const calls: string[] = [];
	const reader = {
		execute: async (_repositoryId: string, request: { sql: string }) => {
			calls.push(request.sql);
			if (request.sql.includes("lix_as_of")) throw deferred;
			if (request.sql.includes("lix_active_branch_commit_id"))
				return { rows: [[{ kind: "text", value: head }]] } as never;
			return {
				rows: [
					[
						{ kind: "text", value: "/notes.md" },
						{ kind: "int", value: 5 },
					],
				],
			} as never;
		},
	};
	const inventory = await readRepositoryInventory(
		reader,
		REPOSITORY_ID,
		"commit-1",
	);
	assert.equal(inventory.user_content_bytes, 5);
	assert.equal(calls.length, 3);
	head = "commit-2";
	await assert.rejects(
		readRepositoryInventory(reader, REPOSITORY_ID, "commit-1"),
		(error: unknown) => error === deferred,
	);
});

void test("internal .lix paths are classified and still included in totals", async () => {
	const inventory = await readRepositoryInventory(
		{
			execute: async () =>
				({
					rows: [
						[
							{ kind: "text", value: "/.lix/config.md" },
							{ kind: "int", value: 20 },
						],
						[
							{ kind: "text", value: "/notes.md" },
							{ kind: "int", value: 30 },
						],
					],
				}) as never,
		},
		REPOSITORY_ID,
		"commit-1",
	);
	assert.equal(inventory.file_count, 2);
	assert.equal(inventory.total_content_bytes, 50);
	assert.equal(inventory.user_file_count, 1);
	assert.equal(inventory.user_content_bytes, 30);
	assert.equal(inventory.lix_internal_file_count, 1);
	assert.equal(inventory.lix_internal_content_bytes, 20);
	assert.deepEqual(inventory.extension_file_counts, { md: 2 });
	assert.deepEqual(inventory.user_extension_file_counts, { md: 1 });
	assert.deepEqual(inventory.lix_internal_extension_file_counts, { md: 1 });
});

void test("inventory measures live bytes, size buckets and extensions without exporting paths", async () => {
	const inventory = await readRepositoryInventory(
		{
			execute: async (_repositoryId, request) => {
				assert.match(request.sql, /OCTET_LENGTH\(content\)/);
				assert.equal(request.params?.[0]?.value, "commit-1");
				return {
					rows: [
						[
							{ kind: "text", value: "/private/a.MD" },
							{ kind: "int", value: 0 },
						],
						[
							{ kind: "text", value: "/private/b.md" },
							{ kind: "int", value: 1024 },
						],
						[
							{ kind: "text", value: "/private/c.png" },
							{ kind: "int", value: 1_048_576 },
						],
					],
				} as never;
			},
		},
		REPOSITORY_ID,
		"commit-1",
	);
	assert.equal(inventory.file_count, 3);
	assert.equal(inventory.total_content_bytes, 1_049_600);
	assert.equal(inventory.user_file_count, 3);
	assert.equal(inventory.lix_internal_file_count, 0);
	assert.deepEqual(inventory.user_file_size_buckets, {
		under_1kb: 1,
		"1kb_to_10kb": 1,
		"1mb_and_over": 1,
	});
	assert.equal(inventory.file_size_under_1kb, 1);
	assert.equal(inventory.file_size_1kb_to_10kb, 1);
	assert.equal(inventory.file_size_1mb_and_over, 1);
	assert.deepEqual(inventory.extension_file_counts, { md: 2, png: 1 });
	assert.deepEqual(inventory.extension_content_bytes, {
		md: 1024,
		png: 1_048_576,
	});
	assert.equal(JSON.stringify(inventory).includes("/private"), false);

	const captured: EventMessage[] = [];
	await captureRepositoryInventory(
		{ POSTHOG_PROJECT_TOKEN: "test-token", POSTHOG_ENVIRONMENT: "production" },
		{
			userId: "user-1",
			repositoryId: REPOSITORY_ID,
			commitId: "commit-1",
			surface: "mcp",
			inventory,
		},
		() =>
			({
				captureImmediate: async (event: EventMessage) => {
					captured.push(event);
				},
				shutdown: async () => undefined,
			}) as never,
	);
	assert.equal(captured[0]?.event, "repository_inventory_snapshot");
	assert.equal(captured[0]?.properties?.file_count, 3);
	assert.deepEqual(captured[0]?.properties?.$groups, {
		repository: REPOSITORY_ID,
	});
	assert.equal(JSON.stringify(captured).includes("/private"), false);
});
