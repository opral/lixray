import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { format } from "oxfmt";
import { LixFileService } from "../src/mcp/file-service.ts";
import { createLixrayMcpServer } from "../src/mcp/server.ts";

const unusedRuntimeClient = new Proxy(
	{},
	{
		get: (target, property) => () => {
			void target;
			throw new Error(
				`tools/list unexpectedly invoked runtime method ${String(property)}`,
			);
		},
	},
);
const server = createLixrayMcpServer(new LixFileService(unusedRuntimeClient));
const client = new Client({
	name: "lixray-mcp-tools-generator",
	version: "1.0.0",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const rawMessages = [];
const send = serverTransport.send.bind(serverTransport);
serverTransport.send = async (message, options) => {
	rawMessages.push(structuredClone(message));
	await send(message, options);
};

try {
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	await client.listTools();

	const response = rawMessages.find(isToolsListResponse);
	if (!response) {
		throw new Error("MCP server did not return a tools/list response");
	}

	const formatOptions = JSON.parse(
		await readFile(new URL("../.oxfmtrc.json", import.meta.url), "utf8"),
	);
	delete formatOptions.$schema;
	const formatted = await format(
		"mcp-tools.json",
		`${JSON.stringify(response.result.tools, null, "\t")}\n`,
		formatOptions,
	);
	if (formatted.errors.length > 0) {
		throw new Error(
			`Failed to format tools/list output: ${JSON.stringify(formatted.errors)}`,
		);
	}
	await writeFile(
		new URL("../mcp-tools.json", import.meta.url),
		formatted.code,
	);
} finally {
	await client.close();
	await server.close();
}

function isToolsListResponse(message) {
	return (
		"result" in message &&
		message.result &&
		typeof message.result === "object" &&
		"tools" in message.result &&
		Array.isArray(message.result.tools)
	);
}
