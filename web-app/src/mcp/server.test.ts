import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
	FileServiceError,
	LixFileService,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	type LixRuntimeClient,
} from "./file-service.ts";
import {
	EXECUTE_SQL_INTROSPECTION_QUERY,
	EXECUTE_SQL_REFERENCE_DDL,
	EXECUTE_SQL_SURFACES,
	EXECUTE_TOOL_DESCRIPTION,
} from "./execute-schema.ts";
import {
	MCP_AUTHORIZATION_SERVER,
	MCP_PROTECTED_RESOURCE_URL,
	MCP_RESOURCE,
	createLixrayMcpServer,
	mcpAuthenticateChallenge,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	protectedResourceMetadataResponse,
	type McpToolCallObservation,
} from "./server.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "22222222-2222-4222-8222-222222222222";
const THROW_BRANCH_ID = "33333333-3333-4333-8333-333333333333";
const COMMIT_ID = "44444444-4444-4444-8444-444444444444";
const HIDDEN_BRANCH_ID = "55555555-5555-4555-8555-555555555555";

void test("protected resource discovery advertises the Supabase authorization server", async () => {
	const response = protectedResourceMetadataResponse();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.deepEqual(await response.json(), {
		resource: MCP_RESOURCE,
		authorization_servers: [MCP_AUTHORIZATION_SERVER],
		scopes_supported: ["openid", "email", "profile"],
		resource_documentation: "https://lixray.com/docs/mcp",
	});
	assert.match(
		mcpAuthenticateChallenge(),
		new RegExp(
			`resource_metadata="${escapeRegExp(MCP_PROTECTED_RESOURCE_URL)}"`,
		),
	);
	const unauthorized = mcpUnauthorizedResponse("invalid_token", "Expired.");
	assert.equal(unauthorized.status, 401);
	assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");
	const challenge = unauthorized.headers.get("www-authenticate");
	assert.ok(challenge);
	assert.deepEqual(await unauthorized.json(), {
		error: "unauthorized",
		error_description: "Expired.",
		_meta: { "mcp/www_authenticate": [challenge] },
	});
});

void test("MCP documentation distinguishes browser and client authentication", async () => {
	const response = mcpDocumentationResponse();
	assert.equal(response.status, 200);
	const documentation = await response.text();
	assert.match(
		documentation,
		/browser session and your MCP client authorization are separate/,
	);
	assert.match(documentation, /initialize, tools\/list, and list_workspaces/);
	assert.match(documentation, /no refresh token is available/);
	assert.match(documentation, /do not include access or refresh tokens/);
	assert.match(documentation, /ordered batch of statements/);
	assert.match(documentation, /executes the batch atomically/);
	assert.match(documentation, /default to the workspace default branch/);
});

