import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const railwayEntrypoint = new URL("../src/railway-server.ts", import.meta.url);

void test("the Railway entrypoint does not load the Node SQL parser or WASM", async () => {
	const source = await readFile(railwayEntrypoint, "utf8");

	assert.doesNotMatch(
		source,
		/node-lix-sql-parser|lix_js_sdk_bg\.wasm|parseSqlScript|initSync/,
	);
	assert.doesNotMatch(source, /cloudflare|workerd|wrangler/i);
	assert.doesNotMatch(source, /import\.meta\.env\.DEV/);
});
