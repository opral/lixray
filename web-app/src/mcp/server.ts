/*
 * The MCP SDK exposes dynamically registered tool arguments as `any`. Keep
 * this exception at the adapter boundary; the individual Zod schemas and
 * Lix service remain the runtime type guards for these values.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { instrument } from "@posthog/mcp";
import {
	createMcpHandler,
	McpServer,
	type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { PostHog } from "posthog-node";
import { z } from "zod";
import type { ParseSqlScript } from "../lib/lix-sql-access.ts";
import {
	EXECUTE_SQL_TOOL_DESCRIPTION,
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
const MCP_SCOPES = ["openid", "email", "profile"] as const;

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
	parseSqlScript?: ParseSqlScript;
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

const lixRef = z
	.string()
	.min(1)
	.describe("Lix UUID, slug, or @namespace/slug reference");
const context = z
	.string()
	.min(1)
	.describe("Opaque Lix context returned by open_lix or switch_branch");
const branchId = z.string().min(1).describe("Lix branch id");
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
		branch_id: branchId,
		commit_id: z.string(),
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
			instructions:
				"LixRay exposes the JavaScript Lix SDK over MCP. Call list_lixes when you need to discover a Lix, then open_lix once and pass its returned context to every later call. The context is an explicit, signed Lix-and-branch handle; it is not an MCP session. File and directory creation, reads, edits, deletes, and path changes are SQL operations through query_sql or execute_sql using the public lix_file and lix_directory tables. query_sql is SELECT-only; execute_sql accepts any atomic SQL batch and is always treated as potentially destructive. Do not invent file helper tools or branch state.",
		},
	);
	const surfaceVersion = mcpSurfaceVersion(toolSurfaceDescriptions());

	registerTool(
		server,
		"list_lixes",
		"List lixes",
		"List LixRay lixes the signed-in user can access. Use this before open_lix when the Lix is not already known.",
		z.object({}).strict(),
		listLixesOutput,
		readAnnotations(),
		securitySchemes,
		async () => ({ lixes: await service.listLixes() }),
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
	);

	registerTool(
		server,
		"open_lix",
		"Open a Lix",
		"Resolve and open a Lix context. If branch_id is omitted, pin the context to the Lix's current active branch. The returned context is required by every other tool.",
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
				branch_id: opened.branchId,
				commit_id: opened.commitId,
			};
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
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
			assertReadOnlyQuery(
				options.parseSqlScript,
				args.sql,
				Array.isArray(args.params) ? args.params.length : 0,
			);
			return service.execute(args.context, toExecuteRequest(args));
		},
		"query_sql",
		options.onToolCall,
		surfaceVersion,
		requestId,
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
		writeAnnotations(),
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
	);

	registerTool(
		server,
		"create_checkpoint",
		"Create checkpoint",
		"Create a checkpoint on the branch selected by context.",
		z.object({ context }).strict(),
		checkpointOutput,
		writeAnnotations(),
		securitySchemes,
		async ({ context: token }) => {
			const result = await service.createCheckpoint(token);
			return { context: result.context, commit_id: result.commitId };
		},
		undefined,
		options.onToolCall,
		surfaceVersion,
		requestId,
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
	);

	return server;
}

export async function handleMcpTransport(
	request: Request,
	service: LixService,
	options: McpServerOptions = {},
): Promise<Response> {
	const requestId = options.requestId ?? requestIdForMcpRequest(request);
	if (new URL(request.url).pathname !== MCP_PATH) {
		return withMcpRequestId(
			new Response("Not found\n", { status: 404 }),
			requestId,
		);
	}
	const server = createLixrayMcpServer(service, {
		...options,
		requestId,
		serverName: options.serverName ?? mcpServerNameForUrl(request.url),
	});
	const handler = createMcpHandler(() => server, {
		legacy: "stateless",
		responseMode: "json",
		onerror: (error) =>
			console.error("LixRay MCP protocol error", { requestId, error }),
	});
	let shutdownPosthog: (() => Promise<void>) | undefined;
	if (options.posthogToken) {
		const posthog = new PostHog(options.posthogToken, {
			host: options.posthogHost ?? "https://us.i.posthog.com",
			flushAt: 1,
			flushInterval: 0,
		});
		// @posthog/mcp 0.10.x recognizes the v1 low-level Server shape. The v2
		// high-level McpServer intentionally exposes registerTool(), so instrument
		// its underlying low-level server while keeping the v2 transport intact.
		const observationCache = new Map<string, McpToolCallObservation>();
		const originalOnToolCall = options.onToolCall;
		const wrappedOnToolCall = originalOnToolCall
			? (observation: McpToolCallObservation): void => {
					observationCache.set(observation.requestId, observation);
					originalOnToolCall(observation);
				}
			: undefined;
		(options as any).onToolCall = wrappedOnToolCall;

		instrument(server.server, posthog, {
			context: false,
			enableExceptionAutocapture: false,
			identify: options.posthogDistinctId
				? { distinctId: options.posthogDistinctId }
				: null,
			eventProperties: () => {
				const observation = observationCache.get(requestId);
				const baseProps: Record<string, unknown> = {
					environment: "production",
					mcp_server: "lixray",
					oauth_client_id: options.posthogClientId,
					request_id: requestId,
				};

				if (observation?.executeInput && observation?.executeOutput) {
					const firstStmt = observation.executeInput.statements[0];

					baseProps.sql_op = firstStmt?.operation;
					baseProps.row_count = observation.executeOutput.rowCount;
					baseProps.is_bulk = observation.executeInput.statementCount > 1;
					if (observation.lixId) baseProps.lix_id = observation.lixId;
					if (observation.lixId) baseProps.repository_id = observation.lixId;

					// For file writes, add actual content size (computed in handler from content.length / Buffer.byteLength utf8)
					// Do not emit file_path or file_extension (real values are on lixr_file_written only)
					if (observation.fileContentCharCount !== undefined) {
						baseProps.char_count = observation.fileContentCharCount;
					}
					if (observation.fileContentByteCount !== undefined) {
						baseProps.byte_count = observation.fileContentByteCount;
					}
				}

				return baseProps;
			},
			beforeSend: (event) => {
				const redacted = redactMcpAnalyticsEvent(event);
				if (
					redacted.properties &&
					typeof redacted.properties === "object" &&
					!Array.isArray(redacted.properties)
				) {
					const props = redacted.properties as Record<string, unknown>;
					delete props.$mcp_parameters;
					delete props.$mcp_response;
					delete props.$mcp_error_message;
				}
				return redacted;
			},
		});
		shutdownPosthog = async () => {
			// @posthog/mcp publishes through an internal async redaction pipeline.
			// Let that pipeline enqueue its captures before draining the client.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await posthog.shutdown();
		};
	}
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
			"Call list_lixes when the Lix is unknown, then open_lix. Pass the returned context to every later tool. A context selects one Lix and one branch and is signed, expiring, and independent from the MCP transport request.",
			"",
			"Use query_sql for one SELECT statement and execute_sql for any atomic ordered SQL batch. execute_sql is always treated as potentially destructive. File and directory operations are SQL against public lix_file and lix_directory tables; do not expect separate file helper tools. Directory paths use /skills, not /skills/.",
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
			const executeInput = isSqlTool(name)
				? observeExecuteInput(name === "query_sql" ? [input] : input.statements)
				: undefined;
			try {
				const raw = await call(input);
				const executeOutput = isSqlTool(name)
					? observeExecuteOutput(
							name === "query_sql" ? { results: [raw.result] } : raw,
						)
					: undefined;
				observeToolCall(observer, startedAt, {
					requestId,
					toolName,
					outcome: "success",
					surfaceVersion,
					...(executeInput ? { executeInput } : {}),
					...(executeOutput ? { executeOutput } : {}),
				});
				const structuredContent = {
					...(raw as Record<string, unknown>),
					request_id: requestId,
				};
				return {
					structuredContent,
					content: [
						{ type: "text" as const, text: summarizeToolResult(name, raw) },
					],
				};
			} catch (caught) {
				const error = toMcpError(caught, requestId);
				observeToolCall(observer, startedAt, {
					requestId,
					toolName,
					outcome: "error",
					surfaceVersion,
					errorCode: error.code,
					...(executeInput ? { executeInput } : {}),
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
					content: [{ type: "text" as const, text: summarizeToolError(error) }],
				};
			}
		},
	);
}

function summarizeToolResult(name: string, raw: unknown): string {
	if (!raw || typeof raw !== "object") return `${name} completed.`;
	const result = raw as Record<string, unknown>;
	const contextSuffix = formatContextSuffix(result);

	if (name === "list_lixes") {
		const count = Array.isArray(result.lixes) ? result.lixes.length : 0;
		return `Found ${count} accessible ${count === 1 ? "Lix" : "Lixes"}.`;
	}
	if (name === "open_lix") {
		return `Opened ${String(result.url ?? result.id)} on branch ${String(result.branch_id)} at commit ${String(result.commit_id)}. Context expires at ${String(result.context_expires_at)}.${contextSuffix}`;
	}
	if (name === "query_sql") {
		return `${summarizeSqlResults([result.result])}${contextSuffix}`;
	}
	if (name === "execute_sql") {
		const results = Array.isArray(result.results) ? result.results : [];
		return `Atomic SQL completed ${results.length} ${results.length === 1 ? "statement" : "statements"}. ${summarizeSqlResults(results)}${contextSuffix}`;
	}
	if (name === "active_branch_id") {
		return `Active branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.${contextSuffix}`;
	}
	if (name === "switch_branch") {
		return `Switched to branch ${String(result.branch_id)} at commit ${String(result.commit_id)}.${contextSuffix}`;
	}
	if (name === "create_branch") {
		const branch = result.branch as Record<string, unknown> | undefined;
		if (branch) {
			return `Created branch ${String(branch.name)} (${String(branch.id)}) at commit ${String(branch.commit_id)}.${contextSuffix}`;
		}
		return `Branch created.${contextSuffix}`;
	}
	if (name === "create_checkpoint") {
		return `Checkpoint created at commit ${String(result.commit_id)}.${contextSuffix}`;
	}
	if (name === "undo") {
		return `Undone to commit ${String(result.target_commit_id)} (inverse commit ${String(result.inverse_commit_id)}).${contextSuffix}`;
	}
	if (name === "redo") {
		return `Redone to commit ${String(result.target_commit_id)} (replay commit ${String(result.replay_commit_id)}).${contextSuffix}`;
	}
	if (name === "merge_branch_preview") {
		return `Merge preview completed.${contextSuffix}`;
	}
	if (name === "merge_branch") {
		return `Branch merged.${contextSuffix}`;
	}
	return `${name} completed.${contextSuffix}`;
}

/**
 * Format essential continuation fields for text content fallback.
 * Returns a consistent machine-parseable suffix containing the opaque context
 * token required for chaining operations. The context is canonically provided
 * in structuredContent; including it in text content ensures compatibility with
 * MCP bridges or wrappers that expose only content[].text without propagating
 * the full structuredContent to downstream consumers.
 */
