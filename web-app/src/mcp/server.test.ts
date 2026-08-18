import assert from "node:assert/strict";
import test from "node:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	createLixError,
	LixService,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type LixRuntimeClient,
} from "./lix-service.ts";
import type { ParseSqlScript } from "../lib/lix-sql-access.ts";
import { PostHog, type EventMessage } from "posthog-node";
import {
	attachMcpToolCallAnalyticsProperties,
	handleMcpTransport,
	MCP_REQUEST_ID_HEADER,
	MCP_PROTOCOL_VERSION,
	MCP_RESOURCE,
	mcpAuthenticateChallenge,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	redactMcpAnalyticsEvent,
	requestIdForMcpRequest,
	sqlOpFromMcpToolArguments,
	withMcpRequestId,
	protectedResourceMetadataResponse,
} from "./server.ts";
import {
	observeExecuteInput,
	observeExecuteOutput,
} from "./tool-observation.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const parseSqlScript: ParseSqlScript = (sql) => ({
	statements: sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean)
		.map((statement) => ({ sql: statement })),
});

function sqlPayloadFromText(text: string): unknown {
	const withoutContext = text.replace(/\s*context=\S+\s*$/, "");
	const jsonStart = withoutContext.search(/[[{]/);
	assert.ok(jsonStart >= 0, `expected JSON SQL result in text: ${text}`);
	return JSON.parse(withoutContext.slice(jsonStart));
}

class FakeRuntime implements LixRuntimeClient {
	async listLixes() {
		return [
			{
				id: LIX_ID,
				name: "Company",
				slug: "company",
				namespace: { id: "n", name: "Acme", handle: "acme" },
			},
		];
	}
	async activeBranchId(_lixId: string, branchId?: string) {
		return branchId ?? "main";
	}
	async switchBranch(_lixId: string, branchId: string) {
		return { branchId };
	}
	async execute(_lixId: string, _branchId: string, request: ExecuteRequest) {
		if (request.sql === "SELECT internal_error") {
			throw new Error("private implementation detail");
		}
		if (request.sql === "SELECT error") {
			throw createLixError(
				"LIX_UNSUPPORTED_SQL",
				"This SQL statement is not supported.",
				{
					details: { operation: "execute" },
					hint: "Use SELECT 1 instead.",
				},
			);
		}
		if (request.sql.includes("lix_active_branch_commit_id")) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: "commit-1" }]],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (/FROM lix_file\b/i.test(request.sql)) {
			return {
				columns: ["path", "name"],
				rows: [
					[
						{ kind: "text" as const, value: "/skills/hello.md" },
						{ kind: "text" as const, value: "hello.md" },
					],
				],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(request.sql)) {
			return {
				columns: [],
				rows: [],
				rowsAffected: 1,
				notices: [],
			};
		}
		return {
			columns: ["value"],
			rows: [[{ kind: "text" as const, value: "ok" }]],
			rowsAffected: 0,
			notices: [],
		};
	}
	async executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	) {
		return {
			results: await Promise.all(
				request.statements.map((statement) =>
					this.execute(lixId, branchId, statement),
				),
			),
		};
	}
	async createBranch() {
		return { id: "draft", name: "Draft", hidden: false, commitId: "commit-1" };
	}
	async createCheckpoint() {
		return { commitId: "commit-1" };
	}
	async undo() {
		return {
			branchId: "main",
			targetCommitId: "old",
			inverseCommitId: "inverse",
		};
	}
	async redo() {
		return {
			branchId: "main",
			targetCommitId: "next",
			replayCommitId: "replay",
		};
	}
	async mergeBranchPreview() {
		return { outcome: "alreadyUpToDate" };
	}
	async mergeBranch() {
		return { outcome: "mergeCommitted" };
	}
}

void test("discovery helpers advertise the modern stateless contract", async () => {
	assert.equal(MCP_PROTOCOL_VERSION, "2026-07-28");
	assert.match(mcpAuthenticateChallenge(), /resource_metadata=/);
	assert.deepEqual(
		await protectedResourceMetadataResponse({
			authorizationServer: "https://auth.example",
		}).json(),
		{
			resource: MCP_RESOURCE,
			authorization_servers: ["https://auth.example"],
			scopes_supported: ["openid", "email", "profile"],
			resource_documentation: "https://lixray.com/mcp/docs",
		},
	);
	assert.match(
		await mcpDocumentationResponse().text(),
		/server\/discover|X-Request-ID/,
	);
	assert.equal(mcpUnauthorizedResponse().status, 401);
});

