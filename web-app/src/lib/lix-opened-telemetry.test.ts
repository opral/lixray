import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	ANONYMOUS_LIX_ACCOUNT_ID,
	createLixOpenedOnSpan,
	identifiedDistinctId,
	repositoryOpenedAiSpanFromLixSpan,
} from "./lix-opened-telemetry.ts";

const FORBIDDEN_OPEN_PRODUCT_EVENTS = [
	"repository_opened",
	"lixray_repository_opened",
	"webapp_repository_opened",
];

void test("completed lix.repository.opened span captures exactly one $ai_span", () => {
	const captured: Array<ReturnType<typeof repositoryOpenedAiSpanFromLixSpan>> =
		[];
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
			"lix.id": "legacy-must-not-map",
			"lix.account_id": "user-123",
		},
	});
	onSpan({
		name: "lix.repository.opened",
		traceId: "trace-1",
		spanId: "span-1",
		attributes: {
			"lix.id": "lix-1",
			"lix.branch_id": "branch-1",
			"lix.account_id": "user-123",
		},
	});

	assert.deepEqual(captured, [
		{
			event: "$ai_span",
			distinctId: "user-123",
			properties: {
				$ai_span_name: "lix.repository.opened",
				$ai_trace_id: "trace-1",
				$ai_span_id: "span-1",
				lix_id: "lix-1",
				branch_id: "branch-1",
				repository_id: "lix-1",
				environment: "production",
				source: "web",
			},
		},
	]);
	assert.equal(
		captured[0]?.properties && "$ai_latency" in captured[0].properties,
		false,
	);
});

void test("engine start.name lix.repository.opened maps the same $ai_span", () => {
	assert.deepEqual(
		repositoryOpenedAiSpanFromLixSpan(
			{
				name: "callback",
				start: {
					name: "lix.repository.opened",
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
			event: "$ai_span",
			distinctId: "user-123",
			properties: {
				$ai_span_name: "lix.repository.opened",
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
		repositoryOpenedAiSpanFromLixSpan(
			{
				name: "lix.repository.opened",
				attributes: {
					"lix.id": "lix-1",
					"lix.account_id": ANONYMOUS_LIX_ACCOUNT_ID,
				},
			},
			{ environment: "production", source: "server" },
		),
		null,
	);
});

void test("Atelier, MCP tools, and bind hooks are not open-repo product writers", async () => {
	const files = await Promise.all([
		readFile(
			new URL("../components/repository-atelier.tsx", import.meta.url),
			"utf8",
		),
		readFile(new URL("../mcp/server.ts", import.meta.url), "utf8"),
		readFile(new URL("../mcp/lix-service.ts", import.meta.url), "utf8"),
		readFile(new URL("../worker/handler.ts", import.meta.url), "utf8"),
	]);
	for (const source of files) {
		for (const eventName of FORBIDDEN_OPEN_PRODUCT_EVENTS) {
			assert.doesNotMatch(source, new RegExp(`["']${eventName}["']`));
			assert.doesNotMatch(
				source,
				new RegExp(`captureTelemetry\\(\\s*["']${eventName}["']`),
			);
		}
	}
});
