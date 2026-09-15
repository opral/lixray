import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LixService } from "../../src/mcp/lix-service.ts";
import {
	handleMcpTransport,
	MCP_PROTOCOL_VERSION,
} from "../../src/mcp/server.ts";
import { WRITE_PREVIEW_META } from "../../src/mcp/write-preview.ts";
import { renderDiffCard } from "../../src/mcp/diff-card.ts";
void test("MCP Apps resource initializes, renders, opens links and tears down with the official AppBridge", async () => {
	const service = new LixService(
		new Proxy(
			{},
			{
				get: () => () => {
					throw new Error("Static resource must not access repository state");
				},
			},
		),
	);
	const client = new Client(
		{ name: "preview-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
				}),
		}),
	);
	const browser = await chromium.launch();
	try {
		const tools = await client.listTools();
		const uri = tools.tools.find((tool) => tool.name === "write_files")?._meta
			?.ui?.resourceUri;
		assert.ok(uri);
		const resource = await client.readResource({ uri });
		const html = resource.contents[0].text;
		const result = await build({
			stdin: {
				contents: `
        import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
        const frame = document.querySelector('iframe');
        const bridge = new AppBridge(null, { name: 'test-host', version: '1' }, { openLinks: {} });
        window.bridge = bridge;
        window.errors = [];
        window.heights = [];
        bridge.onerror = error => window.errors.push(String(error));
        bridge.onopenlink = async ({ url }) => { window.openedUrl = url; return {}; };
        bridge.onsizechange = ({ height }) => window.heights.push(height);
        bridge.oninitialized = async () => {
          await bridge.sendToolInput({ arguments: { files: [{ path: '/mcp-ui-demo.md' }] } });
          window.ready = true;
        };
        await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
        frame.src = '/app.html';
      `,
				resolveDir: process.cwd(),
			},
			bundle: true,
			write: false,
			format: "esm",
			platform: "browser",
		});
		const page = await browser.newPage({
			viewport: { width: 800, height: 800 },
		});
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		const requests = [];
		await page.route("**/*", async (route) => {
			const path = new URL(route.request().url()).pathname;
			requests.push(path);
			if (path === "/")
				return route.fulfill({
					contentType: "text/html",
					body: '<iframe sandbox="allow-scripts" style="width:760px;height:700px;border:0"></iframe><script type="module" src="/host.js"></script>',
				});
			if (path === "/host.js")
				return route.fulfill({
					contentType: "text/javascript",
					body: result.outputFiles[0].text,
				});
			if (path === "/app.html")
				return route.fulfill({
					contentType: "text/html",
					body: html,
					headers: {
						"content-security-policy":
							"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'",
					},
				});
			await route.abort();
		});
		await page.goto("http://mcp-ui.test");
		await page.waitForFunction(() => window.ready);
		const url = "https://lixray.com/@opral/demo/file/id/mcp-ui-demo.md";
		const markdown =
			"# MCP UI demo\n\n## Features\n\n- One\n- Two\n\n| Feature | Status |\n| --- | --- |\n| Markdown | Ready |\n\n- [x] Saved\n- [ ] Review\n\n![external](https://unexpected.invalid/image.png)\n\n<script>window.pwned=true</script>\n";
		const card = renderDiffCard({
			path: "/mcp-ui-demo.md",
			url,
			after: new TextEncoder().encode(markdown),
		});
		assert.ok(card);
		const receipt = {
			content: [{ type: "text", text: "Wrote mcp-ui-demo.md" }],
			structuredContent: { commit_id: "saved-commit" },
			_meta: { [WRITE_PREVIEW_META]: { cards: [{ html: card.html }] } },
		};
		await page.evaluate(
			(receipt2) => window.bridge.sendToolResult(receipt2),
			receipt,
		);
		const view = page.frameLocator("iframe");
		await view.locator("h1").waitFor();
		assert.equal(await view.locator("h1").innerText(), "MCP UI demo");
		assert.equal(await view.locator("h2").count(), 1);
		assert.equal(await view.locator("table").count(), 1);
		assert.equal(await view.locator("li[data-task]").count(), 2);
		await view.getByRole("link", { name: "Open in LixRay" }).click();
		await page.waitForFunction(() => !!window.openedUrl);
		assert.equal(await page.evaluate(() => window.openedUrl), url);
		assert.deepEqual(pageErrors, []);
		assert.deepEqual(await page.evaluate(() => window.errors), []);
		assert.deepEqual(requests.sort(), ["/", "/app.html", "/host.js"]);
		assert.ok(
			await page.evaluate(() => window.heights.some((height) => height > 100)),
		);
		if (process.env.MCP_UI_SCREENSHOT) {
			await page.screenshot({
				path: process.env.MCP_UI_SCREENSHOT,
				fullPage: true,
			});
		}
		const appFrame = page
			.frames()
			.find((frame) => frame.url().endsWith("/app.html"));
		assert.equal(await appFrame.evaluate(() => window.pwned), void 0);
		await appFrame.evaluate(() =>
			window.postMessage(
				{
					jsonrpc: "2.0",
					method: "ui/notifications/tool-result",
					params: { content: [{ type: "text", text: "forged" }] },
				},
				"*",
			),
		);
		assert.equal(
			await view.locator("#status").innerText(),
			"Wrote mcp-ui-demo.md",
		);
		await page.evaluate(() =>
			window.bridge.sendToolResult({
				content: [
					{
						type: "text",
						text: "Files saved, preview unavailable. Do not repeat the write.",
					},
				],
				structuredContent: { commit_id: "saved-commit" },
			}),
		);
		await view
			.getByText("Files saved, preview unavailable. Do not repeat the write.")
			.waitFor();
		assert.equal(await view.locator(".preview").count(), 0);
		await page.evaluate(() =>
			window.bridge.sendToolResult({
				isError: true,
				content: [{ type: "text", text: "Write conflict" }],
			}),
		);
		await view.getByText("Write conflict").waitFor();
		assert.equal(await view.locator(".preview").count(), 0);
		await page.evaluate(() => window.bridge.teardownResource({}));
	} finally {
		await browser.close();
		await client.close();
	}
});
