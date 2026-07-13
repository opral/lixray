import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const serverDirectory = path.resolve("dist/preview-worker");
const config = JSON.parse(
	(
		await readFile(path.resolve("wrangler.preview-runtime.jsonc"), "utf8")
	).replace(/,\s*([}\]])/g, "$1"),
);

const forbiddenBindings = [
	...(config.durable_objects?.bindings ?? []),
	...(config.containers ?? []),
	...(config.r2_buckets ?? []),
	...(config.d1_databases ?? []),
	...(config.kv_namespaces ?? []),
	...(config.services ?? []),
];
if (forbiddenBindings.length > 0) {
	throw new Error("The preview Worker contains a state or service binding");
}
if (Object.keys(config.exports ?? {}).length > 0) {
	throw new Error("The preview Worker exports a Durable Object implementation");
}
if (
	config.assets?.binding !== "ASSETS" ||
	config.assets?.not_found_handling !== "single-page-application"
) {
	throw new Error("The preview Worker must serve the generated SPA shell");
}
const shell = await readFile(path.resolve("dist/client/index.html"), "utf8");
if (shell.includes("Workspaces") || shell.includes("Sign in")) {
	throw new Error("The preview SPA shell contains route-specific markup");
}

const uploadFiles = await workerModuleFiles(serverDirectory);
let compressedBytes = 0;
for (const file of uploadFiles) {
	compressedBytes += gzipSync(await readFile(file)).byteLength;
	if (!file.endsWith(".js")) continue;
	const source = await readFile(file, "utf8");
	if (
		source.includes("SlateDbContainer") ||
		source.includes("@cloudflare/containers")
	) {
		throw new Error(`The preview bundle contains container code: ${file}`);
	}
}
if (compressedBytes >= 10 * 1024 * 1024) {
	throw new Error(
		`The preview Worker exceeds the 10 MiB compressed limit: ${compressedBytes} bytes`,
	);
}

console.log(
	`Preview bundle has no state bindings or container implementation (${compressedBytes} compressed bytes).`,
);

async function workerModuleFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await workerModuleFiles(file)));
		else if (entry.name.endsWith(".js") || entry.name.endsWith(".wasm")) {
			files.push(file);
		}
	}
	return files;
}
