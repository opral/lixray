/*
 * The MCP SDK exposes dynamically registered tool arguments as `any`. Keep
 * this exception at the adapter boundary; the individual Zod schemas and
 * Lix service remain the runtime type guards for these values.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { sqlToolError } from "./sql-errors.ts";
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
	LIST_FILES_TOOL_DESCRIPTION,
	LIX_CATALOG_HINT,
	LIX_IS_NOT_SQLITE_MESSAGE,
	LIX_SQL_OPERATING_GUIDE,
	QUERY_SQL_TOOL_DESCRIPTION,
	READ_FILES_TOOL_DESCRIPTION,
	WRITE_FILES_TOOL_DESCRIPTION,
} from "./execute-schema.ts";
import {
	createLixError,
	isLixError,
	LixService,
	type DiffRef,
	type ExecuteRequest,
	type FileChange,
} from "./lix-service.ts";
import {
	mcpSurfaceVersion,
	observeExecuteInput,
	observeExecuteOutput,
	type McpExecuteInputObservation,
	type McpExecuteOutputObservation,
} from "./tool-observation.ts";

import { MCP_RESOURCE } from "./auth.ts";
import {
	MCP_APP_HTML,
	DIFF_CARD_URI,
	DIFF_CARD_META,
	DIFF_CARD_HTML,
} from "./diff-card-app.ts";
import {
	diffCardPayload,
	diffCardStatus,
	isRenderablePath,
	MAX_CARD_FILES,
	type DiffCardPayload,
} from "./diff-card.ts";
import {
	DELETED_FILE_NAMES_SQL,
	TOUCHED_CHANGES_SQL,
	deletedFileNames,
	describeTouched,
	directoryPaths,
	directoryPathsSql,
	mcpOriginKey,
	mimeTypeForPath,
	touchedFromChanges,
	type TouchedEntity,
} from "./touched-entities.ts";

export const MCP_PATH = "/mcp";
export { MCP_RESOURCE } from "./auth.ts";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTECTED_RESOURCE_PATH =
	"/.well-known/oauth-protected-resource";
export const MCP_DOCUMENTATION_PATH = "/mcp/docs";
export const MCP_PROTECTED_RESOURCE_URL = `${MCP_RESOURCE}${MCP_PROTECTED_RESOURCE_PATH}`;
export const MCP_REQUEST_ID_HEADER = "X-Request-ID";
export const MCP_AI_TRACE_ID_HEADER = "X-PostHog-AI-Trace-ID";
export const MCP_AI_PARENT_ID_HEADER = "X-PostHog-AI-Parent-ID";
export const MCP_AI_SESSION_ID_HEADER = "X-PostHog-AI-Session-ID";
export const SQL_GUIDE_URI = "lixray://docs/sql";
const MCP_SCOPES = ["openid", "email", "profile", "offline_access"] as const;

export const MCP_URL_GUIDE =
	"Browser links: use the exact server-generated url from open_lix.files or get_entity_urls. file_paths are SQL paths, not browser URLs. Never build one by hand: an entity URL is /file/<id>/<path-slug> or /folder/<id>/<path-slug>, and the app rewrites the slug from the id anyway. After creating or renaming files/directories, call get_entity_urls once with all items you need to link, using the current context. This read resolves canonical links; it is not a persistence verification. A url carries a branch parameter only when it is not the Lix's default branch; keep it exactly as returned. URLs do not grant access or publish private items. If resolution fails, report the error and omit the item link rather than guessing.";

export const GET_ENTITY_URLS_TOOL_DESCRIPTION =
	"Return canonical browser URLs for up to 50 files or directories in the Lix and branch in context, each given by kind and exactly one of id or absolute path. Use after writes or renames, or for items absent from open_lix.files; copy the returned urls exactly. Read-only; directory path / is the repository URL.";

export const UNDO_TOOL_DESCRIPTION =
	"Undo the latest undoable change on the context branch by creating an inverse commit. Prefer this to manual SQL reversal when asked to undo that change. No commit_id parameter; inspect history first if later edits may exist. Stops at checkpoints; restore copies a saved state into a new undoable commit.";

/** What the host shows after a change, and what the agent should not repeat. */
export const DIFF_CARD_GUIDE =
	"After write_files, execute_sql, or diff, MCP Apps hosts render a collapsible card of what changed: one bar naming the files, which the user expands to page through each file's rendered change and open it in LixRay. When the user asks what changed between two points (a checkpoint, a commit, a branch, the working state), call diff and the same card appears. The card is collapsed by default and the user opens it; name the change in one sentence and do not repeat the file list in prose. Other hosts get the same receipt and file links; do not assume a card was displayed.";

export const DIFF_TOOL_DESCRIPTION =
	'List the files that differ between two points of the Lix in context, each added, modified, removed, or moved (with before_path). before and after are each { checkpoint_id }, { commit_id }, { branch_id }, "working" (the branch as it stands), or "latest_checkpoint" (the nearest checkpoint behind it); paths narrows the list. Read-only. "What changed since the last checkpoint" is { before: "latest_checkpoint", after: "working" }. MCP Apps hosts render the same collapsible card a write shows; summarize in one sentence rather than listing the files.';

