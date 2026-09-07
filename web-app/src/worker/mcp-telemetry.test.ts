import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	observeExecuteInput,
	observeExecuteOutput,
} from "../mcp/tool-observation.ts";
import { createMcpTelemetrySession } from "./mcp-telemetry.ts";

const SURFACE_VERSION = "fnv1a32:1234abcd";
const LIX_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "request-123";

void test("MCP telemetry captures a PostHog AI span for production tool usage", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: " project-token ",
			POSTHOG_HOST: " https://posthog.example ",
			POSTHOG_ENVIRONMENT: "production",
			RAILWAY_GIT_COMMIT_SHA: "worker-version-123",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
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

	session.onToolCall({
		requestId: REQUEST_ID,
		toolName: "list_lixes",
		outcome: "success",
		durationMs: 12,
		surfaceVersion: SURFACE_VERSION,
		lixId: LIX_ID,
	});
	await session.flush();

	assert.equal(shutdowns, 1);
	assert.equal(captured.length, 1);
	const event = captured[0];
	assert.equal(event?.distinctId, "user-123");
	assert.equal(event?.event, "$ai_span");
	assert.deepEqual(event?.groups, { lix: LIX_ID });
	assert.match(String(event?.properties?.$ai_trace_id), UUID_PATTERN);
	assert.match(String(event?.properties?.$ai_span_id), UUID_PATTERN);
	assert.deepEqual(omitIds(event?.properties), {
		$ai_span_name: "mcp.list_lixes",
		$ai_latency: 0.012,
		$ai_is_error: false,
		mcp_server: "lixray",
		mcp_tool: "list_lixes",
		request_id: REQUEST_ID,
		outcome: "success",
		duration_ms: 12,
		oauth_client_id: "oauth-client-456",
		environment: "production",
		release_id: "worker-version-123",
		mcp_surface_version: SURFACE_VERSION,
		lix_id: LIX_ID,
	});
});

void test("MCP telemetry records trace errors without lix grouping", async () => {
	const captured: Array<EventMessage> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
			LIXRAY_RELEASE_ID: "release-456",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
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

	session.onToolCall({
		requestId: REQUEST_ID,
		toolName: "query_sql",
		outcome: "error",
		errorCode: "invalid_arguments",
		durationMs: 0,
		surfaceVersion: SURFACE_VERSION,
	});
	await session.flush();

	assert.equal(captured[0]?.event, "$ai_span");
	assert.equal(captured[0]?.properties?.$ai_is_error, true);
	assert.equal(captured[0]?.properties?.request_id, REQUEST_ID);
	assert.deepEqual(captured[0]?.properties?.$ai_error, {
		code: "invalid_arguments",
	});
	assert.equal(captured[0]?.properties?.error_code, "invalid_arguments");
	assert.equal(captured[0]?.properties?.release_id, "release-456");
	assert.equal(captured[0]?.groups, undefined);
});

void test("MCP traces expose SQL friction without lix values or result rows", async () => {
	const captured: Array<EventMessage> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
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
	const executeInput = observeExecuteInput([
		{
			sql: "SELECT content FROM lix_file WHERE path = '/private.txt' AND id = $1",
			params: [{ kind: "text", value: "private-bound-value" }],
		},
	]);
	const executeOutput = observeExecuteOutput({
		results: [
			{
				columns: ["content"],
				rows: [[{ kind: "text", value: "private result" }]],
				rowsAffected: 0,
				notices: [
					{
						code: "LIX_HISTORY_NON_IDENTITY_FILTER",
						message: "private notice message",
					},
				],
			},
		],
	});
	assert.ok(executeInput);
	assert.ok(executeOutput);

	session.onToolCall({
		requestId: REQUEST_ID,
		toolName: "query_sql",
		outcome: "success",
		durationMs: 4,
		surfaceVersion: SURFACE_VERSION,
		lixId: LIX_ID,
		executeInput,
		executeOutput,
	});
	await session.flush();

	const properties = captured[0]?.properties;
	assert.equal(properties?.statement_count, 1);
	assert.deepEqual(properties?.sql_operations, ["SELECT"]);
	assert.deepEqual(properties?.notice_codes, [
		"LIX_HISTORY_NON_IDENTITY_FILTER",
	]);
	assert.equal(properties?.row_count, 1);
	assert.equal(properties?.rows_affected, 0);
	assert.equal(properties?.notice_count, 1);
	assert.match(
		String(
			(
				properties?.$ai_input_state as {
					statements?: Array<{ sanitizedSql?: string }>;
				}
			)?.statements?.[0]?.sanitizedSql,
		),
		/where path = \? and id = \?/,
	);
	assert.doesNotMatch(
		JSON.stringify(captured),
		/private\.txt|private-bound-value|private result|private notice message/,
	);
});

void test("MCP telemetry is disabled without production configuration", () => {
	let clientCreations = 0;
	const createClient = () => {
		clientCreations += 1;
		throw new Error("client should not be created");
	};

	assert.equal(
		createMcpTelemetrySession(
			{ POSTHOG_ENVIRONMENT: "production" },
			{ userId: "user-123", clientId: "client-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createMcpTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "preview",
			},
			{ userId: "user-123", clientId: "client-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createMcpTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "production",
			},
			{ userId: "demo", clientId: "demo", isDemo: true },
			{ createClient },
		),
		null,
	);
	assert.equal(clientCreations, 0);
});

