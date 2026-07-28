import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	initSync,
	parseSqlScript as parseSqlScriptBinding,
} from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk.js";
import wasmUrl from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm?url";
import type { ParseSqlScript } from "../worker/handler";

let initialized = false;

export const parseSqlScript: ParseSqlScript = (sql, providedParamCount) => {
	if (!initialized) {
		// Vite records emitted SSR assets as web-root paths; Node resolves them
		// relative to the built server entry instead.
		initSync({
			module: readFileSync(fileURLToPath(resolveWasmUrl(wasmUrl))),
		});
		initialized = true;
	}
	return parseSqlScriptBinding(
		sql,
		providedParamCount,
	) as ReturnType<ParseSqlScript>;
};

function resolveWasmUrl(url: string): URL {
	// Vite serves source dependencies as /@fs/<absolute path> in development.
	// Treating that value as module-relative produces .../src/lib/@fs/... .
	if (url.startsWith("/@fs/")) {
		return pathToFileURL(decodeURIComponent(url.slice("/@fs".length)));
	}
	return new URL(url.startsWith("/") ? `.${url}` : url, import.meta.url);
}
