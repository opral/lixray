import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bakeNodeWasm, extractBundledWasmUrls } from "./bake-node-wasm.mjs";

void test("the Railway Node bundle bakes the Lix parser WASM", async () => {
	const [packageJson, parser] = await Promise.all([
		readFile(new URL("../package.json", import.meta.url), "utf8"),
		readFile(
			new URL("../src/lib/node-lix-sql-parser.ts", import.meta.url),
			"utf8",
		),
	]);
	const scripts = JSON.parse(packageJson).scripts;
	assert.match(scripts["bundle:railway"], /bake-node-wasm/);
	assert.match(scripts["ci:build:node"], /bundle:railway/);
	assert.match(parser, /resolveNodeWasmCandidates/);
});

void test("the vendored parser WASM is present for the Railway image bake", async () => {
	const source = new URL(
		"../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm",
		import.meta.url,
	);
	const bytes = await readFile(source);
	assert.ok(bytes.byteLength > 0);
	assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
});

void test("extracts relative and hashed Vite wasm URLs from the server bundle", () => {
	assert.deepEqual(
		extractBundledWasmUrls(
			`const a = new URL("../wasm/lix_js_sdk_bg.wasm", import.meta.url).href;
			 const b = "/assets/lix_js_sdk_bg-hash.wasm";`,
		),
		["../wasm/lix_js_sdk_bg.wasm", "/assets/lix_js_sdk_bg-hash.wasm"],
	);
});

void test("copies the vendored WASM to every path the Node loader will open", async () => {
	const webAppDir = await mkdtemp(join(tmpdir(), "bake-node-wasm-"));
	const sourceWasm = join(webAppDir, "source.wasm");
	const serverBundle = join(webAppDir, "dist", "server", "railway-server.js");
	await writeFile(sourceWasm, "wasm-bytes");
	await mkdir(join(webAppDir, "dist", "server"), { recursive: true });
	await writeFile(
		serverBundle,
		'const wasmUrl = "../wasm/lix_js_sdk_bg.wasm";\n',
	);

	const result = await bakeNodeWasm({ webAppDir, sourceWasm, serverBundle });
	const bakedPath = join(webAppDir, "dist", "wasm", "lix_js_sdk_bg.wasm");

	assert.deepEqual(result.bundledUrls, ["../wasm/lix_js_sdk_bg.wasm"]);
	assert.deepEqual(result.targets, [bakedPath]);
	assert.equal(await readFile(bakedPath, "utf8"), "wasm-bytes");
});

void test("copies hashed client asset URLs so the existing resolver can open them", async () => {
	const webAppDir = await mkdtemp(join(tmpdir(), "bake-node-wasm-"));
	const sourceWasm = join(webAppDir, "source.wasm");
	const serverBundle = join(webAppDir, "dist", "server", "railway-server.js");
	await writeFile(sourceWasm, "hashed-wasm");
	await mkdir(join(webAppDir, "dist", "server"), { recursive: true });
	await writeFile(
		serverBundle,
		'export const wasmUrl = "/assets/lix_js_sdk_bg-hash.wasm";\n',
	);

	const result = await bakeNodeWasm({ webAppDir, sourceWasm, serverBundle });
	const bakedPath = join(webAppDir, "dist", "wasm", "lix_js_sdk_bg.wasm");
	const hashedPath = join(
		webAppDir,
		"dist",
		"client",
		"assets",
		"lix_js_sdk_bg-hash.wasm",
	);

	assert.deepEqual([...result.targets].sort(), [hashedPath, bakedPath].sort());
	assert.equal(await readFile(bakedPath, "utf8"), "hashed-wasm");
	assert.equal(await readFile(hashedPath, "utf8"), "hashed-wasm");
});

void test("fails when the bundled server never mentions the parser WASM", async () => {
	const webAppDir = await mkdtemp(join(tmpdir(), "bake-node-wasm-"));
	const sourceWasm = join(webAppDir, "source.wasm");
	const serverBundle = join(webAppDir, "dist", "server", "railway-server.js");
	await writeFile(sourceWasm, "wasm-bytes");
	await mkdir(join(webAppDir, "dist", "server"), { recursive: true });
	await writeFile(serverBundle, "export default {};\n");

	await assert.rejects(
		bakeNodeWasm({ webAppDir, sourceWasm, serverBundle }),
		/does not reference lix_js_sdk_bg\.wasm/,
	);
});
