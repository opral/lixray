import { SpanStatusCode } from "@opentelemetry/api";
import {
	NodeTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
tracerProvider.register();
import assert from "node:assert/strict";
import { DIFF_CARD_META } from "./diff-card-app.ts";
import type { DiffCardPayload } from "./diff-card.ts";
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
	type TransactionClient,
	type LixRuntimeClient,
} from "./lix-service.ts";
import { PostHog } from "posthog-node";
import {
	type McpToolCallObservation,
	attachMcpToolCallObservationProperties,
	CREATE_CHECKPOINT_TOOL_DESCRIPTION,
	handleMcpTransport,
	LIST_LIXES_TOOL_DESCRIPTION,
	MCP_REQUEST_ID_HEADER,
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
const isGuidedTool = (name: string) => isSqlTool(name) || name === "diff";

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

/** A failed call's { error }: the JSON text block, never structuredContent. */
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
		if (request.sql === "SELECT commit_id FROM lix_restore($1)") {
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
				commit: null,
			};
		}
		if (
			request.sql === "SELECT commit_id FROM lix_create_checkpoint(NULL, NULL)"
		) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: "commit-1" }]],
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (
			request.sql.startsWith(
				"SELECT commit_id FROM lix_log() WHERE is_checkpoint",
			)
		) {
			return {
				columns: ["commit_id"],
				rows: this.checkpoints
					.slice(0, 1)
					.map((id) => [{ kind: "text" as const, value: id }]),
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (
			/^SELECT (?:id FROM lix_commit|commit_id FROM lix_log\(\)) WHERE (?:id|commit_id) = \$1( AND is_checkpoint)? LIMIT 1$/.test(
				request.sql,
			)
		) {
			const id = request.params?.[0];
			const known =
				id?.kind === "text" &&
				(request.sql.includes("is_checkpoint")
					? this.checkpoints.includes(id.value)
					: id.value !== "missing-commit");
			return {
				columns: ["id"],
				rows: known ? [[id]] : [],
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (
			request.sql === "SELECT commit_id FROM lix_branch WHERE id = $1 LIMIT 1"
		) {
			const id = request.params?.[0];
			return {
				columns: ["commit_id"],
				rows:
					id?.kind === "text" && id.value === "main"
						? [[{ kind: "text" as const, value: "commit-1" }]]
						: [],
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (request.sql.includes("lix_active_branch_commit_id")) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: "commit-1" }]],
				rowsAffected: 0,
				notices: [],
				commit: null,
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
				commit: null,
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
				commit: null,
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
				commit: null,
			};
		}
		if (request.sql.startsWith("SELECT id, diff_type, from_path, to_path")) {
			if (this.changesFailure) throw this.changesFailure;
			const wanted = (request.params ?? [])
				.slice(2)
				.flatMap((param) => (param.kind === "text" ? [param.value] : []));
			const paths = [
				...new Set([...this.previousFiles.keys(), ...this.files.keys()]),
			].filter((path) => wanted.length === 0 || wanted.includes(path));
			const rows = paths.flatMap((path) => {
				const before = this.previousFiles.get(path);
				const after = this.files.get(path);
				if (before && after && before.base64 === after.base64) return [];
				const blob = (file: { base64: string } | undefined) =>
					file
						? { kind: "blob" as const, base64: file.base64 }
						: { kind: "null" as const };
				const side = (file: unknown) =>
					file
						? { kind: "text" as const, value: path }
						: { kind: "null" as const };
				return [
					[
						{ kind: "text" as const, value: (after ?? before)!.id },
						{
							kind: "text" as const,
							value: !before ? "added" : !after ? "removed" : "modified",
						},
						side(before),
						side(after),
						blob(before),
						blob(after),
					],
				];
			});
			return {
				columns: [
					"id",
					"diff_type",
					"from_path",
					"to_path",
					"from_content",
					"to_content",
				],
				rows,
				rowsAffected: 0,
				notices: [],
				commit: null,
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
				commit: null,
			};
		}
		if (/RETURNING id, path/.test(request.sql)) {
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
				commit: null,
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
				commit: null,
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
				commit: null,
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
				commit: null,
			};
		}
		return {
			columns: ["value"],
			rows: [[{ kind: "text" as const, value: "ok" }]],
			rowsAffected: 0,
			notices: [],
			commit: null,
		};
	}
	/** What the last transaction started from, for the change query. */
	previousFiles = new Map<
		string,
		{ id: string; base64: string; metadata: Record<string, unknown> | null }
	>();
	/** Set to make the change query fail, the way a flaky upstream would. */
	changesFailure: Error | undefined;
	/** Checkpoint commit ids on the branch, newest first. */
	checkpoints: string[] = ["checkpoint-0"];

	async transaction<T>(
		lixId: string,
		branchId: string,
		run: (tx: TransactionClient) => Promise<T>,
	) {
		this.previousFiles = new Map(this.files);
		const value = await run({
			execute: (request) => this.execute(lixId, branchId, request),
		});
		return { value, commit: { before: "commit-0", after: "commit-1" } };
	}

	async executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	) {
		return {
			commit: { before: "commit-0", after: "commit-1" },
			results: (
				await Promise.all(
					request.statements.map((statement) =>
						this.execute(lixId, branchId, {
							...statement,
							options: request.options,
						}),
					),
				)
			).map(({ columns, rows, rowsAffected, notices }) => ({
				columns,
				rows,
				rowsAffected,
				notices,
			})),
		};
	}
	async createBranch() {
		return { id: "draft", name: "Draft", hidden: false, commitId: "commit-1" };
	}
	async undo() {
		return { commitId: "inverse" };
	}
	async redo() {
		return { commitId: "replay" };
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
				"get_entity_urls",
				"diff",
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
		assert.match(executeSqlTool.description ?? "", /outcome is unknown/);
		assert.match(executeSqlTool.description ?? "", /checkpoint: true/);
		assert.match(executeSqlTool.description ?? "", /one write path/);
		const executeInput = executeSqlTool.inputSchema as {
			properties: Record<string, unknown>;
		};
		assert.ok(executeInput.properties.last_seen_commit_id);
		assert.ok(executeInput.properties.checkpoint);
		const executeOutput = executeSqlTool.outputSchema as {
			properties: Record<string, unknown>;
		};
		assert.ok(executeOutput.properties.checkpoint_commit_id);
		assert.ok(executeOutput.properties.warning);
		const undoTool = tools.tools.find((tool) => tool.name === "undo")!;
		assert.match(undoTool.description ?? "", /latest undoable/);
		assert.match(undoTool.description ?? "", /SELECT commit_id FROM lix_undo/);
		assert.deepEqual(
			Object.keys((undoTool.inputSchema as { properties: object }).properties),
			["context"],
		);
		const sqlGuide = await client.readResource({ uri: "lixray://docs/sql" });
		assert.ok(sqlGuide.contents[0] && "text" in sqlGuide.contents[0]);
		assert.equal(sqlGuide.contents[0].text, LIX_SQL_OPERATING_GUIDE);
		assert.equal(
			tools.tools.some((tool) => tool.name === "write_files"),
			false,
		);
		assert.match(executeSqlTool.description ?? "", /last_seen_commit_id/);
		assert.match(executeSqlTool.description ?? "", /lixcol_metadata/);
		assert.match(queryTool.description ?? "", /query_sql is the read path/);
		assert.match(queryTool.description ?? "", /OCTET_LENGTH\(content\)/);
		assert.match(
			queryTool.description ?? "",
			/SUBSTRING\(content FROM 1 FOR 4096\)/,
		);
		assert.match(queryTool.description ?? "", /Agents previously overfetched/);
		assert.match(MCP_SERVER_INSTRUCTIONS, /outcome is unknown/);
		// The listing stays bounded: the guide lives on two tools only, the
		// rest are one-liners, output schemas are success-only.
		const listingChars = JSON.stringify(tools.tools).length;
		assert.ok(
			listingChars < 34_000,
			`tools/list is ${listingChars} chars; keep it under 34k`,
		);
		for (const tool of tools.tools) {
			const limit = isGuidedTool(tool.name) ? 1_800 : 320;
			assert.doesNotMatch(
				JSON.stringify(tool.outputSchema),
				/request_id|server_time/,
			);
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
		assert.match(restoreTool.description ?? "", /content from commit_id/);
		assert.match(restoreTool.description ?? "", /into a new commit/);
		assert.match(restoreTool.description ?? "", /undo can reverse/);
		assert.match(restoreTool.description ?? "", /working baseline/);
		assert.match(
			restoreTool.description ?? "",
			/commit_id from create_checkpoint/,
		);
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
		// File reads are SQL; there are no file-list or file-read shortcuts.
		assert.deepEqual(
			tools.tools
				.map((tool) => tool.name)
				.filter((name) => name === "list_files" || name === "read_files"),
			[],
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
		assert.equal(openedContent.request_id, undefined);
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
		assert.equal(openedContent.request_id, undefined);
		assert.match(responseRequestIds.at(-1) ?? "", /^[0-9a-f-]{36}$/i);
		const restored = await client.callTool({
			name: "restore",
			arguments: { context, commit_id: "commit-target" },
		});
		assert.equal(restored.isError, undefined, JSON.stringify(restored));
		assert.deepEqual(restored.structuredContent, {
			context,
			branch_id: "main",
			commit_id: "commit-target",
		});
		const restoredText = toolText(restored);
		assert.match(
			restoredText,
			/Restored content on branch main in new commit commit-target/,
		);
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
				commit: null,
			},
		);
		assert.equal(queriedContent.request_id, undefined);
		assert.match(responseRequestIds.at(-1) ?? "", /^[0-9a-f-]{36}$/i);
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
			commit: null,
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
				commit: null,
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
			statement_index: 0,
		});
		assert.equal(failedContent.request_id, undefined);
		assert.match(responseRequestIds.at(-1) ?? "", /^[0-9a-f-]{36}$/i);
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
			/query_sql rejects mutating SQL/,
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
		assert.match(internalContent.error.hint, /Contact LixRay support/);
		assert.doesNotMatch(internalContent.error.hint, /request_id/);
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
	// execute_sql states persistence and what checkpoint: true is for; the
	// policy itself is not repeated there.
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /already persisted/);
	assert.match(EXECUTE_SQL_TOOL_DESCRIPTION, /saving needs no checkpoint/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /Use judgment/);
});

