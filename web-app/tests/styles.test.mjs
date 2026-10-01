import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, createServer, loadConfigFromFile } from "vite";
import { privateTailwind } from "../../vendor/atelier/scripts/private-tailwind.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const library = path.resolve(root, "../vendor/atelier");

async function compile(entry, config, plugins) {
	const result = await build({
		configFile: false,
		root,
		logLevel: "error",
		resolve: config.resolve,
		plugins,
		build: {
			cssTarget: config.build.cssTarget,
			write: false,
			rollupOptions: { input: entry },
		},
	});
	return result.output.find(
		(item) => item.type === "asset" && item.fileName.endsWith(".css"),
	).source;
}

for (const command of ["serve", "build"]) {
	test(`LixRay ${command} CSS keeps the complete Atelier stylesheet isolated`, async () => {
		const { config } = await loadConfigFromFile(
			{ command, mode: "development" },
			path.join(root, "vite.config.ts"),
		);
		const host = await compile(path.join(root, "src/styles.css"), config, [
			tailwindcss(),
		]);
		const entry = path.join(
			library,
			command === "serve" ? "src/index.css" : "dist/atelier.css",
		);
		const css = await compile(entry, config, [
			tailwindcss(),
			privateTailwind(),
		]);
		assert.equal([...host.matchAll(/(?:^|})\.flex\{/g)].length, 1);
		assert.ok(host.includes(".bg-panel"), "missing host bg-panel utility");
		assert.ok(!host.includes(".atw\\:"), "host generated library utilities");
		assert.ok(css.includes(".atw\\:flex"), "missing private library utility");
		assert.ok(
			css.includes("--atw-tw-enter-opacity"),
			"missing private animation properties",
		);
		assert.ok(
			!css.includes("--tw-"),
			"library shares host implementation properties",
		);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			for (const sheets of [
				[host, css],
				[css, host],
			]) {
				await page.setContent(`<style>${sheets.join("\n")}</style>
<div id="rail" class="flex sm:hidden">Phone rail</div>
<div id="grid" class="grid grid-cols-1 sm:grid-cols-2">Comparison</div>
<div class="atelier-root"><button id="control" class="atw:border atw:bg-panel">Atelier</button></div>`);
				for (const [width, hidden, columns] of [
					[390, false, 1],
					[1440, true, 2],
				]) {
					await page.setViewportSize({ width, height: 900 });

					assert.equal(
						await page
							.locator("#rail")
							.evaluate((node) => getComputedStyle(node).display),
						hidden ? "none" : "flex",
					);
					assert.equal(
						await page
							.locator("#grid")
							.evaluate(
								(node) =>
									getComputedStyle(node).gridTemplateColumns.split(" ").length,
							),
						columns,
					);
					assert.equal(
						await page
							.locator("#control")
							.evaluate((node) => getComputedStyle(node).backgroundColor),
						"rgb(255, 255, 255)",
					);
					assert.equal(
						await page
							.locator("#control")
							.evaluate((node) => getComputedStyle(node).borderTopWidth),
						"1px",
					);
				}
			}
		} finally {
			await browser.close();
		}
	});
}

// Exercise the actual ?url development resolver and transform pipeline.
test("the development URL alias serves isolated library CSS", async () => {
	const { config } = await loadConfigFromFile(
		{ command: "serve", mode: "development" },
		path.join(root, "vite.config.ts"),
	);
	const server = await createServer({
		configFile: false,
		root,
		logLevel: "error",
		resolve: config.resolve,
		plugins: [tailwindcss(), privateTailwind()],
		optimizeDeps: { noDiscovery: true, include: [] },
		server: { middlewareMode: true, fs: { allow: [path.resolve(root, "..")] } },
	});
	try {
		const resolved = await server.pluginContainer.resolveId(
			"@opral/atelier/style.css?url",
			path.join(root, "src/routes/__root.tsx"),
		);
		assert.equal(resolved.id, path.join(library, "src/index.css") + "?url");
		const transformed = await server.transformRequest(
			"/@fs/" + path.join(library, "src/index.css") + "?direct",
		);
		assert.ok(transformed.code.includes(".atw\\:flex"));
		assert.ok(transformed.code.includes("--atw-tw-enter-opacity"));
		assert.ok(!transformed.code.includes("--tw-"));
		assert.ok(
			transformed.code.includes(".atelier-render"),
			"source stylesheet is missing static chrome",
		);
	} finally {
		await server.close();
	}
});
