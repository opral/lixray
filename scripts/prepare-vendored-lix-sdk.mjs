import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const modeArguments = process.argv.slice(2);
if (modeArguments.some((argument) => argument !== "--native")) {
	throw new Error(
		`Unsupported vendored Lix preparation mode: ${modeArguments.join(" ")}`,
	);
}
const buildNative = modeArguments.includes("--native");

await requireDirectory(
	releaseDist,
	"Install workspace dependencies before building the vendored Lix SDK.",
);
await requireDirectory(
	sdkRoot,
	"Initialize the vendor/lix submodule before installing dependencies.",
);
await rm(join(sdkRoot, "lix_js_sdk.node"), { force: true });

const skipWasmBuild = process.env.LIXRAY_SKIP_VENDORED_LIX_WASM === "1";
let preservedWasmRoot;
try {
	if (skipWasmBuild) {
		const wasmDir = join(sdkDist, "wasm");
		await requireDirectory(
			wasmDir,
			"LIXRAY_SKIP_VENDORED_LIX_WASM=1 requires an existing vendored WASM build. Run the build once without this flag first.",
		);
		preservedWasmRoot = await mkdtemp(join(tmpdir(), "lixray-vendored-wasm-"));
		await cp(wasmDir, join(preservedWasmRoot, "wasm"), { recursive: true });
	}

	await rm(sdkDist, { recursive: true, force: true });
	await cp(releaseDist, sdkDist, { recursive: true });

	if (preservedWasmRoot) {
		await rm(join(sdkDist, "wasm"), { recursive: true, force: true });
		await cp(join(preservedWasmRoot, "wasm"), join(sdkDist, "wasm"), {
			recursive: true,
		});
	}
} finally {
	if (preservedWasmRoot) {
		await rm(preservedWasmRoot, { recursive: true, force: true });
	}
}
const toolchainEnv = await vendoredLixToolchainEnv({
	requireWasmBindgen: true,
});
if (!skipWasmBuild) {
	run(
		process.execPath,
		[join(sdkRoot, "scripts", "build-wasm.js")],
		toolchainEnv,
	);
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

await rm(join(sdkDist, "bundled-plugins"), { recursive: true, force: true });
run(
	process.execPath,
	[join(sdkRoot, "scripts", "build-bundled-plugins.js")],
	toolchainEnv,
);

if (buildNative) {
	const toolchainEnv = {
		...(await vendoredLixToolchainEnv({ requireWasmBindgen: false })),
		LIX_NATIVE_PROFILE: "test",
	};
	run(
		process.execPath,
		[join(sdkRoot, "scripts", "build-native.js")],
		toolchainEnv,
		sdkRoot,
	);
	verifyNativeSdk();
}

async function requireDirectory(path, message) {
	try {
		if ((await stat(path)).isDirectory()) return;
	} catch {
		// Use the actionable error below.
	}
	throw new Error(message);
}

async function vendoredLixToolchainEnv({ requireWasmBindgen }) {
	const lixRoot = join(sdkRoot, "..", "..");
	const channel = requiredMatch(
		await readFile(join(lixRoot, "rust-toolchain.toml"), "utf8"),
		/channel\s*=\s*"([^"]+)"/,
		"Rust channel",
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
	let env = {
		...process.env,
		CARGO_UNSTABLE_BINDEPS: "true",
		RUSTUP_TOOLCHAIN: channel,
	};

	if (!commandSucceeds("rustup", ["run", channel, "cargo", "--version"], env)) {
		({ env, path } = await useCachedRustup({
			cacheRoot,
			cargoBin,
			cargoHome,
			channel,
			env,
			path,
			requireWasmBindgen,
			rustupHome,
		}));
	}
	if (!commandSucceeds("rustup", ["run", channel, "cargo", "--version"], env)) {
		throw new Error(
			`Rust toolchain ${channel} is unavailable after provisioning.`,
		);
	}

	if (requireWasmBindgen) {
		for (const target of ["wasm32-unknown-unknown", "wasm32-wasip2"]) {
			if (rustTargetInstalled(target, channel, env)) continue;
			run("rustup", ["target", "add", target, "--toolchain", channel], env);
		}
	}

	if (!requireWasmBindgen) return env;

	const wasmBindgenVersion = requiredMatch(
		await readFile(join(lixRoot, "Cargo.lock"), "utf8"),
		/\[\[package\]\]\s*\nname = "wasm-bindgen"\s*\nversion = "([^"]+)"/,
		"wasm-bindgen version",
	);
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

async function useCachedRustup({
	cacheRoot,
	cargoBin,
	cargoHome,
	channel,
	env,
	path,
	requireWasmBindgen,
	rustupHome,
}) {
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new Error(
			"Building the vendored Lix SDK requires Rust. Install rustup and retry.",
		);
	}
	const cachedPath = `${cargoBin}${delimiter}${path}`;
	const cachedEnv = {
		...env,
		CARGO_HOME: cargoHome,
		PATH: cachedPath,
		RUSTUP_HOME: rustupHome,
	};
	if (!commandSucceeds("rustup", ["--version"], cachedEnv)) {
		await mkdir(cacheRoot, { recursive: true });
		const rustupInit = join(cacheRoot, "rustup-init");
		const rustupUrl =
			"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init";
		await downloadVerified(rustupUrl, `${rustupUrl}.sha256`, rustupInit);
		await chmod(rustupInit, 0o755);
		const rustupInitArgs = [
			"-y",
			"--no-modify-path",
			"--profile",
			"minimal",
			"--default-toolchain",
			channel,
		];
		if (requireWasmBindgen) {
			rustupInitArgs.push("--target", "wasm32-unknown-unknown");
		}
		run(rustupInit, rustupInitArgs, cachedEnv);
	}
	if (
		!commandSucceeds(
			"rustup",
			["run", channel, "cargo", "--version"],
			cachedEnv,
		)
	) {
		run(
			"rustup",
			["toolchain", "install", channel, "--profile", "minimal"],
			cachedEnv,
		);
	}
	return { env: cachedEnv, path: cachedPath };
}

function rustTargetInstalled(target, channel, env) {
	return (
		commandOutput(
			"rustup",
			["target", "list", "--installed", "--toolchain", channel],
			env,
		)
			?.split(/\r?\n/)
			.includes(target) ?? false
	);
}

function commandSucceeds(command, args, env) {
	return spawnSync(command, args, { env, stdio: "ignore" }).status === 0;
}

function commandOutput(command, args, env) {
	const result = spawnSync(command, args, { encoding: "utf8", env });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function run(command, args, env, cwd) {
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function verifyNativeSdk() {
	const script = [
		"(async () => {",
		`  const { openLix } = await import(${JSON.stringify(pathToFileURL(join(sdkDist, "index.js")).href)});`,
		"  const lix = await openLix();",
		"  try {",
		'    const [result] = await lix.executeBatch([{ sql: "SELECT 1 AS value" }]);',
		'    if (result?.rows?.[0]?.values?.[0]?.toJS() !== 1) throw new Error("Vendored Lix native executeBatch smoke test failed");',
		"  } finally {",
		"    await lix.close();",
		"  }",
		"})().catch((error) => {",
		"  console.error(error);",
		"  process.exitCode = 1;",
		"});",
	].join("\n");
	run(process.execPath, ["--eval", script], process.env);
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