void test("shipped copy explains when write readback is useful", async () => {
	for (const text of [
		MCP_SERVER_INSTRUCTIONS,
		LIX_SQL_OPERATING_GUIDE,
		MCP_DOCS,
	]) {
		assert.match(text, /outcome is unknown/);
		assert.doesNotMatch(text, /inspect the relevant rows first/);
		assert.doesNotMatch(text, /final verification SELECT is recommended/);
	}
	assert.match(MCP_SERVER_INSTRUCTIONS, /validation is part of the task/i);
	assert.match(MCP_DOCS, /validation is part of the task/);
	assert.match(await mcpDocumentationResponse().text(), /outcome is unknown/);
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
		assert.match(text, /query_sql/);
		assert.match(text, /OCTET_LENGTH/);
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
			{ name: "undo", arguments: { context }, text: /Undo committed as/ },
			{ name: "redo", arguments: { context }, text: /Redo committed as/ },
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
		assert.equal(openedFallback.request_id, undefined);

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

void test("typed context errors provide hints without diagnostic metadata", async () => {
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
		assert.equal(expiredError.details, undefined);
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
		assert.equal(malformedError.details, undefined);

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
		assert.equal(signatureError.details, undefined);
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
			files: Array<{
				id: string;
				path: string;
				url: string;
				display_url: string;
			}>;
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
				url: "https://lixray.test/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg",
				display_url:
					"https://lixray.test/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md",
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
		assert.equal(failedContent.request_id, undefined);
		assert.equal(typeof first.properties.request_id, "string");
		assert.equal(succeededContent.request_id, undefined);
		assert.equal(typeof retry.properties.request_id, "string");
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
			if (event.event === "$mcp_tool_call")
				assert.match(String(event.properties.trace_id), /^[0-9a-f]{32}$/);
			assert.equal(event.properties.$ai_trace_id, undefined);
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
				onToolCall: (value) => calls.push(value),
			},
		);
		const text = await response.text();
		const payload = JSON.parse(text) as {
			id: number | null;
			error: { code: number; message: string; data: { request_id: string } };
		};
		assert.equal(payload.error.data, undefined);
		assert.doesNotMatch(payload.error.message, /request_id/);
		assert.doesNotMatch(text, /private-/);
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
			message: "Internal error",
		},
	});
	assert.doesNotMatch(text, /secret|credentials/);
});

