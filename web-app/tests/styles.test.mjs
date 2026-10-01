import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, loadConfigFromFile } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const command of ["serve", "build"]) {
	test(`LixRay ${command} CSS generates one responsive utility sheet`, async () => {
		const { config } = await loadConfigFromFile(
			{ command, mode: "development" },
			path.join(root, "vite.config.ts"),
		);
		const result = await build({
			configFile: false,
			root,
			logLevel: "error",
			resolve: config.resolve,
			plugins: [tailwindcss()],
			build: {
				cssTarget: config.build.cssTarget,
				write: false,
				rollupOptions: { input: path.join(root, "src/styles.css") },
			},
		});
		const css = result.output.find(
			(item) => item.type === "asset" && item.fileName.endsWith(".css"),
		).source;
		assert.equal([...css.matchAll(/(?:^|})\.flex\{/g)].length, 1);
		assert.ok(css.includes(".bg-panel"), "missing bg-panel utility");
		assert.ok(css.includes(".animate-in"), "missing animation utility");
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(`<style>${css}</style>
<div id="rail" class="flex sm:hidden">Phone rail</div>
<div id="grid" class="grid grid-cols-1 sm:grid-cols-2">Comparison</div>
<div class="atelier-root"><button id="control" class="border bg-panel">Atelier</button></div>`);
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
		} finally {
			await browser.close();
		}
	});
}
