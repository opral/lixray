import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import type { McpToolCallObservation } from "../mcp/server.ts";
import { createMcpTelemetrySession } from "./mcp-telemetry.ts";

void test("MCP telemetry captures privacy-safe production tool usage", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: " project-token ",
			POSTHOG_HOST: " https://posthog.example ",
			POSTHOG_ENVIRONMENT: "production",
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
		toolName: "read_file",
		outcome: "success",
		durationMs: 12,
		workspaceId: "11111111-1111-4111-8111-111111111111",
		path: "/private.txt",
		sql: "select secret from private_table",
		result: "private result",
	} as McpToolCallObservation);
	await session.flush();

	assert.equal(shutdowns, 1);
	assert.deepEqual(captured, [
		{
			distinctId: "user-123",
			event: "mcp_tool_called",
			properties: {
				tool_name: "read_file",
				outcome: "success",
				duration_ms: 12,
				oauth_client_id: "oauth-client-456",
				environment: "production",
				workspace_id: "11111111-1111-4111-8111-111111111111",
			},
			groups: {
				workspace: "11111111-1111-4111-8111-111111111111",
			},
		},
	]);
});

void test("MCP telemetry records error codes without workspace grouping", async () => {
	const captured: Array<EventMessage> = [];
	const session = createMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
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
		toolName: "read_file",
		outcome: "error",
		errorCode: "invalid_arguments",
		durationMs: 0,
	});
	await session.flush();

	assert.deepEqual(captured[0]?.properties, {
		tool_name: "read_file",
		outcome: "error",
		duration_ms: 0,
		oauth_client_id: "oauth-client-456",
		environment: "production",
		error_code: "invalid_arguments",
	});
	assert.equal(captured[0]?.groups, undefined);
});

void test("MCP telemetry captures execute SQL without bound parameters", async () => {
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
		toolName: "execute",
		outcome: "success",
		durationMs: 4,
		workspaceId: "11111111-1111-4111-8111-111111111111",
		sql: "SELECT value FROM lix_key_value WHERE key = $1",
		params: [{ kind: "text", value: "private-bound-value" }],
	} as McpToolCallObservation);
	await session.flush();

	assert.deepEqual(captured[0]?.properties, {
		tool_name: "execute",
		outcome: "success",
		duration_ms: 4,
		oauth_client_id: "oauth-client-456",
		environment: "production",
		workspace_id: "11111111-1111-4111-8111-111111111111",
		sql: "SELECT value FROM lix_key_value WHERE key = $1",
	});
	assert.doesNotMatch(JSON.stringify(captured), /private-bound-value|params/);
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
			toolName: "list_workspaces",
			outcome: "success",
			durationMs: 1,
		}),
	);
	await assert.doesNotReject(session.flush());
	assert.deepEqual(warnings, [
		"Failed to capture MCP telemetry",
		"Failed to shut down MCP telemetry",
	]);
});
