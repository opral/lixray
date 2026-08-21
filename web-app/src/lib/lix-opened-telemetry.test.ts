import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	ANONYMOUS_LIX_ACCOUNT_ID,
	createLixOpenedOnSpan,
	identifiedDistinctId,
	repositoryOpenedFromBind,
	repositoryOpenedFromLixOpened,
} from "./lix-opened-telemetry.ts";

void test("completed lix.opened span captures exactly one repository_opened", () => {
	const captured: Array<ReturnType<typeof repositoryOpenedFromLixOpened>> = [];
	const onSpan = createLixOpenedOnSpan({
		capture: (event) => captured.push(event),
		environment: "production",
		source: "web",
	});

	onSpan({
		name: "lix.sql.query",
		attributes: { "lix.id": "should-ignore" },
	});
	onSpan({
		name: "lix.opened",
		attributes: {
			"lix.id": "lix-1",
			"lix.branch_id": "branch-1",
			"lix.account_id": "user-123",
		},
	});

	assert.deepEqual(captured, [
		{
			event: "repository_opened",
			distinctId: "user-123",
			properties: {
				lix_id: "lix-1",
				branch_id: "branch-1",
				repository_id: "lix-1",
				environment: "production",
				source: "web",
			},
		},
	]);
	assert.equal(
		"duration_ms" in (captured[0]?.properties ?? {}),
		false,
		"repository_opened is a count event unless Lix provides a duration",
	);
});

void test("engine start.kind LixOpened maps the same product event", () => {
	assert.deepEqual(
		repositoryOpenedFromLixOpened(
			{
				name: "lix.opened",
				start: {
					kind: "LixOpened",
					name: "lix.opened",
					attributes: [
						{ key: "lix.id", value: { String: "lix-1" } },
						{ key: "lix.branch_id", value: { String: "branch-1" } },
						{ key: "lix.account_id", value: { String: "user-123" } },
					],
				},
				attributes: {},
			},
			{ environment: "production", source: "web" },
		),
		{
			event: "repository_opened",
			distinctId: "user-123",
			properties: {
				lix_id: "lix-1",
				branch_id: "branch-1",
				repository_id: "lix-1",
				environment: "production",
				source: "web",
			},
		},
	);
});

void test("anonymous and demo accounts never become a distinct_id", () => {
	assert.equal(identifiedDistinctId(ANONYMOUS_LIX_ACCOUNT_ID), null);
	assert.equal(identifiedDistinctId("lixray-demo"), null);
	assert.equal(identifiedDistinctId(""), null);
	assert.equal(
		repositoryOpenedFromBind({
			lixId: "lix-1",
			branchId: "branch-1",
			accountId: ANONYMOUS_LIX_ACCOUNT_ID,
			environment: "production",
			source: "server",
		}),
		null,
	);
});

void test("one bind produces one product event", () => {
	assert.deepEqual(
		repositoryOpenedFromBind({
			lixId: "lix-1",
			branchId: "branch-1",
			accountId: "user-123",
			organizationId: "org-1",
			environment: "production",
			source: "mcp",
		}),
		{
			event: "repository_opened",
			distinctId: "user-123",
			properties: {
				lix_id: "lix-1",
				branch_id: "branch-1",
				repository_id: "lix-1",
				organization_id: "org-1",
				environment: "production",
				source: "mcp",
			},
		},
	);
});

void test("engine spans pass through onEngineSpan without becoming repository_opened", () => {
	const captured: Array<ReturnType<typeof repositoryOpenedFromLixOpened>> = [];
	const engine: Array<{ name: string }> = [];
	const onSpan = createLixOpenedOnSpan({
		capture: (event) => captured.push(event),
		onEngineSpan: (span) => engine.push({ name: span.name }),
		environment: "production",
		source: "web",
	});
	onSpan({
		name: "lix.sql.batch",
		attributes: { "lix.id": "lix-1" },
	});
	onSpan({
		name: "lix.opened",
		attributes: {
			"lix.id": "lix-1",
			"lix.account_id": "user-123",
		},
	});
	assert.equal(captured.length, 1);
	assert.equal(captured[0]?.event, "repository_opened");
	assert.deepEqual(
		engine.map((span) => span.name),
		["lix.sql.batch", "lix.opened"],
	);
});

void test("Atelier and MCP tool handlers are not repository_opened writers", async () => {
	const files = await Promise.all([
		readFile(
			new URL("../components/repository-atelier.tsx", import.meta.url),
			"utf8",
		),
		readFile(new URL("../mcp/server.ts", import.meta.url), "utf8"),
	]);
	for (const source of files) {
		assert.doesNotMatch(
			source,
			/captureTelemetry\(\s*["']repository_opened["']/,
		);
		assert.doesNotMatch(source, /["']repository_opened["']/);
	}
});
