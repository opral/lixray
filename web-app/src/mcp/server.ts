import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FileServiceError, LixFileService } from "./file-service.ts";
import { EXECUTE_TOOL_DESCRIPTION } from "./execute-schema.ts";
import {
	mcpSurfaceVersion,
	observeExecuteInput,
	observeExecuteOutput,
	type McpExecuteInputObservation,
	type McpExecuteOutputObservation,
} from "./tool-observation.ts";

export const MCP_PATH = "/mcp";
export const MCP_RESOURCE = "https://lixray.com";
export const MCP_PROTECTED_RESOURCE_PATH =
	"/.well-known/oauth-protected-resource";
// Not under /docs — that prefix belongs to the human docs site; this is the
// plain-text page MCP clients are pointed at via resource_documentation.
export const MCP_DOCUMENTATION_PATH = "/mcp/docs";
export const MCP_PROTECTED_RESOURCE_URL = `${MCP_RESOURCE}${MCP_PROTECTED_RESOURCE_PATH}`;
const MCP_SCOPES = ["openid", "email", "profile"] as const;

type McpAuthMode = "oauth" | "none";

export interface McpToolCallObservation {
	toolName: string;
	outcome: "success" | "error";
	durationMs: number;
	surfaceVersion: string;
	errorCode?: string;
	lixId?: string;
	executeInput?: McpExecuteInputObservation;
	executeOutput?: McpExecuteOutputObservation;
}

export type McpToolCallObserver = (observation: McpToolCallObservation) => void;

interface McpServerOptions {
	authMode?: McpAuthMode;
	onToolCall?: McpToolCallObserver;
	serverName?: "LixRay" | "LixRay_Dev";
}

const LOCAL_MCP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function mcpServerNameForUrl(url: string): "LixRay" | "LixRay_Dev" {
	return LOCAL_MCP_HOSTNAMES.has(new URL(url).hostname)
		? "LixRay_Dev"
		: "LixRay";
}

type McpSecurityScheme =
	| { type: "oauth2"; scopes: Array<string> }
	| { type: "noauth" };

const oauthSecuritySchemes: Array<McpSecurityScheme> = [
	{ type: "oauth2", scopes: [...MCP_SCOPES] },
];

const uuid = z.uuid().describe("Lix UUID");
const lixRef = z
	.string()
	.describe(
		"Exact lix UUID, exact lix slug, or exact @namespace/slug. Use the lix UUID when available.",
	);
// Lix accepts non-UUID branch identifiers such as the built-in `global`
// branch. Keep the MCP contract as broad as the Lix client contract.
const branchId = z.string().min(1).describe("Lix branch ID");
const executeSqlText = z.string().trim().min(1);
const wireValue = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("null"), value: z.null().optional() }).strict(),
	z.object({ kind: z.literal("bool"), value: z.boolean() }).strict(),
	z.object({ kind: z.literal("int"), value: z.number().int().safe() }).strict(),
	z.object({ kind: z.literal("float"), value: z.number().finite() }).strict(),
	z.object({ kind: z.literal("text"), value: z.string() }).strict(),
	z.object({ kind: z.literal("blob"), base64: z.string() }).strict(),
	z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
]);
const executeStatement = z
	.object({
		sql: executeSqlText,
		params: z.array(wireValue).max(1000).optional().default([]),
	})
	.strict();
const lixSummaryOutput = z
	.object({
		id: uuid,
		name: z.string(),
		slug: z.string(),
		namespace: z
			.object({ id: z.string(), name: z.string(), handle: z.string() })
			.strict(),
	})
	.strict();
const toolErrorOutput = z
	.object({
		error: z
			.object({
				code: z.string(),
				message: z.string(),
				details: z.record(z.string(), z.unknown()).optional(),
			})
			.strict(),
	})
	.strict();
