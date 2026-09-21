import { build } from "esbuild";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRailwayBundle } from "./assert-railway-bundle.mjs";
import { bakeLixWasm } from "./bake-lix-wasm.mjs";

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
});

await rename(bundled, outfile);
const source = await readFile(outfile, "utf8");
// Vite preserves the shared initializer's relative URL in the server build.
// Relocate it alongside any browser asset URLs when flattening the bundle.
const rewritten = source.replaceAll(
	/["'](?:\/assets\/lix_js_sdk_bg-[A-Za-z0-9_-]+|\.\/wasm\/lix_js_sdk_bg)\.wasm["']/g,
	'"../wasm/lix_js_sdk_bg.wasm"',
);
await writeFile(outfile, rewritten);
await bakeLixWasm();
await assertRailwayBundle(outfile);

// The runtime image has no node_modules. Bundle host tracing alongside its
// HTTP adapter; all copies of the OTel API share the registered global provider.
await build({
	entryPoints: [
		resolve(root, "telemetry.mjs"),
		resolve(root, "railway-server.mjs"),
	],
	outdir: resolve(root, "../dist/runtime"),
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	external: ["node:*"],
	banner: {
		js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
	},
});
