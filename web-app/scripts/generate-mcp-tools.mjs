import { readFile, writeFile } from "node:fs/promises";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { format } from "oxfmt";
import { LixService } from "../src/mcp/lix-service.ts";
import { handleMcpTransport, MCP_PROTOCOL_VERSION } from "../src/mcp/server.ts";

const unusedRuntimeClient = new Proxy(
	{},
	{
		get: (_target, property) => () => {
			throw new Error(
				`tools/list unexpectedly invoked runtime method ${String(property)}`,
			);
		},
	},
);
const service = new LixService(unusedRuntimeClient);
const fetcher = (input, init) =>
	handleMcpTransport(new Request(input, init), service, {
		authMode: "none",
		serverName: "LixRay_Tools",
	});
const transport = new StreamableHTTPClientTransport(
	new URL("https://lixray.test/mcp"),
	{ fetch: fetcher },
);
const client = new Client(
	{ name: "lixray-mcp-tools-generator", version: "1.0.0" },
	{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
);

try {
	await client.connect(transport);
	const response = await client.listTools();
	const formatOptions = JSON.parse(
		await readFile(new URL("../.oxfmtrc.json", import.meta.url), "utf8"),
	);
	delete formatOptions.$schema;
	const formatted = await format(
		"mcp-tools.json",
		`${JSON.stringify(response.tools, null, "\t")}\n`,
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
}
