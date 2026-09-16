import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openLix } from "@lix-js/sdk";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Transport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WorkerLixRuntimeClient } from "../src/mcp/runtime-client.ts";
import { LixService } from "../src/mcp/lix-service.ts";
import { DIFF_CARD_META, DIFF_CARD_URI } from "../src/mcp/diff-card-app.ts";
import { handleMcpTransport, MCP_PROTOCOL_VERSION } from "../src/mcp/server.ts";
const out = new URL("../../artifacts/mcp-ui-fix/", import.meta.url);
await mkdir(out, { recursive: true });
const markdown =
	"# MCP UI demo\n\n## Markdown features\n\n- First item\n- Second item\n\n| Feature | Status |\n| --- | --- |\n| Markdown | Rendered |\n\n- [x] Written\n- [ ] Review card\n";
await writeFile(new URL("input.md", out), markdown);
const results = [];
for (const version of ["v2", "v1"]) {
	const lix = await openLix();
	const id = "11111111-1111-4111-8111-111111111111";
	const runtime = new WorkerLixRuntimeClient(
		{},
		{ userId: "local-repro", token: "local-only" },
		async () => null,
		{
			lixSummaries: [
				{
					id,
					name: "demo",
					slug: "demo",
					namespace: { id, name: "opral", handle: "opral" },
				},
			],
		},
	);
	runtime.sessions.set(
		id,
		Promise.resolve({
			lix,
			queue: Promise.resolve(),
			defaultBranchId: await lix.activeBranchId(),
		}),
	);
	const service = new LixService(runtime, {
		contextSigningKey: "local-repro-only",
		principal: { userId: "local-repro", clientId: version },
	});
	const responses = [];
	const fetcher = async (input, init) => {
		const response = await handleMcpTransport(
			new Request(input, init),
			service,
			{ authMode: "none", urlOrigin: "https://local.lixray.invalid" },
		);
		responses.push({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.clone().text(),
		});
		return response;
	};
	const client =
		version === "v2"
			? new Client(
					{ name: "ui-repro", version: "1" },
					{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
				)
			: new V1Client({ name: "ui-repro", version: "1" });
	const transport =
		version === "v2"
			? new StreamableHTTPClientTransport(
					new URL("https://local.lixray.invalid/mcp"),
					{ fetch: fetcher },
				)
			: new V1Transport(new URL("https://local.lixray.invalid/mcp"), {
					fetch: fetcher,
				});
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		const tool = tools.tools.find((t) => t.name === "write_files");
		const opened = await client.callTool({
			name: "query_sql",
			arguments: { lix_ref: "@opral/demo", sql: "SELECT 1 AS ready" },
		});
		assert.equal(opened.isError, void 0, JSON.stringify(opened));
		const context = opened.structuredContent.context;
		const written = await client.callTool({
			name: "write_files",
			arguments: {
				context,
				files: [{ path: "/mcp-ui-demo.md", content: markdown }],
			},
		});
		await writeFile(
			new URL(`${version}-write.json`, out),
			JSON.stringify(written, null, 2),
		);
		assert.equal(written.isError, void 0, JSON.stringify(written));
		assert.ok(written.content.every((x) => x.type !== "resource"));
		const card = written._meta[DIFF_CARD_META];
		assert.equal(card.files.length, 1);
		const html = card.files[0].html;
		for (const pattern of [
			/<h1\b/,
			/<h2\b/,
			/<ul\b/,
			/<table\b/,
			/<li[^>]*data-task="x"/,
		])
			assert.match(html, pattern);
		await writeFile(new URL(`${version}-card.html`, out), html);
		const readback = await client.callTool({
			name: "query_sql",
			arguments: {
				context,
				sql: "SELECT content FROM lix_file WHERE path = $1",
				params: [{ kind: "text", value: "/mcp-ui-demo.md" }],
			},
		});
		assert.equal(readback.isError, void 0, JSON.stringify(readback));
		const cell = readback.structuredContent.result.rows[0][0];
		assert.equal(cell.kind, "blob");
		assert.equal(Buffer.from(cell.base64, "base64").toString("utf8"), markdown);
		const db = await lix.execute(
			"SELECT content FROM lix_file WHERE path = $1",
			["/mcp-ui-demo.md"],
		);
		assert.equal(new TextDecoder().decode(db.rows[0].content), markdown);
		await writeFile(
			new URL(`${version}-readback.json`, out),
			JSON.stringify(readback, null, 2),
		);
		let resourceResult;
		try {
			const resource = await client.readResource({ uri: DIFF_CARD_URI });
			assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
			await writeFile(
				new URL(`${version}-app.html`, out),
				resource.contents[0].text,
			);
			resourceResult = {
				status: "success",
				mimeType: resource.contents[0].mimeType,
			};
		} catch (error) {
			resourceResult = String(error);
		}
		results.push({
			version,
			write: "success",
			byteExactReadback: true,
			contentTypes: written.content.map((x) => x.type),
			htmlBytes: Buffer.byteLength(html),
			toolMetadata: tool._meta,
			readResource: resourceResult,
		});
	} catch (error) {
		results.push({ version, error: String(error), stack: error.stack });
	} finally {
		await client.close();
		await runtime.close();
		await writeFile(
			new URL(`${version}-transport.json`, out),
			JSON.stringify(responses, null, 2),
		);
	}
}
await writeFile(new URL("summary.json", out), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => "error" in r)) process.exitCode = 1;
