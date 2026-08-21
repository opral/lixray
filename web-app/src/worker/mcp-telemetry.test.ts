import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import { createLixEngineTelemetrySession } from "./mcp-telemetry.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

void test("Lix engine telemetry forwards a Lix SQL span, never mcp.*", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createLixEngineTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: " project-token ",
			POSTHOG_HOST: " https://posthog.example ",
			POSTHOG_ENVIRONMENT: "production",
			RAILWAY_GIT_COMMIT_SHA: "worker-version-123",
		},
		{ userId: "user-123" },
		{
			createClient: (token, options) => {
				assert.equal(token, "project-token");
				assert.deepEqual(options, {
					host: "https://posthog.example",
					flushAt: 1,
					flushInterval: 0,
				});
				return {
					captureImmediate: async (event) => {
						captured.push(structuredClone(event));
					},
					shutdown: async () => {
						shutdowns += 1;
					},
				};
			},
		},
	);
	assert.ok(session);

	session.onSpan({
		schemaVersion: 2,
		name: "lix.sql.batch",
		traceId: "trace-lix",
		spanId: "span-lix",
		parentSpanId: "parent-lix",
		durationMs: 42,
		status: "ok",
		attributes: { "lix.id": LIX_ID, "lix.execution.kind": "batch" },
	});
	session.onSpan({
		name: "mcp.execute_sql",
		traceId: "invented",
		spanId: "invented",
		durationMs: 279,
		status: "ok",
	});
	session.onSpan({
		name: "mcp.open_lix",
		durationMs: 10,
		status: "ok",
	});
	session.onSpan({
		name: "mcp.create_checkpoint",
		durationMs: 10,
		status: "ok",
	});
	await session.flush();

	assert.equal(shutdowns, 1);
	assert.equal(captured.length, 1);
	const event = captured[0];
	assert.equal(event?.distinctId, "user-123");
	assert.equal(event?.event, "$ai_span");
	assert.deepEqual(event?.groups, { lix: LIX_ID });
	assert.deepEqual(event?.properties, {
		$ai_span_name: "lix.sql.batch",
		$ai_latency: 0.042,
		$ai_is_error: false,
		$ai_trace_id: "trace-lix",
		$ai_span_id: "span-lix",
		$ai_parent_id: "parent-lix",
		lix_attributes: { "lix.id": LIX_ID, "lix.execution.kind": "batch" },
		environment: "production",
		release_id: "worker-version-123",
	});
	assert.doesNotMatch(
		JSON.stringify(captured),
		/mcp\.execute_sql|mcp\.open_lix|mcp\.create_checkpoint/,
	);
});

void test("Lix engine telemetry records Lix errors without inventing ids", async () => {
	const captured: Array<EventMessage> = [];
	const session = createLixEngineTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
			LIXRAY_RELEASE_ID: "release-456",
		},
		{ userId: "user-123" },
		{
			createClient: (_token, options) => {
				assert.equal(options.host, "https://us.i.posthog.com");
				return {
					captureImmediate: async (event) => {
						captured.push(structuredClone(event));
					},
					shutdown: async () => undefined,
				};
			},
		},
	);
	assert.ok(session);

	session.onSpan({
		schemaVersion: 1,
		name: "lix.sql.query",
		durationMs: 4,
		status: "error",
		attributes: { "error.type": "LIX_UNSUPPORTED_SQL" },
	});
	await session.flush();

	assert.equal(captured[0]?.event, "$ai_span");
	assert.equal(captured[0]?.properties?.$ai_span_name, "lix.sql.query");
	assert.equal(captured[0]?.properties?.$ai_is_error, true);
	assert.equal(captured[0]?.properties?.$ai_trace_id, undefined);
	assert.equal(captured[0]?.properties?.$ai_span_id, undefined);
	assert.equal(captured[0]?.properties?.release_id, "release-456");
	assert.equal(captured[0]?.groups, undefined);
});

void test("lix.opened is not a timed $ai_span product event", async () => {
	const captured: Array<EventMessage> = [];
	const session = createLixEngineTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123" },
		{
			createClient: () => ({
				captureImmediate: async (event) => {
					captured.push(structuredClone(event));
				},
				shutdown: async () => undefined,
			}),
		},
	);
	assert.ok(session);
	session.onSpan({
		name: "lix.opened",
		durationMs: 15,
		status: "ok",
		attributes: { "lix.id": LIX_ID, "lix.account_id": "user-123" },
	});
	await session.flush();
	assert.equal(captured.length, 0);
});

void test("Lix engine telemetry is disabled without production configuration", () => {
	let clientCreations = 0;
	const createClient = () => {
		clientCreations += 1;
		throw new Error("client should not be created");
	};

	assert.equal(
		createLixEngineTelemetrySession(
			{ POSTHOG_ENVIRONMENT: "production" },
			{ userId: "user-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createLixEngineTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "preview",
			},
			{ userId: "user-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createLixEngineTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "production",
			},
			{ userId: "demo", isDemo: true },
			{ createClient },
		),
		null,
	);
	assert.equal(clientCreations, 0);
});

void test("Lix engine telemetry treats Railway or Vite production as production", async () => {
	const captured: Array<EventMessage> = [];
	const createClient = () => ({
		captureImmediate: async (event: EventMessage) => {
			captured.push(structuredClone(event));
		},
		shutdown: async () => undefined,
	});

	const railwaySession = createLixEngineTelemetrySession(
		{
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_token",
			RAILWAY_ENVIRONMENT_NAME: "production",
		},
		{ userId: "user-123" },
		{ createClient },
	);
	assert.ok(railwaySession);
	railwaySession.onSpan({
		name: "lix.sql.query",
		durationMs: 1,
		status: "ok",
	});
	await railwaySession.flush();
	assert.equal(captured[0]?.event, "$ai_span");
	assert.equal(captured[0]?.properties?.$ai_span_name, "lix.sql.query");

	const viteSession = createLixEngineTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			VITE_PUBLIC_TELEMETRY_ENVIRONMENT: "production",
		},
		{ userId: "user-123" },
		{ createClient },
	);
	assert.ok(viteSession);
});

void test("PostHog delivery failures do not escape the telemetry session", async () => {
	const warnings: Array<string> = [];
	const session = createLixEngineTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123" },
		{
			createClient: () => ({
				captureImmediate: async () => {
					throw new Error("capture unavailable");
				},
				shutdown: async () => {
					throw new Error("shutdown unavailable");
				},
			}),
			warn: (message) => warnings.push(message),
		},
	);
	assert.ok(session);

	assert.doesNotThrow(() =>
		session.onSpan({
			name: "lix.sql.query",
			durationMs: 1,
			status: "ok",
		}),
	);
	await assert.doesNotReject(session.flush());
	assert.deepEqual(warnings, [
		"Failed to capture Lix engine telemetry",
		"Failed to shut down Lix engine telemetry",
	]);
});

void test("worker MCP telemetry source does not invent mcp.* $ai_span names", async () => {
	const source = await readFile(
		new URL("./mcp-telemetry.ts", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /mcp\.\$\{/);
	assert.doesNotMatch(source, /\$ai_span_name:\s*`mcp\./);
	assert.match(source, /createLixEngineTelemetrySession/);
	assert.doesNotMatch(source, /createMcpTelemetrySession/);
});
