import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WASM_FILE = "lix_js_sdk_bg.wasm";
const PRODUCTION_WASM_PATH = "/app/web-app/dist/wasm/lix_js_sdk_bg.wasm";

export async function assertRailwayBundle(bundlePath) {
	const source = await readFile(bundlePath, "utf8");
	assert.doesNotMatch(
		source,
		/node-lix-sql-parser/,
		"Railway bundle must not import the removed Node SQL parser",
	);
	assert.match(
		source,
		/openRemoteLixBinding|openRemote/,
		"Railway bundle must contain the Lix SDK remote client",
	);
	assert.match(
		source,
		/\.\.\/wasm\/lix_js_sdk_bg\.wasm/,
		"Railway bundle must resolve the Lix SDK WASM beside the server bundle",
	);
	const wasm = await readFile(
		resolve(dirname(bundlePath), "../wasm", WASM_FILE),
	);
	assert.deepEqual(
		wasm.subarray(0, 4),
		Buffer.from([0x00, 0x61, 0x73, 0x6d]),
		`${PRODUCTION_WASM_PATH} must contain a WebAssembly module`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const bundle = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../dist/server/railway-server.js",
	);
	await assertRailwayBundle(bundle);
}
