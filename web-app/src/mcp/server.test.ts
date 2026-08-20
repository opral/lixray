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
import { PostHog } from "posthog-node";
import {
	attachMcpToolCallObservationProperties,
	CREATE_CHECKPOINT_TOOL_DESCRIPTION,
	handleMcpTransport,
	MCP_REQUEST_ID_HEADER,
	MCP_PROTOCOL_VERSION,
	MCP_RESOURCE,
	MCP_SERVER_INSTRUCTIONS,
	mcpAuthenticateChallenge,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	redactMcpAnalyticsEvent,
	requestIdForMcpRequest,
	withMcpRequestId,
	protectedResourceMetadataResponse,
} from "./server.ts";
import { EXECUTE_SQL_TOOL_DESCRIPTION } from "./execute-schema.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const MCP_DOCS = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../../docs/mcp.md"),
	"utf8",
);

function assertCheckpointPolicy(text: string): void {
	assert.match(text, /user-facing/);
	assert.match(text, /do not call/i);
	assert.match(text, /after a write/i);
	assert.match(text, /agent may recommend/);
}

function sqlPayloadFromText(text: string): unknown {
	const withoutContext = text.replace(/\s*context=\S+\s*$/, "");
	const jsonStart = withoutContext.search(/[[{]/);
	assert.ok(jsonStart >= 0, `expected JSON SQL result in text: ${text}`);
	return JSON.parse(withoutContext.slice(jsonStart));
}

class FakeRuntime implements LixRuntimeClient {
	hasOpenRuntime() {
		return false;
	}
	bindSession() {}
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
		if (request.sql.includes("LIX_TYPE_MISMATCH")) {
			throw createLixError("LIX_TYPE_MISMATCH", "column expects text", {
				hint: "Bind a text value.",
			});
		}
		if (request.sql === "SELECT lix_restore($1)") {
			if (
				request.params?.[0]?.kind === "text" &&
				request.params[0].value === "missing-commit"
			) {
				throw createLixError(
					"LIX_COMMIT_NOT_FOUND",
					"Restore target commit does not exist.",
				);
			}
			return {
				columns: ["lix_restore"],
				rows: [[request.params?.[0] ?? { kind: "null" as const }]],
				rowsAffected: 0,
				notices: [],
			};
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
	assert.match(
		mcpAuthenticateChallenge(),
		/scope="openid email profile offline_access"/,
	);
	assert.deepEqual(
		await protectedResourceMetadataResponse({
			authorizationServer: "https://auth.example",
		}).json(),
		{
			resource: MCP_RESOURCE,
			authorization_servers: ["https://auth.example"],
			scopes_supported: ["openid", "email", "profile", "offline_access"],
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
			request_id: "req-1",
			success: false,
			error_code: "LIX_TYPE_MISMATCH",
		},
	});
	assert.deepEqual(event.properties, {
		mcp_tool_name: "query_sql",
		request_id: "req-1",
		success: false,
		error_code: "LIX_TYPE_MISMATCH",
	});
});

void test("observation properties attach success and error_code on both outcomes", () => {
	const failed = attachMcpToolCallObservationProperties(
		{ request_id: "fail-1" },
		{
			requestId: "fail-1",
			toolName: "execute_sql",
			outcome: "error",
			durationMs: 4,
			surfaceVersion: "test",
			errorCode: "LIX_TYPE_MISMATCH",
			lixId: LIX_ID,
			executeInput: {
				statementCount: 1,
				statements: [
					{
						index: 0,
						operation: "INSERT",
						sanitizedSql: "insert into lix_file(path,content)values(?,?)",
						shapeId: "shape",
						parameterCount: 2,
						redactedLiteralCount: 0,
						truncated: false,
					},
				],
			},
		},
	);
	assert.equal(failed.success, false);
	assert.equal(failed.error_code, "LIX_TYPE_MISMATCH");
	assert.equal(failed.sql_op, "INSERT");
	assert.equal(failed.lix_id, LIX_ID);
	assert.equal(failed.repository_id, LIX_ID);
	assert.equal(failed.request_id, "fail-1");

	const succeeded = attachMcpToolCallObservationProperties(
		{ request_id: "ok-1" },
		{
			requestId: "ok-1",
			toolName: "execute_sql",
			outcome: "success",
			durationMs: 6,
			surfaceVersion: "test",
			lixId: LIX_ID,
			executeInput: {
				statementCount: 1,
				statements: [
					{
						index: 0,
						operation: "INSERT",
						sanitizedSql: "insert into lix_file(path,content)values(?,?)",
						shapeId: "shape",
						parameterCount: 2,
						redactedLiteralCount: 0,
						truncated: false,
					},
				],
			},
			executeOutput: {
				resultCount: 1,
				rowCount: 0,
				rowsAffected: 1,
				noticeCodes: [],
				results: [],
			},
		},
	);
	assert.equal(succeeded.success, true);
	assert.equal(succeeded.error_code, undefined);
	assert.equal(succeeded.sql_op, "INSERT");
	assert.equal(succeeded.row_count, 0);
});

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
				"restore",
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
		assert.match(queryTool.description ?? "", /CAST\(\$2 AS BYTEA\)/);
		assert.match(executeSqlTool.description ?? "", /CAST\(\$2 AS BYTEA\)/);
		assert.doesNotMatch(
			queryTool.description ?? "",
			/\{"kind":"blob"/,
			"query_sql must not advertise kind blob as the default content wire value",
		);
		assert.doesNotMatch(
			executeSqlTool.description ?? "",
			/\{"kind":"blob"/,
			"execute_sql must not advertise kind blob as the default content wire value",
		);
		assert.match(executeSqlTool.description ?? "", /already saved/);
		assert.match(
			executeSqlTool.description ?? "",
			/does not require a checkpoint/,
		);
		assertCheckpointPolicy(executeSqlTool.description ?? "");
		const checkpointTool = tools.tools.find(
			(tool) => tool.name === "create_checkpoint",
		);
		assert.ok(checkpointTool);
		assert.match(checkpointTool.description ?? "", /already persist/);
		assert.match(checkpointTool.description ?? "", /not required/);
		assertCheckpointPolicy(checkpointTool.description ?? "");
		const restoreTool = tools.tools.find((tool) => tool.name === "restore");
		assert.ok(restoreTool);
		assert.match(restoreTool.description ?? "", /ancestor/);
		assert.match(restoreTool.description ?? "", /creates no commit/);
		assert.match(restoreTool.description ?? "", /does not delete/);
		assert.match(restoreTool.description ?? "", /not undoable/);
		assert.match(restoreTool.description ?? "", /undo only applies/);
		assert.match(restoreTool.description ?? "", /checkpoint-driven/);
		assert.match(
			restoreTool.description ?? "",
			/untracked rows remain unchanged/,
		);
		assert.match(restoreTool.description ?? "", /create_checkpoint returns/);
		assert.match(restoreTool.description ?? "", /no restore_checkpoint/);
		assert.equal(restoreTool.annotations?.destructiveHint, true);
		assert.equal(restoreTool.annotations?.idempotentHint, true);
		assert.match(JSON.stringify(restoreTool.inputSchema), /commit_id/);
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
		const restored = await client.callTool({
			name: "restore",
			arguments: { context, commit_id: "commit-target" },
		});
		assert.equal(restored.isError, undefined, JSON.stringify(restored));
		assert.deepEqual(restored.structuredContent, {
			context,
			branch_id: "main",
			commit_id: "commit-target",
			request_id: responseRequestIds.at(-1),
		});
		const restoredText =
			restored.content?.[0]?.type === "text" ? restored.content[0].text : "";
		assert.match(restoredText, /Restored branch main to commit commit-target/);
		assert.match(restoredText, /context=[^\s]+/);
		const failedRestore = await client.callTool({
			name: "restore",
			arguments: { context, commit_id: "missing-commit" },
		});
		assert.equal(failedRestore.isError, true);
		assert.deepEqual(
			(failedRestore.structuredContent as { error: Record<string, unknown> })
				.error,
			{
				code: "LIX_COMMIT_NOT_FOUND",
				message: "Restore target commit does not exist.",
			},
		);
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
			/query_sql rejects INSERT, UPDATE, and DELETE/,
		);
		assert.match(
			JSON.stringify(mutationThroughQuery.structuredContent),
			/Use execute_sql for writes/,
		);
		const insertThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "INSERT INTO example VALUES (1)" },
		});
		assert.equal(insertThroughQuery.isError, true);
		const updateThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "UPDATE example SET value = 2" },
		});
		assert.equal(updateThroughQuery.isError, true);
		const valuesThroughQuery = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "VALUES (1)" },
		});
		assert.equal(valuesThroughQuery.isError, undefined);
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

