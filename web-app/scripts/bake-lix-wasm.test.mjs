import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bakeLixWasm } from "./bake-lix-wasm.mjs";

void test("bakes the SDK WASM into the Railway runtime tree", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-wasm-"));
	const source = join(directory, "source.wasm");
	const target = join(directory, "dist", "wasm", "lix_js_sdk_bg.wasm");
	const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]);
	await writeFile(source, bytes);

	const result = await bakeLixWasm({ source, target });

	assert.equal(result.byteLength, bytes.byteLength);
	assert.deepEqual(await readFile(target), bytes);
});

void test("rejects an invalid SDK WASM artifact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-wasm-"));
	const source = join(directory, "source.wasm");
	const target = join(directory, "dist", "wasm", "lix_js_sdk_bg.wasm");
	await writeFile(source, "not wasm");

	await assert.rejects(bakeLixWasm({ source, target }), /WASM is invalid/);
});
