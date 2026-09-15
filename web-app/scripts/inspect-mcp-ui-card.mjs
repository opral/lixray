import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const out = new URL("../../artifacts/mcp-ui-fix/", import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({
		viewport: { width: 800, height: 750 },
		deviceScaleFactor: 1,
	});
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(new URL("v2-card.html", out).href);
	const counts = {
		h1: await page.locator("h1").count(),
		h2: await page.locator("h2").count(),
		table: await page.locator("table").count(),
		checkboxes: await page.locator("li[data-task]").count(),
	};
	assert.equal(counts.h1, 1);
	assert.equal(counts.h2, 1);
	assert.equal(counts.table, 1);
	assert.equal(counts.checkboxes, 2);
	assert.deepEqual(errors, []);
	await page.screenshot({
		path: new URL("card.png", out).pathname,
		fullPage: true,
	});
	await writeFile(
		new URL("browser.json", out),
		JSON.stringify({ counts, errors, browser: browser.version() }, null, 2),
	);
	console.log(counts);
} finally {
	await browser.close();
}