void test("transport generates shared trace context and isolates tool observers", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const calls: McpToolCallObservation[] = [];
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{
			fetch: async (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
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
		assert.match(calls[0]!.traceId!, /^[0-9a-f]{32}$/);
		const invalid = await client.callTool({ name: "open_lix", arguments: {} });
		assert.equal(invalid.isError, true);
		assert.doesNotMatch(JSON.stringify(invalid.content), /request_id/);
		assert.equal(calls.length, 2);
		assert.equal(calls[1]?.outcome, "error");
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
			entities: Array<{ url: string; display_url: string; id: string | null }>;
		};
		assert.equal(
			content.entities[0].url,
			"https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg?branch=draft",
		);
		assert.equal(
			content.entities[0].display_url,
			"https://dev.lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg/skills/hello.md?branch=draft",
		);
		assert.equal(
			content.entities[1].url,
			"https://dev.lixray.com/@acme/company?branch=draft",
		);
		assert.equal(content.entities[1].id, null);
		assert.equal(content.entities[1].display_url, content.entities[1].url);
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

void test("every MCP guidance surface distinguishes stored and display URLs", async () => {
	for (const text of [
		MCP_SERVER_INSTRUCTIONS,
		MCP_DOCS,
		await mcpDocumentationResponse().text(),
	]) {
		assert.match(text, /get_entity_urls/);
		assert.match(text, /display_url/);
		assert.match(text, /branch/);
	}
	assert.match(GET_ENTITY_URLS_TOOL_DESCRIPTION, /Read-only/);
	// The link rule is stated once, in the URL guide; execute_sql stays short.
	assert.match(MCP_URL_GUIDE, /get_entity_urls/);
	assert.doesNotMatch(EXECUTE_SQL_TOOL_DESCRIPTION, /get_entity_urls/);
	assert.match(OPEN_LIX_TOOL_DESCRIPTION, /display_url/);
});

void test("a change query that fails leaves the batch saved, without a card", async () => {
	const runtime = new FakeRuntime();
	runtime.changesFailure = new Error("upstream is having a day");
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
		const opened = await client.callTool({
			name: "open_lix",
			arguments: { lix_ref: "@acme/company" },
		});
		const context = (opened.structuredContent as { context: string }).context;
		const written = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) RETURNING id, path",
						params: [
							{ kind: "text", value: "/skills/hello.md" },
							{ kind: "text", value: "# Notes" },
						],
					},
				],
			},
		});
		// The card is a courtesy; the batch it describes already happened.
		assert.equal(written.isError, undefined, JSON.stringify(written));
		assert.equal(written._meta?.[DIFF_CARD_META], undefined);
		assert.deepEqual(
			(written.structuredContent as { commit: unknown }).commit,
			{ before: "commit-0", after: "commit-1" },
		);
		assert.equal(
			(written.content ?? []).some((block) => block.type === "resource"),
			false,
		);
		assert.equal(
			(written.content ?? []).filter((block) => block.type === "resource_link")
				.length,
			1,
		);
	} finally {
		await client.close();
	}
});

