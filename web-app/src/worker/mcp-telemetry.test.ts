import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	observeExecuteInput,
	observeExecuteOutput,
} from "../mcp/tool-observation.ts";
import {
	createMcpTelemetrySession,
	type McpRequestObservation,
	type McpTelemetrySession,
} from "./mcp-telemetry.ts";

const SURFACE_VERSION = "fnv1a32:1234abcd";
const LIX_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "22222222-2222-4222-8222-222222222222";

void test("MCP telemetry captures a PostHog AI span for production tool usage", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: " project-token ",
			POSTHOG_HOST: " https://posthog.example ",
			POSTHOG_ENVIRONMENT: "production",
			CF_VERSION_METADATA: { id: "worker-version-123" },
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
		toolName: "list_lixes",
		outcome: "success",
		durationMs: 12,
		surfaceVersion: SURFACE_VERSION,
		lixResolutionDurationMs: 4,
		storageExecutionDurationMs: 5,
		lixId: LIX_ID,
	});
	completeRequest(session);
	await session.flush();

	assert.equal(shutdowns, 1);
	assert.equal(captured.length, 1);
	const event = captured[0];
	assert.equal(event?.distinctId, "user-123");
	assert.equal(event?.event, "$ai_span");
	assert.deepEqual(event?.groups, { lix: LIX_ID });
	assert.equal(event?.properties?.$ai_trace_id, TRACE_ID);
	assert.match(String(event?.properties?.$ai_span_id), UUID_PATTERN);
	assert.deepEqual(omitSpanId(event?.properties), {
		$ai_trace_id: TRACE_ID,
		$ai_span_name: "mcp.list_lixes",
		$ai_latency: 0.02,
		$ai_is_error: false,
		mcp_server: "lixray",
		mcp_trace_id: TRACE_ID,
		jsonrpc_method: "tools/call",
		mcp_client_name: "Codex",
		mcp_client_version: "1.2.3",
		mcp_protocol_version: "2025-06-18",
		authentication_duration_ms: 3,
		lix_resolution_duration_ms: 4,
		storage_execution_duration_ms: 5,
		response_serialization_duration_ms: 2,
		request_duration_ms: 20,
		response_status: 200,
		mcp_tool: "list_lixes",
		outcome: "success",
		duration_ms: 12,
		tool_duration_ms: 12,
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
		toolName: "execute",
		outcome: "error",
		errorCode: "invalid_arguments",
		durationMs: 0,
		surfaceVersion: SURFACE_VERSION,
	});
	completeRequest(session, { responseStatus: 500 });
	await session.flush();

	assert.equal(captured[0]?.event, "$ai_span");
	assert.equal(captured[0]?.properties?.$ai_is_error, true);
	assert.deepEqual(captured[0]?.properties?.$ai_error, {
		code: "invalid_arguments",
	});
	assert.equal(captured[0]?.properties?.error_code, "invalid_arguments");
	assert.equal(captured[0]?.properties?.release_id, "release-456");
	assert.equal(captured[0]?.groups, undefined);
});

void test("MCP telemetry captures safe lifecycle request metadata without tool arguments", async () => {
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

	completeRequest(session, {
		jsonRpcMethod: "initialize",
		clientName: "Claude Desktop",
		clientVersion: "2.0.0",
	});
	await session.flush();

	assert.equal(captured.length, 1);
	assert.equal(captured[0]?.properties?.$ai_span_name, "mcp.initialize");
	assert.equal(captured[0]?.properties?.mcp_tool, undefined);
	assert.equal(captured[0]?.properties?.mcp_client_name, "Claude Desktop");
	assert.equal(captured[0]?.properties?.mcp_client_version, "2.0.0");
	assert.equal(captured[0]?.properties?.jsonrpc_method, "initialize");
	assert.doesNotMatch(
		JSON.stringify(captured),
		/Bearer|access_token|arguments|params/,
	);
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
			sql: "SELECT data FROM lix_file WHERE path = '/private.txt' AND id = $1",
			params: [{ kind: "text", value: "private-bound-value" }],
		},
	]);
	const executeOutput = observeExecuteOutput({
		results: [
			{
				columns: ["data"],
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
		toolName: "execute",
		outcome: "success",
		durationMs: 4,
		surfaceVersion: SURFACE_VERSION,
		lixId: LIX_ID,
		executeInput,
		executeOutput,
	});
	completeRequest(session);
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
			toolName: "list_lixes",
			outcome: "success",
			durationMs: 1,
			surfaceVersion: SURFACE_VERSION,
		}),
	);
	completeRequest(session);
	await assert.doesNotReject(session.flush());
	assert.deepEqual(warnings, [
		"Failed to capture MCP telemetry",
		"Failed to shut down MCP telemetry",
	]);
});

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function completeRequest(
	session: McpTelemetrySession,
	overrides: Partial<McpRequestObservation> = {},
): void {
	assert.ok(session.completeRequest);
	session.completeRequest({
		traceId: TRACE_ID,
		jsonRpcMethod: "tools/call",
		clientName: "Codex",
		clientVersion: "1.2.3",
		protocolVersion: "2025-06-18",
		authenticationDurationMs: 3,
		responseSerializationDurationMs: 2,
		requestDurationMs: 20,
		responseStatus: 200,
		...overrides,
	});
}

function omitSpanId(
	properties: EventMessage["properties"],
): Record<string, unknown> {
	const rest = { ...(properties ?? {}) };
	delete rest.$ai_span_id;
	return rest;
}
