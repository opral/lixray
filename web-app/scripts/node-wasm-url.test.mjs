import assert from "node:assert/strict";
import test from "node:test";
import { resolveNodeWasmUrl } from "../src/lib/node-wasm-url.mjs";

void test("resolves emitted web assets from the bundled server", () => {
	assert.equal(
		resolveNodeWasmUrl(
			"/assets/lix_js_sdk_bg-hash.wasm",
			"file:///app/web-app/dist/server/railway-server.js",
		).href,
		"file:///app/web-app/dist/client/assets/lix_js_sdk_bg-hash.wasm",
	);
});

void test("preserves Vite development filesystem URLs", () => {
	assert.equal(
		resolveNodeWasmUrl(
			"/@fs/root/repos/lixray/vendor/lix/sdk.wasm",
			"file:///root/repos/lixray/web-app/src/lib/node-lix-sql-parser.ts",
		).href,
		"file:///root/repos/lixray/vendor/lix/sdk.wasm",
	);
});
