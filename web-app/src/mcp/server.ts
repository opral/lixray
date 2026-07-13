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

export const MCP_PATH = "/mcp";
export const MCP_RESOURCE = "https://lixray.com";
export const MCP_AUTHORIZATION_SERVER =
	"https://xpkokrinmkjqcnjzbmpe.supabase.co/auth/v1";
export const MCP_PROTECTED_RESOURCE_PATH =
	"/.well-known/oauth-protected-resource";
export const MCP_DOCUMENTATION_PATH = "/docs/mcp";
export const MCP_PROTECTED_RESOURCE_URL = `${MCP_RESOURCE}${MCP_PROTECTED_RESOURCE_PATH}`;
export const MCP_SCOPES = ["openid", "email", "profile"] as const;

const securitySchemes = [{ type: "oauth2" as const, scopes: [...MCP_SCOPES] }];

const uuid = z.uuid().describe("Workspace UUID");
const branchId = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.describe("Existing Lix branch ID");
const absolutePath = z.string().min(1).max(1024);
const wireValue = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("null"), value: z.null().optional() }).strict(),
	z.object({ kind: z.literal("bool"), value: z.boolean() }).strict(),
	z.object({ kind: z.literal("int"), value: z.number().int().safe() }).strict(),
	z.object({ kind: z.literal("float"), value: z.number().finite() }).strict(),
	z.object({ kind: z.literal("text"), value: z.string() }).strict(),
	z.object({ kind: z.literal("blob"), base64: z.string() }).strict(),
	z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
]);

interface ToolDefinition {
	descriptor: {
		name: string;
		title: string;
		description: string;
		inputSchema: Record<string, unknown>;
		securitySchemes: Array<{ type: "oauth2"; scopes: Array<string> }>;
		annotations: ToolAnnotations;
		_meta: Record<string, unknown>;
	};
	schema: z.ZodType<Record<string, unknown>>;
	call(args: Record<string, unknown>): Promise<unknown>;
}

export function createLixrayMcpServer(service: LixFileService): Server {
	const server = new Server(
		{ name: "LixRay", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use LixRay tools to work with private workspace files. First list workspaces and branches. Always read an existing entry and use its revision before editing, moving, replacing, or deleting it. Never guess IDs or revisions. The execute tool runs raw Lix SQL and may bypass file safeguards; use it only when the user requests SQL or the file tools cannot perform the task.",
		},
	);
	const tools = buildTools(service);

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => tool.descriptor),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = tools.find(
			(candidate) => candidate.descriptor.name === request.params.name,
		);
		if (!tool) {
			throw new McpError(
				ErrorCode.InvalidParams,
				`Unknown tool: ${request.params.name}`,
			);
		}
		const parsed = tool.schema.safeParse(request.params.arguments ?? {});
		if (!parsed.success) {
			return errorResult("invalid_arguments", z.prettifyError(parsed.error));
		}
		try {
			const structuredContent = await tool.call(parsed.data);
			return {
				structuredContent: asStructuredContent(structuredContent),
				content: [
					{
						type: "text" as const,
						text: successSummary(tool.descriptor.name, structuredContent),
					},
				],
			};
		} catch (caught) {
			if (caught instanceof FileServiceError) {
				return errorResult(caught.code, caught.message, caught.details);
			}
			console.error("LixRay MCP tool failed", {
				tool: tool.descriptor.name,
				error: errorDetails(caught),
			});
			return errorResult("internal_error", "The LixRay tool call failed.");
		}
	});

	return server;
}