void test("diff compares two points and sends the same card a write does", async () => {
	const runtime = new FakeRuntime();
	const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
	runtime.previousFiles = new Map([
		[
			"/gtm/leads.csv",
			{
				id: "44444444-4444-4444-8444-444444444441",
				base64: encode("name,stage\nAcme,lead\n"),
				metadata: null,
			},
		],
		[
			"/gtm/old.md",
			{
				id: "44444444-4444-4444-8444-444444444442",
				base64: encode("# Old\n"),
				metadata: null,
			},
		],
	]);
	runtime.files = new Map([
		[
			"/gtm/leads.csv",
			{
				id: "44444444-4444-4444-8444-444444444441",
				base64: encode("name,stage\nAcme,qualified\nBeta,lead\n"),
				metadata: null,
			},
		],
		[
			"/gtm/plan.md",
			{
				id: "44444444-4444-4444-8444-444444444443",
				base64: encode("# Plan\n"),
				metadata: null,
			},
		],
	]);
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
		{ name: "diff-test", version: "1" },
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
		const diffed = await client.callTool({
			name: "diff",
			arguments: { context, before: "latest_checkpoint", after: "working" },
		});
		assert.equal(diffed.isError, undefined, JSON.stringify(diffed));
		const result = diffed.structuredContent as {
			files: Array<Record<string, unknown>>;
			before: string;
			after: string;
			commit_id: string;
			url: string;
		};
		assert.equal(result.before, "checkpoint-0");
		assert.equal(result.after, "commit-1");
		assert.equal(result.commit_id, "commit-1");
		assert.equal(result.url, "https://dev.lixray.com/@acme/company");
		assert.deepEqual(
			result.files.map((file) => [file.path, file.status]),
			[
				["/gtm/leads.csv", "modified"],
				["/gtm/old.md", "removed"],
				["/gtm/plan.md", "added"],
			],
		);
		for (const file of result.files) {
			assert.equal(file.before_commit_id, "checkpoint-0");
			assert.equal(file.after_commit_id, "commit-1");
			assert.equal(typeof file.url, "string");
			assert.equal(typeof file.display_url, "string");
		}
		assert.match(String(result.files[0]?.url), /\/file\/[A-Za-z0-9_-]{22}$/);
		assert.match(String(result.files[0]?.display_url), /\/gtm\/leads\.csv$/);
		assert.equal(result.files[1]?.url, result.url);
		assert.equal(result.files[1]?.display_url, result.url);
		assert.match(
			toolText(diffed),
			/^3 files changed between latest checkpoint checkpoint-0 and working \(commit commit-1\): gtm\/leads\.csv, gtm\/old\.md, gtm\/plan\.md\./,
		);
		// The surviving files link; the deleted one has nowhere to go.
		assert.deepEqual(
			diffed.content
				?.filter((block) => block.type === "resource_link")
				.map((block) => (block as { description?: string }).description),
			["Modified gtm/leads.csv", "Added gtm/plan.md"],
		);
		const card = diffed._meta?.[DIFF_CARD_META] as DiffCardPayload;
		assert.equal(card.title, "3 files changed");
		assert.equal(card.folder, "/gtm");
		assert.equal(card.tally, "1 added · 1 modified · 1 removed");
		assert.deepEqual(
			card.files.map((file) => file.label),
			["modified · +1 ~1 rows", "removed · 1 line", "added · 1 line"],
		);
		assert.match(card.files[0]!.html ?? "", /qualified/);
		assert.equal(card.files[0]!.url, result.files[0]?.display_url);
		assert.equal(card.files[1]!.url, result.url);

		// An explicit span narrowed to one path.
		const narrowed = await client.callTool({
			name: "diff",
			arguments: {
				context,
				before: { checkpoint_id: "checkpoint-0" },
				after: { branch_id: "main" },
				paths: ["/gtm/plan.md"],
			},
		});
		assert.equal(narrowed.isError, undefined, JSON.stringify(narrowed));
		assert.match(
			toolText(narrowed),
			/^1 file changed between checkpoint checkpoint-0 and branch main \(commit commit-1\): gtm\/plan\.md\./,
		);

		// The same point twice is an empty diff, not a question for Lix.
		const same = await client.callTool({
			name: "diff",
			arguments: {
				context,
				before: { commit_id: "commit-1" },
				after: "working",
			},
		});
		assert.equal(same.isError, undefined, JSON.stringify(same));
		assert.match(
			toolText(same),
			/^0 files changed between commit commit-1 and working/,
		);
		assert.equal(same._meta?.[DIFF_CARD_META], undefined);

		// A ref that names nothing is refused with a hint, before any compare.
		const missing = await client.callTool({
			name: "diff",
			arguments: {
				context,
				before: { checkpoint_id: "commit-1" },
				after: "working",
			},
		});
		assert.equal(missing.isError, true);
		assert.match(toolText(missing), /No checkpoint commit-1/);
		runtime.checkpoints = [];
		const none = await client.callTool({
			name: "diff",
			arguments: { context, before: "latest_checkpoint", after: "working" },
		});
		assert.equal(none.isError, true);
		assert.match(toolText(none), /no checkpoint yet/);

		// An SQL batch that touched a file gets the same card, from its receipt.
		const executed = await client.callTool({
			name: "execute_sql",
			arguments: {
				context,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) RETURNING id, path",
						params: [
							{ kind: "text", value: "/skills/hello.md" },
							{ kind: "text", value: "# Hello\n" },
						],
					},
				],
			},
		});
		assert.equal(executed.isError, undefined, JSON.stringify(executed));
		const executedCard = executed._meta?.[DIFF_CARD_META] as DiffCardPayload;
		assert.equal(executedCard.title, "1 file added");
		assert.equal(executedCard.folder, "/skills");
		assert.deepEqual(
			executedCard.files.map((file) => [file.name, file.status]),
			[["hello.md", "added"]],
		);
		assert.match(executedCard.files[0]!.html ?? "", /Hello/);
	} finally {
		await client.close();
	}
});