function formatContextSuffix(result: Record<string, unknown>): string {
	if (typeof result.context !== "string" || result.context.length === 0) {
		return "";
	}
	return ` context=${result.context}`;
}

function summarizeSqlResults(results: Array<unknown>): string {
	let returnedRows = 0;
	let affectedRows = 0;
	for (const value of results) {
		if (!value || typeof value !== "object") continue;
		const result = value as Record<string, unknown>;
		if (Array.isArray(result.rows)) returnedRows += result.rows.length;
		if (typeof result.rowsAffected === "number") {
			affectedRows += result.rowsAffected;
		}
	}
	return `SQL returned ${returnedRows} ${returnedRows === 1 ? "row" : "rows"} and affected ${affectedRows} ${affectedRows === 1 ? "row" : "rows"}.`;
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
		"undo",
		"redo",
		"merge_branch_preview",
		"merge_branch",
	].map((name) => ({ name }));
}

function assertReadOnlyQuery(
	parseSqlScript: ParseSqlScript | undefined,
	sql: string,
	paramCount: number,
): void {
	const statement = parsedSingleStatement(
		parseSqlScript,
		sql,
		paramCount,
		"query_sql",
	);
	if (!/^\s*SELECT\b/i.test(statement)) {
		throw createLixError(
			"invalid_request",
			"query_sql accepts only a SELECT statement.",
			{
				hint: "Use execute_sql for non-SELECT SQL.",
			},
		);
	}
}

function parsedSingleStatement(
	parseSqlScript: ParseSqlScript | undefined,
	sql: string,
	paramCount: number,
	toolName: "query_sql",
): string {
	if (!parseSqlScript) {
		throw createLixError(
			"upstream_error",
			"SQL classification is unavailable.",
			{
				hint: "Retry later. If the failure persists, contact LixRay support.",
			},
		);
	}
	let parsed: ReturnType<ParseSqlScript>;
	try {
		parsed = parseSqlScript(sql, paramCount);
	} catch (caught) {
		throw createLixError(
			"invalid_request",
			`${toolName} could not parse SQL.`,
			{
				hint: "Correct the SQL syntax and parameter count, then retry.",
				details: {
					parser_message:
						caught instanceof Error
							? caught.message
							: "SQL parser rejected input.",
				},
			},
		);
	}
	if (parsed.statements.length !== 1) {
		throw createLixError(
			"invalid_request",
			`${toolName} requires exactly one SQL statement per input entry.`,
			{
				hint: "Send one SELECT statement.",
			},
		);
	}
	return parsed.statements[0]!.sql;
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

function readAnnotations(): ToolAnnotations {
	return {
		readOnlyHint: true,
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
