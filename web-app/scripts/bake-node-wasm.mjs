import { copyFile, mkdir, readFile } from "node:fs/promises";
import { accessSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BAKED_NODE_WASM_FILENAME,
	bakedNodeWasmUrl,
	resolveNodeWasmUrl,
} from "../src/lib/node-wasm-url.mjs";

const defaultWebAppDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceWasm = join(
	defaultWebAppDir,
	"..",
	"vendor",
	"lix",
	"packages",
	"js-sdk",
	"dist",
	"wasm",
	BAKED_NODE_WASM_FILENAME,
);

const WASM_REF =
	/(?:\.\.\/)+(?:[\w./-]*?)?lix_js_sdk_bg[\w.-]*\.wasm|\/(?:assets|wasm)\/lix_js_sdk_bg[\w.-]*\.wasm|lix_js_sdk_bg(?:-[\w]+)?\.wasm/g;

/**
 * @param {string} source
 */
export function extractBundledWasmUrls(source) {
	return [...new Set(source.match(WASM_REF) ?? [])];
}

/**
 * @param {{
 *   webAppDir?: string,
 *   sourceWasm?: string,
 *   serverBundle?: string,
 * }} [options]
 */
export async function bakeNodeWasm(options = {}) {
	const webAppDir = options.webAppDir ?? defaultWebAppDir;
	const sourceWasm = options.sourceWasm ?? defaultSourceWasm;
	const serverBundle =
		options.serverBundle ??
		join(webAppDir, "dist", "server", "railway-server.js");

	accessExisting(sourceWasm, "vendored Lix parser WASM");
	accessExisting(serverBundle, "bundled Railway server");

	const serverModuleUrl = pathToFileURL(serverBundle).href;
	const bundle = await readFile(serverBundle, "utf8");
	const bundledUrls = extractBundledWasmUrls(bundle);
	if (bundledUrls.length === 0) {
		throw new Error(
			`${serverBundle} does not reference ${BAKED_NODE_WASM_FILENAME}`,
		);
	}

	const targets = new Set([
		fileURLToPath(bakedNodeWasmUrl(serverModuleUrl)),
		...bundledUrls.map((url) =>
			fileURLToPath(resolveNodeWasmUrl(url, serverModuleUrl)),
		),
	]);

	for (const target of targets) {
		await mkdir(dirname(target), { recursive: true });
		await copyFile(sourceWasm, target);
		accessExisting(target, "baked Lix parser WASM");
	}

	return { sourceWasm, serverBundle, bundledUrls, targets: [...targets] };
}

/**
 * @param {string} path
 * @param {string} label
 */
function accessExisting(path, label) {
	try {
		accessSync(path);
	} catch {
		throw new Error(`${label} is missing at ${path}`);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
	const result = await bakeNodeWasm();
	console.log(
		`Baked Lix parser WASM to ${result.targets.join(", ")} (from ${result.bundledUrls.join(", ")})`,
	);
}