const listLixesOutput = z.union([
	z.object({ lixes: z.array(lixSummaryOutput) }).strict(),
	toolErrorOutput,
]);
const activeBranchOutput = z.union([
	z.object({ branch_id: branchId }).strict(),
	toolErrorOutput,
]);
const executeStatementOutput = z
	.object({
		columns: z.array(z.string()),
		rows: z.array(z.array(wireValue)),
		rowsAffected: z.number().int().nonnegative(),
		notices: z.array(z.unknown()),
	})
	.strict();
const executeOutput = z.union([
	z.object({ results: z.array(executeStatementOutput) }).strict(),
	toolErrorOutput,
]);

interface ToolDefinition {
	descriptor: {
		name: string;
		title: string;
		description: string;
		inputSchema: Record<string, unknown>;
		outputSchema?: Record<string, unknown>;
		securitySchemes: Array<McpSecurityScheme>;
		annotations: ToolAnnotations;
		_meta: Record<string, unknown>;
	};
	schema: z.ZodType<Record<string, unknown>>;
	outputSchema?: z.ZodType<Record<string, unknown>>;
	call(args: Record<string, unknown>): Promise<unknown>;
}

export function createLixrayMcpServer(
	service: LixFileService,
	options: McpServerOptions = {},
): Server {
	const server = new Server(
		{ name: options.serverName ?? "LixRay", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use LixRay's execute tool for lix inspection and changes. SQL and branch controls use the lix's active Lix branch, just like the Lix client. Use active_branch_id to inspect it and switch_branch to change it. Query lix_branch with execute when you need the branch catalog. Freely make changes, as the user can review all changes in the UI. Never guess lix or branch IDs.",
		},
	);
	const tools = buildTools(
		service,
		options.authMode === "none" ? [{ type: "noauth" }] : oauthSecuritySchemes,
	);
	const surfaceVersion = mcpSurfaceVersion(
		tools.map((tool) => tool.descriptor),
	);
	const observe = (
		startedAt: number,
		observation: Omit<McpToolCallObservation, "durationMs" | "surfaceVersion">,
	) =>
		observeToolCall(options.onToolCall, startedAt, {
			...observation,
			surfaceVersion,
		});

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => tool.descriptor),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const startedAt = Date.now();
		const tool = tools.find(
			(candidate) => candidate.descriptor.name === request.params.name,
		);
		if (!tool) {
			observe(startedAt, {
				toolName: "unknown",
				outcome: "error",
				errorCode: "unknown_tool",
			});
			throw new McpError(
				ErrorCode.InvalidParams,
				`Unknown tool: ${request.params.name}`,
			);
		}
		const executeInput =
			tool.descriptor.name === "execute"
				? observeExecuteInput(request.params.arguments?.statements)
				: undefined;
		const parsed = tool.schema.safeParse(request.params.arguments ?? {});
		if (!parsed.success) {
			observe(startedAt, {
				toolName: tool.descriptor.name,
				outcome: "error",
				errorCode: "invalid_arguments",
				...(executeInput ? { executeInput } : {}),
			});
			return errorResult("invalid_arguments", z.prettifyError(parsed.error));
		}
		let lixId: string | undefined;
		try {
			const callArgs: Record<string, unknown> = { ...parsed.data };
			if (typeof parsed.data.lix_ref === "string") {
				lixId = await service.resolveLixRef(parsed.data.lix_ref);
				callArgs.lix_ref = lixId;
			}
			const rawStructuredContent = asStructuredContent(
				await tool.call(callArgs),
			);
			const parsedOutput = tool.outputSchema?.safeParse(rawStructuredContent);
			if (parsedOutput && !parsedOutput.success) {
				throw new Error(
					`${tool.descriptor.name} returned invalid structured output: ${z.prettifyError(parsedOutput.error)}`,
				);
			}
			const structuredContent = parsedOutput?.success
				? parsedOutput.data
				: rawStructuredContent;
			const executeOutput =
				tool.descriptor.name === "execute"
					? observeExecuteOutput(structuredContent)
					: undefined;
			observe(startedAt, {
				toolName: tool.descriptor.name,
				outcome: "success",
				...(lixId ? { lixId } : {}),
				...(executeInput ? { executeInput } : {}),
				...(executeOutput ? { executeOutput } : {}),
			});
			return {
				structuredContent,
				content: [
					{
						type: "text" as const,
						text: successSummary(tool.descriptor.name),
					},
				],
			};
		} catch (caught) {
			if (caught instanceof FileServiceError) {
				observe(startedAt, {
					toolName: tool.descriptor.name,
					outcome: "error",
					errorCode: caught.code,
					...(lixId ? { lixId } : {}),
					...(executeInput ? { executeInput } : {}),
				});
				return errorResult(caught.code, caught.message, caught.details);
			}
			observe(startedAt, {
				toolName: tool.descriptor.name,
				outcome: "error",
				errorCode: "internal_error",
				...(lixId ? { lixId } : {}),
				...(executeInput ? { executeInput } : {}),
			});
			console.error("LixRay MCP tool failed", {
				tool: tool.descriptor.name,
				error: errorDetails(caught),
			});
			return errorResult("internal_error", "The LixRay tool call failed.");
		}
	});

	return server;
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