void test("SQL calls need no opening and failures survive SDK output validation", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const transport = new StreamableHTTPClientTransport(
		new URL("https://lixray.test/mcp"),
		{
			fetch: async (input, init) =>
				handleMcpTransport(
					new globalThis.Request(input, init) as never,
					service,
					{ authMode: "none" },
				),
		},
	);
	const client = new Client(
		{ name: "direct-sql-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		await client.listTools(); // Load output schemas into the validating client.
		const read = await client.callTool({
			name: "query_sql",
			arguments: { lix_ref: "@acme/company", sql: "SELECT 1" },
		});
		assert.notEqual(read.isError, true);
		assert.equal(
			typeof (read.structuredContent as { context: string }).context,
			"string",
		);
		const write = await client.callTool({
			name: "execute_sql",
			arguments: {
				lix_ref: "@acme/company",
				branch_id: "feature",
				statements: [{ sql: "SELECT 1" }],
			},
		});
		assert.notEqual(write.isError, true);
		for (const [sql, outcome] of [
			["SELECT error", "not_committed"],
			["SELECT internal_error", "unknown"],
		]) {
			const result = await client.callTool({
				name: "execute_sql",
				arguments: { lix_ref: "@acme/company", statements: [{ sql }] },
			});
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent, undefined);
			const error = (
				toolErrorContent(result) as unknown as {
					error: { outcome: string; statement_index?: number; hint: string };
				}
			).error;
			assert.equal(error.outcome, outcome);
			if (outcome === "not_committed") {
				assert.equal(error.statement_index, 0);
				assert.match(error.hint, /CAST/);
			} else assert.match(error.hint, /Read the affected state/);
		}
		const ambiguous = await client.callTool({
			name: "query_sql",
			arguments: {
				lix_ref: "@acme/company",
				context: (read.structuredContent as { context: string }).context,
				sql: "SELECT 1",
			},
		});
		assert.equal(ambiguous.isError, true);
	} finally {
		await client.close();
	}
});

