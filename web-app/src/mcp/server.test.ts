import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
	LixFileService,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	type LixRuntimeClient,
} from "./file-service.ts";
import {
	EXECUTE_SQL_COLUMNS_QUERY,
	EXECUTE_SQL_CORE_SCHEMA,
	EXECUTE_SQL_TABLES_QUERY,
	EXECUTE_TOOL_DESCRIPTION,
} from "./execute-schema.ts";
import {
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
const AUTHORIZATION_SERVER = "https://supabase.example.test/auth/v1";

void test("protected resource discovery advertises the Supabase authorization server", async () => {
	const response = protectedResourceMetadataResponse({
		authorizationServer: AUTHORIZATION_SERVER,
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.deepEqual(await response.json(), {
		resource: MCP_RESOURCE,
		authorization_servers: [AUTHORIZATION_SERVER],
		scopes_supported: ["openid", "email", "profile"],
		resource_documentation: "https://lixray.com/mcp/docs",
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
	assert.match(documentation, /active Lix branch/);
	assert.match(documentation, /active_branch_id/);
	assert.match(documentation, /switch_branch/);
	assert.match(documentation, /lix_branch/);
	assert.match(documentation, /raw Lix SQL execute/);
	assert.doesNotMatch(documentation, /file tools|reading, creating, editing/i);
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
			["list_workspaces", "active_branch_id", "switch_branch", "execute"],
		);
		for (const tool of listed.tools) {
			assert.deepEqual(tool._meta?.securitySchemes, [
				{ type: "oauth2", scopes: ["openid", "email", "profile"] },
			]);
			assert.equal(tool.annotations?.openWorldHint, false);
		}
		for (const name of ["list_workspaces", "active_branch_id"]) {
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
		const executeDescription = executeTool.description;
		assert.ok(executeDescription);
		assert.ok(executeDescription.startsWith(EXECUTE_TOOL_DESCRIPTION));
		assert.ok(executeDescription.includes(EXECUTE_SQL_CORE_SCHEMA));
		assert.ok(executeDescription.includes(EXECUTE_SQL_TABLES_QUERY));
		assert.ok(executeDescription.includes(EXECUTE_SQL_COLUMNS_QUERY));
		assert.match(executeDescription, /active Lix branch/);
		assert.deepEqual(runtimeClient.executeRequests, []);
		assert.equal(executeTool?.annotations?.readOnlyHint, false);
		assert.equal(executeTool?.annotations?.destructiveHint, false);
		assert.equal(executeTool?.annotations?.idempotentHint, false);

		const rawTools = findRawTools(rawMessages);
		assert.equal(rawTools.length, 4);
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
		for (const name of ["execute"]) {
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
			assert.equal(
				inputSchema?.properties?.branch_id,
				undefined,
				`${name} should use the active branch without a branch_id input`,
			);
		}
		const switchBranchInput = rawTools.find(
			(tool) => tool.name === "switch_branch",
		)?.inputSchema as
			| {
					required?: Array<string>;
					properties?: Record<
						string,
						{ format?: string; minLength?: number; description?: string }
					>;
			  }
			| undefined;
		assert.ok(switchBranchInput);
		const switchBranchId = switchBranchInput.properties?.branch_id;
		assert.ok(switchBranchId);
		assert.equal(switchBranchId.format, undefined);
		assert.equal(switchBranchId.minLength, 1);
		assert.equal(switchBranchId.description, "Lix branch ID");
		assert.equal(
			switchBranchInput.required?.includes("branch_id"),
			true,
			"switch_branch should require an explicit branch ID",
		);

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

		const activeBranch = await client.callTool({
			name: "active_branch_id",
			arguments: { workspace_ref: "personal" },
		});
		assert.equal(activeBranch.isError, undefined);
		assert.deepEqual(activeBranch.structuredContent, { branch_id: BRANCH_ID });

		const switchedBranch = await client.callTool({
			name: "switch_branch",
			arguments: { workspace_ref: "personal", branch_id: "global" },
		});
		assert.equal(switchedBranch.isError, undefined);
		assert.deepEqual(switchedBranch.structuredContent, { branch_id: "global" });

		const activeGlobalBranch = await client.callTool({
			name: "active_branch_id",
			arguments: { workspace_ref: "personal" },
		});
		assert.equal(activeGlobalBranch.isError, undefined);
		assert.deepEqual(activeGlobalBranch.structuredContent, {
			branch_id: "global",
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
					sql: "SELECT value FROM lix_key_value WHERE key = $1",
					params: [{ kind: "text", value: "example" }],
					options: undefined,
				},
			},
		]);
		assert.deepEqual(runtimeClient.executeActiveBranchIds, ["global"]);

		const batch = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
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

		const invalidExecuteArguments = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
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

		const rejectedBranchOverride = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
				branch_id: BRANCH_ID,
				statements: [{ sql: "SELECT 1" }],
			},
		});
		assert.equal(rejectedBranchOverride.isError, true);
		assert.equal(
			(
				rejectedBranchOverride.structuredContent as
					| { error?: { code?: string } }
					| undefined
			)?.error?.code,
			"invalid_arguments",
		);

		const switchedToFailingBranch = await client.callTool({
			name: "switch_branch",
			arguments: { workspace_ref: WORKSPACE_ID, branch_id: THROW_BRANCH_ID },
		});
		assert.equal(switchedToFailingBranch.isError, undefined);
		assert.deepEqual(switchedToFailingBranch.structuredContent, {
			branch_id: THROW_BRANCH_ID,
		});

		const internalFailure = await client.callTool({
			name: "execute",
			arguments: {
				workspace_ref: WORKSPACE_ID,
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
			observations.map(
				({
					durationMs,
					surfaceVersion,
					executeInput,
					executeOutput,
					...observation
				}) => {
					assert.ok(Number.isInteger(durationMs));
					assert.ok(durationMs >= 0);
					assert.match(surfaceVersion, /^fnv1a32:[0-9a-f]{8}$/);
					return {
						...observation,
						...(executeInput
							? { statementCount: executeInput.statementCount }
							: {}),
						...(executeOutput
							? { resultCount: executeOutput.resultCount }
							: {}),
					};
				},
			),
			[
				{ toolName: "list_workspaces", outcome: "success" },
				{
					toolName: "active_branch_id",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "switch_branch",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "active_branch_id",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "execute",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
					statementCount: 1,
					resultCount: 1,
				},
				{
					toolName: "execute",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
					statementCount: 2,
					resultCount: 2,
				},
				{
					toolName: "execute",
					outcome: "error",
					errorCode: "invalid_arguments",
					statementCount: 1,
				},
				{
					toolName: "execute",
					outcome: "error",
					errorCode: "invalid_arguments",
					statementCount: 1,
				},
				{
					toolName: "switch_branch",
					outcome: "success",
					workspaceId: WORKSPACE_ID,
				},
				{
					toolName: "execute",
					outcome: "error",
					errorCode: "internal_error",
					workspaceId: WORKSPACE_ID,
					statementCount: 1,
				},
				{
					toolName: "unknown",
					outcome: "error",
					errorCode: "unknown_tool",
				},
			],
		);
		assert.doesNotMatch(JSON.stringify(observations), /"example"|"result"/);
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
		assert.equal(rawTools.length, 4);
		for (const tool of rawTools) {
			assert.deepEqual(tool.securitySchemes, [{ type: "noauth" }]);
		}
	} finally {
		await client.close();
		await server.close();
	}
});

class ProtocolLixRuntimeClient implements LixRuntimeClient {
	private currentBranchId = BRANCH_ID;
	readonly executeRequests: Array<{
		workspaceId: string;
		request: ExecuteRequest;
	}> = [];
	readonly executeActiveBranchIds: Array<string> = [];

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

	async activeBranchId() {
		return this.currentBranchId;
	}

	async switchBranch(_workspaceId: string, branchId: string) {
		this.currentBranchId = branchId;
		return { branchId };
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		if (this.currentBranchId === THROW_BRANCH_ID) {
			throw new Error("Unexpected runtime failure");
		}
		this.executeActiveBranchIds.push(this.currentBranchId);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