void test("MCP initialize, tools/list, and tools/call expose the authenticated tool contract", async () => {
	const runtimeClient = new ProtocolLixRuntimeClient();
	const service = new LixFileService(runtimeClient);
	const observations: Array<McpToolCallObservation> = [];
	const server = createLixrayMcpServer(service, {
		onToolCall: (observation) => observations.push(observation),
	});
	const client = new Client({ name: "lixray-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const rawMessages: Array<JSONRPCMessage> = [];
	const send = serverTransport.send.bind(serverTransport);
	serverTransport.send = async (message, options) => {
		rawMessages.push(structuredClone(message));
		await send(message, options);
	};

	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const listed = await client.listTools();
		assert.deepEqual(
			listed.tools.map((tool) => tool.name),
			[
				"list_workspaces",
				"list_branches",
				"list_directory",
				"find_files",
				"read_file",
				"write_file",
				"edit_file",
				"create_directory",
				"move_entry",
				"delete_entry",
				"execute",
			],
		);
		for (const tool of listed.tools) {
			assert.deepEqual(tool._meta?.securitySchemes, [
				{ type: "oauth2", scopes: ["openid", "email", "profile"] },
			]);
			assert.equal(tool.annotations?.openWorldHint, false);
		}
		for (const name of [
			"list_workspaces",
			"list_branches",
			"list_directory",
			"find_files",
			"read_file",
		]) {
			assert.equal(
				listed.tools.find((tool) => tool.name === name)?.annotations
					?.readOnlyHint,
				true,
			);
		}
		for (const tool of listed.tools.filter((tool) => tool.name !== "execute")) {
			assert.equal(tool.annotations?.destructiveHint, false, tool.name);
		}
		const executeTool = listed.tools.find((tool) => tool.name === "execute");
		assert.ok(executeTool);
		assert.equal(executeTool.description, EXECUTE_TOOL_DESCRIPTION);
		assert.ok(executeTool.description.includes(EXECUTE_SQL_REFERENCE_DDL));
		assert.ok(
			executeTool.description.includes(EXECUTE_SQL_INTROSPECTION_QUERY),
		);
		for (const sqlSurface of EXECUTE_SQL_SURFACES) {
			assert.ok(
				executeTool.description.includes(`CREATE TABLE ${sqlSurface.name} (`),
				sqlSurface.name,
			);
		}
		assert.deepEqual(runtimeClient.executeRequests, []);
		assert.equal(executeTool?.annotations?.readOnlyHint, false);
		assert.equal(executeTool?.annotations?.destructiveHint, true);
		assert.equal(executeTool?.annotations?.idempotentHint, false);

		const rawTools = findRawTools(rawMessages);
		assert.equal(rawTools.length, 11);
		const checkedInTools: unknown = JSON.parse(
			await readFile(new URL("../../mcp-tools.json", import.meta.url), "utf8"),
		);
		assert.deepEqual(
			checkedInTools,
			rawTools,
			"web-app/mcp-tools.json is stale; run `pnpm --dir web-app mcp:tools:generate` or `pnpm --dir web-app build`",
		);
		for (const tool of rawTools) {
			assert.deepEqual(tool.securitySchemes, [
				{ type: "oauth2", scopes: ["openid", "email", "profile"] },
			]);
			assert.ok(
				tool.outputSchema,
				`${String(tool.name)} should expose an output schema`,
			);
		}
		for (const name of rawTools
			.map((tool) => String(tool.name))
			.filter((name) => name !== "list_workspaces")) {
			const inputSchema = rawTools.find((tool) => tool.name === name)
				?.inputSchema as
				| {
						required?: Array<string>;
						properties?: Record<
							string,
							{
								type?: string;
								description?: string;
								anyOf?: unknown;
								format?: unknown;
								pattern?: unknown;
							}
						>;
				  }
				| undefined;
			assert.ok(inputSchema, `${name} should expose an input schema`);
			assert.equal(inputSchema.properties?.workspace_id, undefined, name);
			assert.ok(inputSchema.properties?.workspace_ref, name);
			assert.equal(inputSchema.required?.includes("workspace_ref"), true, name);
			assert.equal(inputSchema.properties?.workspace_ref?.type, "string", name);
			assert.equal(
				inputSchema.properties?.workspace_ref?.anyOf,
				undefined,
				name,
			);
			assert.equal(
				inputSchema.properties?.workspace_ref?.format,
				undefined,
				name,
			);
			assert.equal(
				inputSchema.properties?.workspace_ref?.pattern,
				undefined,
				name,
			);
			assert.match(
				inputSchema.properties?.workspace_ref?.description ?? "",
				/Exact workspace UUID, exact workspace slug, or exact @namespace\/slug\. Use the workspace UUID when available\./,
				name,
			);
		}
		for (const name of [
			"write_file",
			"edit_file",
			"move_entry",
			"delete_entry",
		]) {
			const inputSchema = rawTools.find((tool) => tool.name === name)
				?.inputSchema as
				| {
						required?: Array<string>;
						properties?: Record<
							string,
							{
								format?: string;
								maxLength?: number;
								description?: string;
							}
						>;
				  }
				| undefined;
			assert.ok(inputSchema, `${name} should expose an input schema`);
			assert.equal(
				inputSchema.required?.includes("expected_revision") ?? false,
				false,
				`${name} should not require expected_revision`,
			);
			const revisionSchema = inputSchema.properties?.expected_revision;
			assert.ok(revisionSchema, `${name} should expose expected_revision`);
			assert.equal(revisionSchema.format, "uuid", name);
			assert.equal(revisionSchema.maxLength, undefined, name);
			assert.match(
				revisionSchema.description ?? "",
				/Iff provided, .+ succeeds only if it matches\./,
				name,
			);
		}
		for (const name of [
			"list_directory",
			"find_files",
			"read_file",
			"write_file",
			"edit_file",
			"create_directory",
			"move_entry",
		]) {
			const outputSchema = rawTools.find(
				(tool) => tool.name === name,
			)?.outputSchema;
			assert.ok(outputSchema, `${name} should expose an output schema`);
			const revisionSchemas = findPropertySchemas(outputSchema, "revision");
			assert.ok(
				revisionSchemas.length > 0,
				`${name} should describe its returned revision`,
			);
			for (const revisionSchema of revisionSchemas) {
				assert.equal(revisionSchema.format, "uuid", name);
				assert.equal(revisionSchema.maxLength, undefined, name);
			}
		}
		const defaultedInputs = new Map([
			["find_files", ["under_path"]],
			["read_file", ["start_line", "line_count"]],
			["delete_entry", ["recursive"]],
		]);
		for (const [name, defaultedProperties] of defaultedInputs) {
			const inputSchema = rawTools.find((tool) => tool.name === name)
				?.inputSchema as { required?: Array<string> } | undefined;
			assert.ok(inputSchema, `${name} should expose an input schema`);
			for (const property of defaultedProperties) {
				assert.equal(
					inputSchema.required?.includes(property) ?? false,
					false,
					`${name}.${property} should use its default when omitted`,
				);
			}
		}
		const executeInput = rawTools.find((tool) => tool.name === "execute")
			?.inputSchema as
			| {
					properties?: {
						statements?: {
							items?: {
								required?: Array<string>;
							};
						};
					};
			  }
			| undefined;
		assert.equal(
			executeInput?.properties?.statements?.items?.required?.includes(
				"params",
			) ?? false,
			false,
		);
		const findFilesInput = rawTools.find((tool) => tool.name === "find_files")
			?.inputSchema as { properties?: Record<string, unknown> } | undefined;
		assert.equal(findFilesInput?.properties?.limit, undefined);
		const editFileInput = rawTools.find((tool) => tool.name === "edit_file")
			?.inputSchema as
			| {
					properties?: {
						edits?: { items?: { required?: Array<string> } };
					};
			  }
			| undefined;
		assert.equal(
			editFileInput?.properties?.edits?.items?.required?.includes(
				"replace_all",
			) ?? false,
			false,
		);
		for (const name of [
			"list_directory",
			"find_files",
			"read_file",
			"write_file",
			"edit_file",
			"create_directory",
			"move_entry",
			"delete_entry",
			"execute",
		]) {
			const inputSchema = rawTools.find((tool) => tool.name === name)
				?.inputSchema as
				| {
						required?: Array<string>;
						properties?: Record<
							string,
							{
								format?: string;
								maxLength?: number;
								description?: string;
							}
						>;
				  }
				| undefined;
			const branchSchema = inputSchema?.properties?.branch_id;
			assert.ok(branchSchema, `${name} should expose branch_id`);
			assert.equal(branchSchema.format, "uuid", name);
			assert.equal(branchSchema.maxLength, undefined, name);
			assert.match(
				branchSchema.description ?? "",
				/Omit to use the workspace default branch/,
			);
			assert.equal(
				inputSchema.required?.includes("branch_id") ?? false,
				false,
				`${name} should default branch_id`,
			);
		}

		const workspaces = await client.callTool({
			name: "list_workspaces",
			arguments: {},
		});
		assert.equal(workspaces.isError, undefined);
		assert.deepEqual(workspaces.structuredContent, {
			workspaces: [
				{
					id: WORKSPACE_ID,
					name: "Personal",
					slug: "personal",
					organization: {
						id: "org-1",
						name: "Example",
						handle: "example",
					},
				},
			],
		});

		const urlRead = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_ref: "@example/personal",
				branch_id: BRANCH_ID,
				path: "/scratch/samuel's-todos.md",
			},
		});
		assert.equal(urlRead.isError, undefined);
		assert.deepEqual(urlRead.structuredContent, {
			path: "/scratch/samuel's-todos.md",
			content: "todo",
			size: 4,
			revision: COMMIT_ID,
			updatedAt: "2026-07-16T12:00:00.000Z",
			totalLines: 1,
			startLine: 1,
			endLine: 1,
			hasMore: false,
		});
		assert.deepEqual(runtimeClient.fileReadRequests, [
			{
				workspaceId: WORKSPACE_ID,
				path: "/scratch/samuel's-todos.md",
			},
		]);

		const branches = await client.callTool({
			name: "list_branches",
			arguments: { workspace_ref: "personal" },
		});
		assert.equal(branches.isError, undefined);
		assert.deepEqual(branches.structuredContent, {
			branches: [
				{
					id: BRANCH_ID,
					name: "main",
					hidden: false,
					commitId: COMMIT_ID,
				},
			],
			current_branch_id: BRANCH_ID,
		});

		const executed = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				statements: [
					{
						sql: "SELECT value FROM lix_key_value WHERE key = $1",
						params: [{ kind: "text", value: "example" }],
					},
				],
			},
		});
		assert.equal(executed.isError, undefined);
		assert.deepEqual(executed.structuredContent, {
			results: [
				{
					columns: ["value"],
					rows: [[{ kind: "text", value: "result" }]],
					rowsAffected: 0,
					notices: [],
				},
			],
		});
		assert.deepEqual(runtimeClient.executeRequests, [
			{
				workspaceId: WORKSPACE_ID,
				request: {
					branchId: BRANCH_ID,
					sql: "SELECT value FROM lix_key_value WHERE key = $1",
					params: [{ kind: "text", value: "example" }],
					options: undefined,
				},
			},
		]);

		const batch = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: BRANCH_ID,
				statements: [
					{
						sql: "INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
						params: [
							{ kind: "text", value: "example" },
							{ kind: "text", value: "result" },
						],
					},
					{
						sql: "SELECT value FROM lix_key_value WHERE key = $1",
						params: [{ kind: "text", value: "example" }],
					},
				],
			},
		});
		assert.equal(batch.isError, undefined);
		assert.equal(
			(batch.structuredContent as { results: Array<unknown> }).results.length,
			2,
		);

		const invalidRead = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: BRANCH_ID,
				path: "/../secret.txt",
			},
		});
		assert.equal(invalidRead.isError, true);
		assert.equal(
			(
				invalidRead.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"invalid_path",
		);

		const invalidArguments = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: BRANCH_ID,
			},
		});
		assert.equal(invalidArguments.isError, true);
		assert.equal(
			(
				invalidArguments.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"invalid_arguments",
		);

		const legacyWorkspaceId = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_id: WORKSPACE_ID,
				branch_id: BRANCH_ID,
				path: "/legacy.txt",
			},
		});
		assert.equal(legacyWorkspaceId.isError, true);
		assert.equal(
			(
				legacyWorkspaceId.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"invalid_arguments",
		);

		const malformedWorkspaceRef = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_ref: "https://lixray.com/@example/personal/file/legacy.txt",
				branch_id: BRANCH_ID,
				path: "/legacy.txt",
			},
		});
		assert.equal(malformedWorkspaceRef.isError, true);
		assert.equal(
			(
				malformedWorkspaceRef.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"not_found",
		);

		const invalidExecuteArguments = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: BRANCH_ID,
				statements: [{ sql: "  SELECT $1  ", params: [{ kind: "text" }] }],
			},
		});
		assert.equal(invalidExecuteArguments.isError, true);
		assert.equal(
			(
				invalidExecuteArguments.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"invalid_arguments",
		);

		const internalFailure = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: THROW_BRANCH_ID,
				statements: [{ sql: "SELECT 1" }],
			},
		});
		assert.equal(internalFailure.isError, true);
		assert.equal(
			(
				internalFailure.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"internal_error",
		);

		await assert.rejects(
			client.callTool({ name: "untrusted-secret-tool-name", arguments: {} }),
			/Unknown tool/,
		);

		assert.deepEqual(
			observations.map(({ durationMs, ...observation }) => {
				assert.ok(Number.isInteger(durationMs));
				assert.ok(durationMs >= 0);
				return observation;
			}),
			[
				{ toolName: "list_workspaces", outcome: "success" },
				{
					toolName: "read_file",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "list_branches",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "execute",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
					sql: "SELECT value FROM lix_key_value WHERE key = $1",
				},
				{
					toolName: "execute",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
					sql: "INSERT INTO lix_key_value (key, value) VALUES ($1, $2);\nSELECT value FROM lix_key_value WHERE key = $1",
				},
				{
					toolName: "read_file",
					outcome: "error",
					errorCode: "invalid_path",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "read_file",
					outcome: "error",
					errorCode: "invalid_arguments",
				},
				{
					toolName: "read_file",
					outcome: "error",
					errorCode: "invalid_arguments",
				},
				{
					toolName: "read_file",
					outcome: "error",
					errorCode: "not_found",
				},
				{
					toolName: "execute",
					outcome: "error",
					errorCode: "invalid_arguments",
					sql: "SELECT $1",
				},
				{
					toolName: "execute",
					outcome: "error",
					errorCode: "internal_error",
					workspaceId: WORKSPACE_ID,
					sql: "SELECT 1",
				},
				{
					toolName: "unknown",
					outcome: "error",
					errorCode: "unknown_tool",
				},
			],
		);
	} finally {
		await client.close();
		await server.close();
	}
});

