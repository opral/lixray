import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const serverDirectory = path.resolve("dist/preview-worker");
const config = await readJsonc("wrangler.preview-runtime.jsonc");
const buildConfig = await readJsonc("wrangler.preview.jsonc");
verifyBindings(config, "runtime");
verifyBindings(buildConfig, "build");
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
	`Preview bundle has only the dedicated preview R2 binding and no container implementation (${compressedBytes} compressed bytes).`,
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

async function readJsonc(file) {
	return JSON.parse(
		(await readFile(path.resolve(file), "utf8")).replace(/,\s*([}\]])/g, "$1"),
	);
}

function verifyBindings(workerConfig, label) {
	const forbiddenBindings = [
		...(workerConfig.durable_objects?.bindings ?? []),
		...(workerConfig.containers ?? []),
		...(workerConfig.d1_databases ?? []),
		...(workerConfig.kv_namespaces ?? []),
		...(workerConfig.services ?? []),
	];
	if (forbiddenBindings.length > 0) {
		throw new Error(
			`The preview ${label} config contains a forbidden state or service binding`,
		);
	}
	const r2Bindings = workerConfig.r2_buckets ?? [];
	if (
		r2Bindings.length !== 1 ||
		r2Bindings[0]?.binding !== "PREVIEW_STATE" ||
		r2Bindings[0]?.bucket_name !== "lixray-preview"
	) {
		throw new Error(
			`The preview ${label} config must bind only PREVIEW_STATE to lixray-preview`,
		);
	}
	if (Object.keys(workerConfig.exports ?? {}).length > 0) {
		throw new Error(
			`The preview ${label} config exports a Durable Object implementation`,
		);
	}
}