function telemetryGate() {
	let release!: () => void;
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { entered, enter, wait, release };
}

async function telemetryClient(
	service: LixService,
	calls: McpToolCallObservation[],
	options: NonNullable<Parameters<typeof handleMcpTransport>[2]> = {},
) {
	const client = new Client(
		{ name: "telemetry-regression", version: "1" },
		{
			versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
		},
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					...options,
					authMode: "none",
					requestId: "same-http-id",
					onToolCall: (call) => calls.push(call),
				}),
		}),
	);
	return client;
}

void test("tool span and summary wait for execute_sql preview and resource links", async (t) => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	const calls: McpToolCallObservation[] = [];
	const client = await telemetryClient(service, calls);
	t.after(() => client.close());
	const opened = await client.callTool({
		name: "open_lix",
		arguments: { lix_ref: LIX_ID },
	});
	assert.equal(
		calls.find((call) => call.toolName === "open_lix")?.inventoryCommitId,
		(opened.structuredContent as { commit_id: string }).commit_id,
	);
	const token = (opened.structuredContent as { context: string }).context;
	const preview = telemetryGate();
	const links = telemetryGate();
	let preparingLinks = false;
	const originalChanges = service.fileChanges.bind(service);
	service.fileChanges = async (...args) => {
		preview.enter();
		await preview.wait;
		preparingLinks = true;
		return originalChanges(...args);
	};
	const originalLinks = service.getEntityUrls.bind(service);
	service.getEntityUrls = async (...args) => {
		if (preparingLinks) {
			links.enter();
			await links.wait;
		}
		return originalLinks(...args);
	};
	const before = spanExporter.getFinishedSpans().length;
	const work = client.callTool({
		name: "execute_sql",
		arguments: {
			context: token,
			statements: [
				{
					sql: "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) RETURNING id, path",
					params: [
						{ kind: "text", value: "/skills/hello.md" },
						{ kind: "text", value: "# Hello\n" },
					],
				},
			],
		},
	});
	await preview.entered;
	assert.equal(
		calls.filter((call) => call.toolName === "execute_sql").length,
		0,
	);
	assert.equal(
		spanExporter
			.getFinishedSpans()
			.slice(before)
			.filter((span) => span.name === "mcp.tool").length,
		0,
	);
	preview.release();
	await links.entered;
	assert.equal(
		calls.filter((call) => call.toolName === "execute_sql").length,
		0,
	);
	links.release();
	const result = await work;
	assert.notEqual(result.isError, true);
	const spans = spanExporter.getFinishedSpans().slice(before);
	const tool = spans.find((span) => span.name === "mcp.tool")!;
	assert.equal(tool.attributes["mcp.tool.outcome"], "success");
	assert.equal(tool.attributes["lix.commit.outcome"], "committed");
	for (const name of ["mcp.response.preview", "mcp.response.links"]) {
		const phase = spans.find((span) => span.name === name)!;
		assert.ok(phase, name);
		assert.equal(phase.parentSpanContext?.spanId, tool.spanContext().spanId);
		assert.ok(
			spans.indexOf(phase) < spans.indexOf(tool),
			"phase must finish before tool",
		);
	}
	assert.equal(
		calls.filter((call) => call.toolName === "execute_sql").length,
		1,
	);
});

