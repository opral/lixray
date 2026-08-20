import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRailwayBundle } from "./assert-railway-bundle.mjs";

void test("accepts a Railway bundle that does not open the JS SDK WASM file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "railway-server.js");
	await writeFile(
		bundle,
		'export default { fetch() { return new Response("ok"); } };\n',
	);
	await assertRailwayBundle(bundle);
});

void test("rejects a Railway bundle that still opens the production WASM path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "railway-server.js");
	await writeFile(
		bundle,
		'import { readFile } from "node:fs/promises";\n' +
			'await readFile("/app/web-app/dist/wasm/lix_js_sdk_bg.wasm");\n',
	);
	await assert.rejects(
		() => assertRailwayBundle(bundle),
		/lix_js_sdk_bg\.wasm/,
	);
});

void test("rejects a Railway bundle that still imports the Node SQL parser", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "railway-server.js");
	await writeFile(bundle, 'import "./lib/node-lix-sql-parser.ts";\n');
	await assert.rejects(() => assertRailwayBundle(bundle), /Node SQL parser/);
});
