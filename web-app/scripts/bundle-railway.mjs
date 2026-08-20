import { build } from "esbuild";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRailwayBundle } from "./assert-railway-bundle.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(root, "../dist/server/railway-server.js");
const bundled = resolve(root, "../dist/server/railway-server.bundled.js");

await build({
	entryPoints: [outfile],
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "bundle",
	external: ["node:*"],
	banner: {
		js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
	},
	outfile: bundled,
	allowOverwrite: true,
	plugins: [stubLixWasmPlugin()],
});

const rewritten = (await readFile(bundled, "utf8")).replaceAll(
	"lix_js_sdk_bg.wasm",
	"lix-wasm-not-shipped-on-railway",
);
await writeFile(outfile, rewritten);
await unlink(bundled);
await assertRailwayBundle(outfile);

function stubLixWasmPlugin() {
	return {
		name: "stub-lix-wasm",
		setup(buildApi) {
			buildApi.onResolve({ filter: /lix_js_sdk_bg\.wasm$/ }, (args) => ({
				path: args.path,
				namespace: "lix-wasm-stub",
			}));
			buildApi.onLoad({ filter: /.*/, namespace: "lix-wasm-stub" }, () => ({
				contents:
					'throw new Error("Lix WASM is not shipped in the Railway image");',
				loader: "js",
			}));
		},
	};
}