void test("late serialization and SDK output validation publish only terminal error summaries", async (t) => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	const calls: McpToolCallObservation[] = [];
	const client = await telemetryClient(service, calls);
	t.after(() => client.close());
	for (const invalidName of [123, BigInt(123)]) {
		service.listLixes = async () =>
			[
				{
					id: LIX_ID,
					name: invalidName,
					slug: "repo",
					namespace: { handle: "user" },
				},
			] as unknown as Awaited<ReturnType<LixService["listLixes"]>>;
		const before = calls.length;
		const result = await client.callTool({ name: "list_lixes", arguments: {} });
		assert.equal(result.isError, true);
		assert.equal(calls.length, before + 1);
		assert.equal(calls.at(-1)?.outcome, "error");
		const span = spanExporter
			.getFinishedSpans()
			.find((span) => span.spanContext().spanId === calls.at(-1)?.spanId)!;
		assert.equal(span.status.code, SpanStatusCode.ERROR);
	}
});

void test("concurrent tools sharing an HTTP request ID keep distinct native identities", async (t) => {
	const captured: CapturedMcpEvent[] = [];
	const restore = stubPosthogCapture(captured);
	t.after(restore);
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	const calls: McpToolCallObservation[] = [];
	const client = await telemetryClient(service, calls, {
		posthogToken: "phc_test",
		posthogDistinctId: "u",
	});
	t.after(() => client.close());
	const gate = telemetryGate();
	const list = service.listLixes.bind(service);
	service.listLixes = async () => {
		gate.enter();
		await gate.wait;
		return list();
	};
	const slow = client.callTool({ name: "list_lixes", arguments: {} });
	await gate.entered;
	const invalid = await client.callTool({ name: "open_lix", arguments: {} });
	assert.equal(invalid.isError, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.toolName, "open_lix");
	gate.release();
	await slow;
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.toolName, "list_lixes");
	assert.equal(calls[0]?.requestId, calls[1]?.requestId);
	assert.notEqual(calls[0]?.spanId, calls[1]?.spanId);
	assert.equal(calls[1]?.outcome, "success");
	await drainPosthogMcp();
	const events = captured.filter((event) => event.event === "$mcp_tool_call");
	assert.equal(events.length, 2);
	for (const call of calls) {
		const event = events.find(
			(event) => event.properties.span_id === call.spanId,
		)!;
		assert.ok(event);
		assert.equal(event.properties.$mcp_tool_name, call.toolName);
		assert.equal(event.properties.success, call.outcome === "success");
	}
});