void test("list_lixes text lists @handle/slug and uuid for each lix", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_ListLixes_Test",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "list-lixes-text-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const listed = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(listed.isError, undefined, JSON.stringify(listed));
		const listedText =
			listed.content?.[0]?.type === "text" ? listed.content[0].text : "";
		assert.match(listedText, /@acme\/company/);
		assert.match(listedText, new RegExp(LIX_ID));
		assert.doesNotMatch(
			listedText,
			/^Found \d+ accessible Lix(?:es)?\.$/,
			"list_lixes must not regress to a count-only sentence when lixes exist",
		);
	} finally {
		await client.close();
	}
});

void test("list_lixes text is a clear sentence when no lixes exist", async () => {
	class EmptyListRuntime extends FakeRuntime {
		async listLixes() {
			return [];
		}
	}
	const service = new LixService(new EmptyListRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_ListLixes_Empty_Test",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "list-lixes-empty-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const listed = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(listed.isError, undefined, JSON.stringify(listed));
		const listedText =
			listed.content?.[0]?.type === "text" ? listed.content[0].text : "";
		assert.match(listedText, /Found 0 accessible Lixes\./);
		assert.doesNotMatch(listedText, /@/);
	} finally {
		await client.close();
	}
});

void test("checkpoint copy forbids agent-initiated checkpoints after writes", () => {
	assertCheckpointPolicy(MCP_SERVER_INSTRUCTIONS);
	assertCheckpointPolicy(CREATE_CHECKPOINT_TOOL_DESCRIPTION);
	assertCheckpointPolicy(EXECUTE_SQL_TOOL_DESCRIPTION);
	assertCheckpointPolicy(MCP_DOCS);
	assert.match(MCP_SERVER_INSTRUCTIONS, /already saved/);
	assert.match(CREATE_CHECKPOINT_TOOL_DESCRIPTION, /user explicitly asked/);
	assert.match(MCP_DOCS, /Writes persist without a\s+checkpoint/);
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

void test("failed execute_sql then successful retry both emit $mcp_tool_call", async () => {
	const captured: Array<{
		event: string;
		distinctId: string;
		properties: Record<string, unknown>;
	}> = [];
	type CaptureMethod = typeof PostHog.prototype.capture;
	type ShutdownMethod = typeof PostHog.prototype.shutdown;
	const originalCapture = PostHog.prototype.capture.bind(
		PostHog.prototype,
	) as CaptureMethod;
	const originalShutdown = PostHog.prototype.shutdown.bind(
		PostHog.prototype,
	) as ShutdownMethod;
	PostHog.prototype.capture = function capture(event) {
		const distinctId = event.distinctId;
		if (typeof distinctId !== "string") {
			throw new Error("expected PostHog capture distinctId");
		}
		captured.push({
			event: event.event,
			distinctId,
			properties: { ...(event.properties ?? {}) },
		});
		return { uuid: "test-uuid", event, distinct_id: distinctId };
	} as CaptureMethod;
	PostHog.prototype.shutdown = async function shutdown() {
		return;
	} as ShutdownMethod;

	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "felix", clientId: "codex-desktop" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Telemetry_Test",
			posthogToken: "phc_test_token",
			posthogDistinctId: "felix",
			posthogClientId: "codex-desktop",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "codex-desktop", version: "1.0.0" },
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

		const failed = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2) -- LIX_TYPE_MISMATCH",
						params: [
							{ kind: "text", value: "/skills/hello.md" },
							{ kind: "int", value: 1 },
						],
					},
				],
			},
		});
		assert.equal(failed.isError, true);
		const failedContent = failed.structuredContent as {
			request_id: string;
			error: { code: string };
		};
		assert.equal(failedContent.error.code, "LIX_TYPE_MISMATCH");

		const succeeded = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2)",
						params: [
							{ kind: "text", value: "/skills/hello.md" },
							{ kind: "text", value: "# hello\n" },
						],
					},
				],
			},
		});
		assert.equal(succeeded.isError, undefined, JSON.stringify(succeeded));
		const succeededContent = succeeded.structuredContent as {
			request_id: string;
		};

		const toolCalls = captured.filter(
			(event) => event.event === "$mcp_tool_call",
		);
		const executeCalls = toolCalls.filter(
			(event) => event.properties.$mcp_tool_name === "execute_sql",
		);
		assert.equal(
			executeCalls.length,
			2,
			`expected two execute_sql $mcp_tool_call events, got ${JSON.stringify(captured)}`,
		);

		const [first, retry] = executeCalls;
		assert.ok(first);
		assert.ok(retry);
		assert.equal(first.distinctId, "felix");
		assert.equal(retry.distinctId, "felix");
		assert.equal(first.properties.request_id, failedContent.request_id);
		assert.equal(retry.properties.request_id, succeededContent.request_id);
		assert.notEqual(first.properties.request_id, retry.properties.request_id);
		assert.equal(first.properties.lix_id, LIX_ID);
		assert.equal(retry.properties.lix_id, LIX_ID);
		assert.equal(first.properties.success, false);
		assert.equal(retry.properties.success, true);
		assert.equal(first.properties.error_code, "LIX_TYPE_MISMATCH");
		assert.equal(retry.properties.error_code, undefined);
		assert.equal(first.properties.sql_op, "INSERT");
		assert.equal(retry.properties.sql_op, "INSERT");
		assert.equal(first.properties.environment, "production");
		assert.equal(first.properties.mcp_server, "lixray");
		assert.equal(typeof first.properties.$mcp_duration_ms, "number");
		assert.equal(first.properties.duration_ms, undefined);
		assert.equal(first.properties.$ai_latency, undefined);
		assert.equal(
			first.properties.$mcp_parameters,
			undefined,
			"SQL bodies must not survive redaction",
		);
		assert.equal(first.properties.$mcp_response, undefined);
		assert.equal(first.properties.$mcp_error_message, undefined);
		assert.doesNotMatch(
			JSON.stringify(captured),
			/"mcp_tool_called"|"mcp_connected"|"file_written"/,
		);
		const mcpToolCallWriters = captured.filter(
			(event) => event.event === "$mcp_tool_call",
		);
		assert.equal(mcpToolCallWriters.length, toolCalls.length);
	} finally {
		PostHog.prototype.capture = originalCapture;
		PostHog.prototype.shutdown = originalShutdown;
		await client.close();
	}
});

