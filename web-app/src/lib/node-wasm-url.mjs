import { pathToFileURL } from "node:url";

export const BAKED_NODE_WASM_FILENAME = "lix_js_sdk_bg.wasm";

/**
 * Vite 8 / Rolldown may emit a relative `?url` such as
 * `../wasm/lix_js_sdk_bg.wasm` into the bundled server. That resolves to
 * `dist/wasm/` beside `dist/server`, not `dist/client/assets`.
 *
 * @param {string} moduleUrl
 */
export function bakedNodeWasmUrl(moduleUrl) {
	return new URL(`../wasm/${BAKED_NODE_WASM_FILENAME}`, moduleUrl);
}

/**
 * @param {string} url
 * @param {string} moduleUrl
 */
export function resolveNodeWasmUrl(url, moduleUrl) {
	// Vite serves source dependencies as /@fs/<absolute path> in development.
	if (url.startsWith("/@fs/")) {
		return pathToFileURL(decodeURIComponent(url.slice("/@fs".length)));
	}
	// Vite emits web-root asset URLs into the Node bundle. The runtime image
	// keeps those files in dist/client/assets beside dist/server.
	if (url.startsWith("/")) {
		return new URL(`../client${url}`, moduleUrl);
	}
	return new URL(url, moduleUrl);
}

/**
 * @param {string} url
 * @param {string} moduleUrl
 */
export function resolveNodeWasmCandidates(url, moduleUrl) {
	const resolved = resolveNodeWasmUrl(url, moduleUrl);
	const baked = bakedNodeWasmUrl(moduleUrl);
	return resolved.href === baked.href ? [resolved] : [resolved, baked];
}
