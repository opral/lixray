import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	initSync,
	parseSqlScript as parseSqlScriptBinding,
} from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk.js";
import wasmUrl from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm?url";
import type { ParseSqlScript } from "./lix-sql-access";
import { resolveNodeWasmUrl } from "./node-wasm-url.mjs";

let initialized = false;

export const parseSqlScript: ParseSqlScript = (sql, providedParamCount) => {
	if (!initialized) {
		initSync({
			module: readFileSync(
				fileURLToPath(resolveNodeWasmUrl(wasmUrl, import.meta.url)),
			),
		});
		initialized = true;
	}
	return parseSqlScriptBinding(
		sql,
		providedParamCount,
	) as ReturnType<ParseSqlScript>;
};