export const MCP_SERVER_INSTRUCTIONS = `LixRay exposes the JavaScript Lix SDK over MCP. Match this server by its exact LixRay name rather than broad repository or file keywords. For SQL with an exact @handle/slug or Lix UUID, pass lix_ref directly; do not call open_lix or list_lixes first. Call list_lixes only when the target Lix is unknown. SQL calls accept lix_ref with optional branch_id, defaulting to the repository default branch. Use open_lix only for its file inventory or to obtain a context for other tools. An existing context remains pinned to its selected branch; pass it alone instead of lix_ref. open_lix includes a bounded file_paths manifest; when file_paths_complete is true, use it instead of listing files again. Prefer read_files and write_files for ordinary file reads and creates/updates; use list_files only to discover paths. Batch known paths together. Use query_sql for advanced reads and execute_sql for other mutations, including renames/deletes and directory operations. ${DIFF_CARD_GUIDE} The context is an explicit, encrypted Lix-and-branch handle; it is not an MCP session. Prefer structuredContent when the host provides it. Never copy a context token from the prose summary. Text-only hosts receive a later content text block that is the full structuredContent JSON — parse that object for context and SQL rows.

Lix SQL is a Postgres dialect subset, not SQLite. Discover tables/columns through information_schema; use $1, $2 parameters. The SQL tools carry essential guidance; the full SQL reference is available at ${SQL_GUIDE_URI}. A successful mutation is already saved. Read back when the outcome is unknown or validation is part of the task; never blindly retry an uncertain write.

${UNDO_TOOL_DESCRIPTION}

${MCP_URL_GUIDE}

Writes persist without a checkpoint; execute_sql already saved the files. Use create_checkpoint to mark meaningful milestones so the user can follow your work and return to important states. Create a checkpoint when you finish a substantial, coherent piece of work, such as completing a document, implementing a feature, or finishing a related batch of changes. Also checkpoint when the user asks. Use judgment: routine edits, typo fixes, and intermediate steps usually do not need checkpoints. Do not checkpoint after every edit or ask the user to manage checkpoint timing. A checkpoint marks progress; it is not required to save changes. Use restore with a commit_id to copy that saved state into a new commit on the selected branch. Do not invent tools, arguments, or branch state.`;

export const CREATE_CHECKPOINT_TOOL_DESCRIPTION =
	"Mark a milestone on the branch in context so the user can follow your work and return to it. Changes are already saved automatically; a checkpoint is not required to save them.";

export const RESTORE_TOOL_DESCRIPTION =
	"Copy content from commit_id into a new commit on the context branch. Preserves history and working baseline; undo can reverse it. Returns the new commit_id, or null if unchanged. Use a commit_id from create_checkpoint or history.";

export const LIST_LIXES_TOOL_DESCRIPTION =
	"List the lixes the signed-in user can access, each as @handle/slug plus uuid. Call only when the target Lix is unknown; With an exact reference, use open_lix for file-tool context or lix_ref directly for SQL.";

export const OPEN_LIX_TOOL_DESCRIPTION =
	"Open exact @handle/slug or UUID without calling list_lixes first and mint context (active branch unless branch_id is given). Optional for SQL. Returns counts, file_paths (SQL paths, not URLs), and files with id, path, canonical url; when file_paths_complete is true, do not list files again.";

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

