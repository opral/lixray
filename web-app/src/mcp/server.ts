/*
 * The MCP SDK exposes dynamically registered tool arguments as `any`. Keep
 * this exception at the adapter boundary; the individual Zod schemas and
 * Lix service remain the runtime type guards for these values.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { instrument, PostHogMCP } from "@posthog/mcp";
import {
	createMcpHandler,
	McpServer,
	type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { sqlLooksLikeWrite } from "../lib/lix-sql-access.ts";
import {
	EXECUTE_SQL_TOOL_DESCRIPTION,
	LIX_SQL_OPERATING_GUIDE,
	QUERY_SQL_TOOL_DESCRIPTION,
} from "./execute-schema.ts";
import {
	createLixError,
	isLixError,
	LixService,
	type ExecuteRequest,
} from "./lix-service.ts";
import {
	mcpSurfaceVersion,
	observeExecuteInput,
	observeExecuteOutput,
	type McpExecuteInputObservation,
	type McpExecuteOutputObservation,
} from "./tool-observation.ts";

export const MCP_PATH = "/mcp";
export const MCP_RESOURCE = "https://lixray.com";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTECTED_RESOURCE_PATH =
	"/.well-known/oauth-protected-resource";
export const MCP_DOCUMENTATION_PATH = "/mcp/docs";
export const MCP_PROTECTED_RESOURCE_URL = `${MCP_RESOURCE}${MCP_PROTECTED_RESOURCE_PATH}`;
export const MCP_REQUEST_ID_HEADER = "X-Request-ID";
export const MCP_AI_TRACE_ID_HEADER = "X-PostHog-AI-Trace-ID";
export const MCP_AI_PARENT_ID_HEADER = "X-PostHog-AI-Parent-ID";
export const MCP_AI_SESSION_ID_HEADER = "X-PostHog-AI-Session-ID";
const MCP_SCOPES = ["openid", "email", "profile", "offline_access"] as const;

export const MCP_SERVER_INSTRUCTIONS = `LixRay exposes the JavaScript Lix SDK over MCP. Call list_lixes when you need to discover a Lix, then open_lix once and pass its returned context to every later call. The context is an explicit, signed Lix-and-branch handle; it is not an MCP session. Prefer structuredContent when the host provides it. Never copy a context token from the prose summary. Text-only hosts receive a later content text block that is the full structuredContent JSON — parse that object for context, request_id, and SQL rows.

${LIX_SQL_OPERATING_GUIDE}

Writes persist without a checkpoint; execute_sql already saved the files. create_checkpoint is an explicit user-facing action, not agent ceremony. Do not call create_checkpoint after a write, after every change, or to be safe. The agent may recommend that the user checkpoint when a task or session is done; prefer leaving the checkpoint to the user. Never treat checkpointing as required, unlike Git commits. Use restore with a commit_id to move the selected branch back to an ancestor without creating a commit. Do not invent file helper tools or branch state.`;

export const CREATE_CHECKPOINT_TOOL_DESCRIPTION =
	"Create a named restore point on the branch selected by context. This is an explicit user-facing action, not agent ceremony — writes already persist through execute_sql and a checkpoint is not required for durability. Do not call this after a write, after every change, or to be safe; call it only when the user explicitly asked. The agent may recommend that the user checkpoint when a task or session is done; prefer leaving the checkpoint to the user.";

export const RESTORE_TOOL_DESCRIPTION =
	"Move the branch selected by context to ancestor commit_id. Restore creates no commit, does not delete abandoned commits, and is not undoable; undo only applies to commits made afterward. A later checkpoint-driven garbage-collection sweep may reclaim abandoned commits that are not reachable from a retention root; other branches and branch-local untracked rows remain unchanged. create_checkpoint returns a commit_id usable here; there is no restore_checkpoint tool.";

export const LIST_LIXES_TOOL_DESCRIPTION =
	"List LixRay lixes the signed-in user can access. Use this before open_lix when the Lix is not already known. Each result identifies a lix as @handle/slug plus uuid.";

export const OPEN_LIX_TOOL_DESCRIPTION =
	"Resolve a lix and mint a signed context required by every later tool. If branch_id is omitted, pin the context to the Lix's current active branch. The response reports file and directory counts so empty lixes are obvious.";

type McpAuthMode = "oauth" | "none";

export interface McpToolCallObservation {
	requestId: string;
	toolName: string;
	outcome: "success" | "error";
	durationMs: number;
	surfaceVersion: string;
	errorCode?: string;
	lixId?: string;
	executeInput?: McpExecuteInputObservation;
	executeOutput?: McpExecuteOutputObservation;
	fileContentCharCount?: number;
	fileContentByteCount?: number;
	/** Original SQL + params for in-process file-write detection. Never sent to PostHog. */
	rawStatements?: Array<{ sql: string; params?: Array<unknown> }>;
	traceId?: string;
	parentId?: string;
	sessionId?: string;
}

export interface McpAiTraceContext {
	traceId?: string;
	parentId?: string;
	sessionId?: string;
}

export type McpToolCallObserver = (observation: McpToolCallObservation) => void;

export interface McpServerOptions {
	authMode?: McpAuthMode;
	requestId?: string;
	serverName?: string;
	onToolCall?: McpToolCallObserver;
	posthogToken?: string;
	posthogHost?: string;
	posthogDistinctId?: string;
	posthogClientId?: string;
	onPosthogFlush?: (flush: () => Promise<void>) => void;
	traceContext?: McpAiTraceContext;
}

