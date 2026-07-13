import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mcpUrl = new URL(process.env.LIXRAY_MCP_URL ?? "https://lixray.com/mcp");
const accessToken = process.env.LIXRAY_MCP_ACCESS_TOKEN;

if (!accessToken) {
	throw new Error(
		"LIXRAY_MCP_ACCESS_TOKEN is required. Supply a temporary OAuth access token without writing it to a file.",
	);
}

const resourceMetadataUrl = new URL(
	"/.well-known/oauth-protected-resource",
	mcpUrl,
);
const resourceResponse = await fetch(resourceMetadataUrl);
assert.equal(
	resourceResponse.status,
	200,
	"protected-resource discovery failed",
);
const resource = await resourceResponse.json();
assert.equal(resource.resource, "https://lixray.com");
assert.ok(Array.isArray(resource.authorization_servers));
assert.ok(resource.authorization_servers.length > 0);

for (const issuer of resource.authorization_servers) {
	const metadataUrl = new URL(issuer);
	metadataUrl.pathname = `${metadataUrl.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
	const response = await fetch(metadataUrl);
	assert.equal(response.status, 200, `OAuth discovery failed for ${issuer}`);
	const metadata = await response.json();
	assert.ok(
		metadata.grant_types_supported?.includes("authorization_code"),
		"authorization server does not advertise authorization_code",
	);
	assert.ok(
		metadata.grant_types_supported?.includes("refresh_token"),
		"authorization server does not advertise refresh_token",
	);
}

const client = new Client({
	name: "lixray-connection-check",
	version: "1.0.0",
});
const transport = new StreamableHTTPClientTransport(mcpUrl, {
	requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
});

try {
	await client.connect(transport);
	const { tools } = await client.listTools();
	assert.ok(
		tools.some((tool) => tool.name === "list_workspaces"),
		"tools/list did not include list_workspaces",
	);
	const result = await client.callTool({
		name: "list_workspaces",
		arguments: {},
	});
	assert.notEqual(
		result.isError,
		true,
		"list_workspaces returned an MCP error",
	);
	const workspaceCount = Array.isArray(result.structuredContent?.workspaces)
		? result.structuredContent.workspaces.length
		: undefined;
	process.stdout.write(
		`${JSON.stringify({ ok: true, server: mcpUrl.origin, toolCount: tools.length, workspaceCount }, null, 2)}\n`,
	);
} finally {
	await client.close();
}