void test("official analytics waits for final validation and completed-call enrichment", async (t) => {
	const captured: CapturedMcpEvent[] = [];
	const restore = stubPosthogCapture(captured);
	t.after(restore);
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	service.listLixes = async () =>
		[
			{ id: LIX_ID, name: 123, slug: "repo", namespace: { handle: "u" } },
		] as unknown as Awaited<ReturnType<LixService["listLixes"]>>;
	const summaries: McpToolCallObservation[] = [];
	const client = new Client(
		{ name: "analytics-terminal", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	t.after(() => client.close());
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					posthogToken: "phc_test",
					posthogDistinctId: "u",
					onToolCall: (summary) => {
						summaries.push(summary);
						summary.fileContentCharCount = 10;
						summary.fileContentByteCount = 12;
					},
				}),
		}),
	);
	const result = await client.callTool({ name: "list_lixes", arguments: {} });
	assert.equal(result.isError, true);
	await drainPosthogMcp();
	const events = captured.filter((event) => event.event === "$mcp_tool_call");
	assert.equal(events.length, 1);
	assert.equal(events[0]?.properties.success, false);
	assert.equal(events[0]?.properties.char_count, 10);
	assert.equal(events[0]?.properties.byte_count, 12);
	assert.equal(events[0]?.properties.span_id, summaries[0]?.spanId);
	assert.equal(events[0]?.properties.trace_id, summaries[0]?.traceId);
});

void test("cancelling an SSE response does not shutdown analytics before its tool unwinds", async (t) => {
	const captured: CapturedMcpEvent[] = [];
	const restore = stubPosthogCapture(captured);
	let shutdowns = 0;
	PostHog.prototype.shutdown = async () => {
		shutdowns++;
	};
	t.after(restore);
	const gate = telemetryGate();
	t.after(gate.release);
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	const list = service.listLixes.bind(service);
	service.listLixes = async () => {
		gate.enter();
		await gate.wait;
		return list();
	};
	const calls: McpToolCallObservation[] = [];
	const response = await handleMcpTransport(
		new Request("https://lixray.test/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-11-25",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_lixes", arguments: {} },
			}),
		}),
		service,
		{
			posthogToken: "phc_test",
			posthogDistinctId: "u",
			onToolCall: (call) => calls.push(call),
		},
	);
	assert.match(
		response.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	await gate.entered;
	assert.equal(calls.length, 0);
	assert.equal(shutdowns, 0);
	await response.body!.cancel();
	await drainPosthogMcp();
	assert.equal(shutdowns, 0);
	gate.release();
	await drainPosthogMcp();
	await drainPosthogMcp();
	assert.equal(calls.length, 1);
	assert.equal(shutdowns, 1);
});

void test("malformed protocol envelopes annotate the HTTP context without inventing a tool span", async () => {
	const service = new LixService(new FakeRuntime(), {
		contextSigningKey: "test",
		principal: { userId: "u", clientId: "c" },
	});
	const before = spanExporter.getFinishedSpans().length;
	await tracerProvider
		.getTracer("test-http")
		.startActiveSpan("test HTTP root", async (span) => {
			try {
				const response = await handleMcpTransport(
					new Request("https://lixray.test/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"mcp-protocol-version": MCP_PROTOCOL_VERSION,
						},
						body: "{private-malformed-json",
					}),
					service,
				);
				assert.doesNotMatch(await response.text(), /private-malformed-json/);
			} finally {
				span.end();
			}
		});
	const spans = spanExporter.getFinishedSpans().slice(before);
	assert.equal(spans.filter((span) => span.name === "mcp.tool").length, 0);
	assert.match(
		String(spans.at(-1)?.attributes["mcp.error.type"]),
		/^MCP_(RPC_|PROTOCOL_ERROR)/,
	);
	assert.equal(spans.at(-1)?.attributes["mcp.failure.stage"], "transport");
});
