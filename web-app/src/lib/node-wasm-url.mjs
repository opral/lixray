import { pathToFileURL } from "node:url";

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