void test("PostHog MCP analytics redaction removes private payloads", () => {
	const event = redactMcpAnalyticsEvent({
		event: "$mcp_tool_call",
		properties: {
			$mcp_parameters: { context: "signed-context", sql: "SELECT secret" },
			$mcp_response: { rows: [["secret"]] },
			$mcp_error_message: "private error",
			$exception_list: [{ stack: "private stack" }],
			mcp_tool_name: "query_sql",
		},
	});
	assert.deepEqual(event.properties, { mcp_tool_name: "query_sql" });
});

void test("sql_op is derived from SQL tool arguments before the tool runs", () => {
	assert.equal(
		sqlOpFromMcpToolArguments("query_sql", { sql: "SELECT 1" }),
		"SELECT",
	);
	assert.equal(
		sqlOpFromMcpToolArguments("execute_sql", {
			statements: [{ sql: "INSERT INTO example VALUES (1)" }],
		}),
		"INSERT",
	);
	assert.equal(sqlOpFromMcpToolArguments("list_lixes", {}), undefined);
	assert.equal(sqlOpFromMcpToolArguments("query_sql", { sql: "" }), undefined);
});

void test("success MCP tool observations attach request_id sql_op and success", () => {
	const executeInput = observeExecuteInput([{ sql: "SELECT 1" }]);
	const executeOutput = observeExecuteOutput({
		results: [{ columns: ["value"], rows: [[{ kind: "text", value: "ok" }]] }],
	});
	assert.ok(executeInput);
	assert.ok(executeOutput);
	const properties: Record<string, unknown> = { request_id: "req-success" };
	attachMcpToolCallAnalyticsProperties(properties, {
		requestId: "req-success",
		toolName: "query_sql",
		outcome: "success",
		durationMs: 4,
		surfaceVersion: "fnv1a32:test",
		executeInput,
		executeOutput,
	});
	assert.equal(properties.success, true);
	assert.equal(properties.request_id, "req-success");
	assert.equal(properties.sql_op, "SELECT");
	assert.equal(properties.error_code, undefined);
	assert.equal(properties.file_path, undefined);
	assert.equal(properties.file_extension, undefined);
});

void test("failure MCP tool observations attach success false and error_code", () => {
	const executeInput = observeExecuteInput([{ sql: "SELECT error" }]);
	assert.ok(executeInput);
	const properties: Record<string, unknown> = { request_id: "req-failure" };
	attachMcpToolCallAnalyticsProperties(properties, {
		requestId: "req-failure",
		toolName: "query_sql",
		outcome: "error",
		errorCode: "LIX_UNSUPPORTED_SQL",
		durationMs: 2,
		surfaceVersion: "fnv1a32:test",
		executeInput,
	});
	assert.equal(properties.success, false);
	assert.equal(properties.request_id, "req-failure");
	assert.equal(properties.sql_op, "SELECT");
	assert.equal(properties.error_code, "LIX_UNSUPPORTED_SQL");
	assert.equal(properties.row_count, undefined);
});

void test("missing observations still mark failure from the official MCP envelope", () => {
	const properties: Record<string, unknown> = {
		request_id: "req-fallback",
		$mcp_is_error: true,
		$mcp_response: {
			isError: true,
			structuredContent: { error: { code: "invalid_request" } },
		},
	};
	attachMcpToolCallAnalyticsProperties(properties, undefined);
	assert.equal(properties.success, false);
	assert.equal(properties.error_code, "invalid_request");
});