type McpSecurityScheme =
	| { type: "oauth2"; scopes: Array<string> }
	| { type: "noauth" };

const oauthSecuritySchemes: Array<McpSecurityScheme> = [
	{ type: "oauth2", scopes: [...MCP_SCOPES] },
];

const PRIVATE_MCP_ANALYTICS_PROPERTIES = [
	"$mcp_parameters",
	"$mcp_response",
	"$mcp_error_message",
	"$exception_list",
] as const;

export function redactMcpAnalyticsEvent<
	T extends { properties: Record<string, unknown> },
>(event: T): T {
	const properties = { ...event.properties };
	for (const property of PRIVATE_MCP_ANALYTICS_PROPERTIES) {
		delete properties[property];
	}
	return { ...event, properties };
}

const MCP_DISCOVER_METHOD = "server/discover";

interface OfficialDiscoverEmitter {
	captureInitialize(data: {
		distinctId?: string;
		durationMs?: number;
		protocolVersion?: string;
		properties?: Record<string, unknown>;
	}): void;
	captureToolsList(data: {
		distinctId?: string;
		durationMs?: number;
		protocolVersion?: string;
		toolNames?: string[];
		properties?: Record<string, unknown>;
	}): void;
}

/**
 * `@posthog/mcp` 0.11.x treats a high-level server as anything with `.server`
 * plus `tool()`. MCP TypeScript SDK v2 exposes `registerTool()` instead, so
 * instrument() rejects the v2 `McpServer` and official `$mcp_tool_call` never
 * wraps. Alias `tool` so the high-level adapter can patch `tools/call`.
 */
export function prepareHighLevelMcpServerForPosthog(
	server: McpServer,
): McpServer {
	const highLevel = server as McpServer & {
		tool?: McpServer["registerTool"];
	};
	if (typeof highLevel.tool !== "function") {
		highLevel.tool = server.registerTool.bind(server);
	}
	return server;
}

/**
 * `@posthog/mcp` 0.11.x still does not capture `server/discover`. Modern
 * 2026-07-28 clients skip initialize/tools/list, so map discover onto the
 * official handshake events without a second duration field.
 */
export function wrapDiscoverAsOfficialHandshake(
	server: McpServer,
	posthog: OfficialDiscoverEmitter,
	identity: {
		distinctId?: string;
		clientId?: string;
		requestId?: string;
		traceContext?: McpAiTraceContext;
	} = {},
): void {
	const lowLevel = server.server as {
		setRequestHandler: (...args: unknown[]) => unknown;
	};
	const originalSetRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);
	lowLevel.setRequestHandler = (...args: unknown[]) => {
		if (args[0] !== MCP_DISCOVER_METHOD) {
			return originalSetRequestHandler(...args);
		}
		const handler = args.at(-1);
		if (typeof handler !== "function") {
			return originalSetRequestHandler(...args);
		}
		const wrapped = async (...handlerArgs: unknown[]) => {
			const startedAt = Date.now();
			const result = await (handler as (...h: unknown[]) => unknown)(
				...handlerArgs,
			);
			emitDiscoverAsOfficialHandshake(
				server,
				posthog,
				identity,
				Date.now() - startedAt,
			);
			return result;
		};
		return originalSetRequestHandler(...args.slice(0, -1), wrapped);
	};
}

function emitDiscoverAsOfficialHandshake(
	server: McpServer,
	posthog: OfficialDiscoverEmitter,
	identity: {
		distinctId?: string;
		clientId?: string;
		requestId?: string;
		traceContext?: McpAiTraceContext;
	},
	durationMs: number,
): void {
	if (!identity.distinctId) return;
	const properties = {
		environment: "production",
		mcp_server: "lixray",
		oauth_client_id: identity.clientId,
		request_id: identity.requestId,
		...posthogAiTraceProperties(identity.traceContext),
	};
	posthog.captureInitialize({
		distinctId: identity.distinctId,
		durationMs,
		protocolVersion: MCP_PROTOCOL_VERSION,
		properties,
	});
	posthog.captureToolsList({
		distinctId: identity.distinctId,
		durationMs,
		protocolVersion: MCP_PROTOCOL_VERSION,
		toolNames: registeredMcpToolNames(server),
		properties,
	});
}

function registeredMcpToolNames(server: McpServer): string[] {
	// `_registeredTools` is private on the SDK class. Intersecting McpServer
	// with a public copy of that field collapses the type to `never`.
	const tools = (
		server as unknown as {
			_registeredTools?: Record<string, { enabled?: boolean }>;
		}
	)._registeredTools;
	if (!tools) return [];
	return Object.entries(tools)
		.filter(([, tool]) => tool.enabled !== false)
		.map(([name]) => name);
}

/**
 * Locked `$mcp_tool_call` properties. Applied after the tool finishes so
 * failures still get `success=false`, `error_code`, and `sql_op`.
 */
export function attachMcpToolCallObservationProperties(
	properties: Record<string, unknown>,
	observation: McpToolCallObservation | undefined,
	fallbackIsError?: boolean,
): Record<string, unknown> {
	properties.success = observation
		? observation.outcome === "success"
		: fallbackIsError !== true;
	if (observation?.errorCode) {
		properties.error_code = observation.errorCode;
	} else {
		delete properties.error_code;
	}
	if (observation?.executeInput) {
		properties.sql_op = observation.executeInput.statements[0]?.operation;
		properties.is_bulk = observation.executeInput.statementCount > 1;
	}
	if (observation?.executeOutput) {
		properties.row_count = observation.executeOutput.rowCount;
	}
	if (observation?.lixId) {
		properties.lix_id = observation.lixId;
		properties.repository_id = observation.lixId;
	}
	if (observation?.fileContentCharCount !== undefined) {
		properties.char_count = observation.fileContentCharCount;
	}
	if (observation?.fileContentByteCount !== undefined) {
		properties.byte_count = observation.fileContentByteCount;
	}
	return properties;
}

