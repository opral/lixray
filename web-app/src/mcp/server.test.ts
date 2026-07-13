import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
	LixFileService,
	type ExecuteRequest,
	type ExecuteResponse,
	type FileServiceBackend,
} from "./file-service.ts";
import {
	MCP_AUTHORIZATION_SERVER,
	MCP_PROTECTED_RESOURCE_URL,
	MCP_RESOURCE,
	createLixrayMcpServer,
	mcpAuthenticateChallenge,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	protectedResourceMetadataResponse,
} from "./server.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

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
});

void test("MCP initialize, tools/list, and tools/call expose the authenticated tool contract", async () => {
	const backend = new ProtocolBackend();
	const service = new LixFileService(backend);
	const server = createLixrayMcpServer(service);
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
		assert.equal(executeTool?.annotations?.readOnlyHint, false);
		assert.equal(executeTool?.annotations?.destructiveHint, true);
		assert.equal(executeTool?.annotations?.idempotentHint, false);

		const rawTools = findRawTools(rawMessages);
		assert.equal(rawTools.length, 11);
		for (const tool of rawTools) {
			assert.deepEqual(tool.securitySchemes, [
				{ type: "oauth2", scopes: ["openid", "email", "profile"] },
			]);
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
					organization: { id: "org-1", name: "Example" },
				},
			],
		});

		const executed = await client.callTool({
			name: "execute",
			arguments: {
				workspace_id: WORKSPACE_ID,
				branch_id: "main",
				sql: "SELECT value FROM lix_key_value WHERE key = $1",
				params: [{ kind: "text", value: "example" }],
			},
		});
		assert.equal(executed.isError, undefined);
		assert.deepEqual(executed.structuredContent, {
			columns: ["value"],
			rows: [[{ kind: "text", value: "result" }]],
			rowsAffected: 0,
			notices: [],
		});
		assert.deepEqual(backend.executeRequests, [
			{
				workspaceId: WORKSPACE_ID,
				request: {
					branchId: "main",
					sql: "SELECT value FROM lix_key_value WHERE key = $1",
					params: [{ kind: "text", value: "example" }],
				},
			},
		]);

		const invalidRead = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_id: WORKSPACE_ID,
				branch_id: "main",
				path: "/../secret.txt",
			},
		});
		assert.equal(invalidRead.isError, true);
		assert.equal(
			(
				invalidRead.structuredContent as
					{ error?: { code?: string } } | undefined
			)?.error?.code,
			"invalid_path",
		);
	} finally {
		await client.close();
		await server.close();
	}
});

void test("authless MCP tools advertise noauth security", async () => {
	const server = createLixrayMcpServer(
		new LixFileService(new ProtocolBackend()),
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

class ProtocolBackend implements FileServiceBackend {
	readonly executeRequests: Array<{
		workspaceId: string;
		request: ExecuteRequest;
	}> = [];

	async listWorkspaces() {
		return [
			{
				id: WORKSPACE_ID,
				name: "Personal",
				organization: { id: "org-1", name: "Example" },
			},
		];
	}

	async listBranches() {
		return [{ id: "main", name: "main", hidden: false, commitId: "commit-1" }];
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		this.executeRequests.push({ workspaceId, request });
		return {
			columns: ["value"],
			rows: [[{ kind: "text", value: "result" }]],
			rowsAffected: 0,
			notices: [],
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
