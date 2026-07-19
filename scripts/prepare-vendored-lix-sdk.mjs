import {
	chmod,
	cp,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDist = join(
	workspaceRoot,
	"node_modules",
	"@lix-js",
	"sdk-release",
	"dist",
);
const sdkRoot = join(workspaceRoot, "vendor", "lix", "packages", "js-sdk");
const sdkDist = join(sdkRoot, "dist");
const tsc = join(
	workspaceRoot,
	"web-app",
	"node_modules",
	"typescript",
	"bin",
	"tsc",
);

await requireDirectory(
	releaseDist,
	"Install workspace dependencies before building the vendored Lix SDK.",
);
await requireDirectory(
	sdkRoot,
	"Initialize the vendor/lix submodule before installing dependencies.",
);

await rm(sdkDist, { recursive: true, force: true });
await cp(releaseDist, sdkDist, { recursive: true });

if (process.env.LIXRAY_SKIP_VENDORED_LIX_WASM !== "1") {
	const toolchainEnv = await vendoredLixToolchainEnv();
	const wasm = spawnSync(
		process.execPath,
		[join(sdkRoot, "scripts", "build-wasm.js")],
		{
			env: toolchainEnv,
			stdio: "inherit",
		},
	);
	if (wasm.error) throw wasm.error;
	if (wasm.status !== 0) process.exit(wasm.status ?? 1);
}

const compiled = spawnSync(
	process.execPath,
	[tsc, "-p", join(sdkRoot, "tsconfig.json")],
	{
		stdio: "inherit",
	},
);
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

async function requireDirectory(path, message) {
	try {
		if ((await stat(path)).isDirectory()) return;
	} catch {
		// Use the actionable error below.
	}
	throw new Error(message);
}

async function vendoredLixToolchainEnv() {
	const lixRoot = join(sdkRoot, "..", "..");
	const channel = requiredMatch(
		await readFile(join(lixRoot, "rust-toolchain.toml"), "utf8"),
		/channel\s*=\s*"([^"]+)"/,
		"Rust channel",
	);
	const wasmBindgenVersion = requiredMatch(
		await readFile(join(lixRoot, "Cargo.lock"), "utf8"),
		/\[\[package\]\]\s*\nname = "wasm-bindgen"\s*\nversion = "([^"]+)"/,
		"wasm-bindgen version",
	);
	const cacheRoot = join(
		workspaceRoot,
		"node_modules",
		".cache",
		"lix-rust-toolchain",
	);
	const cargoHome = join(cacheRoot, "cargo");
	const rustupHome = join(cacheRoot, "rustup");
	const toolsRoot = join(cacheRoot, "tools");
	const cargoBin = join(cargoHome, "bin");
	const toolsBin = join(toolsRoot, "bin");
	let path = process.env.PATH ?? "";
	let env = { ...process.env };

	if (!commandSucceeds("cargo", ["--version"], env)) {
		if (process.platform !== "linux" || process.arch !== "x64") {
			throw new Error(
				"Building the vendored Lix WASM requires Rust. Install rustup and retry.",
			);
		}
		await mkdir(cacheRoot, { recursive: true });
		const rustupInit = join(cacheRoot, "rustup-init");
		const rustupUrl =
			"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init";
		await downloadVerified(rustupUrl, `${rustupUrl}.sha256`, rustupInit);
		await chmod(rustupInit, 0o755);
		env = { ...env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome };
		run(
			rustupInit,
			[
				"-y",
				"--no-modify-path",
				"--profile",
				"minimal",
				"--default-toolchain",
				channel,
				"--target",
				"wasm32-unknown-unknown",
			],
			env,
		);
		path = `${cargoBin}${delimiter}${path}`;
		env = { ...env, PATH: path };
	}

	const expectedWasmBindgen = `wasm-bindgen ${wasmBindgenVersion}`;
	if (
		commandOutput("wasm-bindgen", ["--version"], env) !== expectedWasmBindgen
	) {
		await mkdir(toolsRoot, { recursive: true });
		run(
			"cargo",
			[
				"install",
				"wasm-bindgen-cli",
				"--version",
				wasmBindgenVersion,
				"--locked",
				"--root",
				toolsRoot,
			],
			env,
		);
		path = `${toolsBin}${delimiter}${path}`;
		env = { ...env, PATH: path };
	}

	return env;
}

function commandSucceeds(command, args, env) {
	return spawnSync(command, args, { env, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, env) {
	const result = spawnSync(command, args, { encoding: "utf8", env });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function run(command, args, env) {
	const result = spawnSync(command, args, { env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

async function downloadVerified(url, checksumUrl, destination) {
	const [response, checksumResponse] = await Promise.all([
		fetch(url),
		fetch(checksumUrl),
	]);
	if (!response.ok || !checksumResponse.ok) {
		throw new Error(
			`Failed to download the Rust installer: HTTP ${response.status}/${checksumResponse.status}`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (!expected || actual !== expected) {
		throw new Error("Downloaded Rust installer checksum did not match.");
	}
	await writeFile(destination, bytes);
}

function requiredMatch(value, pattern, description) {
	const match = pattern.exec(value)?.[1];
	if (!match)
		throw new Error(`Could not read ${description} from vendored Lix.`);
	return match;
}