export interface McpTransportObservation {
	requestId: string;
	traceId: string;
	parentId?: string;
	sessionId?: string;
	durationMs: number;
	statusCode: number;
	outcome: "success" | "error";
	errorCode?: string;
	stage: "transport";
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
	/** Browser origin of the serving deployment; never supplied by tool arguments. */
	urlOrigin?: string;
	onToolCall?: McpToolCallObserver;
	onTransport?: (observation: McpTransportObservation) => void;
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
	.describe(
		"Opaque Lix context returned by SQL tools, open_lix or switch_branch",
	);
const branchId = z.string().min(1).describe("Lix branch id");
const commitId = z.string().min(1).describe("Lix commit id");
const sourceBranchId = z.string().min(1).describe("Source branch id");
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

// Rows carry the same {kind, value} wire shape as params; the output schema
// says so once instead of inlining the union again per tool.
const wireRows = z
	.array(z.array(z.unknown()))
	.describe("Rows of wire values in the same {kind, value} shape as params");

const listLixesOutput = withError(
	z.object({
		lixes: z.array(
			z
				.object({
					id: z.string(),
					name: z.string(),
					slug: z.string(),
					namespace: z.object({ handle: z.string() }).strict(),
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
		files: z.array(
			z.object({ id: z.string(), path: z.string(), url: z.string() }).strict(),
		),
		file_paths: z.array(z.string()),
		file_paths_complete: z.boolean(),
		file_paths_sql: z.string().optional(),
		empty: z.boolean(),
	}),
);
const entityUrlsOutput = withError(
	z.object({
		context,
		entities: z.array(
			z
				.object({
					kind: z.enum(["file", "directory"]),
					id: z.string().nullable(),
					path: z.string(),
					url: z.string(),
				})
				.strict(),
		),
	}),
);

const fileMetadata = z.record(z.string(), z.unknown());
const listedFile = z
	.object({ id: z.string(), path: z.string(), url: z.string() })
	.strict();
const listFilesOutput = withError(
	z.object({
		context,
		commit_id: z.string(),
		files: z.array(listedFile),
		truncated: z.boolean(),
	}),
);
const readFilesOutput = withError(
	z.object({
		context,
		commit_id: z.string(),
		files: z.array(
			z
				.object({
					id: z.string(),
					path: z.string(),
					url: z.string(),
					size: z.number().int(),
					/** The file's text; absent when `encoding` says why it is not. */
					content: z.string().optional(),
					encoding: z.enum(["binary", "too-large"]).optional(),
					lixcol_metadata: fileMetadata.nullable(),
				})
				.strict(),
		),
		missing: z.array(z.string()),
	}),
);
const writeFilesOutput = withError(
	z.object({
		context,
		commit_id: z.string().optional(),
		files: z.array(listedFile),
		checkpoint_commit_id: z.string().optional(),
		commit: z.object({ before: z.string(), after: z.string() }).nullable(),
		warning: z.string().optional(),
	}),
);
const diffRef = z.union([
	z.object({ checkpoint_id: commitId }).strict(),
	z.object({ commit_id: commitId }).strict(),
	z.object({ branch_id: branchId }).strict(),
	z.literal("working"),
	z.literal("latest_checkpoint"),
]);
const diffOutput = withError(
	z.object({
		context,
		files: z.array(
			z
				.object({
					path: z.string(),
					status: z.enum(["added", "modified", "removed", "moved"]),
					before_path: z.string().optional(),
					before_commit_id: z.string(),
					after_commit_id: z.string(),
					url: z.string(),
				})
				.strict(),
		),
		before: z.string(),
		after: z.string(),
		commit_id: z.string(),
		url: z.string(),
	}),
);
const entityUrlSelector = z.union([
	z
		.object({ kind: z.enum(["file", "directory"]), id: z.string().uuid() })
		.strict(),
	z
		.object({
			kind: z.enum(["file", "directory"]),
			path: z.string().startsWith("/"),
		})
		.strict(),
]);

const branchStateOutput = withError(
	z.object({ context, branch_id: branchId, commit_id: z.string() }),
);
const commitSpan = z.object({ before: z.string(), after: z.string() }).strict();
const executeOutput = withError(
	z.object({
		context,
		result: z
			.object({
				columns: z.array(z.string()),
				rows: wireRows,
				rowsAffected: z.number().int(),
				notices: z.array(z.unknown()),
				commit: commitSpan.nullable(),
			})
			.strict(),
	}),
);
const executeBatchOutput = withError(
	z.object({
		context,
		commit: commitSpan.nullable(),
		results: z.array(
			z
				.object({
					columns: z.array(z.string()),
					rows: wireRows,
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
			capabilities: { tools: {}, resources: {} },
			instructions: MCP_SERVER_INSTRUCTIONS,
		},
	);
	const surfaceVersion = mcpSurfaceVersion(toolSurfaceDescriptions());
	server.registerResource(
		"sql-guide",
		SQL_GUIDE_URI,
		{
			title: "Lix SQL reference",
			mimeType: "text/plain",
		},
		(uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/plain",
					text: LIX_SQL_OPERATING_GUIDE,
				},
			],
		}),
	);
	server.registerResource(
		"diff-card",
		DIFF_CARD_URI,
		{
			title: "LixRay file changes",
			mimeType: MCP_APP_HTML,
			description:
				"A collapsible card of the files write_files, execute_sql, or diff changed.",
		},
		(uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: MCP_APP_HTML,
					text: DIFF_CARD_HTML,
					_meta: {
						ui: {
							csp: { connectDomains: [], resourceDomains: [] },
							prefersBorder: false,
						},
					},
				},
			],
		}),
	);

	registerTool(
		server,
		"list_lixes",
		"LixRay: Discover lixes",
		LIST_LIXES_TOOL_DESCRIPTION,
		z.object({}).strict(),
		listLixesOutput,
		readAnnotations(),
		securitySchemes,
		async () => ({
			lixes: (await service.listLixes()).map(
				({ id, name, slug, namespace }) => ({
					id,
					name,
					slug,
					namespace: { handle: namespace.handle },
				}),
			),
		}),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"open_lix",
		"LixRay: Open a Lix",
		OPEN_LIX_TOOL_DESCRIPTION,
		z.object({ lix_ref: lixRef, branch_id: branchId.optional() }).strict(),
		openLixOutput,
		readAnnotations(),
		securitySchemes,
		async ({ lix_ref, branch_id }) => {
			const opened = await service.openLix(
				lix_ref,
				branch_id,
				options.urlOrigin,
			);
			return {
				context: opened.context,
				context_expires_at: opened.contextExpiresAt,
				id: opened.lixId,
				url: opened.url,
				files: opened.files,
				lix_ref: opened.lixRef,
				name: opened.name,
				branch_id: opened.branchId,
				commit_id: opened.commitId,
				file_count: opened.fileCount,
				directory_count: opened.directoryCount,
				file_paths: opened.filePaths,
				file_paths_complete: opened.filePathsComplete,
				// A truncated manifest says how to get the rest, so an agent that
				// trusts the open payload is not left with a partial list.
				...(opened.filePathsComplete
					? {}
					: { file_paths_sql: OPEN_LIX_ALL_FILE_PATHS_SQL }),
				empty: opened.empty,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"get_entity_urls",
		"LixRay: Get canonical item URLs",
		GET_ENTITY_URLS_TOOL_DESCRIPTION,
		z
			.object({ context, entities: z.array(entityUrlSelector).min(1).max(50) })
			.strict(),
		entityUrlsOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token, entities }) =>
			service.getEntityUrls(token, entities, options.urlOrigin),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"list_files",
		"LixRay: List files",
		LIST_FILES_TOOL_DESCRIPTION,
		z
			.object({
				context,
				directory: z.string().min(1).optional(),
				name: z.string().min(1).optional(),
			})
			.strict(),
		listFilesOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token, directory, name }) => {
			const listed = await service.listFiles(
				token,
				{ ...(directory ? { directory } : {}), ...(name ? { name } : {}) },
				options.urlOrigin,
			);
			return {
				context: listed.context,
				commit_id: listed.commitId,
				files: listed.files,
				truncated: listed.truncated,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"read_files",
		"LixRay: Read files",
		READ_FILES_TOOL_DESCRIPTION,
		z
			.object({ context, paths: z.array(z.string().min(1)).min(1).max(100) })
			.strict(),
		readFilesOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token, paths }) => {
			const read = await service.readFiles(token, paths, options.urlOrigin);
			return {
				context: read.context,
				commit_id: read.commitId,
				files: read.files,
				missing: read.missing,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"write_files",
		"LixRay: Write files",
		WRITE_FILES_TOOL_DESCRIPTION,
		z
			.object({
				context,
				files: z
					.array(
						z
							.object({
								path: z.string().min(1),
								content: z.string().optional(),
								content_base64: z.string().optional(),
								lixcol_metadata: fileMetadata.nullable().optional(),
							})
							.strict(),
					)
					.min(1)
					.max(100),
				last_seen_commit_id: commitId.optional(),
				checkpoint: z.boolean().optional(),
			})
			.strict(),
		writeFilesOutput,
		writeAnnotations(),
		securitySchemes,
		async (
			{ context: token, files, last_seen_commit_id, checkpoint },
			callId,
		) => {
			const written = await service.writeFiles(
				token,
				{
					files,
					...(last_seen_commit_id
						? { lastSeenCommitId: last_seen_commit_id }
						: {}),
					...(checkpoint ? { checkpoint } : {}),
					originKey: mcpOriginKey(callId),
				},
				options.urlOrigin,
			);
			const rendered = await writeCard(
				service,
				token,
				written,
				files,
				options.urlOrigin,
			);
			const warning = [
				written.warning,
				rendered.failed ? PREVIEW_UNAVAILABLE : undefined,
			]
				.filter(Boolean)
				.join(" ");
			return {
				context: written.context,
				commit_id: written.commitId,
				files: written.files,
				...(written.checkpointCommitId
					? { checkpoint_commit_id: written.checkpointCommitId }
					: {}),
				...uiField(rendered.card),
				commit: written.commit,
				...(warning ? { warning } : {}),
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"diff",
		"LixRay: Diff two points",
		DIFF_TOOL_DESCRIPTION,
		z
			.object({
				context,
				before: diffRef,
				after: diffRef,
				paths: z.array(z.string().min(1)).min(1).max(100).optional(),
			})
			.strict(),
		diffOutput,
		readAnnotations(),
		securitySchemes,
		async ({ context: token, before, after, paths }) => {
			const [beforeId, afterId] = await Promise.all([
				service.resolveDiffRef(token, before),
				service.resolveDiffRef(token, after),
			]);
			const span = { before: beforeId, after: afterId };
			const changes =
				beforeId === afterId
					? []
					: await service.fileChanges(token, span, paths ?? []);
			const urls = await service.changeUrls(token, changes, options.urlOrigin);
			const files = changes.map((change, index) => ({
				path: change.path,
				status: diffCardStatus(change),
				...(change.movedFrom !== undefined
					? { before_path: change.movedFrom }
					: {}),
				before_commit_id: beforeId,
				after_commit_id: afterId,
				url: urls.files[index]!,
			}));
			const named = files.map((file) => file.path.replace(/^\//, ""));
			const shown = named.slice(0, 20);
			return {
				context: token,
				files,
				before: beforeId,
				after: afterId,
				commit_id: afterId,
				url: urls.repository,
				...uiField(changeCard(changes, urls.files, "changed", urls.repository)),
				[SUMMARY_KEY]: `${files.length} ${files.length === 1 ? "file" : "files"} changed between ${describeDiffRef(before, beforeId)} and ${describeDiffRef(after, afterId)}${shown.length ? `: ${shown.join(", ")}${named.length > shown.length ? `, +${named.length - shown.length} more` : ""}` : ""}.`,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"query_sql",
		"LixRay: Query SQL",
		QUERY_SQL_TOOL_DESCRIPTION,
		z
			.object({
				context: context.optional(),
				lix_ref: z
					.string()
					.min(1)
					.optional()
					.describe("Exact @handle/slug or UUID. No open_lix call required."),
				branch_id: branchId
					.optional()
					.describe(
						"Defaults to the repository default branch when lix_ref is used.",
					),
				sql: z.string().min(1),
				params: z.array(wireValue).optional(),
			})
			.strict(),
		executeOutput,
		readAnnotations(),
		securitySchemes,
		async (args) => {
			assertLixCatalog(args.sql);
			assertReadOnlyQuery(args.sql);
			return service.execute(args.context, toExecuteRequest(args));
		},
		"query_sql",
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
	);

	registerTool(
		server,
		"execute_sql",
		"Execute SQL atomically",
		EXECUTE_SQL_TOOL_DESCRIPTION,
		z
			.object({
				context: context.optional(),
				lix_ref: z
					.string()
					.min(1)
					.optional()
					.describe("Exact @handle/slug or UUID. No open_lix call required."),
				branch_id: branchId
					.optional()
					.describe(
						"Defaults to the repository default branch when lix_ref is used.",
					),
				statements: z.array(sqlStatement).min(1),
				options: executeOptions.optional(),
			})
			.strict(),
		executeBatchOutput,
		writeAnnotations(),
		securitySchemes,
		async ({ context: token, statements, options: batchOptions }, callId) => {
			for (const [statementIndex, statement] of (
				statements as Array<{ sql: string }>
			).entries()) {
				try {
					assertLixCatalog(statement.sql);
				} catch (caught) {
					if (!isLixError(caught)) throw caught;
					throw createLixError(
						caught.code ?? "invalid_request",
						caught.message,
						{ hint: caught.hint, details: { statementIndex } },
					);
				}
			}
			// Every change the batch makes carries this call's origin key, so
			// the result can say what it touched without reading the SQL.
			return {
				...(await service.executeBatch(token, {
					statements,
					options: {
						...toExecuteOptions(batchOptions),
						originKey: mcpOriginKey(callId, batchOptions?.origin_key),
					},
				})),
			};
		},
		"execute_sql",
		options.onToolCall,
		surfaceVersion,
		requestId,
		service,
		options.urlOrigin,
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
		options.urlOrigin,
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
		options.urlOrigin,
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
		options.urlOrigin,
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
		options.urlOrigin,
	);

	registerTool(
		server,
		"restore",
		"Restore branch",
		RESTORE_TOOL_DESCRIPTION,
		z.object({ context, commit_id: commitId }).strict(),
		withError(
			z.object({
				context,
				branch_id: branchId,
				commit_id: z.string().nullable(),
			}),
		),
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
		options.urlOrigin,
	);

	registerTool(
		server,
		"undo",
		"Undo latest change",
		UNDO_TOOL_DESCRIPTION,
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
		options.urlOrigin,
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
		options.urlOrigin,
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
		options.urlOrigin,
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
		options.urlOrigin,
	);

	return server;
}

/** Observe the complete SDK boundary, including failures before a tool runs. */
export async function handleMcpTransport(
	request: Request,
	service: LixService,
	options: McpServerOptions = {},
): Promise<Response> {
	const startedAt = Date.now();
	const requestId = options.requestId ?? requestIdForMcpRequest(request);
	const incomingContext =
		options.traceContext ?? aiTraceContextForMcpRequest(request);
	const traceContext = {
		...incomingContext,
		traceId: incomingContext.traceId ?? crypto.randomUUID(),
	};
	let errorCode: string | undefined;
	let response: Response;
	try {
		response = await handleMcpTransportRequest(
			request,
			service,
			{ ...options, requestId, traceContext },
			(error) => {
				errorCode = "MCP_PROTOCOL_ERROR";
				console.error("LixRay MCP protocol error", { requestId, error });
			},
		);
		// Never consume SSE: only JSON mode responses are finite.
		if (
			response.headers.get("content-type")?.split(";")[0]?.trim() ===
			"application/json"
		) {
			const text = await response.text();
			response = new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
			const payload: unknown = JSON.parse(text);
			if (payload && typeof payload === "object" && !Array.isArray(payload)) {
				const rpc = payload as Record<string, unknown>;
				if (rpc.error && typeof rpc.error === "object") {
					const error = rpc.error as Record<string, unknown>;
					const code = typeof error.code === "number" ? error.code : -32603;
					errorCode = `MCP_RPC_${code}`;
					// SDK errors may contain private input or exception details.
					const messages: Record<number, string> = {
						[-32700]: "Parse error",
						[-32600]: "Invalid request",
						[-32601]: "Method not found",
						[-32602]: "Invalid params",
					};
					rpc.error = {
						code,
						message: messages[code] ?? "Internal error",
					};
					const headers = new Headers(response.headers);
					headers.delete("content-length");
					response = new Response(JSON.stringify(rpc), {
						status: response.status,
						statusText: response.statusText,
						headers,
					});
				} else if (
					rpc.result &&
					typeof rpc.result === "object" &&
					(rpc.result as Record<string, unknown>).isError === true
				) {
					errorCode = "MCP_TOOL_ERROR";
				}
			}
		}
	} catch (error) {
		console.error("LixRay MCP transport error", { requestId, error });
		errorCode = "MCP_INTERNAL_ERROR";
		response = Response.json(
			{
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32603,
					message: "Internal error",
				},
			},
			{ status: 500, headers: { "access-control-allow-origin": "*" } },
		);
	}
	errorCode ??= response.status >= 400 ? `HTTP_${response.status}` : undefined;
	try {
		options.onTransport?.({
			requestId,
			...traceContext,
			stage: "transport",
			durationMs: Date.now() - startedAt,
			statusCode: response.status,
			outcome: errorCode ? "error" : "success",
			...(errorCode ? { errorCode } : {}),
		});
	} catch {
		/* Telemetry must not change protocol responses. */
	}
	return withMcpRequestId(response, requestId);
}

async function handleMcpTransportRequest(
	request: Request,
	service: LixService,
	options: McpServerOptions,
	onProtocolError: (error: Error) => void,
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
						parentId: traceContext.traceId,
						...(traceContext.sessionId
							? { sessionId: traceContext.sessionId }
							: {}),
					});
					observationCache.set(observation.requestId, observation);
					try {
						options.onToolCall?.(observation);
					} catch {
						/* Telemetry must not change tool results. */
					}
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
				urlOrigin: options.urlOrigin ?? new URL(request.url).origin,
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
			onerror: onProtocolError,
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
		try {
			if (shutdownPosthog) {
				if (options.onPosthogFlush) {
					options.onPosthogFlush(shutdownPosthog);
				} else {
					await shutdownPosthog();
				}
			}
		} catch {
			/* Analytics delivery must not fail the MCP request. */
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
			"Setup: In an MCP-compatible client, add a remote connector using the endpoint above, then complete the LixRay sign-in and authorization flow. Connector support and setup menus depend on the client. If no LixRay connector is available, ask the user to connect it; a webpage cannot install a connector for the client.",
			"",
			"Match the exact LixRay server name instead of broad repository or file keywords. For SQL with an exact @handle/slug or Lix UUID, pass lix_ref directly to query_sql or execute_sql, optionally branch_id; no opening call is required. Call list_lixes only when the target is unknown. Prefer the returned context from structuredContent. Never copy a context token from the prose summary; text-only hosts receive a later text block that is the full structuredContent JSON. open_lix includes a bounded file_paths manifest; when file_paths_complete is true, do not list files again. A context selects one Lix and one branch and is encrypted, expiring, and independent from the MCP transport request.",
			"",
			"Use query_sql for one read-only SQL statement and execute_sql for any atomic ordered SQL batch; each tool's description carries the SQL guide (Lix is a Postgres dialect subset, not SQLite: discover tables through information_schema). Prefer read_files and write_files for ordinary file work; batch known paths together. Use SQL for advanced queries and other mutations. execute_sql is always treated as potentially destructive. File renames/deletes and directory operations use SQL against public lix_file and lix_directory tables; get_entity_urls only resolves browser links and is not a file CRUD tool. Directory paths have no trailing slash: /skills, not /skills/.",
			"A successful execute_sql persisted the mutation. Read back only when the write outcome is unknown or validation is part of the task.",
			MCP_URL_GUIDE,
			"HTTP responses include X-Request-ID for support correlation. Diagnostic identifiers stay out of tool results.",
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
	call: (args: Record<string, any>, callId: string) => Promise<any>,
	observationName: string | undefined,
	observer: McpToolCallObserver | undefined,
	surfaceVersion: string,
	requestId: string,
	service: LixService,
	urlOrigin?: string,
): void {
	server.registerTool(
		name,
		{
			title,
			description,
			inputSchema,
			outputSchema,
			annotations,
			_meta: {
				securitySchemes,
				...(CARD_TOOLS.has(name) ? { ui: { resourceUri: DIFF_CARD_URI } } : {}),
			},
		},
		async (args) => {
			const startedAt = Date.now();
			const toolName = observationName ?? name;
			const input = args as Record<string, any>;
			const rawStatements = sqlToolStatements(name, input);
			const executeInput = rawStatements
				? observeExecuteInput(rawStatements)
				: undefined;
			let executionStarted = false;
			let executionCompleted = false;
			try {
				if (isSqlTool(name))
					input.context = await service.contextForSqlTarget(input);
				// A request can carry several calls; each stamps its own key, so
				// the readback below sees only this call's changes.
				const callId = `${requestId}.${crypto.randomUUID()}`;
				executionStarted = true;
				const returned = (await call(input, callId)) as Record<string, unknown>;
				executionCompleted = true;
				// Preview metadata travels outside content and structuredContent: hosts
				// validate structuredContent against the output schema.
				const declared = returned[UI_RESULT_KEY];
				let ui = (
					declared && typeof declared === "object" ? declared : null
				) as DiffCardPayload | null;
				const ownSummary =
					typeof returned[SUMMARY_KEY] === "string"
						? (returned[SUMMARY_KEY] as string)
						: undefined;
				const raw =
					UI_RESULT_KEY in returned || SUMMARY_KEY in returned
						? Object.fromEntries(
								Object.entries(returned).filter(
									([key]) => key !== UI_RESULT_KEY && key !== SUMMARY_KEY,
								),
							)
						: returned;
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
				};
				const touched =
					name === "execute_sql" &&
					typeof input.context === "string" &&
					!readOnlyResults(raw)
						? await touchedByCall(
								service,
								input.context,
								mcpOriginKey(callId, input.options?.origin_key),
							)
						: EMPTY_TOUCHED;
				// An execute_sql batch has the same receipt a write has — a commit
				// span and the files it touched — so it gets the same card.
				if (name === "execute_sql" && typeof input.context === "string")
					ui = await executeCard(
						service,
						input.context,
						raw,
						touched,
						urlOrigin,
					);
				const summary = toolResultTextBlocks(
					ownSummary ?? summarizeToolResult(name, raw, touched),
					structuredContent,
				);
				const links = await resultResourceLinks(
					name,
					input,
					raw,
					touched,
					service,
					urlOrigin,
				);
				// Summary, then the links a host can render as chips, then the
				// structured JSON for text-only hosts.
				return {
					structuredContent,
					content: [summary[0]!, ...links, ...summary.slice(1)],
					...(ui ? { _meta: { [DIFF_CARD_META]: ui } } : {}),
				};
			} catch (caught) {
				const baseError = toMcpError(caught);
				const error = isSqlTool(name)
					? sqlToolError(baseError, {
							write: name === "execute_sql",
							started: executionStarted,
							completed: executionCompleted,
							statementCount: rawStatements?.length ?? 0,
						})
					: baseError;
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
				// No structuredContent on an error: clients validate structured
				// content against the success-only output schema whenever it is
				// present, and would turn this into a -32602 schema violation.
				// The JSON text block still carries { error }.
				return {
					isError: true,
					content: toolResultTextBlocks(summarizeToolError(error), {
						error,
					}),
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

/**
 * Links a host can render inline for what the call did: the repository on
 * open_lix, and each file or directory an execute_sql batch wrote. Reads
 * (query_sql) link nothing. Resolution reuses get_entity_urls, so a link is
 * only ever a canonical URL for an entity that exists; a failed lookup just
 * means no links.
 */
type TouchedByCall = {
	readonly entities: ReadonlyArray<TouchedEntity>;
	readonly deletedDirectoryCount: number;
};
const EMPTY_TOUCHED: TouchedByCall = { entities: [], deletedDirectoryCount: 0 };

/**
 * Asks the change log what one call changed: one read joined to current
 * file paths, plus a read for directory paths and one for deleted files'
 * names only when the batch had any. A failed read means an unadorned
 * result, never a wrong one.
 */
async function touchedByCall(
	service: LixService,
	context: string,
	originKey: string,
): Promise<TouchedByCall> {
	try {
		const changes = touchedFromChanges(
			(
				await service.execute(context, {
					sql: TOUCHED_CHANGES_SQL,
					params: [{ kind: "text", value: originKey }],
				})
			).result,
		);
		const entities: TouchedEntity[] = [...changes.files];
		if (changes.directoryIds.length > 0) {
			const paths = directoryPaths(
				(
					await service.execute(context, {
						sql: directoryPathsSql(changes.directoryIds.length),
						params: changes.directoryIds.map((id) => ({
							kind: "text",
							value: id,
						})),
					})
				).result,
			);
			for (const id of changes.directoryIds) {
				const path = paths.get(id);
				if (path) entities.push({ kind: "directory", path, action: "wrote" });
			}
		}
		if (changes.deletedFileIds.length > 0) {
			const names = deletedFileNames(
				(
					await service.execute(context, {
						sql: DELETED_FILE_NAMES_SQL,
						params: [{ kind: "text", value: originKey }],
					})
				).result,
			);
			let unnamed = 0;
			for (const id of changes.deletedFileIds) {
				const path = names.get(id);
				if (path) entities.push({ kind: "file", path, action: "deleted" });
				else unnamed += 1;
			}
			if (unnamed > 0) {
				entities.push({
					kind: "file",
					path: `${unnamed} ${unnamed === 1 ? "file" : "files"}`,
					action: "deleted",
				});
			}
		}
		return { entities, deletedDirectoryCount: changes.deletedDirectoryCount };
	} catch {
		return EMPTY_TOUCHED;
	}
}

/**
 * The card a host can render beside a change.
 *
 * A tool result tells the reader files changed; the card shows them what
 * changed, in Atelier's own review UI, without leaving the thread. Hosts that
 * cannot render UI still get the summary and JSON; the card stays in result
 * metadata.
 */
const UI_RESULT_KEY = "_ui";

/** A tool's own one-line summary, when the output alone cannot say it. */
const SUMMARY_KEY = "_summary";

/** The tools whose result the diff card resource renders. */
const CARD_TOOLS = new Set(["write_files", "execute_sql", "diff"]);

const PREVIEW_UNAVAILABLE =
	"Files saved, preview unavailable. Do not repeat the write.";

/**
 * The card for a write: what changed between the commits its receipt names.
 *
 * The write does not carry its own before-bytes. It carries a commit span,
 * and the span is asked what changed — the same question a checkpoint or any
 * two commits would be asked, so one render path serves them all. A write
 * that published no commit has nothing to show; a failure here is a warning
 * on a write that already succeeded.
 */
async function writeCard(
	service: LixService,
	token: string,
	written: Awaited<ReturnType<LixService["writeFiles"]>>,
	requested: ReadonlyArray<{ path: string; content?: string }>,
	urlOrigin: string | undefined,
): Promise<{ card: DiffCardPayload | null; failed: boolean }> {
	const span = written.commit;
	if (!span || span.before === span.after) return { card: null, failed: false };
	try {
		const paths = requested
			.filter((file) => file.content !== undefined)
			.map((file) => file.path)
			.slice(0, MAX_CARD_FILES);
		if (paths.length === 0) return { card: null, failed: false };
		const changes = await service.fileChanges(token, span, paths);
		const urls = await service.changeUrls(token, changes, urlOrigin);
		return {
			card: changeCard(changes, urls.files, "written", urls.repository),
			failed: false,
		};
	} catch (caught) {
		console.error("LixRay MCP file changes failed", {
			error: errorDetails(caught),
		});
		return { card: null, failed: true };
	}
}

/**
 * The card for an execute_sql batch: the files the change log says it
 * touched, asked of the commit span the batch moved between. A batch that
 * touched no file, or published no commit, has no card; a failure here
 * leaves the receipt unadorned rather than wrong.
 */
async function executeCard(
	service: LixService,
	token: string,
	raw: unknown,
	touched: TouchedByCall,
	urlOrigin: string | undefined,
): Promise<DiffCardPayload | null> {
	const span = (raw as { commit?: { before: string; after: string } | null })
		.commit;
	if (!span || span.before === span.after) return null;
	const paths = touched.entities
		.filter(
			(entity) => entity.kind === "file" && !/^\d+ files?$/.test(entity.path),
		)
		.map((entity) => entity.path)
		.slice(0, MAX_CARD_FILES);
	if (paths.length === 0) return null;
	try {
		const changes = await service.fileChanges(token, span, paths);
		const urls = await service.changeUrls(token, changes, urlOrigin);
		return changeCard(changes, urls.files, "written", urls.repository);
	} catch (caught) {
		console.error("LixRay MCP file changes failed", {
			error: errorDetails(caught),
		});
		return null;
	}
}

/**
 * Builds the card, with Atelier's views first: the files it can draw come
 * before the ones it can only name, so the previews are the first pages.
 * A view that fails to render is a note on a card that still lists the file.
 */
function changeCard(
	changes: ReadonlyArray<FileChange>,
	urls: ReadonlyArray<string>,
	verb: "written" | "changed",
	repositoryUrl: string,
): DiffCardPayload | null {
	const repository = repositoryOf(repositoryUrl);
	const listed = changes.map((change, index) => ({
		path: change.path,
		...(change.movedFrom !== undefined ? { movedFrom: change.movedFrom } : {}),
		url: urls[index] ?? repositoryUrl,
		...(change.before !== undefined ? { before: change.before } : {}),
		...(change.after !== undefined ? { after: change.after } : {}),
	}));
	const drawable = listed.filter((change) => isRenderablePath(change.path));
	const named = listed.filter((change) => !isRenderablePath(change.path));
	try {
		return diffCardPayload({
			verb,
			changes: [...drawable, ...named],
			...(repository ? { repository } : {}),
		});
	} catch (caught) {
		// A card is a courtesy; a change that happened still happened.
		console.error("LixRay MCP diff card failed", {
			error: errorDetails(caught),
		});
		return null;
	}
}

function uiField(
	card: DiffCardPayload | null,
): Record<string, DiffCardPayload> {
	return card ? { [UI_RESULT_KEY]: card } : {};
}

/** "checkpoint a1b2", "working (commit c3d4)": a ref as the summary says it. */
function describeDiffRef(ref: DiffRef, commitId: string): string {
	if (ref === "working") return `working (commit ${commitId})`;
	if (ref === "latest_checkpoint") return `latest checkpoint ${commitId}`;
	if ("checkpoint_id" in ref) return `checkpoint ${ref.checkpoint_id}`;
	if ("commit_id" in ref) return `commit ${ref.commit_id}`;
	return `branch ${ref.branch_id} (commit ${commitId})`;
}

/** "@opral/monorepo" out of a LixRay entity URL, when it carries one. */
function repositoryOf(url: string): string | undefined {
	const match = /\/(@[^/]+\/[^/?#]+)(?:[/?#]|$)/.exec(url);
	return match?.[1];
}

async function resultResourceLinks(
	name: string,
	input: Record<string, any>,
	raw: unknown,
	touched: TouchedByCall,
	service: LixService,
	urlOrigin: string | undefined,
): Promise<Array<ResourceLinkBlock>> {
	if (!raw || typeof raw !== "object") return [];
	const result = raw as Record<string, unknown>;
	if (name === "open_lix" && typeof result.url === "string") {
		return [
			{
				type: "resource_link",
				uri: result.url,
				name:
					typeof result.lix_ref === "string"
						? result.lix_ref
						: typeof result.name === "string"
							? result.name
							: "Repository",
				description: "Opened repository",
			},
		];
	}
	if (name === "write_files" && Array.isArray(result.files)) {
		return (result.files as Array<{ path: string; url: string }>)
			.slice(0, 50)
			.map((file) => {
				const mimeType = mimeTypeForPath(file.path);
				return {
					type: "resource_link",
					uri: file.url,
					name: file.path.split("/").filter(Boolean).at(-1) ?? file.path,
					description: `Wrote ${file.path.replace(/^\//, "")}`,
					...(mimeType ? { mimeType } : {}),
				};
			});
	}
	if (name === "diff" && Array.isArray(result.files)) {
		return (
			result.files as Array<{ path: string; url: string; status: string }>
		)
			.filter((file) => file.status !== "removed")
			.slice(0, 50)
			.map((file) => {
				const mimeType = mimeTypeForPath(file.path);
				return {
					type: "resource_link",
					uri: file.url,
					name: file.path.split("/").filter(Boolean).at(-1) ?? file.path,
					description: `${file.status === "added" ? "Added" : file.status === "moved" ? "Moved" : "Modified"} ${file.path.replace(/^\//, "")}`,
					...(mimeType ? { mimeType } : {}),
				};
			});
	}
	if (name !== "execute_sql" || typeof input.context !== "string") return [];
	const surviving = touched.entities
		.filter((entity) => entity.action !== "deleted")
		.slice(0, 50);
	if (surviving.length === 0) return [];
	try {
		const resolved = await service.getEntityUrls(
			input.context,
			surviving.map(({ kind, path }) => ({ kind, path })),
			urlOrigin,
		);
		return resolved.entities.map((entity, index) => {
			const action =
				surviving[index]?.action === "updated" ? "Updated" : "Wrote";
			const mimeType =
				entity.kind === "file" ? mimeTypeForPath(entity.path) : undefined;
			return {
				type: "resource_link",
				uri: entity.url,
				name: entity.path.split("/").filter(Boolean).at(-1) ?? entity.path,
				description: `${action} ${entity.path.replace(/^\//, "")}`,
				...(mimeType ? { mimeType } : {}),
			};
		});
	} catch {
		return [];
	}
}

type ResourceLinkBlock = {
	type: "resource_link";
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
};

function summarizeToolResult(
	name: string,
	raw: unknown,
	touched: TouchedByCall = EMPTY_TOUCHED,
): string {
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
		return summarizeExecuteSql(result.results, touched);
	}
	if (name === "list_files") {
		const files = Array.isArray(result.files) ? result.files : [];
		return `Listed ${files.length} ${files.length === 1 ? "file" : "files"}${result.truncated ? " (truncated; narrow the filter)" : ""} at commit ${String(result.commit_id)}.`;
	}
	if (name === "read_files") {
		const files = Array.isArray(result.files) ? result.files : [];
		const missing = Array.isArray(result.missing) ? result.missing : [];
		return `Read ${files.length} ${files.length === 1 ? "file" : "files"}${missing.length ? `; missing: ${missing.join(", ")}` : ""} at commit ${String(result.commit_id)}.`;
	}
	if (name === "write_files") {
		const files = Array.isArray(result.files)
			? (result.files as Array<{ path?: unknown }>)
			: [];
		const names = files.map((file) =>
			typeof file.path === "string" ? file.path.replace(/^\//, "") : "?",
		);
		const checkpoint =
			typeof result.checkpoint_commit_id === "string"
				? ` (checkpoint ${result.checkpoint_commit_id})`
				: "";
		return `Wrote ${names.join(" · ")}${typeof result.commit_id === "string" ? ` at commit ${result.commit_id}` : ""}${checkpoint}.${typeof result.warning === "string" ? ` ${result.warning}` : ""}`;
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
		return typeof result.commit_id === "string"
			? `Restored content on branch ${String(result.branch_id)} in new commit ${result.commit_id}.`
			: `Branch ${String(result.branch_id)} already matches the requested state.`;
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
	const manifest =
		result.file_paths_complete === false && Array.isArray(result.file_paths)
			? ` file_paths lists the first ${result.file_paths.length}; for every path run query_sql: ${OPEN_LIX_ALL_FILE_PATHS_SQL}.`
			: "";
	return `Opened ${identity}${name} on branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.${formatInventory(result)}${manifest} Context expires at ${String(result.context_expires_at)}.`;
}

/** The follow-up for a truncated open_lix manifest. */
const OPEN_LIX_ALL_FILE_PATHS_SQL =
	"SELECT id, path FROM lix_file ORDER BY path";

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

function summarizeExecuteSql(payload: unknown, touched: TouchedByCall): string {
	const results: Array<unknown> = Array.isArray(payload) ? payload : [];
	let affected = 0;
	for (const item of results) {
		affected += sqlRowsAffected(item);
	}
	if (touched.entities.length > 0 || touched.deletedDirectoryCount > 0)
		return describeTouched(
			touched.entities,
			affected,
			touched.deletedDirectoryCount,
		);
	return `execute_sql: ${affected} ${affected === 1 ? "row" : "rows"} affected`;
}

function sqlRowCount(payload: unknown): number {
	if (!payload || typeof payload !== "object") return 0;
	const rows = (payload as { rows?: unknown }).rows;
	return Array.isArray(rows) ? rows.length : 0;
}

/**
 * A batch whose every statement returned a result set and changed no rows
 * is a read; the change readback would find nothing.
 */
function readOnlyResults(raw: unknown): boolean {
	const results = (raw as { results?: unknown } | null)?.results;
	if (!Array.isArray(results) || results.length === 0) return false;
	return results.every((result) => {
		const columns = (result as { columns?: unknown } | null)?.columns;
		return (
			Array.isArray(columns) &&
			columns.length > 0 &&
			sqlRowsAffected(result) === 0
		);
	});
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
	statement_index?: number;
}): string {
	return `${error.statement_index !== undefined ? `Statement ${error.statement_index + 1} (statements[${error.statement_index}]): ` : ""}LixRay error ${error.code}: ${error.message}${error.hint ? ` Hint: ${error.hint}` : ""}`;
}

function toMcpError(caught: unknown): {
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
		hint: "Contact LixRay support if the problem persists.",
	};
}

/**
 * Output schemas describe the success shape only. Errors return
 * `isError: true` with `{ error: { code, message, hint? } }`,
 * which the SDK does not validate against the schema, so no tool needs to
 * carry the error branch in tools/list.
 */
function withError(schema: z.ZodObject<any>) {
	return schema;
}

function toolSurfaceDescriptions(): Array<Record<string, unknown>> {
	return [
		"list_lixes",
		"open_lix",
		"get_entity_urls",
		"list_files",
		"read_files",
		"write_files",
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
	].map((name) => ({ name }));
}

/** SQLite catalog habits get the Lix catalog by name, not a parse error. */
const SQLITE_CATALOG_PATTERN =
	/\bsqlite_(?:master|schema|temp_master|temp_schema)\b|\bpragma\s+\w/i;

function assertLixCatalog(sql: string): void {
	if (!SQLITE_CATALOG_PATTERN.test(sql)) return;
	throw createLixError("invalid_request", LIX_IS_NOT_SQLITE_MESSAGE, {
		hint: LIX_CATALOG_HINT,
	});
}

function assertReadOnlyQuery(sql: string): void {
	if (sqlLooksLikeWrite(sql)) {
		throw createLixError(
			"invalid_request",
			"query_sql rejects mutating SQL, including checkpoint and recovery SELECT commands.",
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