type CapturedMcpEvent = {
	event: string;
	distinctId: string;
	properties: Record<string, unknown>;
};

function stubPosthogCapture(captured: CapturedMcpEvent[]): () => void {
	type CaptureMethod = typeof PostHog.prototype.capture;
	type ShutdownMethod = typeof PostHog.prototype.shutdown;
	const originalCapture = PostHog.prototype.capture.bind(
		PostHog.prototype,
	) as CaptureMethod;
	const originalShutdown = PostHog.prototype.shutdown.bind(
		PostHog.prototype,
	) as ShutdownMethod;
	PostHog.prototype.capture = function capture(event) {
		const distinctId =
			typeof event.distinctId === "string" ? event.distinctId : "anonymous";
		captured.push({
			event: event.event,
			distinctId,
			properties: { ...(event.properties ?? {}) },
		});
		return { uuid: "test-uuid", event, distinct_id: distinctId };
	} as CaptureMethod;
	PostHog.prototype.shutdown = async function shutdown() {
		return;
	} as ShutdownMethod;
	return () => {
		PostHog.prototype.capture = originalCapture;
		PostHog.prototype.shutdown = originalShutdown;
	};
}

async function drainPosthogMcp(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function assertOfficialToolCall(
	captured: CapturedMcpEvent[],
	toolName: string,
	distinctId: string,
): void {
	const match = captured.find(
		(event) =>
			event.event === "$mcp_tool_call" &&
			event.properties.$mcp_tool_name === toolName,
	);
	assert.ok(match, `expected $mcp_tool_call for ${toolName}`);
	assert.equal(match.distinctId, distinctId);
	assert.equal(typeof match.properties.$mcp_duration_ms, "number");
	assert.equal(match.properties.duration_ms, undefined);
	assert.equal(match.properties.$ai_latency, undefined);
}

void test("legacy initialize instrument() emits $mcp_tool_call for list_lixes and query_sql", async () => {
	const captured: CapturedMcpEvent[] = [];
	const restore = stubPosthogCapture(captured);
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "felix", clientId: "codex-desktop" },
	});
	const requests: Array<Request> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		requests.push(request.clone());
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Legacy_Instrument_Test",
			posthogToken: "phc_test_token",
			posthogDistinctId: "felix",
			posthogClientId: "codex-desktop",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "legacy-instrument-client", version: "1.0.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		const listLixesTool = tools.tools.find(
			(tool) => tool.name === "list_lixes",
		);
		const querySqlTool = tools.tools.find((tool) => tool.name === "query_sql");
		assert.equal(
			(listLixesTool?.inputSchema as { properties?: { context?: unknown } })
				?.properties?.context,
			undefined,
			"context: false must not inject PostHog intent context onto list_lixes",
		);
		assert.ok(
			(querySqlTool?.inputSchema as { properties?: { context?: unknown } })
				?.properties?.context,
			"query_sql must keep LixRay's signed context argument",
		);
		const listed = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(listed.isError, undefined, JSON.stringify(listed));
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const context = (opened.structuredContent as { context: string }).context;
		assert.match(context, /\S+/);
		const queried = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1" },
		});
		assert.equal(queried.isError, undefined, JSON.stringify(queried));
		await drainPosthogMcp();
		const firstBody = await requests[0]?.text();
		assert.match(firstBody ?? "", /initialize/);
		assert.ok(captured.some((event) => event.event === "$mcp_initialize"));
		assertOfficialToolCall(captured, "list_lixes", "felix");
		assertOfficialToolCall(captured, "query_sql", "felix");
	} finally {
		restore();
		await client.close();
	}
});

