import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryOpenedSink } from "./repository-opened-sink.ts";

void test("MCP cache-hit bind produces one repository_opened for the identified person", async () => {
	const captured: Array<{
		distinctId: string;
		event: string;
		properties: Record<string, unknown>;
	}> = [];
	const sink = createRepositoryOpenedSink(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_HOST: "https://posthog.example",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123" },
		{
			createClient: () => ({
				async captureImmediate(event) {
					assert.ok(event.distinctId);
					captured.push({
						distinctId: event.distinctId,
						event: event.event,
						properties: event.properties as Record<string, unknown>,
					});
				},
				async shutdown() {},
			}),
		},
	);
	assert.ok(sink);
	sink.bind({
		lixId: "lix-1",
		branchId: "branch-1",
		organizationId: "org-1",
		source: "mcp",
	});
	await sink.flush();
	assert.deepEqual(captured, [
		{
			distinctId: "user-123",
			event: "repository_opened",
			properties: {
				lix_id: "lix-1",
				branch_id: "branch-1",
				repository_id: "lix-1",
				organization_id: "org-1",
				environment: "production",
				source: "mcp",
			},
		},
	]);
});

void test("missing PostHog config does not create a sink", () => {
	assert.equal(
		createRepositoryOpenedSink(
			{ POSTHOG_ENVIRONMENT: "production" },
			{ userId: "user-123" },
		),
		null,
	);
	assert.equal(
		createRepositoryOpenedSink(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "preview",
			},
			{ userId: "user-123" },
		),
		null,
	);
	assert.equal(
		createRepositoryOpenedSink(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "production",
			},
			{ userId: "user-123", isDemo: true },
		),
		null,
	);
});