void test("MCP telemetry treats Railway or Vite production as production", async () => {
	const captured: Array<EventMessage> = [];
	const createClient = () => ({
		captureImmediate: async (event: EventMessage) => {
			captured.push(structuredClone(event));
		},
		shutdown: async () => undefined,
	});

	const railwaySession = createMcpTelemetrySession(
		{
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_token",
			RAILWAY_ENVIRONMENT_NAME: "production",
		},
		{ userId: "user-123", clientId: "client-123" },
		{ createClient },
	);
	assert.ok(railwaySession);
	railwaySession.onToolCall({
		requestId: REQUEST_ID,
		toolName: "list_lixes",
		outcome: "success",
		durationMs: 1,
		surfaceVersion: SURFACE_VERSION,
	});
	await railwaySession.flush();
	assert.equal(captured[0]?.event, "$ai_span");

	const viteSession = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			VITE_PUBLIC_TELEMETRY_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "client-123" },
		{ createClient },
	);
	assert.ok(viteSession);
});

void test("PostHog delivery failures do not escape the telemetry session", async () => {
	const warnings: Array<string> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "client-123" },
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
		session.onToolCall({
			requestId: REQUEST_ID,
			toolName: "list_lixes",
			outcome: "success",
			durationMs: 1,
			surfaceVersion: SURFACE_VERSION,
		}),
	);
	await assert.doesNotReject(session.flush());
	assert.deepEqual(warnings, [
		"Failed to capture MCP telemetry",
		"Failed to shut down MCP telemetry",
	]);
});

void test("open_lix emits an MCP wall-clock span", async () => {
	const captured: Array<EventMessage> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
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
	session.onToolCall({
		requestId: REQUEST_ID,
		toolName: "open_lix",
		outcome: "success",
		durationMs: 42,
		surfaceVersion: SURFACE_VERSION,
		lixId: LIX_ID,
	});
	await session.flush();
	assert.equal(captured.length, 1);
	assert.equal(captured[0]?.event, "$ai_span");
	assert.equal(captured[0]?.properties?.$ai_span_name, "mcp.open_lix");
	assert.equal(captured[0]?.properties?.$ai_latency, 0.042);
});

void test("MCP telemetry joins an upstream trace and session", async () => {
	const captured: Array<EventMessage> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
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
	session.onToolCall({
		requestId: REQUEST_ID,
		toolName: "query_sql",
		outcome: "success",
		durationMs: 7,
		surfaceVersion: SURFACE_VERSION,
		traceId: "trace-upstream-123",
		parentId: "parent-upstream-456",
		sessionId: "conversation-789",
	});
	await session.flush();
	assert.equal(captured[0]?.properties?.$ai_trace_id, "trace-upstream-123");
	assert.equal(captured[0]?.properties?.$ai_parent_id, "parent-upstream-456");
	assert.equal(captured[0]?.properties?.$ai_session_id, "conversation-789");
});

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function omitIds(
	properties: EventMessage["properties"],
): Record<string, unknown> {
	const rest = { ...(properties ?? {}) };
	delete rest.$ai_trace_id;
	delete rest.$ai_span_id;
	return rest;
}

void test("request failures produce a root trace without private exception payloads", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "token",
			POSTHOG_ENVIRONMENT: "production",
			LIXRAY_RELEASE_ID: "release",
		},
		{ userId: "anonymous-request", clientId: "unknown" },
		{
			createClient: () => ({
				captureImmediate: async (event) => {
					captured.push(event);
				},
				shutdown: async () => {
					shutdowns++;
				},
			}),
		},
	);
	assert.ok(session?.onTransport);
	for (const stage of ["authentication", "setup", "transport"] as const) {
		session.onTransport({
			requestId: REQUEST_ID,
			traceId: "trace-123",
			sessionId: "session-123",
			durationMs: 25,
			statusCode: 500,
			outcome: "error",
			errorCode: "-32603",
			stage,
			...{ message: "secret SQL and credentials", body: "private document" },
		});
	}
	await session.flush();
	assert.equal(shutdowns, 1);
	assert.equal(captured.length, 3);
	for (const event of captured) {
		assert.equal(event.event, "$ai_trace");
		assert.equal(event.properties?.$ai_trace_id, "trace-123");
		assert.equal(event.properties?.$ai_session_id, "session-123");
		assert.equal(event.properties?.request_id, REQUEST_ID);
		assert.equal(event.properties?.http_status, 500);
		assert.equal(event.properties?.$ai_is_error, true);
		assert.equal(event.properties?.release_id, "release");
		assert.doesNotMatch(
			JSON.stringify(event),
			/secret|credentials|private document/,
		);
	}
	assert.deepEqual(
		captured.map((event) => String(event.properties?.failure_stage)),
		["authentication", "setup", "transport"],
	);
});

void test("request telemetry captures are awaited and failures are contained", async () => {
	const warnings: string[] = [];
	let finish: (() => void) | undefined;
	let shutdown = false;
	const session = createMcpTelemetrySession(
		{ POSTHOG_PROJECT_TOKEN: "token", POSTHOG_ENVIRONMENT: "production" },
		{ userId: "user", clientId: "client" },
		{
			createClient: () => ({
				captureImmediate: () =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
				shutdown: async () => {
					shutdown = true;
					throw new Error("offline");
				},
			}),
			warn: (message) => warnings.push(message),
		},
	);
	assert.ok(session?.onTransport);
	session.onTransport({
		requestId: REQUEST_ID,
		traceId: "trace",
		durationMs: 1,
		statusCode: 200,
		outcome: "success",
		stage: "transport",
	});
	const flushing = session.flush();
	assert.equal(shutdown, false);
	assert.ok(finish);
	finish();
	await flushing;
	assert.equal(shutdown, true);
	assert.deepEqual(warnings, ["Failed to shut down MCP telemetry"]);
});
