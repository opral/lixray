import { Buffer } from "node:buffer";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Lix } from "@lix-js/sdk";
import { openMemoryWasmBinding } from "../../../../vendor/lix/packages/js-sdk/dist/binding.node-wasm.js";

/** Use the compiled vendored browser engine, never a published native fallback. */
export async function openDirectoryTestLix(): Promise<Lix> {
	return new Lix(await openMemoryWasmBinding());
}

/**
 * Atelier's public browser entry imports editor CSS, which Node cannot load.
 * Bundle its actual shared operation source for these Node integration tests;
 * only this helper module's package import is redirected. No mutation is mocked.
 * Browser QA still exercises the shipped public entry.
 */
export async function loadDirectoryOperationsForTest() {
	const operationsURL = new URL("./directory-operations.ts", import.meta.url);
	const source = new URL(
		"../src/lib/workspace-file-ops.ts",
		import.meta.resolve("@opral/atelier"),
	);
	const bundled = await build({
		entryPoints: [fileURLToPath(source)],
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
		logLevel: "silent",
	});
	const moduleURL = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.contents).toString("base64")}`;
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (
				specifier === "@opral/atelier" &&
				context.parentURL === operationsURL.href
			) {
				return { url: moduleURL, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	try {
		return await import("./directory-operations.ts");
	} finally {
		hooks.deregister();
	}
}