export async function handleMcpTransport(
	request: Request,
	service: LixFileService,
	ctx: ExecutionContext,
): Promise<Response> {
	// Keep the Worker-only module out of Node's strip-types test loader. The
	// production Worker resolves this Cloudflare module when the MCP route runs.
	const { createMcpHandler } = await import("agents/mcp");
	return createMcpHandler(createLixrayMcpServer(service), {
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
			"The server exposes explicit-workspace, explicit-branch tools for listing, reading, creating, editing, moving, and deleting UTF-8 text files up to 1 MiB, plus a destructive raw Lix SQL execute tool. Existing file-tool content is protected by opaque revisions; raw SQL bypasses those file safeguards.",
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

function buildTools(service: LixFileService): Array<ToolDefinition> {
	return [
		tool(
			"list_workspaces",
			"List workspaces",
			"List the LixRay workspaces the signed-in user can access.",
			z.object({}).strict(),
			readAnnotations(),
			async () => ({ workspaces: await service.listWorkspaces() }),
		),
		tool(
			"list_branches",
			"List branches",
			"List existing Lix branches in one accessible workspace.",
			z.object({ workspace_id: uuid }).strict(),
			readAnnotations(),
			async ({ workspace_id }) => ({
				branches: await service.listBranches(String(workspace_id)),
			}),
		),
		tool(
			"list_directory",
			"List directory",
			"List the immediate files and directories at an absolute directory path.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath.describe("Absolute directory path ending in /"),
				})
				.strict(),
			readAnnotations(),
			async ({ workspace_id, branch_id, path }) => ({
				path,
				entries: await service.listDirectory(
					String(workspace_id),
					String(branch_id),
					String(path),
				),
			}),
		),
		tool(
			"find_files",
			"Find files",
			"Find files by path or name. This does not search file contents.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					query: z.string().trim().min(1).max(100),
					under_path: absolutePath.optional().default("/"),
					limit: z.number().int().min(1).max(100).optional().default(50),
				})
				.strict(),
			readAnnotations(),
			async ({ workspace_id, branch_id, query, under_path, limit }) => ({
				files: await service.findFiles(
					String(workspace_id),
					String(branch_id),
					String(query),
					String(under_path),
					Number(limit),
				),
			}),
		),
		tool(
			"read_file",
			"Read text file",
			"Read a page of a UTF-8 text file and return its current revision for safe edits.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath.describe(
						"Absolute file path without a trailing /",
					),
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
					String(branch_id),
					String(path),
					Number(start_line),
					Number(line_count),
				),
		),
		tool(
			"write_file",
			"Create or replace text file",
			"Create a UTF-8 text file, or replace an existing file only when expected_revision matches.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath,
					content: z.string(),
					expected_revision: z.string().min(1).optional(),
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
					String(branch_id),
					String(path),
					String(content),
					expected_revision === undefined
						? undefined
						: String(expected_revision),
				),
			}),
		),
		tool(
			"edit_file",
			"Edit text file",
			"Apply exact text replacements to a UTF-8 file using its current revision.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath,
					expected_revision: z.string().min(1),
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
					String(branch_id),
					String(path),
					String(expected_revision),
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
		),
		tool(
			"create_directory",
			"Create directory",
			"Create a directory at a canonical absolute path ending in /.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath,
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ workspace_id, branch_id, path }) => ({
				directory: await service.createDirectory(
					String(workspace_id),
					String(branch_id),
					String(path),
				),
			}),
		),
		tool(
			"move_entry",
			"Move file or directory",
			"Move or rename an entry using its revision. Existing destinations are never overwritten.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					source_path: absolutePath,
					destination_path: absolutePath,
					expected_revision: z.string().min(1),
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
					String(branch_id),
					String(source_path),
					String(destination_path),
					String(expected_revision),
				),
			}),
		),
		tool(
			"delete_entry",
			"Delete file or directory",
			"Permanently delete an entry at its current revision. Directories require recursive=true and remove their entire subtree.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					path: absolutePath,
					expected_revision: z.string().min(1),
					recursive: z.boolean().optional().default(false),
				})
				.strict(),
			writeAnnotations(false, false),
			async ({ workspace_id, branch_id, path, expected_revision, recursive }) =>
				service.deleteEntry(
					String(workspace_id),
					String(branch_id),
					String(path),
					String(expected_revision),
					Boolean(recursive),
				),
		),
		tool(
			"execute",
			"Execute raw Lix SQL",
			"Execute caller-provided Lix SQL against an authorized workspace branch. SQL can read or mutate any SQL-accessible branch data and bypasses file-tool safeguards.",
			z
				.object({
					workspace_id: uuid,
					branch_id: branchId,
					sql: z.string().trim().min(1).max(100_000),
					params: z.array(wireValue).max(1000).optional().default([]),
				})
				.strict(),
			writeAnnotations(true, false),
			async ({ workspace_id, branch_id, sql, params }) =>
				service.executeSql(
					String(workspace_id),
					String(branch_id),
					String(sql),
					params as Array<WireValue>,
				),
		),
	];
}

function tool<T extends z.ZodType<Record<string, unknown>>>(
	name: string,
	title: string,
	description: string,
	schema: T,
	annotations: ToolAnnotations,
	call: (args: z.output<T>) => Promise<unknown>,
): ToolDefinition {
	return {
		descriptor: {
			name,
			title,
			description,
			inputSchema: z.toJSONSchema(schema),
			securitySchemes: securitySchemes.map((scheme) => ({
				...scheme,
				scopes: [...scheme.scopes],
			})),
			annotations,
			_meta: { securitySchemes },
		},
		schema,
		call: (args) => call(args as z.output<T>),
	};
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
