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

void test("Railway installs the bundled Fetch runtime before importing app modules", async () => {
	const source = await readFile(
		new URL("./start-railway.mjs", import.meta.url),
		"utf8",
	);
	const runtimeInstall = source.indexOf('await import("./undici-runtime.mjs")');
	const telemetryImport = source.indexOf('import("./telemetry.mjs")');
	const serverImport = source.indexOf('import("./railway-server.mjs")');
	const appImport = source.indexOf(
		'import("../dist/server/railway-server.js")',
	);
	assert.ok(runtimeInstall >= 0, "runtime helper must be imported at startup");
	assert.ok(runtimeInstall < telemetryImport);
	assert.ok(runtimeInstall < serverImport);
	assert.ok(runtimeInstall < appImport);
	assert.doesNotMatch(source, /from ["']\.\/(?:telemetry|railway-server)\.mjs/);

	const bundleSource = await readFile(
		new URL("./bundle-railway.mjs", import.meta.url),
		"utf8",
	);
	assert.match(bundleSource, /resolve\(root, "undici-runtime\.mjs"\)/);
	const dockerfile = await readFile(
		new URL("../Dockerfile", import.meta.url),
		"utf8",
	);
	assert.match(dockerfile, /dist\/runtime\/undici-runtime\.mjs/);
});