void test("official $mcp_tool_call emits success and failure with the four P0 fields", async () => {
	const interceptor = interceptPosthogCaptures();
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const requestIds: Array<string> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		const response = await handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Telemetry_Test",
			parseSqlScript,
			posthogToken: "phc_test_token",
			posthogDistinctId: "user-felix",
			posthogClientId: "oauth-client",
			requestId: `felix-${requestIds.length + 1}`,
		});
		requestIds.push(response.headers.get("x-request-id") ?? "");
		return response;
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "lixray-telemetry-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const context = (opened.structuredContent as { context: string }).context;
		const succeeded = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1" },
		});
		assert.equal(succeeded.isError, undefined);
		const failed = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT error" },
		});
		assert.equal(failed.isError, true);
	} finally {
		await client.close();
		interceptor.restore();
	}

	const toolCalls = interceptor.events.filter(
		(event) => event.event === "$mcp_tool_call",
	);
	assert.equal(
		interceptor.events.some((event) => event.event === "mcp_tool_called"),
		false,
	);
	assert.ok(
		toolCalls.length >= 3,
		`expected open_lix + success + failure $mcp_tool_call, got ${toolCalls
			.map((event) => event.properties?.$mcp_tool_name)
			.join(",")}`,
	);

	const openLix = toolCalls.find(
		(event) => event.properties?.$mcp_tool_name === "open_lix",
	);
	const success = toolCalls.find(
		(event) =>
			event.properties?.$mcp_tool_name === "query_sql" &&
			event.properties?.success === true,
	);
	const failure = toolCalls.find(
		(event) =>
			event.properties?.$mcp_tool_name === "query_sql" &&
			event.properties?.success === false,
	);
	assert.ok(openLix, "open_lix must emit $mcp_tool_call");
	assert.ok(success, "successful query_sql must emit $mcp_tool_call");
	assert.ok(failure, "failed query_sql must emit $mcp_tool_call");

	assert.equal(typeof openLix.properties?.request_id, "string");
	assert.equal(openLix.properties?.success, true);
	assert.equal(openLix.properties?.sql_op, undefined);
	assert.equal(openLix.properties?.error_code, undefined);

	assert.equal(typeof success.properties?.request_id, "string");
	assert.equal(success.properties?.success, true);
	assert.equal(success.properties?.sql_op, "SELECT");
	assert.equal(success.properties?.error_code, undefined);

	assert.equal(typeof failure.properties?.request_id, "string");
	assert.equal(failure.properties?.success, false);
	assert.equal(failure.properties?.sql_op, "SELECT");
	assert.equal(failure.properties?.error_code, "LIX_UNSUPPORTED_SQL");

	for (const event of toolCalls) {
		assert.equal(event.properties?.$mcp_parameters, undefined);
		assert.equal(event.properties?.$mcp_response, undefined);
		assert.equal(event.properties?.$mcp_error_message, undefined);
		assert.equal(event.properties?.file_path, undefined);
		assert.equal(event.properties?.file_extension, undefined);
		assert.doesNotMatch(
			JSON.stringify(event.properties),
			/SELECT secret|private implementation|file_path/,
		);
	}
});

function interceptPosthogCaptures(): {
	events: Array<EventMessage>;
	restore: () => void;
} {
	const events: Array<EventMessage> = [];
	const original = PostHog.prototype.capture;
	PostHog.prototype.capture = function (event: EventMessage) {
		events.push(structuredClone(event));
	};
	return {
		events,
		restore: () => {
			PostHog.prototype.capture = original;
		},
	};
}

void test("MCP request IDs accept a valid incoming ID and expose generated IDs", () => {
	const supplied = new Request("https://lixray.test/mcp", {
		headers: { [MCP_REQUEST_ID_HEADER]: "edge-request-123" },
	});
	assert.equal(requestIdForMcpRequest(supplied), "edge-request-123");

	const response = withMcpRequestId(
		new Response("ok"),
		"generated-request-456",
	);
	assert.equal(
		response.headers.get(MCP_REQUEST_ID_HEADER),
		"generated-request-456",
	);
	assert.match(
		response.headers.get("access-control-expose-headers") ?? "",
		/X-Request-ID/,
	);
});

