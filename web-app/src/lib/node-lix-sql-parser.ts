import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
			module: readFileSync(
				fileURLToPath(
					new URL(
						wasmUrl.startsWith("/") ? `.${wasmUrl}` : wasmUrl,
						import.meta.url,
					),
				),
			),
		});
		initialized = true;
	}
	return parseSqlScriptBinding(
		sql,
		providedParamCount,
	) as ReturnType<ParseSqlScript>;
};
