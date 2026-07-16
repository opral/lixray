import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	DEFAULT_READ_LINE_COUNT,
	FileServiceError,
	LixFileService,
	type WireValue,
} from "./file-service.ts";
import { EXECUTE_TOOL_DESCRIPTION } from "./execute-schema.ts";

export const MCP_PATH = "/mcp";
export const MCP_RESOURCE = "https://lixray.com";
export const MCP_AUTHORIZATION_SERVER =
	"https://xpkokrinmkjqcnjzbmpe.supabase.co/auth/v1";
export const MCP_PROTECTED_RESOURCE_PATH =
	"/.well-known/oauth-protected-resource";
export const MCP_DOCUMENTATION_PATH = "/docs/mcp";
export const MCP_PROTECTED_RESOURCE_URL = `${MCP_RESOURCE}${MCP_PROTECTED_RESOURCE_PATH}`;
export const MCP_SCOPES = ["openid", "email", "profile"] as const;

export type McpAuthMode = "oauth" | "none";

export interface McpToolCallObservation {
	toolName: string;
	outcome: "success" | "error";
	durationMs: number;
	errorCode?: string;
	workspaceId?: string;
	sql?: string;
}

export type McpToolCallObserver = (observation: McpToolCallObservation) => void;

export interface McpServerOptions {
	authMode?: McpAuthMode;
	onToolCall?: McpToolCallObserver;
}

type McpSecurityScheme =
	| { type: "oauth2"; scopes: Array<string> }
	| { type: "noauth" };

const oauthSecuritySchemes: Array<McpSecurityScheme> = [
	{ type: "oauth2", scopes: [...MCP_SCOPES] },
];

const uuid = z.uuid().describe("Workspace UUID");
const branchId = z.uuid().describe("Lix branch UUID");
const optionalBranchId = branchId
	.describe("Lix branch UUID. Omit to use the workspace default branch.")
	.optional();
const currentBranchId = z
	.uuid()
	.describe("Lix default aka current branch UUID");
const revisionId = z.uuid().describe("Lix revision UUID");
const absolutePath = z.string().min(1);
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
const workspaceSummaryOutput = z
	.object({
		id: uuid,
		name: z.string(),
		organization: z.object({ id: z.string(), name: z.string() }).strict(),
	})
	.strict();
const branchSummaryOutput = z
	.object({
		id: branchId,
		name: z.string(),
		hidden: z.boolean(),
		commitId: z.string(),
	})
	.strict();
