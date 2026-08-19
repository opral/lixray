import assert from "node:assert/strict";
import test from "node:test";
import {
	bakedNodeWasmUrl,
	resolveNodeWasmCandidates,
	resolveNodeWasmUrl,
} from "../src/lib/node-wasm-url.mjs";

const bundledServer = "file:///app/web-app/dist/server/railway-server.js";

void test("resolves emitted web assets from the bundled server", () => {
	assert.equal(
		resolveNodeWasmUrl("/assets/lix_js_sdk_bg-hash.wasm", bundledServer).href,
		"file:///app/web-app/dist/client/assets/lix_js_sdk_bg-hash.wasm",
	);
});

void test("resolves a relative Vite ?url onto dist/wasm beside dist/server", () => {
	assert.equal(
		resolveNodeWasmUrl("../wasm/lix_js_sdk_bg.wasm", bundledServer).href,
		"file:///app/web-app/dist/wasm/lix_js_sdk_bg.wasm",
	);
	assert.equal(
		bakedNodeWasmUrl(bundledServer).href,
		"file:///app/web-app/dist/wasm/lix_js_sdk_bg.wasm",
	);
});

void test("falls back to the baked dist/wasm path when Vite emits a hashed asset URL", () => {
	assert.deepEqual(
		resolveNodeWasmCandidates(
			"/assets/lix_js_sdk_bg-hash.wasm",
			bundledServer,
		).map((url) => url.href),
		[
			"file:///app/web-app/dist/client/assets/lix_js_sdk_bg-hash.wasm",
			"file:///app/web-app/dist/wasm/lix_js_sdk_bg.wasm",
		],
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