void test("modern MCP discover and tool calls work without a session id", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const requests: Array<Request> = [];
	const responseRequestIds: Array<string> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		requests.push(request.clone());
		const response = await handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Test",
			parseSqlScript,
		});
		responseRequestIds.push(response.headers.get("x-request-id") ?? "");
		return response;
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{
			fetch: fetcher,
		},
	);
	const client = new Client(
		{ name: "lixray-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		assert.equal(client.getProtocolEra(), "modern");
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			[
				"list_lixes",
				"open_lix",
				"query_sql",
				"execute_sql",
				"active_branch_id",
				"switch_branch",
				"create_branch",
				"create_checkpoint",
				"undo",
				"redo",
				"merge_branch_preview",
				"merge_branch",
			],
		);
		for (const tool of tools.tools) {
			assert.ok(tool.title, `${tool.name} must have a title`);
			assert.ok(tool.name.length <= 64, `${tool.name} exceeds 64 characters`);
			assert.ok(
				tool.annotations?.readOnlyHint === true ||
					tool.annotations?.destructiveHint === true,
				`${tool.name} must be read-only or destructive`,
			);
		}
		const queryTool = tools.tools.find((tool) => tool.name === "query_sql");
		const executeSqlTool = tools.tools.find(
			(tool) => tool.name === "execute_sql",
		);
		assert.ok(queryTool);
		assert.ok(executeSqlTool);
		assert.match(
			queryTool.description ?? "",
			/SQL as the universal read interface/,
		);
		assert.equal(queryTool.annotations?.readOnlyHint, true);
		assert.match(queryTool.description ?? "", /information_schema\.tables/);
		assert.equal(executeSqlTool.annotations?.destructiveHint, true);
		assert.match(
			executeSqlTool.description ?? "",
			/any ordered atomic SQL batch/,
		);
		assert.doesNotMatch(JSON.stringify(queryTool.inputSchema), /idempotency/i);
		assert.doesNotMatch(
			JSON.stringify(executeSqlTool.inputSchema),
			/idempotency/i,
		);
		assert.equal(
			tools.tools.find((tool) => tool.name === "switch_branch")?.annotations
				?.readOnlyHint,
			true,
		);
		assert.equal(
			tools.tools.find((tool) => tool.name === "undo")?.annotations
				?.destructiveHint,
			true,
		);
		assert.equal(
			tools.tools.find((tool) => tool.name === "redo")?.annotations
				?.destructiveHint,
			true,
		);
		assert.ok(!tools.tools.some((tool) => tool.name.includes("file")));
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const openedContent = opened.structuredContent as {
			context: string;
			request_id: string;
			context_expires_at: string;
			id: string;
			url: string;
		};
		const context = openedContent.context;
		assert.equal(typeof context, "string");
		assert.match(openedContent.request_id, /^[0-9a-f-]{36}$/i);
		assert.equal(openedContent.id, LIX_ID);
		assert.equal(openedContent.url, "https://lixray.com/@acme/company");
		assert.ok(Date.parse(openedContent.context_expires_at) > Date.now());
		const openedText =
			opened.content?.[0]?.type === "text" ? opened.content[0].text : "";
		assert.match(openedText, /^Opened https:\/\/lixray\.com\/@acme\/company/);
		assert.match(
			openedText,
			/context=[^\s]+/,
			"open_lix text must include context for bridges that only expose content[].text",
		);
		const extractedContext = /context=([^\s]+)/.exec(openedText)?.[1];
		assert.equal(
			extractedContext,
			context,
			"context in text content must match structuredContent",
		);
		assert.equal(responseRequestIds.at(-1), openedContent.request_id);
		const queried = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1" },
		});
		assert.equal(queried.isError, undefined);
		const queriedContent = queried.structuredContent as {
			request_id: string;
			result: { rowsAffected: number };
		};
		assert.equal(queriedContent.result.rowsAffected, 0);
		const queriedText =
			queried.content?.[0]?.type === "text" ? queried.content[0].text : "";
		assert.deepEqual(sqlPayloadFromText(queriedText), {
			columns: ["value"],
			rows: [[{ kind: "text", value: "ok" }]],
			rowsAffected: 0,
			notices: [],
		});
		assert.match(
			queriedText,
			/context=[^\s]+/,
			"query_sql text fallback must include context",
		);
		assert.equal(responseRequestIds.at(-1), queriedContent.request_id);
		const listedFiles = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT path, name FROM lix_file" },
		});
		assert.equal(listedFiles.isError, undefined);
		const listedFilesText =
			listedFiles.content?.[0]?.type === "text"
				? listedFiles.content[0].text
				: "";
		assert.match(
			listedFilesText,
			/\/skills\/hello\.md/,
			"query_sql text must include SELECT cell values, not only a row count",
		);
		assert.match(listedFilesText, /hello\.md/);
		assert.deepEqual(sqlPayloadFromText(listedFilesText), {
			columns: ["path", "name"],
			rows: [
				[
					{ kind: "text", value: "/skills/hello.md" },
					{ kind: "text", value: "hello.md" },
				],
			],
			rowsAffected: 0,
			notices: [],
		});
		assert.match(
			listedFilesText,
			/context=[^\s]+/,
			"query_sql text fallback must include context",
		);
		const mutated = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{ sql: "INSERT INTO example VALUES (1)" },
					{ sql: "SELECT 2" },
				],
			},
		});
		assert.equal(mutated.isError, undefined);
		const mutatedText =
			mutated.content?.[0]?.type === "text" ? mutated.content[0].text : "";
		assert.match(mutatedText, /^Atomic SQL completed 2 statements\. /);
		assert.deepEqual(sqlPayloadFromText(mutatedText), [
			{ columns: [], rows: [], rowsAffected: 1, notices: [] },
			{
				columns: ["value"],
				rows: [[{ kind: "text", value: "ok" }]],
				rowsAffected: 0,
				notices: [],
			},
		]);
		assert.match(
			mutatedText,
			/context=[^\s]+/,
			"execute_sql text fallback must include context",
		);
		const failed = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT error" },
		});
		assert.equal(failed.isError, true);
		const failedContent = failed.structuredContent as {
			request_id: string;
			error: Record<string, unknown>;
		};
		assert.deepEqual(failedContent.error, {
			code: "LIX_UNSUPPORTED_SQL",
			message: "This SQL statement is not supported.",
			hint: "Use SELECT 1 instead.",
			details: { operation: "execute" },
		});
		assert.equal(responseRequestIds.at(-1), failedContent.request_id);
		assert.match(
			failed.content?.[0]?.type === "text" ? failed.content[0].text : "",
			/Use SELECT 1 instead\./,
		);
		const mutationThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "DELETE FROM example" },
		});
		assert.equal(mutationThroughQuery.isError, true);
		assert.match(
			JSON.stringify(mutationThroughQuery.structuredContent),
			/Use execute_sql for non-SELECT SQL/,
		);
		const valuesThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "VALUES (1)" },
		});
		assert.equal(valuesThroughQuery.isError, true);
		assert.match(
			JSON.stringify(valuesThroughQuery.structuredContent),
			/query_sql accepts only a SELECT/,
		);
		const scriptThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1; SELECT 2" },
		});
		assert.equal(scriptThroughQuery.isError, true);
		assert.match(
			JSON.stringify(scriptThroughQuery.structuredContent),
			/requires exactly one SQL statement/,
		);
		const readThroughExecute = await client.callTool({
			name: "execute_sql",
			arguments: { context, statements: [{ sql: "SELECT 1" }] },
		});
		assert.equal(readThroughExecute.isError, undefined);
		const mixedExecute = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{ sql: "SELECT 1" },
					{ sql: "UPDATE example SET value = 2" },
				],
			},
		});
		assert.equal(mixedExecute.isError, undefined);
		const internalFailure = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT internal_error" },
		});
		assert.equal(internalFailure.isError, true);
		const internalContent = internalFailure.structuredContent as {
			request_id: string;
			error: { message: string; hint: string };
		};
		assert.equal(internalContent.error.message, "The LixRay tool call failed.");
		assert.match(internalContent.error.hint, /Retry once/);
		assert.match(internalContent.error.hint, /request_id/);
		assert.match(internalContent.error.hint, /LixRay support/);
		assert.doesNotMatch(internalContent.error.hint, /private implementation/);
		assert.ok(
			requests.length >= 4,
			"discover, tools/list, and tool calls should be separate requests",
		);
		for (const request of requests) {
			assert.equal(request.headers.has("mcp-session-id"), false);
		}
		const firstBody = await requests[0].text();
		assert.match(firstBody, /server\/discover/);
		assert.match(firstBody, /2026-07-28/);
	} finally {
		await client.close();
	}
});