const entrySummaryOutput = z
	.object({
		kind: z.enum(["file", "directory"]),
		path: absolutePath,
		name: z.string(),
		revision: revisionId,
		updatedAt: z.string(),
		size: z.number().int().nonnegative().nullable().optional(),
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
const listWorkspacesOutput = z.union([
	z.object({ workspaces: z.array(workspaceSummaryOutput) }).strict(),
	toolErrorOutput,
]);
const listBranchesOutput = z.union([
	z
		.object({
			branches: z.array(branchSummaryOutput),
			current_branch_id: currentBranchId,
		})
		.strict(),
	toolErrorOutput,
]);
const listDirectoryOutput = z.union([
	z
		.object({ path: absolutePath, entries: z.array(entrySummaryOutput) })
		.strict(),
	toolErrorOutput,
]);
const findFilesOutput = z.union([
	z.object({ files: z.array(entrySummaryOutput) }).strict(),
	toolErrorOutput,
]);
const fileSnapshotOutput = z.union([
	z
		.object({
			path: absolutePath,
			content: z.string(),
			size: z.number().int().nonnegative(),
			revision: revisionId,
			updatedAt: z.string(),
			totalLines: z.number().int().nonnegative(),
			startLine: z.number().int().nonnegative(),
			endLine: z.number().int().nonnegative(),
			hasMore: z.boolean(),
		})
		.strict(),
	toolErrorOutput,
]);
const fileEntryOutput = z.union([
	z.object({ file: entrySummaryOutput }).strict(),
	toolErrorOutput,
]);
const directoryEntryOutput = z.union([
	z.object({ directory: entrySummaryOutput }).strict(),
	toolErrorOutput,
]);
const movedEntryOutput = z.union([
	z.object({ entry: entrySummaryOutput }).strict(),
	toolErrorOutput,
]);
const deleteEntryOutput = z.union([
	z.object({ path: absolutePath, deleted: z.literal(true) }).strict(),
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
		{ name: "LixRay", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use LixRay tools to work with workspace files. Freely make changes, as the user can review all changes in the UI. Never guess UUIDs.",
		},
	);
	const tools = buildTools(
		service,
		options.authMode === "none" ? [{ type: "noauth" }] : oauthSecuritySchemes,
	);

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => tool.descriptor),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const startedAt = Date.now();
		const tool = tools.find(
			(candidate) => candidate.descriptor.name === request.params.name,
		);
		if (!tool) {
			observeToolCall(options.onToolCall, startedAt, {
				toolName: "unknown",
				outcome: "error",
				errorCode: "unknown_tool",
			});
			throw new McpError(
				ErrorCode.InvalidParams,
				`Unknown tool: ${request.params.name}`,
			);
		}
		const sqlResult =
			tool.descriptor.name === "execute"
				? executeSqlText.safeParse(request.params.arguments?.sql)
				: undefined;
		const sql = sqlResult?.success ? sqlResult.data : undefined;
		const parsed = tool.schema.safeParse(request.params.arguments ?? {});
		if (!parsed.success) {
			observeToolCall(options.onToolCall, startedAt, {
				toolName: tool.descriptor.name,
				outcome: "error",
				errorCode: "invalid_arguments",
				...(sql ? { sql } : {}),
			});
			return errorResult("invalid_arguments", z.prettifyError(parsed.error));
		}
		const workspaceId =
			typeof parsed.data.workspace_id === "string"
				? parsed.data.workspace_id
				: undefined;
		try {
			const rawStructuredContent = asStructuredContent(
				await tool.call(parsed.data),
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
			observeToolCall(options.onToolCall, startedAt, {
				toolName: tool.descriptor.name,
				outcome: "success",
				...(workspaceId ? { workspaceId } : {}),
				...(sql ? { sql } : {}),
			});
			return {
				structuredContent,
				content: [
					{
						type: "text" as const,
						text: successSummary(tool.descriptor.name, structuredContent),
					},
				],
			};
		} catch (caught) {
			if (caught instanceof FileServiceError) {
				observeToolCall(options.onToolCall, startedAt, {
					toolName: tool.descriptor.name,
					outcome: "error",
					errorCode: caught.code,
					...(workspaceId ? { workspaceId } : {}),
					...(sql ? { sql } : {}),
				});
				return errorResult(caught.code, caught.message, caught.details);
			}
			observeToolCall(options.onToolCall, startedAt, {
				toolName: tool.descriptor.name,
				outcome: "error",
				errorCode: "internal_error",
				...(workspaceId ? { workspaceId } : {}),
				...(sql ? { sql } : {}),
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
	ctx: ExecutionContext,
	options: McpServerOptions = {},
): Promise<Response> {
	// Keep the Worker-only module out of Node's strip-types test loader. The
	// production Worker resolves this Cloudflare module when the MCP route runs.
	const { createMcpHandler } = await import("agents/mcp");
	return createMcpHandler(createLixrayMcpServer(service, options), {
		route: MCP_PATH,
		enableJsonResponse: true,
		sessionIdGenerator: undefined,
		corsOptions: {
			origin: "*",
			methods: "GET, POST, DELETE, OPTIONS",
			headers: "Authorization, Content-Type, MCP-Protocol-Version",
			exposeHeaders: "MCP-Session-Id, MCP-Protocol-Version",
		},
	})(request, undefined, ctx);
}

export interface McpDiscoveryOptions {
	protectedResourceUrl?: string;
	authorizationServer?: string;
	resourceDocumentationUrl?: string;
	endpointUrl?: string;
}

export function protectedResourceMetadataResponse(
	options: McpDiscoveryOptions = {},
): Response {
	return Response.json(
		{
			resource: MCP_RESOURCE,
			authorization_servers: [
				options.authorizationServer ?? MCP_AUTHORIZATION_SERVER,
			],
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
			"",
			"Connection check:",
			"1. Confirm this endpoint is registered exactly once for the environment you intend to use.",
			"2. Revoke or log out the MCP connection, then authorize it again.",
			"3. Verify that initialize, tools/list, and list_workspaces all succeed in a fresh client process.",
			"",
			"If the client reports that no refresh token is available, remove the connection's saved authorization and reconnect. If it recurs, report the client version, server URL, and time of the attempt; do not include access or refresh tokens.",
			"",
			"The server exposes explicit-workspace tools for listing, reading, creating, editing, moving, and deleting UTF-8 text files up to 1 MiB, plus a destructive raw Lix SQL execute tool. Branch IDs are optional and default to the workspace default branch. Existing file-tool content is protected by opaque revisions; raw SQL bypasses those file safeguards. Execute accepts a single statement or an atomic semicolon-delimited script, optionally bounded by BEGIN and COMMIT. Scripts return one result per executable statement and use request-wide $n parameters or script-ordered ? parameters.",
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
			"list_workspaces",
			"List workspaces",
			"List the LixRay workspaces the signed-in user can access.",
			z.object({}).strict(),
			readAnnotations(),
			async () => ({ workspaces: await service.listWorkspaces() }),
			listWorkspacesOutput,
		),
		tool(
			"list_branches",
			"List branches",
			"List Lix branches in a workspace and identify its default branch.",
			z.object({ workspace_id: uuid }).strict(),
			readAnnotations(),
			async ({ workspace_id }) => {
				const state = await service.listBranches(String(workspace_id));
				return {
					branches: state.branches.filter(
						(branch) => !branch.hidden && branchId.safeParse(branch.id).success,
					),
					current_branch_id: state.currentBranchId,
				};
			},
			listBranchesOutput,
		),
		tool(
			"list_directory",
			"List directory",
			"List the immediate files and directories in a directory.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe("Absolute directory path ending in /"),
				})
				.strict(),
			readAnnotations(),
			async ({ workspace_id, branch_id, path }) => ({
				path,
				entries: await service.listDirectory(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
				),
			}),
			listDirectoryOutput,
		),
		tool(
			"find_files",
			"Find files",
			"Find files by path or name (does not search file contents).",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					query: z.string().trim().min(1),
					under_path: absolutePath.optional().default("/"),
				})
				.strict(),
			readAnnotations(),
			async ({ workspace_id, branch_id, query, under_path }) => ({
				files: await service.findFiles(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(query),
					String(under_path),
				),
			}),
			findFilesOutput,
		),
		tool(
			"read_file",
			"Read text file",
			"Read a UTF-8 text file.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe("Absolute file path"),
					start_line: z.number().int().min(1).optional().default(1),
					line_count: z
						.number()
						.int()
						.min(1)
						.max(1000)
						.optional()
						.default(DEFAULT_READ_LINE_COUNT),
				})
				.strict(),
			readAnnotations(),
			async ({ workspace_id, branch_id, path, start_line, line_count }) =>
				service.readFile(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
					Number(start_line),
					Number(line_count),
				),
			fileSnapshotOutput,
		),
		tool(
			"write_file",
			"Create or replace text file",
			"Create or replace a UTF-8 text file.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe("Absolute file path"),
					content: z.string(),
					expected_revision: revisionId
						.describe(
							"Optional current file revision. Iff provided, replacement succeeds only if it matches.",
						)
						.optional(),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({
				workspace_id,
				branch_id,
				path,
				content,
				expected_revision,
			}) => ({
				file: await service.writeFile(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
					String(content),
					expected_revision === undefined
						? undefined
						: String(expected_revision),
				),
			}),
			fileEntryOutput,
		),
		tool(
			"edit_file",
			"Edit text file",
			"Apply exact text replacements to a UTF-8 file.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe("Absolute file path"),
					expected_revision: revisionId
						.describe(
							"Optional current file revision. Iff provided, replacement succeeds only if it matches.",
						)
						.optional(),
					edits: z
						.array(
							z
								.object({
									old_text: z.string().min(1),
									new_text: z.string(),
									replace_all: z.boolean().optional().default(false),
								})
								.strict(),
						)
						.min(1)
						.max(50),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ workspace_id, branch_id, path, expected_revision, edits }) => ({
				file: await service.editFile(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
					expected_revision === undefined
						? undefined
						: String(expected_revision),
					(
						edits as Array<{
							old_text: string;
							new_text: string;
							replace_all?: boolean;
						}>
					).map((edit) => ({
						oldText: edit.old_text,
						newText: edit.new_text,
						replaceAll: edit.replace_all,
					})),
				),
			}),
			fileEntryOutput,
		),
		tool(
			"create_directory",
			"Create directory",
			"Create a directory at an absolute path ending in /.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe("Absolute directory path ending in /"),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ workspace_id, branch_id, path }) => ({
				directory: await service.createDirectory(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
				),
			}),
			directoryEntryOutput,
		),
		tool(
			"move_entry",
			"Move file or directory",
			"Move or rename an entry. Existing destinations will return an error.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					source_path: absolutePath.describe(
						"Absolute source path. Directory paths must end in /; file paths must not.",
					),
					destination_path: absolutePath.describe(
						"Absolute destination path with the same kind as source_path. Directory paths must end in /; file paths must not.",
					),
					expected_revision: revisionId
						.describe(
							"Optional current file revision. Iff provided, replacement succeeds only if it matches.",
						)
						.optional(),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({
				workspace_id,
				branch_id,
				source_path,
				destination_path,
				expected_revision,
			}) => ({
				entry: await service.moveEntry(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(source_path),
					String(destination_path),
					expected_revision === undefined
						? undefined
						: String(expected_revision),
				),
			}),
			movedEntryOutput,
		),
		tool(
			"delete_entry",
			"Delete file or directory",
			"Permanently delete an entry. Directories require recursive=true and remove their entire subtree.",
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					path: absolutePath.describe(
						"Absolute entry path. Directory paths must end in /; file paths must not.",
					),
					expected_revision: revisionId
						.describe(
							"Optional current entry revision. Iff provided, delete succeeds only if it matches.",
						)
						.optional(),
					recursive: z.boolean().optional().default(false),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ workspace_id, branch_id, path, expected_revision, recursive }) =>
				service.deleteEntry(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(path),
					expected_revision === undefined
						? undefined
						: String(expected_revision),
					Boolean(recursive),
				),
			deleteEntryOutput,
		),
		tool(
			"execute",
			"Execute raw Lix SQL",
			EXECUTE_TOOL_DESCRIPTION,
			z
				.object({
					workspace_id: uuid,
					branch_id: optionalBranchId,
					sql: executeSqlText,
					params: z.array(wireValue).max(1000).optional().default([]),
				})
				.strict(),
			writeAnnotations(true, false),
			async ({ workspace_id, branch_id, sql, params }) =>
				service.executeSql(
					String(workspace_id),
					await service.resolveBranchId(
						String(workspace_id),
						branch_id === undefined ? undefined : String(branch_id),
					),
					String(sql),
					params as Array<WireValue>,
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

function successSummary(toolName: string, value: unknown): string {
	if (toolName === "read_file" && value && typeof value === "object") {
		const result = value as Record<string, unknown>;
		const path = typeof result.path === "string" ? result.path : "file";
		const revision =
			typeof result.revision === "string" ? result.revision : "unknown";
		return `Read ${path} at revision ${revision}.`;
	}
	return `${toolName} completed successfully.`;
}

function errorDetails(caught: unknown): Record<string, unknown> {
	return caught instanceof Error
		? { name: caught.name, message: caught.message, stack: caught.stack }
		: { value: String(caught) };
}
