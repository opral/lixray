import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRailwayBundle } from "./assert-railway-bundle.mjs";

void test("accepts a Railway bundle with the SDK remote client and WASM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "server", "railway-server.js");
	await mkdir(join(dir, "server"), { recursive: true });
	await mkdir(join(dir, "wasm"), { recursive: true });
	await writeFile(
		bundle,
		'export async function openRemoteLixBinding() { return new URL("../wasm/lix_js_sdk_bg.wasm", import.meta.url); }\n',
	);
	await writeFile(
		join(dir, "wasm", "lix_js_sdk_bg.wasm"),
		Buffer.from([0x00, 0x61, 0x73, 0x6d]),
	);
	await assertRailwayBundle(bundle);
});

void test("rejects a Railway bundle without the SDK remote client", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "server", "railway-server.js");
	await mkdir(join(dir, "server"), { recursive: true });
	await writeFile(bundle, "export default {};\n");
	await assert.rejects(() => assertRailwayBundle(bundle), /remote client/);
});

void test("rejects a Railway bundle without valid SDK WASM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "server", "railway-server.js");
	await mkdir(join(dir, "server"), { recursive: true });
	await mkdir(join(dir, "wasm"), { recursive: true });
	await writeFile(
		bundle,
		'export async function openRemoteLixBinding() { return new URL("../wasm/lix_js_sdk_bg.wasm", import.meta.url); }\n',
	);
	await writeFile(join(dir, "wasm", "lix_js_sdk_bg.wasm"), "not wasm");
	await assert.rejects(() => assertRailwayBundle(bundle), /WebAssembly module/);
});

void test("rejects a Railway bundle that still imports the Node SQL parser", async () => {
	const dir = await mkdtemp(join(tmpdir(), "railway-bundle-"));
	const bundle = join(dir, "server", "railway-server.js");
	await mkdir(join(dir, "server"), { recursive: true });
	await writeFile(bundle, 'import "./lib/node-lix-sql-parser.ts";\n');
	await assert.rejects(() => assertRailwayBundle(bundle), /Node SQL parser/);
});
