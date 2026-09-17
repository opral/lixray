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
import { DIFF_CARD_META } from "../../src/mcp/diff-card-app.ts";
import { diffCardPayload } from "../../src/mcp/diff-card.ts";
/**
 * The resource as a host gets it: read over the wire, with the official
 * AppBridge bundled to drive it. Both are the same for every test.
 */
let served;
async function serveResource() {
	if (served) return served;
	served = (async () => {
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
		try {
			const tools = await client.listTools();
			const uri = tools.tools.find((tool) => tool.name === "write_files")?._meta
				?.ui?.resourceUri;
			assert.ok(uri);
			const resource = await client.readResource({ uri });
			const bundle = await build({
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
			return {
				html: resource.contents[0].text,
				host: bundle.outputFiles[0].text,
			};
		} finally {
			await client.close();
		}
	})();
	return served;
}

/** A host page with the resource in its frame, in the scheme it asks for. */
async function openHost(browser, options = {}) {
	const { html, host } = await serveResource();
	const page = await browser.newPage({
		viewport: { width: 800, height: 800 },
		...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
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
			return route.fulfill({ contentType: "text/javascript", body: host });
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
	return { page, pageErrors, requests };
}

/** The demo document, and the card one write of it sends back. */
const DEMO_URL = "https://lixray.com/@opral/demo/file/id/mcp-ui-demo.md";
const DEMO_MARKDOWN =
	"# MCP UI demo\n\n## Features\n\n- One\n- Two\n\n| Feature | Status |\n| --- | --- |\n| Markdown | Ready |\n\n- [x] Saved\n- [ ] Review\n\n![external](https://unexpected.invalid/image.png)\n\n<script>window.pwned=true</script>\n";

function demoReceipt(changes) {
	const card = diffCardPayload({
		verb: "written",
		repository: "@opral/demo",
		changes,
	});
	assert.ok(card);
	return {
		content: [{ type: "text", text: "Wrote mcp-ui-demo.md" }],
		structuredContent: { commit_id: "saved-commit" },
		_meta: { [DIFF_CARD_META]: card },
	};
}

void test("MCP Apps resource initializes, renders, opens links and tears down with the official AppBridge", async () => {
	const browser = await chromium.launch();
	try {
		const { page, pageErrors, requests } = await openHost(browser);
		const receipt = demoReceipt([
			{
				path: "/mcp-ui-demo.md",
				url: DEMO_URL,
				after: new TextEncoder().encode(DEMO_MARKDOWN),
			},
		]);
		await page.evaluate(
			(receipt2) => window.bridge.sendToolResult(receipt2),
			receipt,
		);
		const view = page.frameLocator("iframe");
		// Collapsed by default: one 44px bar, which the reader opens.
		await view.getByRole("button", { name: /1 file written/ }).waitFor();
		assert.equal(await page.evaluate(() => window.heights.at(-1)), 44);
		await view.getByRole("button", { name: /1 file written/ }).click();
		await view.locator("h1").waitFor();
		assert.equal(await view.locator("h1").innerText(), "MCP UI demo");
		assert.equal(await view.locator("h2").count(), 1);
		assert.equal(await view.locator("table").count(), 1);
		assert.equal(await view.locator("li[data-task]").count(), 2);
		await view.getByRole("button", { name: "Open in LixRay" }).click();
		await page.waitForFunction(() => !!window.openedUrl);
		assert.equal(await page.evaluate(() => window.openedUrl), DEMO_URL);
		assert.deepEqual(pageErrors, []);
		assert.deepEqual(await page.evaluate(() => window.errors), []);
		assert.deepEqual(requests.sort(), ["/", "/app.html", "/host.js"]);
		// Open, the card is one height whatever it carries, and it says so
		// on its own document too, for a host that measures the frame.
		assert.equal(await page.evaluate(() => window.heights.at(-1)), 480);
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
		assert.equal(await view.locator("#card:not([hidden])").count(), 0);
		await page.evaluate(() =>
			window.bridge.sendToolResult({
				isError: true,
				content: [{ type: "text", text: "Write conflict" }],
			}),
		);
		await view.getByText("Write conflict").waitFor();
		assert.equal(await view.locator("#card:not([hidden])").count(), 0);
		await page.evaluate(() => window.bridge.teardownResource({}));
	} finally {
		await browser.close();
	}
});

void test("the head follows the chat, the file keeps Atelier's light scheme, and the pill keeps its own tones", async () => {
	const browser = await chromium.launch();
	try {
		const receipt = demoReceipt([
			{
				path: "/mcp-ui-demo.md",
				url: DEMO_URL,
				after: new TextEncoder().encode(DEMO_MARKDOWN),
			},
		]);
		const read = async (colorScheme) => {
			const { page } = await openHost(browser, { colorScheme });
			await page.evaluate(
				(receipt2) => window.bridge.sendToolResult(receipt2),
				receipt,
			);
			const view = page.frameLocator("iframe");
			await view.getByRole("button", { name: /1 file written/ }).waitFor();
			const frame = page
				.frames()
				.find((each) => each.url().endsWith("/app.html"));
			// Closed, the document is the bar and nothing else: a host that
			// sizes the frame from it leaves no strip of its own below.
			const closed = await frame.evaluate(
				() => document.documentElement.getBoundingClientRect().height,
			);
			await view.getByRole("button", { name: /1 file written/ }).click();
			await view.locator("h1").waitFor();
			const measured = await frame.evaluate(() => {
				const style = (element) => getComputedStyle(element);
				const preview = document
					.getElementById("panel")
					.shadowRoot.querySelector(".preview");
				return {
					open: document.documentElement.getBoundingClientRect().height,
					card: style(document.getElementById("card")).backgroundColor,
					body: style(document.getElementById("details")).backgroundColor,
					scheme: style(document.getElementById("panel")).colorScheme,
					document: style(preview).color,
					word: style(document.querySelector("#label .word")).color,
				};
			});
			// Both schemes, side by side, when someone is looking at them:
			// MCP_UI_SCREENSHOT_DIR=/tmp/cards pnpm test:mcp-ui
			if (process.env.MCP_UI_SCREENSHOT_DIR)
				await page.screenshot({
					path: `${process.env.MCP_UI_SCREENSHOT_DIR}/card-${colorScheme}.png`,
					fullPage: true,
				});
			// The toggle in the foot reads the file in the other scheme, the
			// preview inside the shadow root with it — and leaves the head
			// with the chat.
			await view.locator("#scheme").click();
			const flipped = await frame.evaluate(() => {
				const preview = document
					.getElementById("panel")
					.shadowRoot.querySelector(".preview");
				return {
					card: getComputedStyle(document.getElementById("card"))
						.backgroundColor,
					body: getComputedStyle(document.getElementById("details"))
						.backgroundColor,
					document: getComputedStyle(preview).color,
					label: document.getElementById("scheme").getAttribute("aria-label"),
				};
			});
			// The same pill, for a file that was edited rather than created.
			await page.evaluate(
				(receipt2) => window.bridge.sendToolResult(receipt2),
				demoReceipt([
					{
						path: "/mcp-ui-demo.md",
						url: DEMO_URL,
						before: new TextEncoder().encode("# MCP UI demo\n"),
						after: new TextEncoder().encode(DEMO_MARKDOWN),
					},
				]),
			);
			await view
				.locator("#label .word", { hasText: "edited" })
				.waitFor({ state: "attached" });
			const edited = await frame.evaluate(
				() => getComputedStyle(document.querySelector("#label .word")).color,
			);
			await page.close();
			return { closed, edited, flipped, ...measured };
		};
		const dark = await read("dark");
		const light = await read("light");
		assert.equal(dark.closed, 44);
		assert.equal(light.closed, 44);
		assert.equal(dark.open, 480);
		assert.equal(light.open, 480);
		// The head is chrome and follows the chat, so a closed card reads as
		// one more line of it; below the head the card is Atelier, and
		// Atelier is light, in either chat.
		assert.equal(dark.card, "rgb(28, 25, 23)");
		assert.equal(light.card, "rgb(255, 255, 255)");
		assert.equal(dark.body, "rgb(255, 255, 255)");
		assert.equal(light.body, "rgb(255, 255, 255)");
		assert.equal(dark.document, "rgb(28, 25, 23)");
		assert.equal(light.document, "rgb(28, 25, 23)");
		// The preview takes that from the body — the flip below is the proof
		// that it inherits rather than pinning a scheme of its own.
		assert.equal(dark.scheme, "light");
		assert.equal(light.scheme, "light");
		// The pill is dark chrome in either scheme, and "new" is green on it
		// in both: the page's scheme is the wrong question there.
		assert.equal(dark.word, "rgb(134, 239, 172)");
		assert.equal(light.word, "rgb(134, 239, 172)");
		// And "edited" is the diff palette's orange, never the old yellow.
		assert.equal(dark.edited, "rgb(253, 186, 116)");
		assert.equal(light.edited, "rgb(253, 186, 116)");
		// A reader who wants the dark one takes it, in either chat, and the
		// head stays where it was.
		for (const flipped of [dark.flipped, light.flipped]) {
			assert.equal(flipped.body, "rgb(28, 25, 23)");
			assert.equal(flipped.document, "rgb(245, 242, 237)");
			assert.equal(flipped.label, "Read this file in the light scheme");
		}
		assert.equal(dark.flipped.card, dark.card);
		assert.equal(light.flipped.card, light.card);
	} finally {
		await browser.close();
	}
});
