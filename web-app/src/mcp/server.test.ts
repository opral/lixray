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
	type McpTransportObservation,
	type McpToolCallObservation,
	attachMcpToolCallObservationProperties,
	aiTraceContextForMcpRequest,
	CREATE_CHECKPOINT_TOOL_DESCRIPTION,
	handleMcpTransport,
	LIST_LIXES_TOOL_DESCRIPTION,
	MCP_REQUEST_ID_HEADER,
	MCP_AI_PARENT_ID_HEADER,
	MCP_AI_SESSION_ID_HEADER,
	MCP_AI_TRACE_ID_HEADER,
	MCP_PROTOCOL_VERSION,
	MCP_RESOURCE,
	MCP_SERVER_INSTRUCTIONS,
	GET_ENTITY_URLS_TOOL_DESCRIPTION,
	MCP_URL_GUIDE,
	OPEN_LIX_TOOL_DESCRIPTION,
	mcpAuthenticateChallenge,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	redactMcpAnalyticsEvent,
	requestIdForMcpRequest,
	withMcpRequestId,
	protectedResourceMetadataResponse,
} from "./server.ts";
import {
	EXECUTE_SQL_TOOL_DESCRIPTION,
	LIX_SQL_OPERATING_GUIDE,
} from "./execute-schema.ts";
import { CONTEXT_REOPEN_HINT, OPEN_LIX_INVENTORY_SQL } from "./lix-service.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const MCP_DOCS = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../../docs/mcp.md"),
	"utf8",
);

function assertCheckpointPolicy(text: string): void {
	assert.match(text, /meaningful milestones/);
	assert.match(text, /substantial, coherent piece of work/);
	assert.match(text, /when the user asks/);
	assert.match(text, /routine edits/);
	assert.match(text, /Do not checkpoint after every edit/);
	assert.match(text, /ask the user to manage checkpoint timing/);
	assert.match(text, /not\s+required to save changes/);
	assert.doesNotMatch(
		text,
		/only when the user|prefer leaving|named restore point|Do not call.*after a write/,
	);
}

const isSqlTool = (name: string) =>
	name === "query_sql" || name === "execute_sql";
/** Tools whose card carries a guide, not one line. */
const isGuidedTool = (name: string) =>
	isSqlTool(name) || ["list_files", "read_files", "write_files"].includes(name);

function toolText(result: {
	content?: Array<{ type: string; text?: string }>;
}): string {
	return result.content?.[0]?.type === "text"
		? (result.content[0].text ?? "")
		: "";
}

function toolTextBlocks(result: {
	content?: Array<{ type: string; text?: string }>;
}): Array<string> {
	return (result.content ?? [])
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text);
}

/** A failed call's { request_id, error }: the JSON text block, never structuredContent. */
function toolErrorContent(result: {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
}): {
	request_id: string;
	error: {
		code: string;
		message: string;
		hint?: string;
		details?: Record<string, unknown>;
	};
} {
	assert.equal(
		result.structuredContent,
		undefined,
		"error results must not carry structuredContent",
	);
	const json = toolTextBlocks(result).find((block) => block.startsWith("{"));
	assert.ok(json, "expected a JSON text block on the error result");
	return JSON.parse(json) as ReturnType<typeof toolErrorContent>;
}

function parseStructuredText(result: {
	content?: Array<{ type: string; text?: string }>;
}): unknown {
	const blocks = toolTextBlocks(result);
	assert.ok(
		blocks.length >= 2,
		"expected a later content text block with structuredContent JSON",
	);
	return JSON.parse(blocks[1] ?? "");
}

function assertTextOmitsContext(text: string, context: string): void {
	assert.doesNotMatch(text, /context=/);
	assert.ok(
		!text.includes(context),
		"prose tool text must not echo the signed context token",
	);
}

function assertStructuredTextFallback(
	result: {
		content?: Array<{ type: string; text?: string }>;
		structuredContent?: unknown;
	},
	context?: string,
): Record<string, unknown> {
	const first = toolText(result);
	if (context) {
		assertTextOmitsContext(first, context);
	} else {
		assert.doesNotMatch(first, /context=/);
	}
	const parsed = parseStructuredText(result);
	assert.deepEqual(parsed, result.structuredContent);
	return parsed as Record<string, unknown>;
}