void test("MCP tools preserve continuation fields in text fallback", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_TextContent_Test",
			parseSqlScript,
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "text-content-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);

		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const context = (opened.structuredContent as { context: string }).context;

		const activeBranch = await client.callTool({
			name: "active_branch_id",
			arguments: { context },
		});
		const activeBranchText =
			activeBranch.content?.[0]?.type === "text"
				? activeBranch.content[0].text
				: "";
		assert.match(
			activeBranchText,
			/Active branch.*at commit/,
			"active_branch_id must describe result",
		);
		assert.match(
			activeBranchText,
			/context=[^\s]+/,
			"active_branch_id text fallback must include context",
		);

		const switched = await client.callTool({
			name: "switch_branch",
			arguments: { context, branch_id: "main" },
		});
		const switchedText =
			switched.content?.[0]?.type === "text" ? switched.content[0].text : "";
		assert.match(
			switchedText,
			/Switched to branch/,
			"switch_branch must describe result",
		);
		assert.match(
			switchedText,
			/context=[^\s]+/,
			"switch_branch text fallback must include context",
		);
		const switchedContext = /context=([^\s]+)/.exec(switchedText)?.[1];
		assert.ok(
			switchedContext && switchedContext.length > 0,
			"switch_branch context must be extractable from text",
		);

		const created = await client.callTool({
			name: "create_branch",
			arguments: { context, name: "test-branch" },
		});
		const createdText =
			created.content?.[0]?.type === "text" ? created.content[0].text : "";
		assert.match(
			createdText,
			/Created branch/,
			"create_branch must describe result",
		);
		assert.match(
			createdText,
			/context=[^\s]+/,
			"create_branch text fallback must include context",
		);

		const checkpoint = await client.callTool({
			name: "create_checkpoint",
			arguments: { context },
		});
		const checkpointText =
			checkpoint.content?.[0]?.type === "text"
				? checkpoint.content[0].text
				: "";
		assert.match(
			checkpointText,
			/Checkpoint created/,
			"create_checkpoint must describe result",
		);
		assert.match(
			checkpointText,
			/context=[^\s]+/,
			"create_checkpoint text fallback must include context",
		);

		const undone = await client.callTool({
			name: "undo",
			arguments: { context },
		});
		const undoneText =
			undone.content?.[0]?.type === "text" ? undone.content[0].text : "";
		assert.match(undoneText, /Undone to commit/, "undo must describe result");
		assert.match(
			undoneText,
			/context=[^\s]+/,
			"undo text fallback must include context",
		);

		const redone = await client.callTool({
			name: "redo",
			arguments: { context },
		});
		const redoneText =
			redone.content?.[0]?.type === "text" ? redone.content[0].text : "";
		assert.match(redoneText, /Redone to commit/, "redo must describe result");
		assert.match(
			redoneText,
			/context=[^\s]+/,
			"redo text fallback must include context",
		);

		const preview = await client.callTool({
			name: "merge_branch_preview",
			arguments: { context, source_branch_id: "main" },
		});
		const previewText =
			preview.content?.[0]?.type === "text" ? preview.content[0].text : "";
		assert.match(
			previewText,
			/Merge preview/,
			"merge_branch_preview must describe result",
		);
		assert.match(
			previewText,
			/context=[^\s]+/,
			"merge_branch_preview text fallback must include context",
		);

		const merged = await client.callTool({
			name: "merge_branch",
			arguments: { context, source_branch_id: "main" },
		});
		const mergedText =
			merged.content?.[0]?.type === "text" ? merged.content[0].text : "";
		assert.match(
			mergedText,
			/Branch merged/,
			"merge_branch must describe result",
		);
		assert.match(
			mergedText,
			/context=[^\s]+/,
			"merge_branch text fallback must include context",
		);
	} finally {
		await client.close();
	}
});

void test("legacy MCP initialize and tool calls work without a session id", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const requests: Array<Request> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		requests.push(request.clone());
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Legacy_Test",
			parseSqlScript,
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{
			fetch: fetcher,
		},
	);
	const client = new Client(
		{ name: "lixray-legacy-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	try {
		await client.connect(transport);
		assert.equal(client.getProtocolEra(), "legacy");
		const tools = await client.listTools();
		assert.ok(tools.tools.some((tool) => tool.name === "query_sql"));
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const context = (opened.structuredContent as { context: string }).context;
		const queried = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1" },
		});
		assert.equal(queried.isError, undefined);
		assert.ok(
			requests.length >= 3,
			"initialize, tools/list, and tool calls should run",
		);
		for (const request of requests) {
			assert.equal(request.headers.has("mcp-session-id"), false);
		}
		const firstBody = await requests[0].text();
		assert.match(firstBody, /initialize/);
		assert.doesNotMatch(firstBody, /server\/discover/);
	} finally {
		await client.close();
	}
});