export async function handleMcpTransport(
	request: Request,
	service: LixFileService,
	options: McpServerOptions = {},
): Promise<Response> {
	if (new URL(request.url).pathname !== MCP_PATH) {
		return new Response("Not found\n", { status: 404 });
	}
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
		sessionIdGenerator: undefined,
	});
	const server = createLixrayMcpServer(service, {
		...options,
		serverName: options.serverName ?? mcpServerNameForUrl(request.url),
	});
	await server.connect(transport);
	const response = await transport.handleRequest(request);
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", "*");
	headers.set(
		"access-control-expose-headers",
		"MCP-Session-Id, MCP-Protocol-Version",
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
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
			"Authentication: Supabase OAuth 2.1 with PKCE and dynamic client registration.",
			"",
			"Your LixRay browser session and your MCP client authorization are separate. Being signed in at lixray.com does not mean that Codex or another MCP client has a usable access and refresh token.",
			"The endpoint challenges unauthenticated requests with the OAuth protected-resource metadata URL. Complete authorization before initialize, tools/list, or tools/call.",
			"",
			"Connection check:",
			"1. Confirm this endpoint is registered exactly once for the environment you intend to use. MCP registration names must contain only letters, numbers, hyphens, or underscores; use LixRay_Dev for local development.",
			"2. Revoke or log out the MCP connection, then authorize it again.",
			"3. If a task does not refresh its MCP tool catalog after setup, stop and start a fresh user task. Do not launch a nested agent or Codex process.",
			"4. Verify the client receives the authorization prompt, then confirm initialize, tools/list, and list_lixes succeed after authorization.",
			"",
			"If the client reports that no refresh token is available, remove the connection's saved authorization and reconnect. If it recurs, report the client version, server URL, and time of the attempt; do not include access or refresh tokens.",
			"",
			"The server exposes list_lixes, active_branch_id, switch_branch, and raw Lix SQL execute. SQL and branch controls use the lix's active Lix branch, matching the Lix client. Use active_branch_id to inspect it, switch_branch to change it, and SQL against lix_branch to discover branches. Execute accepts an ordered batch of statements with $n or ? parameters. Lix executes the batch atomically and returns one ordered result per statement.",
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

function buildTools(
	service: LixFileService,
	securitySchemes: Array<McpSecurityScheme>,
): Array<ToolDefinition> {
	const tool = <T extends z.ZodType<Record<string, unknown>>>(
		name: string,
		title: string,
		description: string,
		schema: T,
		annotations: ToolAnnotations,
		call: (args: z.output<T>) => Promise<unknown>,
		outputSchema?: z.ZodType<Record<string, unknown>>,
	) =>
		createTool(
			name,
			title,
			description,
			schema,
			annotations,
			securitySchemes,
			call,
			outputSchema,
		);
	return [
		tool(
			"list_lixes",
			"List lixes",
			"List the LixRay lixes the signed-in user can access.",
			z.object({}).strict(),
			readAnnotations(),
			async () => ({ lixes: await service.listLixes() }),
			listLixesOutput,
		),
		tool(
			"active_branch_id",
			"Get active branch ID",
			"Return the lix's active Lix branch ID.",
			z.object({ lix_ref: lixRef }).strict(),
			readAnnotations(),
			async ({ lix_ref }) => ({
				branch_id: await service.activeBranchId(String(lix_ref)),
			}),
			activeBranchOutput,
		),
		tool(
			"switch_branch",
			"Switch active branch",
			"Switch the lix's active Lix branch. This shared lix state affects subsequent SQL operations.",
			z
				.object({
					lix_ref: lixRef,
					branch_id: branchId,
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ lix_ref, branch_id }) => ({
				branch_id: (
					await service.switchBranch(String(lix_ref), String(branch_id))
				).branchId,
			}),
			activeBranchOutput,
		),
		tool(
			"execute",
			"Execute raw Lix SQL",
			EXECUTE_TOOL_DESCRIPTION,
			z
				.object({
					lix_ref: lixRef,
					statements: z.array(executeStatement).min(1).max(100),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ lix_ref, statements }) =>
				service.executeSql(
					String(lix_ref),
					statements.map((statement) => ({
						sql: statement.sql,
						params: statement.params,
					})),
				),
			executeOutput,
		),
	];
}

function createTool<T extends z.ZodType<Record<string, unknown>>>(
	name: string,
	title: string,
	description: string,
	schema: T,
	annotations: ToolAnnotations,
	securitySchemes: Array<McpSecurityScheme>,
	call: (args: z.output<T>) => Promise<unknown>,
	outputSchema?: z.ZodType<Record<string, unknown>>,
): ToolDefinition {
	return {
		descriptor: {
			name,
			title,
			description,
			inputSchema: mcpJsonSchema(schema, "input"),
			...(outputSchema
				? {
						outputSchema: {
							...mcpJsonSchema(outputSchema, "output"),
							type: "object" as const,
						},
					}
				: {}),
			securitySchemes: securitySchemes.map(cloneSecurityScheme),
			annotations,
			_meta: {
				securitySchemes: securitySchemes.map(cloneSecurityScheme),
			},
		},
		schema,
		...(outputSchema ? { outputSchema } : {}),
		call: (args) => call(args as z.output<T>),
	};
}

function mcpJsonSchema(
	schema: z.ZodType,
	io: "input" | "output",
): Record<string, unknown> {
	const jsonSchema = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
	removeUuidPatterns(jsonSchema);
	return jsonSchema;
}

function removeUuidPatterns(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) removeUuidPatterns(item);
		return;
	}
	const object = value as Record<string, unknown>;
	if (object.format === "uuid") delete object.pattern;
	for (const child of Object.values(object)) removeUuidPatterns(child);
}

function cloneSecurityScheme(scheme: McpSecurityScheme): McpSecurityScheme {
	return scheme.type === "oauth2"
		? { ...scheme, scopes: [...scheme.scopes] }
		: { ...scheme };
}

function readAnnotations(): ToolAnnotations {
	return {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: false,
		idempotentHint: true,
	};
}

function writeAnnotations(
	destructiveHint: boolean,
	idempotentHint: boolean,
): ToolAnnotations {
	return {
		readOnlyHint: false,
		destructiveHint,
		openWorldHint: false,
		idempotentHint,
	};
}

function errorResult(
	code: string,
	message: string,
	details?: Record<string, unknown>,
) {
	return {
		structuredContent: { error: { code, message, details } },
		content: [{ type: "text" as const, text: `${code}: ${message}` }],
		isError: true,
	};
}

function asStructuredContent(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: { result: value };
}

function successSummary(toolName: string): string {
	return `${toolName} completed successfully.`;
}

function errorDetails(caught: unknown): Record<string, unknown> {
	return caught instanceof Error
		? { name: caught.name, message: caught.message, stack: caught.stack }
		: { value: String(caught) };
}
