export const BAKED_NODE_WASM_FILENAME: "lix_js_sdk_bg.wasm";
export function bakedNodeWasmUrl(moduleUrl: string): URL;
export function resolveNodeWasmUrl(url: string, moduleUrl: string): URL;
export function resolveNodeWasmCandidates(
	url: string,
	moduleUrl: string,
): URL[];