const SHARED_GUIDE_MARKERS = [
	/lix_history\('lix_file'/,
	/information_schema\.tables/,
	/CAST\(\$2 AS BYTEA\)/,
	/ON CONFLICT \(path\) DO UPDATE/,
] as const;

class FakeRuntime implements LixRuntimeClient {
	/** Files the file tools see, by path. */
	files = new Map<
		string,
		{ id: string; base64: string; metadata: Record<string, unknown> | null }
	>([
		[
			"/skills/hello.md",
			{
				id: "22222222-2222-4222-8222-222222222222",
				base64: Buffer.from("# Hello\n", "utf8").toString("base64"),
				metadata: null,
			},
		],
	]);
	/** Target paths lix_diff reports as changed since last_seen_commit_id. */
	changedSinceLastSeen: string[] = [];
	writes: string[] = [];
	lastOriginKey: string | undefined;

	fileCount = 0;
	directoryCount = 0;
	hasOpenRuntime() {
		return false;
	}
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
	async defaultBranchId() {
		return "main";
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
		if (
			request.sql ===
			"INSERT INTO lix_restore (commit_id) VALUES ($1) RETURNING commit_id"
		) {
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
				columns: ["commit_id"],
				rows: [[request.params?.[0] ?? { kind: "null" as const }]],
				rowsAffected: 1,
				notices: [],
			};
		}
		if (request.sql === "SELECT commit_id FROM lix_create_checkpoint()") {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: "commit-1" }]],
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
		if (request.sql === OPEN_LIX_INVENTORY_SQL) {
			return {
				columns: ["file_count", "directory_count"],
				rows: [
					[
						{ kind: "int" as const, value: this.fileCount },
						{ kind: "int" as const, value: this.directoryCount },
					],
				],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (/^SELECT id, path FROM lix_file\b/.test(request.sql)) {
			return {
				columns: ["id", "path"],
				rows: [
					[
						{
							kind: "text" as const,
							value: "22222222-2222-4222-8222-222222222222",
						},
						{ kind: "text" as const, value: "/skills/hello.md" },
					],
				],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (
			/^SELECT id, path, content, lixcol_metadata FROM lix_file WHERE path IN/.test(
				request.sql,
			)
		) {
			const wanted = (request.params ?? []).flatMap((param) =>
				param.kind === "text" ? [param.value] : [],
			);
			return {
				columns: ["id", "path", "content", "lixcol_metadata"],
				rows: wanted
					.filter((path) => this.files.has(path))
					.map((path) => {
						const file = this.files.get(path)!;
						return [
							{ kind: "text" as const, value: file.id },
							{ kind: "text" as const, value: path },
							{ kind: "blob" as const, base64: file.base64 },
							file.metadata === null
								? { kind: "null" as const }
								: { kind: "json" as const, value: file.metadata },
						];
					}),
				rowsAffected: 0,
				notices: [],
			};
		}
		if (
			/^SELECT from_path, to_path FROM lix_diff\('lix_file', \$1, \$2\)/.test(
				request.sql,
			)
		) {
			const [from] = request.params ?? [];
			if (from?.kind === "text" && from.value === "unknown-commit")
				throw createLixError("LIX_COMMIT_NOT_FOUND", "commit not found");
			return {
				columns: ["from_path", "to_path"],
				rows: this.changedSinceLastSeen.map((path) => [
					{ kind: "text" as const, value: path },
					{ kind: "text" as const, value: path },
				]),
				rowsAffected: 0,
				notices: [],
			};
		}
		if (/RETURNING id, path$/.test(request.sql)) {
			const path = request.params?.[0];
			if (path?.kind !== "text") throw new Error("path param missing");
			this.lastOriginKey = request.options?.originKey;
			const content = request.params?.[1];
			const existing = this.files.get(path.value);
			const id =
				existing?.id ??
				`33333333-3333-4333-8333-${String(this.files.size + 1).padStart(12, "0")}`;
			this.files.set(path.value, {
				id,
				base64:
					content?.kind === "blob"
						? content.base64
						: content?.kind === "text"
							? Buffer.from(content.value, "utf8").toString("base64")
							: (existing?.base64 ?? ""),
				metadata: existing?.metadata ?? null,
			});
			this.writes.push(request.sql);
			return {
				columns: ["id", "path"],
				rows: [
					[
						{ kind: "text" as const, value: id },
						{ kind: "text" as const, value: path.value },
					],
				],
				rowsAffected: 1,
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
			if (/\blix_file\b/i.test(request.sql))
				this.lastOriginKey = request.options?.originKey;
			return {
				columns: [],
				rows: [],
				rowsAffected: 1,
				notices: [],
			};
		}
		// The change log for this call: the write above created hello.md.
		if (/FROM lix_change c\b/.test(request.sql)) {
			const key = request.params?.[0];
			const matches = key?.kind === "text" && key.value === this.lastOriginKey;
			return {
				columns: ["schema_key", "file_id", "row_pk", "snapshot", "file_path"],
				rows: matches
					? [
							[
								{ kind: "text" as const, value: "lix_file_descriptor" },
								{ kind: "text" as const, value: "IiIiIiIiQiKCIiIiIiIiIg" },
								{ kind: "json" as const, value: ["IiIiIiIiQiKCIiIiIiIiIg"] },
								{ kind: "text" as const, value: '{"name":"hello.md"}' },
								{ kind: "text" as const, value: "/skills/hello.md" },
							],
						]
					: [],
				rowsAffected: 0,
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
					this.execute(lixId, branchId, {
						...statement,
						options: request.options,
					}),
				),
			),
		};
	}
	async createBranch() {
		return { id: "draft", name: "Draft", hidden: false, commitId: "commit-1" };
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

void test("MCP AI trace context accepts explicit PostHog and W3C headers", () => {
	const explicit = aiTraceContextForMcpRequest(
		new Request("https://lixray.test/mcp", {
			headers: {
				[MCP_AI_TRACE_ID_HEADER]: "trace-explicit-123",
				[MCP_AI_PARENT_ID_HEADER]: "parent-explicit-456",
				[MCP_AI_SESSION_ID_HEADER]: "conversation-789",
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			},
		}),
	);
	assert.deepEqual(explicit, {
		traceId: "trace-explicit-123",
		parentId: "parent-explicit-456",
		sessionId: "conversation-789",
	});

	const w3c = aiTraceContextForMcpRequest(
		new Request("https://lixray.test/mcp", {
			headers: {
				traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
			},
		}),
	);
	assert.deepEqual(w3c, {
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		parentId: "00f067aa0ba902b7",
		sessionId: undefined,
	});
});

void test("MCP AI trace context rejects malformed or all-zero identifiers", () => {
	const context = aiTraceContextForMcpRequest(
		new Request("https://lixray.test/mcp", {
			headers: {
				[MCP_AI_TRACE_ID_HEADER]: "contains spaces",
				[MCP_AI_SESSION_ID_HEADER]: "contains/slash",
				traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
			},
		}),
	);
	assert.deepEqual(context, {
		traceId: undefined,
		parentId: undefined,
		sessionId: undefined,
	});
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
				"get_entity_urls",
				"list_files",
				"read_files",
				"write_files",
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
			assert.equal(
				typeof tool.annotations?.readOnlyHint,
				"boolean",
				`${tool.name} must declare readOnlyHint`,
			);
			assert.equal(
				typeof tool.annotations?.openWorldHint,
				"boolean",
				`${tool.name} must declare openWorldHint`,
			);
			assert.equal(
				typeof tool.annotations?.destructiveHint,
				"boolean",
				`${tool.name} must declare destructiveHint`,
			);
		}
		const queryTool = tools.tools.find((tool) => tool.name === "query_sql");
		const executeSqlTool = tools.tools.find(
			(tool) => tool.name === "execute_sql",
		);
		assert.ok(queryTool);
		assert.ok(executeSqlTool);
		assert.match(queryTool.description ?? "", /read-only SQL statement/);
		assert.equal(queryTool.annotations?.readOnlyHint, true);
		assert.equal(executeSqlTool.annotations?.destructiveHint, true);
		assert.match(executeSqlTool.description ?? "", /ordered atomic SQL batch/);
		assert.match(executeSqlTool.description ?? "", /already persisted/);
		// The two SQL tools carry their guide themselves: hosts do not
		// reliably show server instructions, and the card is what an agent
		// reads before its first query. The instructions repeat the rules.
		assert.match(queryTool.description ?? "", /information_schema\.tables/);
		assert.match(queryTool.description ?? "", /not SQLite/);
		assert.match(executeSqlTool.description ?? "", /UPDATE lix_file SET path/);
		assert.match(executeSqlTool.description ?? "", /verification SELECT/);
		assert.match(executeSqlTool.description ?? "", /create_checkpoint/);
		// The file recipe lives on write_files; the SQL cards point at it.
		const writeFilesTool = tools.tools.find(
			(tool) => tool.name === "write_files",
		);
		assert.match(writeFilesTool?.description ?? "", /last_seen_commit_id/);
		assert.match(writeFilesTool?.description ?? "", /lixcol_metadata/);
		assert.match(executeSqlTool.description ?? "", /use write_files/);
		assert.match(queryTool.description ?? "", /read_files and list_files/);
		assert.match(MCP_SERVER_INSTRUCTIONS, /verification SELECT/);
		// The listing stays bounded: the guide lives on two tools only, the
		// rest are one-liners, output schemas are success-only.
		const listingChars = JSON.stringify(tools.tools).length;
		assert.ok(
			listingChars < 34_000,
			`tools/list is ${listingChars} chars; keep it under 34k`,
		);
		for (const tool of tools.tools) {
			const limit = isGuidedTool(tool.name) ? 1_800 : 320;
			assert.ok(
				(tool.description ?? "").length <= limit,
				`${tool.name} description is ${tool.description?.length} chars`,
			);
			assert.equal(
				(tool.outputSchema as { anyOf?: unknown } | undefined)?.anyOf,
				undefined,
				`${tool.name} output schema must not carry the error branch`,
			);
		}
		for (const tool of tools.tools) {
			if (isSqlTool(tool.name)) continue;
			for (const marker of SHARED_GUIDE_MARKERS) {
				assert.doesNotMatch(
					tool.description ?? "",
					marker,
					`${tool.name} must not repeat the shared SQL guide`,
				);
			}
		}
		const checkpointTool = tools.tools.find(
			(tool) => tool.name === "create_checkpoint",
		);
		assert.ok(checkpointTool);
		assert.match(
			checkpointTool.description ?? "",
			/already saved automatically/,
		);
		assert.match(checkpointTool.description ?? "", /not required/);
		assertCheckpointPolicy(MCP_SERVER_INSTRUCTIONS);
		const restoreTool = tools.tools.find((tool) => tool.name === "restore");
		assert.ok(restoreTool);
		assert.match(restoreTool.description ?? "", /ancestor/);
		assert.match(restoreTool.description ?? "", /without creating a commit/);
		assert.match(restoreTool.description ?? "", /not undoable/i);
		assert.match(restoreTool.description ?? "", /undo only applies/);
		assert.match(restoreTool.description ?? "", /other branches are unchanged/);
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
		// The file tools are the only file-named surface; no typed CRUD beyond them.
		assert.deepEqual(
			tools.tools
				.map((tool) => tool.name)
				.filter((name) => name.includes("file")),
			["list_files", "read_files", "write_files"],
		);
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
			lix_ref: string;
			name: string;
			file_count: number;
			directory_count: number;
			empty: boolean;
		};
		const context = openedContent.context;
		assert.equal(typeof context, "string");
		assert.match(openedContent.request_id, /^[0-9a-f-]{36}$/i);
		assert.equal(openedContent.id, LIX_ID);
		assert.equal(openedContent.url, "https://lixray.test/@acme/company");
		assert.ok(Date.parse(openedContent.context_expires_at) > Date.now());
		const openedText = toolText(opened);
		assert.match(openedText, /^Opened @acme\/company \(Company\) on branch/);
		assert.match(openedText, /empty, 0 files, 0 directories/);
		assertTextOmitsContext(openedText, context);
		const openedFallback = assertStructuredTextFallback(opened, context);
		assert.equal(openedFallback.context, context);
		assert.equal(openedFallback.request_id, openedContent.request_id);
		assert.equal(openedContent.lix_ref, "@acme/company");
		assert.equal(openedContent.empty, true);
		assert.equal(openedContent.file_count, 0);
		assert.equal(openedContent.directory_count, 0);
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
		const restoredText = toolText(restored);
		assert.match(restoredText, /Restored branch main to commit commit-target/);
		assertTextOmitsContext(restoredText, context);
		const failedRestore = await client.callTool({
			name: "restore",
			arguments: { context, commit_id: "missing-commit" },
		});
		assert.equal(failedRestore.isError, true);
		assert.deepEqual(
			(toolErrorContent(failedRestore) as { error: Record<string, unknown> })
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
		const queriedText = toolText(queried);
		assert.equal(queriedText, "query_sql: 1 row");
		assertTextOmitsContext(queriedText, context);
		const queriedFallback = assertStructuredTextFallback(queried, context);
		assert.equal(queriedFallback.context, context);
		assert.deepEqual(queriedFallback.result, queriedContent.result);
		assert.deepEqual(
			(queried.structuredContent as { result: unknown }).result,
			{
				columns: ["value"],
				rows: [[{ kind: "text", value: "ok" }]],
				rowsAffected: 0,
				notices: [],
			},
		);
		assert.equal(responseRequestIds.at(-1), queriedContent.request_id);
		const listedFiles = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT path, name FROM lix_file" },
		});
		assert.equal(listedFiles.isError, undefined);
		const listedFilesText = toolText(listedFiles);
		assert.equal(listedFilesText, "query_sql: 1 row");
		assertTextOmitsContext(listedFilesText, context);
		assert.doesNotMatch(
			listedFilesText,
			/\/skills\/hello\.md/,
			"query_sql prose must not embed row dumps; rows belong in the later JSON block",
		);
		const listedFilesFallback = assertStructuredTextFallback(
			listedFiles,
			context,
		);
		assert.match(
			toolTextBlocks(listedFiles).join("\n"),
			/\/skills\/hello\.md/,
			"query_sql agent-visible text must include selected cell values",
		);
		assert.deepEqual(listedFilesFallback.result, {
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
		assert.deepEqual(
			(listedFiles.structuredContent as { result: unknown }).result,
			{
				columns: ["path", "name"],
				rows: [
					[
						{ kind: "text", value: "/skills/hello.md" },
						{ kind: "text", value: "hello.md" },
					],
				],
				rowsAffected: 0,
				notices: [],
			},
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
		const mutatedText = toolText(mutated);
		assert.equal(mutatedText, "execute_sql: 1 row affected");
		assertTextOmitsContext(mutatedText, context);
		assert.doesNotMatch(mutatedText, /\[\{/);
		const mutatedFallback = assertStructuredTextFallback(mutated, context);
		assert.equal(mutatedFallback.context, context);
		assert.deepEqual(mutatedFallback.results, [
			{ columns: [], rows: [], rowsAffected: 1, notices: [] },
			{
				columns: ["value"],
				rows: [[{ kind: "text", value: "ok" }]],
				rowsAffected: 0,
				notices: [],
			},
		]);
		assert.deepEqual(
			(mutated.structuredContent as { results: unknown }).results,
			[
				{ columns: [], rows: [], rowsAffected: 1, notices: [] },
				{
					columns: ["value"],
					rows: [[{ kind: "text", value: "ok" }]],
					rowsAffected: 0,
					notices: [],
				},
			],
		);
		const failed = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT error" },
		});
		assert.equal(failed.isError, true);
		const failedContent = toolErrorContent(failed) as {
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
			JSON.stringify(toolErrorContent(mutationThroughQuery)),
			/query_sql rejects INSERT, UPDATE, and DELETE/,
		);
		assert.match(
			JSON.stringify(toolErrorContent(mutationThroughQuery)),
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
		const internalContent = toolErrorContent(internalFailure) as {
			request_id: string;
			error: { message: string; hint: string };
		};
		assert.equal(internalContent.error.message, "The LixRay tool call failed.");
		assert.match(internalContent.error.hint, /Retry once/);
		assert.match(internalContent.error.hint, /request_id/);
		assert.match(internalContent.error.hint, /LixRay support/);

		// A host that cached the output schemas validates structuredContent
		// whenever it is present; an error must therefore carry none, or the
		// host reports a schema violation instead of the error.
		await client.listTools();
		const sqlite = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT name FROM sqlite_master" },
		});
		assert.equal(sqlite.isError, true);
		const sqliteError = toolErrorContent(sqlite);
		assert.match(sqliteError.error.message, /not SQLite/);
		assert.match(sqliteError.error.hint ?? "", /information_schema\.tables/);
		assert.match(sqliteError.error.hint ?? "", /information_schema\.columns/);
		const pragma = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [{ sql: "SELECT 1" }, { sql: "PRAGMA table_info(x)" }],
			},
		});
		assert.equal(pragma.isError, true);
		assert.match(toolErrorContent(pragma).error.message, /not SQLite/);
		const validatedFailure = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT internal_error" },
		});
		assert.equal(validatedFailure.isError, true);
		assert.equal(validatedFailure.structuredContent, undefined);
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
		const listedFallback = assertStructuredTextFallback(listed);
		assert.ok(Array.isArray(listedFallback.lixes));
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