void test("modern 2026-07-28 instrument() emits $mcp_tool_call for list_lixes and query_sql", async () => {
	const captured: CapturedMcpEvent[] = [];
	const restore = stubPosthogCapture(captured);
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "felix", clientId: "cursor-desktop" },
	});
	const requests: Array<Request> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		requests.push(request.clone());
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_Modern_Instrument_Test",
			posthogToken: "phc_test_token",
			posthogDistinctId: "felix",
			posthogClientId: "cursor-desktop",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "modern-instrument-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		assert.equal(client.getProtocolEra(), "modern");
		const listed = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(listed.isError, undefined, JSON.stringify(listed));
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const context = (opened.structuredContent as { context: string }).context;
		const queried = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT 1" },
		});
		assert.equal(queried.isError, undefined, JSON.stringify(queried));
		await drainPosthogMcp();
		const firstBody = await requests[0]?.text();
		assert.match(firstBody ?? "", /server\/discover/);
		assert.doesNotMatch(firstBody ?? "", /"method":"initialize"/);
		assert.ok(
			captured.some((event) => event.event === "$mcp_initialize"),
			"discover must emit official $mcp_initialize",
		);
		assert.ok(
			captured.some((event) => event.event === "$mcp_tools_list"),
			"discover must emit official $mcp_tools_list",
		);
		assertOfficialToolCall(captured, "list_lixes", "felix");
		assertOfficialToolCall(captured, "query_sql", "felix");
	} finally {
		restore();
		await client.close();
	}
});
