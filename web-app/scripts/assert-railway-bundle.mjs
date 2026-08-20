import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
	assert.doesNotMatch(
		source,
		new RegExp(WASM_FILE.replaceAll(".", "\\.")),
		"Railway bundle must not open lix_js_sdk_bg.wasm",
	);
	assert.doesNotMatch(
		source,
		new RegExp(PRODUCTION_WASM_PATH.replaceAll("/", "\\/")),
		"Railway bundle must not open the production WASM path",
	);
	try {
		await access(resolve(dirname(bundlePath), "../wasm", WASM_FILE));
		assert.fail(`${WASM_FILE} must not be baked into the Railway image`);
	} catch (error) {
		if (error instanceof assert.AssertionError) throw error;
	}
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