const lixRef = z
	.string()
	.min(1)
	.describe("Lix UUID, slug, or @namespace/slug reference");
const context = z
	.string()
	.min(1)
	.describe("Opaque Lix context returned by open_lix or switch_branch");
const branchId = z.string().min(1).describe("Lix branch id");
const commitId = z.string().min(1).describe("Lix commit id");
const sourceBranchId = z.string().min(1).describe("Source branch id");
const requestIdValue = z
	.string()
	.min(1)
	.describe("Request ID for correlating this response with server telemetry");
const wireValue = z.union([
	z.object({ kind: z.literal("null"), value: z.null().optional() }).strict(),
	z.object({ kind: z.literal("bool"), value: z.boolean() }).strict(),
	z.object({ kind: z.literal("int"), value: z.number().int() }).strict(),
	z.object({ kind: z.literal("float"), value: z.number() }).strict(),
	z.object({ kind: z.literal("text"), value: z.string() }).strict(),
	z.object({ kind: z.literal("blob"), base64: z.string() }).strict(),
	z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
]);
const executeOptions = z
	.object({
		origin_key: z.string().optional(),
	})
	.strict();
const sqlStatement = z
	.object({ sql: z.string().min(1), params: z.array(wireValue).optional() })
	.strict();

const errorOutput = z
	.object({
		request_id: requestIdValue,
		error: z
			.object({
				code: z.string(),
				message: z.string(),
				hint: z.string().optional(),
				details: z.unknown().optional(),
			})
			.strict(),
	})
	.strict();

const listLixesOutput = withError(
	z.object({
		lixes: z.array(
			z
				.object({
					id: z.string(),
					name: z.string(),
					slug: z.string(),
					namespace: z
						.object({ id: z.string(), name: z.string(), handle: z.string() })
						.strict(),
				})
				.strict(),
		),
	}),
);
const openLixOutput = withError(
	z.object({
		context,
		context_expires_at: z.string(),
		id: z.string(),
		url: z.string(),
		lix_ref: z.string(),
		name: z.string(),
		branch_id: branchId,
		commit_id: z.string(),
		file_count: z.number().int(),
		directory_count: z.number().int(),
		empty: z.boolean(),
	}),
);
const branchStateOutput = withError(
	z.object({ context, branch_id: branchId, commit_id: z.string() }),
);
const executeOutput = withError(
	z.object({
		context,
		result: z
			.object({
				columns: z.array(z.string()),
				rows: z.array(z.array(wireValue)),
				rowsAffected: z.number().int(),
				notices: z.array(z.unknown()),
			})
			.strict(),
	}),
);
const executeBatchOutput = withError(
	z.object({
		context,
		results: z.array(
			z
				.object({
					columns: z.array(z.string()),
					rows: z.array(z.array(wireValue)),
					rowsAffected: z.number().int(),
					notices: z.array(z.unknown()),
				})
				.strict(),
		),
	}),
);
const branchOutput = withError(
	z.object({
		context,
		branch: z
			.object({
				id: z.string(),
				name: z.string(),
				hidden: z.boolean(),
				commit_id: z.string(),
			})
			.strict(),
	}),
);
const checkpointOutput = withError(
	z.object({ context, commit_id: z.string() }),
);
const undoOutput = withError(
	z.object({
		context,
		branch_id: branchId,
		target_commit_id: z.string(),
		inverse_commit_id: z.string(),
	}),
);
const redoOutput = withError(
	z.object({
		context,
		branch_id: branchId,
		target_commit_id: z.string(),
		replay_commit_id: z.string(),
	}),
);

const baseMergeOutput = z.object({ context }).catchall(z.unknown());

export function mcpServerNameForUrl(url: string): "LixRay" | "LixRay_Dev" {
	const hostname = new URL(url).hostname;
	return new Set(["localhost", "127.0.0.1", "::1"]).has(hostname)
		? "LixRay_Dev"
		: "LixRay";
}

export function requestIdForMcpRequest(request: Request): string {
	const supplied = request.headers.get(MCP_REQUEST_ID_HEADER)?.trim();
	return supplied && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied)
		? supplied
		: crypto.randomUUID();
}

const POSTHOG_AI_ID_PATTERN = /^[A-Za-z0-9._~@()!':|-]{1,200}$/;
const TRACEPARENT_PATTERN =
	/^(?!ff)([0-9a-f]{2})-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})(?:-.+)?$/i;

