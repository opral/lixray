import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	initSync,
	parseSqlScript as parseSqlScriptBinding,
} from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk.js";
import wasmUrl from "../../../vendor/lix/packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm?url";
import type { ParseSqlScript } from "./lix-sql-access";
import { resolveNodeWasmCandidates } from "./node-wasm-url.mjs";

let initialized = false;

function readNodeWasm(): Buffer {
	const candidates = resolveNodeWasmCandidates(wasmUrl, import.meta.url);
	const tried: string[] = [];
	let lastError: unknown;
	for (const candidate of candidates) {
		const path = fileURLToPath(candidate);
		tried.push(path);
		try {
			return readFileSync(path);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Lix parser WASM not found. Tried: ${tried.join(", ")}`, {
		cause: lastError,
	});
}

export const parseSqlScript: ParseSqlScript = (sql, providedParamCount) => {
	if (!initialized) {
		initSync({
			module: readNodeWasm(),
		});
		initialized = true;
	}
	return parseSqlScriptBinding(
		sql,
		providedParamCount,
	) as ReturnType<ParseSqlScript>;
};
