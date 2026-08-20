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

void test("Railway start warms persisted JWKS before accepting traffic", async () => {
	const source = await readFile(
		new URL("./start-railway.mjs", import.meta.url),
		"utf8",
	);
	assert.match(source, /app\.warmJwtVerifier/);
	assert.match(source, /LIXRAY_JWKS_CACHE_PATH/);
	assert.ok(
		source.indexOf("warmJwtVerifier") < source.indexOf("server.listen"),
		"JWKS warmup must finish before the HTTP server listens",
	);
});