function validPosthogAiId(value: string | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed && POSTHOG_AI_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function aiTraceContextForMcpRequest(
	request: Request,
): McpAiTraceContext {
	const traceparent = request.headers.get("traceparent")?.trim();
	const traceparentMatch = traceparent?.match(TRACEPARENT_PATTERN);
	return {
		traceId:
			validPosthogAiId(request.headers.get(MCP_AI_TRACE_ID_HEADER)) ??
			traceparentMatch?.[2]?.toLowerCase(),
		parentId:
			validPosthogAiId(request.headers.get(MCP_AI_PARENT_ID_HEADER)) ??
			traceparentMatch?.[3]?.toLowerCase(),
		sessionId: validPosthogAiId(request.headers.get(MCP_AI_SESSION_ID_HEADER)),
	};
}

export function posthogAiTraceProperties(
	context: McpAiTraceContext | undefined,
): Record<string, string> {
	if (!context) return {};
	return {
		...(context.traceId ? { $ai_trace_id: context.traceId } : {}),
		...(context.parentId ? { $ai_parent_id: context.parentId } : {}),
		...(context.sessionId ? { $ai_session_id: context.sessionId } : {}),
	};
}

export function withMcpRequestId(
	response: Response,
	requestId: string,
): Response {
	const headers = new Headers(response.headers);
	headers.set(MCP_REQUEST_ID_HEADER, requestId);
	const exposedHeaders = new Set(
		(headers.get("access-control-expose-headers") ?? "")
			.split(",")
			.map((header) => header.trim())
			.filter(Boolean),
	);
	exposedHeaders.add(MCP_REQUEST_ID_HEADER);
	headers.set("access-control-expose-headers", [...exposedHeaders].join(", "));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function createLixrayMcpServer(
	service: LixService,
	options: McpServerOptions = {},
): McpServer {
	const requestId = options.requestId ?? crypto.randomUUID();
	const securitySchemes =
		options.authMode === "none"
			? [{ type: "noauth" as const }]
			: oauthSecuritySchemes;
	const server = new McpServer(
		{ name: options.serverName ?? "LixRay", version: "0.2.0" },
		{
			capabilities: { tools: {} },
			instructions: MCP_SERVER_INSTRUCTIONS,
		},
	);
	const surfaceVersion = mcpSurfaceVersion(toolSurfaceDescriptions());

	registerTool(
		server,
		"list_lixes",
		"List lixes",
		LIST_LIXES_TOOL_DESCRIPTION,
		z.object({}).strict(),
		listLixesOutput,
		readAnnotations(),
		securitySchemes,
		async () => ({ lixes: await service.listLixes() }),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"open_lix",
		"Open a Lix",
		OPEN_LIX_TOOL_DESCRIPTION,
		z.object({ lix_ref: lixRef, branch_id: branchId.optional() }).strict(),
		openLixOutput,
		readAnnotations(),
		securitySchemes,
		async ({ lix_ref, branch_id }) => {
			const opened = await service.openLix(lix_ref, branch_id);
			return {
				context: opened.context,
				context_expires_at: opened.contextExpiresAt,
				id: opened.lixId,
				url: `${MCP_RESOURCE}/${opened.lixRef}`,
				lix_ref: opened.lixRef,
				name: opened.name,
				branch_id: opened.branchId,
				commit_id: opened.commitId,
				file_count: opened.fileCount,
				directory_count: opened.directoryCount,
				empty: opened.empty,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"query_sql",
		"Query SQL",
		QUERY_SQL_TOOL_DESCRIPTION,
		z
			.object({
				context,
				sql: z.string().min(1),
				params: z.array(wireValue).optional(),
			})
			.strict(),
		executeOutput,
		readAnnotations(),
		securitySchemes,
		async (args) => {
			assertReadOnlyQuery(args.sql);
			return service.execute(args.context, toExecuteRequest(args));
		},
		"query_sql",
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"execute_sql",
		"Execute SQL atomically",
		EXECUTE_SQL_TOOL_DESCRIPTION,
		z
			.object({
				context,
				statements: z.array(sqlStatement).min(1),
				options: executeOptions.optional(),
			})
			.strict(),
		executeBatchOutput,
		writeAnnotations(),
		securitySchemes,
		async ({ context: token, statements, options: batchOptions }) => {
			return {
				...(await service.executeBatch(token, {
					statements,
					options: toExecuteOptions(batchOptions),
				})),
			};
		},
		"execute_sql",
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"active_branch_id",
		"Get active branch",
		"Return the branch selected by context and its current commit id.",
		z.object({ context }).strict(),
		branchStateOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token }) => {
			const state = await service.activeBranchId(token);
			return {
				context: state.context,
				branch_id: state.branchId,
				commit_id: state.commitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"switch_branch",
		"Switch branch",
		"Return a new context pinned to branch_id. Context switching is explicit and stateless; pass the returned context to subsequent calls.",
		z.object({ context, branch_id: branchId }).strict(),
		branchStateOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token, branch_id }) => {
			const state = await service.switchBranch(token, branch_id);
			return {
				context: state.context,
				branch_id: state.branchId,
				commit_id: state.commitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"create_branch",
		"Create branch",
		"Create a branch from the branch selected by context. The new branch is not made active; call switch_branch when the agent wants to work there.",
		z
			.object({
				context,
				id: z.string().optional(),
				name: z.string().min(1),
				from_commit_id: z.string().optional(),
			})
			.strict(),
		branchOutput,
		writeAnnotations(false, false),
		securitySchemes,
		async ({ context: token, id, name, from_commit_id }) => {
			const result = await service.createBranch(token, {
				id,
				name,
				fromCommitId: from_commit_id,
			});
			return {
				context: result.context,
				branch: {
					id: result.branch.id,
					name: result.branch.name,
					hidden: result.branch.hidden,
					commit_id: result.branch.commitId,
				},
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"create_checkpoint",
		"Create checkpoint",
		CREATE_CHECKPOINT_TOOL_DESCRIPTION,
		z.object({ context }).strict(),
		checkpointOutput,
		writeAnnotations(false, false),
		securitySchemes,
		async ({ context: token }) => {
			const result = await service.createCheckpoint(token);
			return { context: result.context, commit_id: result.commitId };
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"restore",
		"Restore branch",
		RESTORE_TOOL_DESCRIPTION,
		z.object({ context, commit_id: commitId }).strict(),
		branchStateOutput,
		writeAnnotations(true, true),
		securitySchemes,
		async ({ context: token, commit_id }) => {
			const result = await service.restore(token, commit_id);
			return {
				context: result.context,
				branch_id: result.branchId,
				commit_id: result.commitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"undo",
		"Undo last commit",
		"Undo the latest commit on the branch selected by context.",
		z.object({ context }).strict(),
		undoOutput,
		writeAnnotations(),
		securitySchemes,
		async ({ context: token }) => {
			const result = await service.undo(token);
			return {
				context: result.context,
				branch_id: result.branchId,
				target_commit_id: result.targetCommitId,
				inverse_commit_id: result.inverseCommitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"redo",
		"Redo commit",
		"Redo the latest undone commit on the branch selected by context.",
		z.object({ context }).strict(),
		redoOutput,
		writeAnnotations(),
		securitySchemes,
		async ({ context: token }) => {
			const result = await service.redo(token);
			return {
				context: result.context,
				branch_id: result.branchId,
				target_commit_id: result.targetCommitId,
				replay_commit_id: result.replayCommitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"merge_branch_preview",
		"Preview branch merge",
		"Preview merging source_branch_id into the active branch selected by context. This does not mutate Lix state.",
		z.object({ context, source_branch_id: sourceBranchId }).strict(),
		withError(baseMergeOutput),
		readAnnotations(),
		securitySchemes,
		async ({ context: token, source_branch_id }) =>
			service.mergeBranchPreview(token, source_branch_id),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	registerTool(
		server,
		"merge_branch",
		"Merge branch",
		"Merge source_branch_id into the active branch selected by context. Preview first and resolve conflicts before calling this mutating operation.",
		z.object({ context, source_branch_id: sourceBranchId }).strict(),
		withError(baseMergeOutput),
		writeAnnotations(),
		securitySchemes,
		async ({ context: token, source_branch_id }) =>
			service.mergeBranch(token, source_branch_id),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
	);

	return server;
}

export async function handleMcpTransport(
	request: Request,
	service: LixService,
	options: McpServerOptions = {},
): Promise<Response> {
	const requestId = options.requestId ?? requestIdForMcpRequest(request);
	const traceContext =
		options.traceContext ?? aiTraceContextForMcpRequest(request);
	if (new URL(request.url).pathname !== MCP_PATH) {
		return withMcpRequestId(
			new Response("Not found\n", { status: 404 }),
			requestId,
		);
	}
	// Cache observations before constructing the server. `eventProperties`
	// runs before the tool; `beforeSend` runs after, so the wrap must be
	// bound into registerTool() — assigning onto `options` later is a no-op.
	const observationCache = new Map<string, McpToolCallObservation>();
	const onToolCall: McpToolCallObserver | undefined =
		options.posthogToken || options.onToolCall
			? (observation) => {
					Object.assign(observation, {
						...(traceContext.traceId ? { traceId: traceContext.traceId } : {}),
						...(traceContext.parentId
							? { parentId: traceContext.parentId }
							: {}),
						...(traceContext.sessionId
							? { sessionId: traceContext.sessionId }
							: {}),
					});
					observationCache.set(observation.requestId, observation);
					options.onToolCall?.(observation);
				}
			: undefined;
	let shutdownPosthog: (() => Promise<void>) | undefined;
	const posthog = options.posthogToken
		? new PostHogMCP(options.posthogToken, {
				host: options.posthogHost ?? "https://us.i.posthog.com",
				flushAt: 1,
				flushInterval: 0,
			})
		: undefined;
	if (posthog) {
		shutdownPosthog = async () => {
			// @posthog/mcp publishes through an internal async redaction pipeline.
			// Drain microtasks, then one macrotask, before shutting the client.
			await Promise.resolve();
			await Promise.resolve();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await posthog.shutdown();
		};
	}
	const handler = createMcpHandler(
		() => {
			const server = createLixrayMcpServer(service, {
				...options,
				requestId,
				onToolCall,
				serverName: options.serverName ?? mcpServerNameForUrl(request.url),
			});
			if (posthog) {
				// Instrument inside the factory so 0.11.x can wrap v2 string
				// `tools/call` and later `server/discover` registrations.
				instrument(prepareHighLevelMcpServerForPosthog(server), posthog, {
					context: false,
					enableExceptionAutocapture: false,
					identify: options.posthogDistinctId
						? { distinctId: options.posthogDistinctId }
						: null,
					eventProperties: () => ({
						environment: "production",
						mcp_server: "lixray",
						oauth_client_id: options.posthogClientId,
						request_id: requestId,
						...posthogAiTraceProperties(traceContext),
					}),
					beforeSend: (event) => {
						const redacted = redactMcpAnalyticsEvent(event);
						if (
							!redacted.properties ||
							typeof redacted.properties !== "object" ||
							Array.isArray(redacted.properties)
						) {
							return redacted;
						}
						const props = redacted.properties as Record<string, unknown>;
						delete props.$mcp_parameters;
						delete props.$mcp_response;
						delete props.$mcp_error_message;
						if (redacted.event === "$mcp_tool_call") {
							attachMcpToolCallObservationProperties(
								props,
								observationCache.get(requestId),
								props.$mcp_is_error === true,
							);
						}
						return redacted;
					},
				});
				wrapDiscoverAsOfficialHandshake(server, posthog, {
					distinctId: options.posthogDistinctId,
					clientId: options.posthogClientId,
					requestId,
					traceContext,
				});
			}
			return server;
		},
		{
			legacy: "stateless",
			responseMode: "json",
			onerror: (error) =>
				console.error("LixRay MCP protocol error", { requestId, error }),
		},
	);
	try {
		const response = await handler.fetch(request);
		const headers = new Headers(response.headers);
		headers.set("access-control-allow-origin", "*");
		headers.set(
			"access-control-expose-headers",
			"MCP-Protocol-Version, Mcp-Method, Mcp-Name",
		);
		return withMcpRequestId(
			new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
			requestId,
		);
	} finally {
		if (shutdownPosthog) {
			if (options.onPosthogFlush) {
				options.onPosthogFlush(shutdownPosthog);
			} else {
				await shutdownPosthog();
			}
		}
	}
}

interface McpDiscoveryOptions {
	resource?: string;
	protectedResourceUrl?: string;
	authorizationServer?: string;
	resourceDocumentationUrl?: string;
	endpointUrl?: string;
}

export function protectedResourceMetadataResponse(
	options: McpDiscoveryOptions = {},
): Response {
	if (!options.authorizationServer) {
		return new Response("MCP authorization is not configured\n", {
			status: 500,
		});
	}
	return Response.json(
		{
			resource: options.resource ?? MCP_RESOURCE,
			authorization_servers: [options.authorizationServer],
			scopes_supported: [...MCP_SCOPES],
			resource_documentation:
				options.resourceDocumentationUrl ??
				`${MCP_RESOURCE}${MCP_DOCUMENTATION_PATH}`,
		},
		{
			headers: {
				"access-control-allow-origin": "*",
				"cache-control": "public, max-age=300",
			},
		},
	);
}

export function mcpDocumentationResponse(
	options: McpDiscoveryOptions = {},
): Response {
	return new Response(
		[
			"LixRay MCP",
			"",
			`Endpoint: ${options.endpointUrl ?? `${MCP_RESOURCE}${MCP_PATH}`}`,
			`Protocol: MCP ${MCP_PROTOCOL_VERSION} (modern stateless transport only).`,
			"Authentication: Supabase OAuth 2.1 with PKCE and dynamic client registration.",
			"",
			"Call list_lixes when the Lix is unknown, then open_lix. Prefer the returned context from structuredContent. Never copy a context token from the prose summary; text-only hosts receive a later text block that is the full structuredContent JSON. A context selects one Lix and one branch and is signed, expiring, and independent from the MCP transport request.",
			"",
			"Use query_sql for one SELECT statement and execute_sql for any atomic ordered SQL batch. execute_sql is always treated as potentially destructive. File and directory operations are SQL against public lix_file and lix_directory tables; do not expect separate file helper tools. Directory paths use /skills, not /skills/.",
			"execute_sql already persisted the mutation. Do not follow a write with a verification SELECT.",
			"Every MCP response includes X-Request-ID and every tool result includes request_id. You may send X-Request-ID to preserve an upstream correlation ID; use the returned ID when reporting failures.",
			"",
			"Modern clients begin with server/discover. There is no initialize handshake and no MCP session id on this endpoint.",
		].join("\n"),
		{
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "public, max-age=300",
			},
		},
	);
}

export function mcpUnauthorizedResponse(
	error = "invalid_token",
	description = "Sign in to LixRay to continue.",
	protectedResourceUrl = MCP_PROTECTED_RESOURCE_URL,
): Response {
	const challenge = mcpAuthenticateChallenge(
		error,
		description,
		protectedResourceUrl,
	);
	return Response.json(
		{
			error: "unauthorized",
			error_description: description,
			_meta: { "mcp/www_authenticate": [challenge] },
		},
		{
			status: 401,
			headers: {
				"access-control-allow-origin": "*",
				"WWW-Authenticate": challenge,
			},
		},
	);
}

export function mcpAuthenticateChallenge(
	error = "invalid_token",
	description = "Sign in to LixRay to continue.",
	protectedResourceUrl = MCP_PROTECTED_RESOURCE_URL,
): string {
	return `Bearer resource_metadata="${protectedResourceUrl}", scope="${MCP_SCOPES.join(" ")}", error="${error}", error_description="${description.replaceAll('"', "'")}"`;
}

function registerTool(
	server: McpServer,
	name: string,
	title: string,
	description: string,
	inputSchema: z.ZodTypeAny,
	outputSchema: z.ZodTypeAny,
	annotations: ToolAnnotations,
	securitySchemes: Array<McpSecurityScheme>,
	call: (args: Record<string, any>) => Promise<any>,
	observationName: string | undefined,
	observer: McpToolCallObserver | undefined,
	surfaceVersion: string,
	requestId: string,
	service: LixService,
): void {
	server.registerTool(
		name,
		{
			title,
			description,
			inputSchema,
			outputSchema,
			annotations,
			_meta: { securitySchemes },
		},
		async (args) => {
			const startedAt = Date.now();
			const toolName = observationName ?? name;
			const input = args as Record<string, any>;
			const rawStatements = sqlToolStatements(name, input);
			const executeInput = rawStatements
				? observeExecuteInput(rawStatements)
				: undefined;
			try {
				const raw = await call(input);
				const executeOutput = isSqlTool(name)
					? observeExecuteOutput(
							name === "query_sql" ? { results: [raw.result] } : raw,
						)
					: undefined;
				const lixId = await observationLixId(service, input, raw);
				observeToolCall(observer, startedAt, {
					requestId,
					toolName,
					outcome: "success",
					surfaceVersion,
					...(lixId ? { lixId } : {}),
					...(executeInput ? { executeInput } : {}),
					...(executeOutput ? { executeOutput } : {}),
					...(rawStatements ? { rawStatements } : {}),
				});
				const structuredContent = {
					...(raw as Record<string, unknown>),
					request_id: requestId,
				};
				return {
					structuredContent,
					content: toolResultTextBlocks(
						summarizeToolResult(name, raw),
						structuredContent,
					),
				};
			} catch (caught) {
				const error = toMcpError(caught, requestId);
				const lixId = await observationLixId(service, input);
				observeToolCall(observer, startedAt, {
					requestId,
					toolName,
					outcome: "error",
					surfaceVersion,
					errorCode: error.code,
					...(lixId ? { lixId } : {}),
					...(executeInput ? { executeInput } : {}),
					...(rawStatements ? { rawStatements } : {}),
				});
				if (!isLixError(caught)) {
					console.error("LixRay MCP tool failed", {
						tool: name,
						error: errorDetails(caught),
					});
				}
				const structuredContent = { request_id: requestId, error };
				return {
					isError: true,
					structuredContent,
					content: toolResultTextBlocks(
						summarizeToolError(error),
						structuredContent,
					),
				};
			}
		},
	);
}

/**
 * Hosts that concatenate content[].text (and drop structuredContent) still
 * need a copy-able whole JSON object. Keep the first block as a prose
 * summary that never embeds context=; the later block is structuredContent.
 */
function toolResultTextBlocks(
	summary: string,
	structuredContent: Record<string, unknown>,
): Array<{ type: "text"; text: string }> {
	return [
		{ type: "text" as const, text: summary },
		{
			type: "text" as const,
			text: JSON.stringify(structuredContent, null, 2),
		},
	];
}

function summarizeListLixes(result: Record<string, unknown>): string {
	const lixes = Array.isArray(result.lixes) ? result.lixes : [];
	const count = lixes.length;
	const heading = `Found ${count} accessible ${count === 1 ? "Lix" : "Lixes"}.`;
	if (count === 0) {
		return heading;
	}
	const identities = lixes.map((item) => formatListLixIdentity(item));
	return `${heading}\n${identities.join("\n")}`;
}

function formatListLixIdentity(item: unknown): string {
	const lix =
		item && typeof item === "object" ? (item as Record<string, unknown>) : {};
	const namespace =
		lix.namespace && typeof lix.namespace === "object"
			? (lix.namespace as Record<string, unknown>)
			: {};
	const handle = typeof namespace.handle === "string" ? namespace.handle : "";
	const slug = typeof lix.slug === "string" ? lix.slug : "";
	const id = typeof lix.id === "string" ? lix.id : "";
	const name = typeof lix.name === "string" ? lix.name : "";
	const identity =
		handle && slug ? `@${handle}/${slug}` : slug || id || "unknown";
	const parts = [identity];
	if (id && id !== identity) {
		parts.push(id);
	}
	if (name) {
		parts.push(name);
	}
	return parts.join(" ");
}

function summarizeToolResult(name: string, raw: unknown): string {
	if (!raw || typeof raw !== "object") return `${name} completed.`;
	const result = raw as Record<string, unknown>;

	if (name === "list_lixes") {
		return summarizeListLixes(result);
	}
	if (name === "open_lix") {
		return summarizeOpenLix(result);
	}
	if (name === "query_sql") {
		return summarizeQuerySql(result.result);
	}
	if (name === "execute_sql") {
		return summarizeExecuteSql(result.results);
	}
	if (name === "active_branch_id") {
		return `Active branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.`;
	}
	if (name === "switch_branch") {
		return `Switched to branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.`;
	}
	if (name === "create_branch") {
		const branch = result.branch as Record<string, unknown> | undefined;
		if (branch) {
			return `Created branch ${String(branch.name)} (${String(branch.id)}) at commit ${String(branch.commit_id)}.`;
		}
		return "Branch created.";
	}
	if (name === "create_checkpoint") {
		return `Checkpoint created at commit ${String(result.commit_id)}.`;
	}
	if (name === "restore") {
		return `Restored branch ${String(result.branch_id)} to commit ${String(result.commit_id)}.`;
	}
	if (name === "undo") {
		return `Undone to commit ${String(result.target_commit_id)} (inverse commit ${String(result.inverse_commit_id)}).`;
	}
	if (name === "redo") {
		return `Redone to commit ${String(result.target_commit_id)} (replay commit ${String(result.replay_commit_id)}).`;
	}
	if (name === "merge_branch_preview") {
		return "Merge preview completed.";
	}
	if (name === "merge_branch") {
		return "Branch merged.";
	}
	return `${name} completed.`;
}

function summarizeOpenLix(result: Record<string, unknown>): string {
	const identity =
		typeof result.lix_ref === "string" && result.lix_ref.length > 0
			? result.lix_ref
			: String(result.url ?? result.id);
	const name =
		typeof result.name === "string" && result.name.length > 0
			? ` (${result.name})`
			: "";
	return `Opened ${identity}${name} on branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.${formatInventory(result)} Context expires at ${String(result.context_expires_at)}.`;
}

function formatInventory(result: Record<string, unknown>): string {
	if (
		typeof result.file_count !== "number" ||
		typeof result.directory_count !== "number"
	) {
		return "";
	}
	const files = `${result.file_count} ${result.file_count === 1 ? "file" : "files"}`;
	const dirs = `${result.directory_count} ${result.directory_count === 1 ? "directory" : "directories"}`;
	if (result.empty === true) {
		return ` empty, ${files}, ${dirs}.`;
	}
	return ` ${files}, ${dirs}.`;
}

function summarizeQuerySql(payload: unknown): string {
	const rows = sqlRowCount(payload);
	return `query_sql: ${rows} ${rows === 1 ? "row" : "rows"}`;
}

function summarizeExecuteSql(payload: unknown): string {
	const results: Array<unknown> = Array.isArray(payload) ? payload : [];
	let affected = 0;
	for (const item of results) {
		affected += sqlRowsAffected(item);
	}
	return `execute_sql: ${affected} ${affected === 1 ? "row" : "rows"} affected`;
}

function sqlRowCount(payload: unknown): number {
	if (!payload || typeof payload !== "object") return 0;
	const rows = (payload as { rows?: unknown }).rows;
	return Array.isArray(rows) ? rows.length : 0;
}

function sqlRowsAffected(payload: unknown): number {
	if (!payload || typeof payload !== "object") return 0;
	const rowsAffected = (payload as { rowsAffected?: unknown }).rowsAffected;
	return typeof rowsAffected === "number" && Number.isFinite(rowsAffected)
		? Math.max(0, Math.trunc(rowsAffected))
		: 0;
}

function summarizeToolError(error: {
	code: string;
	message: string;
	hint?: string;
}): string {
	return `LixRay error ${error.code}: ${error.message}${error.hint ? ` Hint: ${error.hint}` : ""}`;
}

function toMcpError(
	caught: unknown,
	requestId: string,
): {
	code: string;
	message: string;
	hint?: string;
	details?: unknown;
} {
	if (isLixError(caught)) {
		return {
			code: caught.code ?? "internal_error",
			message: caught.message,
			...(caught.hint ? { hint: caught.hint } : {}),
			...(caught.details !== undefined ? { details: caught.details } : {}),
		};
	}
	return {
		code: "internal_error",
		message: "The LixRay tool call failed.",
		hint: `Retry once. If the failure persists, contact LixRay support with request_id ${requestId}.`,
	};
}

function withError(schema: z.ZodObject<any>) {
	return z.union([schema.extend({ request_id: requestIdValue }), errorOutput]);
}

function toolSurfaceDescriptions(): Array<Record<string, unknown>> {
	return [
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
	].map((name) => ({ name }));
}

function assertReadOnlyQuery(sql: string): void {
	if (sqlLooksLikeWrite(sql)) {
		throw createLixError(
			"invalid_request",
			"query_sql rejects INSERT, UPDATE, and DELETE.",
			{
				hint: "Use execute_sql for writes.",
			},
		);
	}
}

function toExecuteRequest(args: Record<string, any>): ExecuteRequest {
	return {
		sql: args.sql,
		params: args.params,
	};
}

function toExecuteOptions(
	options: Record<string, string> | undefined,
): { originKey?: string } | undefined {
	if (!options) return undefined;
	return {
		...(options.origin_key ? { originKey: options.origin_key } : {}),
	};
}

function isSqlTool(name: string): boolean {
	return name === "query_sql" || name === "execute_sql";
}

type SqlToolStatement = { sql: string; params?: Array<unknown> };

function sqlToolStatements(
	name: string,
	input: Record<string, any>,
): Array<SqlToolStatement> | undefined {
	if (name === "query_sql") return [input as SqlToolStatement];
	if (name === "execute_sql" && Array.isArray(input.statements)) {
		return input.statements as Array<SqlToolStatement>;
	}
	return undefined;
}

async function observationLixId(
	service: LixService,
	input: Record<string, any>,
	raw?: unknown,
): Promise<string | undefined> {
	if (raw && typeof raw === "object" && "id" in raw) {
		const openedId = (raw as { id: unknown }).id;
		if (typeof openedId === "string" && openedId.length > 0) return openedId;
	}
	if (typeof input.context !== "string") return undefined;
	try {
		return await service.contextLixId(input.context);
	} catch {
		return undefined;
	}
}

function readAnnotations(): ToolAnnotations {
	return {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: false,
	};
}

function writeAnnotations(
	destructiveHint = true,
	idempotentHint = false,
): ToolAnnotations {
	return {
		readOnlyHint: false,
		destructiveHint,
		idempotentHint,
		openWorldHint: false,
	};
}

function observeToolCall(
	observer: McpToolCallObserver | undefined,
	startedAt: number,
	observation: Omit<McpToolCallObservation, "durationMs">,
): void {
	if (!observer) return;
	try {
		observer({
			...observation,
			durationMs: Math.max(0, Date.now() - startedAt),
		});
	} catch (caught) {
		console.warn(
			"Failed to observe LixRay MCP tool call",
			errorDetails(caught),
		);
	}
}

function errorDetails(caught: unknown): Record<string, unknown> {
	if (caught instanceof Error)
		return { name: caught.name, message: caught.message };
	return caught && typeof caught === "object"
		? { ...(caught as Record<string, unknown>) }
		: { value: String(caught) };
}