void test("checkpoint copy encourages agent judgment at meaningful milestones", () => {
	assertCheckpointPolicy(MCP_SERVER_INSTRUCTIONS);
	assertCheckpointPolicy(MCP_DOCS);
	// The tool itself keeps only the one fact a caller needs at the call site.
	assert.match(CREATE_CHECKPOINT_TOOL_DESCRIPTION, /not required to save/);
	assert.match(MCP_SERVER_INSTRUCTIONS, /already saved/);
	assert.match(MCP_DOCS, /Writes persist without a\s+checkpoint/);
	// execute_sql states persistence and points at create_checkpoint in one
	// sentence; the policy itself is not repeated there.
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /already persisted/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /saving needs no checkpoint/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /Use judgment/);
});

void test("shipped copy tells agents not to verify writes", async () => {
	for (const text of [
		MCP_SERVER_INSTRUCTIONS,
		LIX_SQL_OPERATING_GUIDE,
		MCP_DOCS,
	]) {
		assert.match(text, /verification [`']?SELECT/);
		assert.doesNotMatch(text, /inspect the relevant rows first/);
		assert.doesNotMatch(text, /final verification SELECT is recommended/);
	}
	assert.match(MCP_SERVER_INSTRUCTIONS, /do not follow a write/i);
	assert.match(MCP_DOCS, /Do not follow a write/);
	assert.match(await mcpDocumentationResponse().text(), /verification SELECT/);
});

void test("list_lixes and open_lix descriptions stay identity- and empty-state honest", () => {
	assert.match(LIST_LIXES_TOOL_DESCRIPTION, /@handle\/slug/);
	assert.match(
		LIST_LIXES_TOOL_DESCRIPTION,
		/only when the target Lix is unknown/,
	);
	assert.match(OPEN_LIX_TOOL_DESCRIPTION, /without calling list_lixes first/);
	assert.match(OPEN_LIX_TOOL_DESCRIPTION, /file_paths/);
});

void test("shipped MCP guidance preserves the shortest read path", async () => {
	for (const text of [
		MCP_SERVER_INSTRUCTIONS,
		MCP_DOCS,
		await mcpDocumentationResponse().text(),
	]) {
		assert.match(text, /exact LixRay/i);
		assert.match(text, /open_lix/i);
		assert.match(text, /directly/i);
		assert.match(text, /list_lixes/i);
		assert.match(text, /only when the target.*unknown/is);
		assert.match(text, /file_paths_complete/);
		assert.match(text, /one parameterized/i);
	}
});

void test("MCP tool text describes outcomes without echoing the context token", async () => {
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
		const openedContent = opened.structuredContent as {
			context: string;
			lix_ref: string;
			empty: boolean;
		};
		const context = openedContent.context;
		assert.match(context, /\S+/);
		assert.equal(openedContent.lix_ref, "@acme/company");
		assert.equal(openedContent.empty, true);
		assertTextOmitsContext(toolText(opened), context);
		assertStructuredTextFallback(opened, context);

		const cases: Array<{
			name: string;
			arguments: Record<string, unknown>;
			text: RegExp;
		}> = [
			{
				name: "active_branch_id",
				arguments: { context },
				text: /Active branch.*at commit/,
			},
			{
				name: "switch_branch",
				arguments: { context, branch_id: "main" },
				text: /Switched to branch/,
			},
			{
				name: "create_branch",
				arguments: { context, name: "test-branch" },
				text: /Created branch/,
			},
			{
				name: "create_checkpoint",
				arguments: { context },
				text: /Checkpoint created/,
			},
			{ name: "undo", arguments: { context }, text: /Undone to commit/ },
			{ name: "redo", arguments: { context }, text: /Redone to commit/ },
			{
				name: "merge_branch_preview",
				arguments: { context, source_branch_id: "main" },
				text: /Merge preview/,
			},
			{
				name: "merge_branch",
				arguments: { context, source_branch_id: "main" },
				text: /Branch merged/,
			},
		];
		for (const toolCall of cases) {
			const result = await client.callTool(toolCall);
			assert.equal(result.isError, undefined, JSON.stringify(result));
			const text = toolText(result);
			assert.match(
				text,
				toolCall.text,
				`${toolCall.name} must describe result`,
			);
			assertTextOmitsContext(text, context);
			const fallback = assertStructuredTextFallback(result, context);
			assert.equal(
				(result.structuredContent as { context: string }).context.length > 0,
				true,
				`${toolCall.name} structuredContent must still carry context`,
			);
			assert.equal(
				fallback.context,
				(result.structuredContent as { context: string }).context,
				`${toolCall.name} later text JSON must match structuredContent.context`,
			);
		}
	} finally {
		await client.close();
	}
});

void test("text-only hosts get structuredContent JSON in a later text block", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_StructuredText_Test",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "structured-text-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const openedFallback = assertStructuredTextFallback(
			opened,
			(opened.structuredContent as { context: string }).context,
		);
		const context = openedFallback.context as string;
		assert.equal(typeof context, "string");
		assert.ok(context.length > 0);
		assert.equal(typeof openedFallback.request_id, "string");

		const queried = await client.callTool({
			name: "query_sql",
			arguments: { context, sql: "SELECT path FROM lix_file" },
		});
		const queriedFallback = assertStructuredTextFallback(queried, context);
		assert.equal(queriedFallback.context, context);
		assert.match(toolTextBlocks(queried).join("\n"), /\/skills\/hello\.md/);

		const executed = await client.callTool({
			name: "execute_sql",
			arguments: { context, statements: [{ sql: "SELECT 2" }] },
		});
		const executedFallback = assertStructuredTextFallback(executed, context);
		assert.equal(executedFallback.context, context);
		assert.ok(Array.isArray(executedFallback.results));

		const switched = await client.callTool({
			name: "switch_branch",
			arguments: { context, branch_id: "main" },
		});
		const switchedContext = (switched.structuredContent as { context: string })
			.context;
		const switchedFallback = assertStructuredTextFallback(
			switched,
			switchedContext,
		);
		assert.equal(switchedFallback.context, switchedContext);
		assert.equal(switchedFallback.branch_id, "main");
	} finally {
		await client.close();
	}
});

void test("typed context errors include hint, server time, and advertised expiration", async () => {
	const expiredService = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
		contextTtlMs: -1,
	});
	const liveService = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcherFor = (service: LixService) => {
		return async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new globalThis.Request(input, init) as unknown as Request;
			return handleMcpTransport(request as never, service, {
				authMode: "none",
				serverName: "LixRay_ContextError_Test",
			});
		};
	};

	const expiredTransport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcherFor(expiredService) },
	);
	const expiredClient = new Client(
		{ name: "context-error-expired-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	const liveTransport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcherFor(liveService) },
	);
	const liveClient = new Client(
		{ name: "context-error-live-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await expiredClient.connect(expiredTransport);
		const expiredOpen = await expiredClient.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const expiredContext = (
			expiredOpen.structuredContent as { context: string }
		).context;
		const expired = await expiredClient.callTool({
			name: "query_sql",
			arguments: { context: expiredContext, sql: "SELECT 1" },
		});
		assert.equal(expired.isError, true);
		const expiredError = (
			toolErrorContent(expired) as {
				error: {
					code: string;
					hint?: string;
					details?: Record<string, unknown>;
				};
			}
		).error;
		assert.equal(expiredError.code, "context_expired");
		assert.equal(expiredError.hint, CONTEXT_REOPEN_HINT);
		assert.equal(typeof expiredError.details?.server_time, "string");
		assert.equal(typeof expiredError.details?.expires_at, "string");
		assert.match(toolText(expired), /Call open_lix again/);
		assert.match(toolText(expired), /structuredContent\.context/);
		assertTextOmitsContext(toolText(expired), expiredContext);

		await liveClient.connect(liveTransport);
		const liveOpen = await liveClient.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		const liveContext = (liveOpen.structuredContent as { context: string })
			.context;

		const malformed = await liveClient.callTool({
			name: "query_sql",
			arguments: {
				context: liveContext.slice(0, 12),
				sql: "SELECT 1",
			},
		});
		assert.equal(malformed.isError, true);
		const malformedError = (
			toolErrorContent(malformed) as {
				error: {
					code: string;
					hint?: string;
					details?: Record<string, unknown>;
				};
			}
		).error;
		assert.equal(malformedError.code, "malformed_context");
		assert.equal(malformedError.hint, CONTEXT_REOPEN_HINT);
		assert.equal(typeof malformedError.details?.server_time, "string");

		const malformedWrite = await liveClient.callTool({
			name: "execute_sql",
			arguments: {
				context: liveContext.slice(0, 12),
				statements: [{ sql: "INSERT INTO example VALUES (1)" }],
			},
		});
		assert.equal(malformedWrite.isError, true);
		assert.equal(
			(
				toolErrorContent(malformedWrite) as {
					error: { code: string };
				}
			).error.code,
			"malformed_context",
		);
		assertTextOmitsContext(toolText(malformedWrite), liveContext);

		const wrongKey = new LixService(new FakeRuntime(), {
			contextSigningKey: "other-key",
			principal: { userId: "user", clientId: "client" },
		});
		const wrongKeyClient = new Client(
			{ name: "context-error-signature-client", version: "1.0.0" },
			{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
		);
		const wrongKeyTransport = new StreamableHTTPClientTransport(
			new URL("https://lixray.test/mcp"),
			{ fetch: fetcherFor(wrongKey) },
		);
		await wrongKeyClient.connect(wrongKeyTransport);
		const signature = await wrongKeyClient.callTool({
			name: "query_sql",
			arguments: { context: liveContext, sql: "SELECT 1" },
		});
		assert.equal(signature.isError, true);
		const signatureError = (
			toolErrorContent(signature) as {
				error: {
					code: string;
					hint?: string;
					details?: Record<string, unknown>;
				};
			}
		).error;
		assert.equal(signatureError.code, "invalid_context");
		assert.equal(signatureError.hint, CONTEXT_REOPEN_HINT);
		assert.equal(typeof signatureError.details?.server_time, "string");
		assert.equal(typeof signatureError.details?.expires_at, "string");
		assert.equal(signatureError.details?.lix_id, undefined);
		await wrongKeyClient.close();
	} finally {
		await expiredClient.close();
		await liveClient.close();
	}
});

void test("open_lix text reports a populated inventory without calling the lix empty", async () => {
	const runtime = new FakeRuntime();
	runtime.fileCount = 4;
	runtime.directoryCount = 1;
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new globalThis.Request(input, init) as unknown as Request;
		return handleMcpTransport(request as never, service, {
			authMode: "none",
			serverName: "LixRay_OpenInventory_Test",
		});
	};
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{ fetch: fetcher },
	);
	const client = new Client(
		{ name: "open-inventory-test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: LIX_ID },
		});
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const content = opened.structuredContent as {
			context: string;
			file_count: number;
			directory_count: number;
			files: Array<{ id: string; path: string; url: string }>;
			file_paths: Array<string>;
			file_paths_complete: boolean;
			file_paths_sql?: string;
			empty: boolean;
		};
		assert.equal(content.file_count, 4);
		assert.equal(content.directory_count, 1);
		assert.deepEqual(content.file_paths, ["/skills/hello.md"]);
		assert.equal(content.file_paths_complete, false);
		// A truncated manifest says how to get the rest.
		assert.equal(
			content.file_paths_sql,
			"SELECT id, path FROM lix_file ORDER BY path",
		);
		assert.match(toolText(opened), /for every path run query_sql/);
		assert.deepEqual(content.files, [
			{
				id: "22222222-2222-4222-8222-222222222222",
				path: "/skills/hello.md",
				url: "https://lixray.test/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md",
			},
		]);
		assert.equal(content.empty, false);
		const text = toolText(opened);
		assert.match(text, /4 files, 1 directory/);
		assert.doesNotMatch(text, /\bempty\b/);
		assertTextOmitsContext(text, content.context);
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
		const failedContent = toolErrorContent(failed) as {
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
		const baseRequest = new globalThis.Request(
			input,
			init,
		) as unknown as Request;
		const headers = new Headers(baseRequest.headers);
		headers.set(MCP_AI_TRACE_ID_HEADER, "trace-modern-123");
		headers.set(MCP_AI_PARENT_ID_HEADER, "parent-modern-456");
		headers.set(MCP_AI_SESSION_ID_HEADER, "conversation-modern-789");
		const request = new globalThis.Request(baseRequest, {
			headers,
		}) as unknown as Request;
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
		for (const event of captured.filter((candidate) =>
			["$mcp_initialize", "$mcp_tools_list", "$mcp_tool_call"].includes(
				candidate.event,
			),
		)) {
			assert.equal(event.properties.$ai_trace_id, "trace-modern-123");
			assert.equal(event.properties.$ai_parent_id, "parent-modern-456");
			assert.equal(event.properties.$ai_session_id, "conversation-modern-789");
		}
	} finally {
		restore();
		await client.close();
	}
});

void test("transport observes and correlates protocol failures before tool execution", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	for (const body of [
		"{broken private-input",
		JSON.stringify({
			jsonrpc: "2.0",
			id: 42,
			method: "private-unknown-method",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	]) {
		const observations: McpTransportObservation[] = [];
		const calls: McpToolCallObservation[] = [];
		const response = await handleMcpTransport(
			new Request("https://lixray.test/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": MCP_PROTOCOL_VERSION,
					"mcp-method": "private-unknown-method",
					"x-request-id": "transport-test",
				},
				body,
			}),
			service,
			{
				onTransport: (value) => observations.push(value),
				onToolCall: (value) => calls.push(value),
			},
		);
		const text = await response.text();
		const payload = JSON.parse(text) as {
			id: number | null;
			error: { code: number; message: string; data: { request_id: string } };
		};
		assert.equal(payload.error.data.request_id, "transport-test");
		assert.match(payload.error.message, /request_id: transport-test/);
		assert.doesNotMatch(text, /private-/);
		assert.equal(observations.length, 1);
		assert.equal(
			observations[0]?.requestId,
			response.headers.get("x-request-id"),
		);
		assert.equal(observations[0]?.outcome, "error");
		assert.equal(observations[0]?.statusCode, response.status);
		assert.equal(observations[0]?.errorCode, `MCP_RPC_${payload.error.code}`);
		assert.ok(observations[0]?.traceId);
		assert.equal(calls.length, 0);
		if (body.startsWith('{"jsonrpc')) {
			assert.equal(response.status, 404);
			assert.equal(payload.id, 42);
		}
	}
});

void test("transport contains setup and observer failures with a correlated safe error", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const observations: McpTransportObservation[] = [];
	const response = await handleMcpTransport(
		new Request("https://lixray.test/mcp", {
			method: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "rpc-id",
				method: "tools/list",
			}),
		}),
		service,
		{
			requestId: "setup-test",
			get serverName(): string {
				throw new Error("secret database credentials");
			},
			onTransport: (value) => {
				observations.push(value);
				throw new Error("analytics unavailable");
			},
		},
	);
	const text = await response.text();
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("x-request-id"), "setup-test");
	assert.deepEqual(JSON.parse(text), {
		jsonrpc: "2.0",
		id: null,
		error: {
			code: -32603,
			message: "Internal error (request_id: setup-test)",
			data: { request_id: "setup-test" },
		},
	});
	assert.equal(observations.length, 1);
	assert.equal(observations[0]?.errorCode, "MCP_INTERNAL_ERROR");
	assert.doesNotMatch(JSON.stringify(observations), /secret|credentials/);
});

void test("transport generates shared trace context and isolates tool observers", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const observations: McpTransportObservation[] = [];
	const calls: McpToolCallObservation[] = [];
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{
			fetch: async (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					onTransport: (value) => observations.push(value),
					onToolCall: (value) => {
						calls.push(value);
						throw new Error("analytics unavailable");
					},
				}),
		},
	);
	const client = new Client(
		{ name: "trace-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const result = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(result.isError, undefined);
		assert.equal(calls.length, 1);
		const observed = observations.find(
			(value) => value.requestId === calls[0]?.requestId,
		);
		assert.ok(observed?.traceId);
		assert.equal(observed?.traceId, calls[0]?.traceId);
		assert.equal(observed?.outcome, "success");
		assert.equal(calls[0]?.parentId, observed?.traceId);
		const invalid = await client.callTool({ name: "open_lix", arguments: {} });
		assert.equal(invalid.isError, true);
		assert.match(
			JSON.stringify(invalid.content),
			new RegExp(`request_id: ${observations.at(-1)?.requestId}`),
		);
		assert.equal(calls.length, 1);
		assert.equal(observations.at(-1)?.outcome, "error");
		assert.equal(observations.at(-1)?.statusCode, 200);
		assert.equal(observations.at(-1)?.errorCode, "MCP_TOOL_ERROR");
	} finally {
		await client.close();
	}
});

void test("MCP returns canonical links through modern and text-only tool results", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "url-test",
		principal: { userId: "user", clientId: "client" },
	});
	const transport = new StreamableHTTPClientTransport(
		new URL("https://dev.lixray.com/mcp"),
		{
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
				}),
		},
	);
	const client = new Client(
		{ name: "canonical-url-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		const resolver = tools.tools.find(
			(tool) => tool.name === "get_entity_urls",
		);
		assert.equal(resolver?.annotations?.readOnlyHint, true);
		assert.equal(resolver?.annotations?.destructiveHint, false);
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: "@acme/company", branch_id: "draft" },
		});
		const context = (opened.structuredContent as { context: string }).context;
		const links = await client.callTool({
			name: "get_entity_urls",
			arguments: {
				context,
				entities: [
					{ kind: "file", path: "/skills/hello.md" },
					{ kind: "directory", path: "/" },
				],
			},
		});
		assert.equal(links.isError, undefined, JSON.stringify(links));
		const content = links.structuredContent as {
			entities: Array<{ url: string; id: string | null }>;
		};
		assert.equal(
			content.entities[0].url,
			"https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md?branch=draft",
		);
		assert.equal(
			content.entities[1].url,
			"https://dev.lixray.com/@acme/company?branch=draft",
		);
		assert.equal(content.entities[1].id, null);
		assert.deepEqual(
			assertStructuredTextFallback(links, context).entities,
			content.entities,
		);
		// open_lix links the repository so a host can render it as a chip.
		assert.deepEqual(
			opened.content?.find((block) => block.type === "resource_link"),
			{
				type: "resource_link",
				uri: "https://dev.lixray.com/@acme/company?branch=draft",
				name: "@acme/company",
				description: "Opened repository",
			},
		);
		// A batch that writes a file says so, and links the file.
		const written = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content",
						params: [
							{ kind: "text", value: "/skills/hello.md" },
							{ kind: "text", value: "# Hello\n" },
						],
					},
				],
			},
		});
		assert.equal(written.isError, undefined, JSON.stringify(written));
		assert.equal(toolText(written), "Wrote skills/hello.md · 1 row affected");
		assert.deepEqual(
			written.content?.filter((block) => block.type === "resource_link"),
			[
				{
					type: "resource_link",
					uri: "https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md?branch=draft",
					name: "hello.md",
					description: "Wrote skills/hello.md",
					mimeType: "text/markdown",
				},
			],
		);
		// The structured JSON stays the last text block for text-only hosts.
		assert.equal(
			(assertStructuredTextFallback(written, context).results as unknown[])
				.length,
			1,
		);
		const missing = await client.callTool({
			name: "get_entity_urls",
			arguments: {
				context,
				entities: [{ kind: "file", path: "/missing.csv" }],
			},
		});
		assert.equal(missing.isError, true);
		assert.equal(
			(toolErrorContent(missing) as { error: { code: string } }).error.code,
			"not_found",
		);
		const invalid = await client.callTool({
			name: "get_entity_urls",
			arguments: {
				context,
				entities: [
					{
						kind: "file",
						id: "22222222-2222-4222-8222-222222222222",
						path: "/skills/hello.md",
					},
				],
			},
		});
		assert.equal(invalid.isError, true);
	} finally {
		await client.close();
	}
});

void test("every MCP guidance surface tells clients to use returned canonical URLs", async () => {
	for (const text of [
		MCP_SERVER_INSTRUCTIONS,
		MCP_DOCS,
		await mcpDocumentationResponse().text(),
	]) {
		assert.match(text, /get_entity_urls/);
		assert.match(text, /canonical/i);
		assert.match(text, /branch/);
	}
	assert.match(GET_ENTITY_URLS_TOOL_DESCRIPTION, /Read-only/);
	// The link rule is stated once, in the URL guide; execute_sql stays short.
	assert.match(MCP_URL_GUIDE, /get_entity_urls/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /get_entity_urls/);
	assert.match(OPEN_LIX_TOOL_DESCRIPTION, /canonical url/);
});

void test("file tools list, read, and write files with metadata and conflict checks", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "file-tools",
		principal: { userId: "user", clientId: "client" },
	});
	const transport = new StreamableHTTPClientTransport(
		new URL("https://dev.lixray.com/mcp"),
		{
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
				}),
		},
	);
	const client = new Client(
		{ name: "file-tools-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		await client.listTools();
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: "@acme/company" },
		});
		const context = (opened.structuredContent as { context: string }).context;

		const listed = await client.callTool({
			name: "list_files",
			arguments: { context, directory: "/skills" },
		});
		assert.equal(listed.isError, undefined, JSON.stringify(listed));
		const listing = listed.structuredContent as {
			commit_id: string;
			files: Array<{ id: string; path: string; url: string }>;
			truncated: boolean;
		};
		assert.equal(listing.commit_id, "commit-1");
		assert.deepEqual(listing.files, [
			{
				id: "22222222-2222-4222-8222-222222222222",
				path: "/skills/hello.md",
				url: "https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md",
			},
		]);
		assert.equal(listing.truncated, false);
		assert.match(toolText(listed), /Listed 1 file at commit commit-1/);

		const read = await client.callTool({
			name: "read_files",
			arguments: { context, paths: ["/skills/hello.md", "/missing.md"] },
		});
		assert.equal(read.isError, undefined, JSON.stringify(read));
		const contents = read.structuredContent as {
			commit_id: string;
			files: Array<Record<string, unknown>>;
			missing: string[];
		};
		assert.deepEqual(contents.files, [
			{
				id: "22222222-2222-4222-8222-222222222222",
				path: "/skills/hello.md",
				url: "https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md",
				size: 8,
				content: { text: "# Hello\n" },
				lixcol_metadata: null,
			},
		]);
		assert.deepEqual(contents.missing, ["/missing.md"]);
		assert.match(toolText(read), /Read 1 file; missing: \/missing\.md/);

		// A write: parent directories, one file per statement, metadata along.
		const written = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				last_seen_commit_id: "commit-1",
				files: [
					{
						path: "/gtm/campaigns/icp.md",
						content: { text: "# ICP" },
						lixcol_metadata: { atelier_csv: { version: 1, columns: [] } },
					},
					{ path: "/skills/hello.md", lixcol_metadata: null },
				],
			},
		});
		assert.equal(written.isError, undefined, JSON.stringify(written));
		const wrote = written.structuredContent as {
			commit_id: string;
			files: Array<{ id: string; path: string; url: string }>;
		};
		assert.deepEqual(
			wrote.files.map((file) => file.path),
			["/gtm/campaigns/icp.md", "/skills/hello.md"],
		);
		assert.match(
			wrote.files[0]!.url,
			/^https:\/\/dev\.lixray\.com\/@acme\/company\/file\//,
		);
		assert.deepEqual(runtime.writes, [
			"INSERT INTO lix_file (path, content, lixcol_metadata) VALUES ($1, CAST($2 AS BYTEA), $3) ON CONFLICT (path) DO UPDATE SET content = excluded.content, lixcol_metadata = excluded.lixcol_metadata RETURNING id, path",
			"UPDATE lix_file SET lixcol_metadata = $2 WHERE path = $1 RETURNING id, path",
		]);
		assert.match(runtime.lastOriginKey ?? "", /^mcp:/);
		assert.match(
			toolText(written),
			/Wrote gtm\/campaigns\/icp\.md · skills\/hello\.md/,
		);
		assert.equal(
			written.content?.filter((block) => block.type === "resource_link").length,
			2,
		);

		// Metadata alone on a file that does not exist is refused before writing.
		const orphan = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				files: [{ path: "/nowhere.md", lixcol_metadata: { a: 1 } }],
			},
		});
		assert.equal(orphan.isError, true);
		assert.equal(toolErrorContent(orphan).error.code, "not_found");

		// A conflicting file since last_seen_commit_id refuses the write and
		// hands back the current contents; unrelated changes never block.
		runtime.changedSinceLastSeen = ["/skills/hello.md"];
		const conflict = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				last_seen_commit_id: "commit-0",
				files: [
					{ path: "/skills/hello.md", content: { text: "# Hello again" } },
					{ path: "/other.md", content: { text: "x" } },
				],
			},
		});
		assert.equal(conflict.isError, true);
		const conflictError = toolErrorContent(conflict).error;
		assert.equal(conflictError.code, "conflict");
		assert.match(conflictError.message, /\/skills\/hello\.md/);
		assert.deepEqual(conflictError.details, {
			current_commit_id: "commit-1",
			files: [
				{
					path: "/skills/hello.md",
					content: { text: "# Hello\n" },
					lixcol_metadata: null,
				},
			],
		});
		// Nothing was written.
		assert.equal(runtime.writes.length, 2);
		const unrelated = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				last_seen_commit_id: "commit-0",
				files: [{ path: "/other.md", content: { text: "x" } }],
			},
		});
		assert.equal(unrelated.isError, undefined, JSON.stringify(unrelated));
		const unknown = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				last_seen_commit_id: "unknown-commit",
				files: [{ path: "/other.md", content: { text: "y" } }],
			},
		});
		assert.equal(unknown.isError, true);
		assert.equal(toolErrorContent(unknown).error.code, "invalid_request");
	} finally {
		await client.close();
	}
});