void test("authless MCP tools advertise noauth security", async () => {
	const server = createLixrayMcpServer(
		new LixFileService(new ProtocolLixRuntimeClient()),
		{ authMode: "none" },
	);
	const client = new Client({ name: "lixray-demo-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const rawMessages: Array<JSONRPCMessage> = [];
	const send = serverTransport.send.bind(serverTransport);
	serverTransport.send = async (message, options) => {
		rawMessages.push(structuredClone(message));
		await send(message, options);
	};

	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const listed = await client.listTools();
		for (const tool of listed.tools) {
			assert.deepEqual(tool._meta?.securitySchemes, [{ type: "noauth" }]);
		}
		const rawTools = findRawTools(rawMessages);
		assert.equal(rawTools.length, 11);
		for (const tool of rawTools) {
			assert.deepEqual(tool.securitySchemes, [{ type: "noauth" }]);
		}
	} finally {
		await client.close();
		await server.close();
	}
});

class ProtocolLixRuntimeClient implements LixRuntimeClient {
	readonly executeRequests: Array<{
		workspaceId: string;
		request: ExecuteRequest;
	}> = [];
	readonly fileReadRequests: Array<{ workspaceId: string; path: string }> = [];

	async listWorkspaces() {
		return [
			{
				id: WORKSPACE_ID,
				name: "Personal",
				slug: "personal",
				organization: { id: "org-1", name: "Example", handle: "example" },
			},
		];
	}

	async listBranches() {
		return {
			branches: [
				{
					id: BRANCH_ID,
					name: "main",
					hidden: false,
					commitId: COMMIT_ID,
				},
				{
					id: HIDDEN_BRANCH_ID,
					name: "hidden",
					hidden: true,
					commitId: COMMIT_ID,
				},
				{
					id: "global",
					name: "global",
					hidden: true,
					commitId: COMMIT_ID,
				},
				{
					id: "legacy-custom-id",
					name: "legacy",
					hidden: false,
					commitId: COMMIT_ID,
				},
			],
			currentBranchId: BRANCH_ID,
		};
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		if (request.sql.includes("BEGIN;")) {
			throw new FileServiceError(
				"LIX_UNSUPPORTED_SQL",
				"Execute accepts exactly one SQL statement.",
			);
		}
		if (
			request.sql ===
			"SELECT data, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE path = $1"
		) {
			const path = request.params?.[0];
			assert.equal(path?.kind, "text");
			this.fileReadRequests.push({ workspaceId, path: path.value });
			return {
				columns: ["data", "lixcol_change_id", "lixcol_updated_at"],
				rows: [
					[
						{ kind: "blob", base64: "dG9kbw==" },
						{ kind: "text", value: COMMIT_ID },
						{ kind: "text", value: "2026-07-16T12:00:00.000Z" },
					],
				],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (request.branchId === THROW_BRANCH_ID) {
			throw new Error("Unexpected runtime failure");
		}
		this.executeRequests.push({ workspaceId, request });
		return {
			columns: ["value"],
			rows: [[{ kind: "text", value: "result" }]],
			rowsAffected: 0,
			notices: [],
		};
	}

	async executeBatch(
		workspaceId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse> {
		return {
			results: await Promise.all(
				request.statements.map((statement) =>
					this.execute(workspaceId, {
						branchId: request.branchId,
						...statement,
						options: request.options,
					}),
				),
			),
		};
	}

	async mutate(): Promise<never> {
		throw new Error("No filesystem mutation should run for this protocol test");
	}
}

function findRawTools(
	messages: Array<JSONRPCMessage>,
): Array<Record<string, unknown>> {
	for (const message of messages) {
		if (
			"result" in message &&
			message.result &&
			typeof message.result === "object" &&
			"tools" in message.result &&
			Array.isArray(message.result.tools)
		) {
			return message.result.tools as Array<Record<string, unknown>>;
		}
	}
	return [];
}

function findPropertySchemas(
	value: unknown,
	propertyName: string,
): Array<Record<string, unknown>> {
	if (!value || typeof value !== "object") return [];
	const object = value as Record<string, unknown>;
	const properties = object.properties;
	const direct =
		properties && typeof properties === "object"
			? (properties as Record<string, unknown>)[propertyName]
			: undefined;
	return [
		...(direct && typeof direct === "object"
			? [direct as Record<string, unknown>]
			: []),
		...Object.values(object).flatMap((child) =>
			findPropertySchemas(child, propertyName),
		),
	];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
