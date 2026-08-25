import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LIX_WASM_FILENAME = "lix_js_sdk_bg.wasm";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webAppDirectory = resolve(scriptDirectory, "..");
const defaultSource = resolve(
	webAppDirectory,
	"../vendor/lix/packages/js-sdk/dist/wasm",
	LIX_WASM_FILENAME,
);
const defaultTarget = resolve(webAppDirectory, "dist/wasm", LIX_WASM_FILENAME);

export async function bakeLixWasm({
	source = defaultSource,
	target = defaultTarget,
} = {}) {
	const bytes = await readFile(source);
	if (
		bytes.byteLength === 0 ||
		!bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
	) {
		throw new Error(`Lix SDK WASM is invalid at ${source}`);
	}
	await mkdir(dirname(target), { recursive: true });
	await copyFile(source, target);
	return { source, target, byteLength: bytes.byteLength };
}

if (
	process.argv[1] !== undefined &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const result = await bakeLixWasm();
	console.log(
		`Baked ${result.byteLength} bytes of Lix SDK WASM to ${result.target}`,
	);
}
