import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const railwayEntrypoint = new URL("../src/railway-server.ts", import.meta.url);
const wasmForbidden =
	/node-lix-sql-parser|lix_js_sdk_bg\.wasm|parseSqlScript|initSync|@lix-js\/sdk|openLix/;

void test("the Railway entrypoint does not directly load heavy runtime modules", async () => {
	const source = await readFile(railwayEntrypoint, "utf8");

	assert.doesNotMatch(source, wasmForbidden);
	assert.doesNotMatch(source, /cloudflare|workerd|wrangler/i);
	assert.doesNotMatch(source, /import\.meta\.env\.DEV/);
});

void test("the MCP runtime uses the Lix SDK remote client", async () => {
	const source = await readFile(
		new URL("../src/mcp/runtime-client.ts", import.meta.url),
		"utf8",
	);

	assert.match(source, /from "@lix-js\/sdk"/);
	assert.match(source, /openLix\(\{/);
	assert.doesNotMatch(source, /openProtocolSession|protocol-session/);
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
