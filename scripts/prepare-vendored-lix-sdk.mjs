import {
	appendFile,
	chmod,
	cp,
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBrowserArtifact } from "./lix-ci-artifacts.mjs";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkRoot = join(workspaceRoot, "vendor", "lix", "packages", "js-sdk");
const sdkDist = join(sdkRoot, "dist");
const opfsStorageRoot = join(
	workspaceRoot,
	"vendor",
	"lix",
	"packages",
	"storage-opfs",
);
const tsc = join(
	workspaceRoot,
	"web-app",
	"node_modules",
	"typescript",
	"bin",
	"tsc",
);
const modeArguments = process.argv.slice(2);
if (
	modeArguments.some(
		(argument) =>
			!["--resolve-only", "--source"].includes(argument),
	)
) {
	throw new Error(
		`Unsupported vendored Lix preparation mode: ${modeArguments.join(" ")}`,
	);
}
const buildSource = modeArguments.includes("--source");
const resolveOnly = modeArguments.includes("--resolve-only");
if (resolveOnly && buildSource)
	throw new Error("Resolve-only mode cannot build from source.");
const lixRoot = join(sdkRoot, "..", "..");
const sourceRevision = requiredOutput(
	"git",
	["-C", lixRoot, "rev-parse", "HEAD"],
	process.env,
	"vendored Lix revision",
);
const browserMarker = join(sdkDist, ".lixray-browser-build.json");

await requireDirectory(
	sdkRoot,
	"Initialize the vendor/lix submodule before installing dependencies.",
);

console.log(`[lix-sdk] Selected vendored Lix ${sourceRevision}.`);

if (buildSource) {
	// Explicit local builds never claim tested cloud artifact provenance.
	if (process.env.LIXRAY_LIX_ARTIFACTS === "only")
		throw new Error("Source builds cannot satisfy artifact-only validation.");
	const clean = spawnSync(
		"git",
		["-C", lixRoot, "diff", "HEAD", "--exit-code"],
		{ stdio: "ignore" },
	);
	if (clean.status !== 0)
		throw new Error(
			"Commit engine changes before building a revision-pinned SDK from source.",
		);
	const toolchainEnv = await vendoredLixToolchainEnv({
		requireWasmBindgen: true,
	});
	run(
		process.execPath,
		[join(sdkRoot, "scripts", "build-wasm.js")],
		toolchainEnv,
		sdkRoot,
	);
	// SDK source imports this generated package export during typechecking.
	run(
		process.execPath,
		[join(sdkRoot, "scripts", "build-compatibility.js")],
		toolchainEnv,
		sdkRoot,
	);
	run(
		process.execPath,
		[tsc, "-p", join(sdkRoot, "tsconfig.json")],
		toolchainEnv,
		sdkRoot,
	);
	// OpfsStorage imports the bundled direct.js, not the unbundled tsc provider.
	// Run the package build so a previous revision's ignored bundle cannot survive.
	run("npm", ["run", "build"], toolchainEnv, opfsStorageRoot);
	await writeBuildMarker(browserMarker, {
		source: "source-build",
		sourceRevision,
		sourceTree: requiredOutput(
			"git",
			["-C", lixRoot, "rev-parse", "HEAD^{tree}"],
			process.env,
			"Lix source tree",
		),
	});
}
let browserReady = await preparedBrowserMatches(sourceRevision);

if (browserReady) {
	console.log(
		`[lix-sdk] REUSE browser SDK already prepared for ${sourceRevision}.`,
	);
} else {
	try {
		const artifact = await installBrowserArtifact({
			opfsStorageRoot,
			revision: sourceRevision,
			sdkRoot,
		});
		if (artifact) {
			await writeBuildMarker(browserMarker, {
				...artifact,
				source: "lix-ci-artifact",
				sourceRevision,
			});
			browserReady = true;
			console.log(
				`[lix-sdk] Installed precompiled browser SDK for ${sourceRevision}.`,
			);
		}
	} catch (error) {
		if (process.env.LIXRAY_LIX_ARTIFACTS === "only") throw error;
		console.log(`[lix-sdk] Artifact install failed (${errorMessage(error)}).`);
	}
}

if (resolveOnly) {
	if (process.env.GITHUB_OUTPUT)
		await appendFile(process.env.GITHUB_OUTPUT, `ready=${browserReady}\n`);
	if (!browserReady) {
		console.log(
			"[lix-sdk] Pinned browser SDK artifact is missing; build it in https://github.com/opral/lix/actions/workflows/ci.yml.",
		);
		process.exit(0);
	}
}

if (!browserReady) {
	throw new Error(
		`Missing browser SDK for ${sourceRevision}. Build it in https://github.com/opral/lix/actions/workflows/ci.yml using the artifact-only action, then retry.`,
	);
}
await ensureWasmSourceLink();

async function preparedBrowserMatches(revision) {
	const marker = await readBuildMarker(browserMarker);
	if (marker?.source === "source-build") {
		const clean = spawnSync(
			"git",
			["-C", lixRoot, "diff", "HEAD", "--exit-code"],
			{ stdio: "ignore" },
		);
		if (
			clean.status !== 0 ||
			marker.sourceTree !==
				requiredOutput(
					"git",
					["-C", lixRoot, "rev-parse", "HEAD^{tree}"],
					process.env,
					"Lix source tree",
				)
		)
			return false;
	}
	return (
		marker?.sourceRevision === revision &&
		(marker.source === "lix-ci-artifact" ||
			(marker.source === "source-build" &&
				process.env.LIXRAY_LIX_ARTIFACTS !== "only")) &&
		(await browserFilesExist())
	);
}

async function browserFilesExist() {
	return (
		(await isFile(join(sdkDist, "index.js"))) &&
		(await isFile(join(sdkDist, "wasm", "lix_js_sdk_bg.wasm"))) &&
		(await isFile(join(sdkDist, "migration.js"))) &&
		(await isFile(join(opfsStorageRoot, "dist", "migration.worker.js"))) &&
		(await isFile(join(opfsStorageRoot, "dist", "index.js"))) &&
		(await isFile(join(opfsStorageRoot, "dist", "direct.js")))
	);
}

async function ensureWasmSourceLink() {
	await rm(join(sdkRoot, "src", "wasm"), { recursive: true, force: true });
	await symlink(join(sdkDist, "wasm"), join(sdkRoot, "src", "wasm"), "dir");
	await rm(join(sdkRoot, "src", "migration-wasm"), {
		recursive: true,
		force: true,
	});
	// Older vendored SDKs still import the detached engine from source.
	if (await isFile(join(sdkDist, "migration-wasm", "lix_js_sdk_bg.wasm"))) {
		await symlink(
			join(sdkDist, "migration-wasm"),
			join(sdkRoot, "src", "migration-wasm"),
			"dir",
		);
	}
}

async function writeBuildMarker(path, value) {
	await writeFile(
		path,
		`${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`,
	);
}

async function readBuildMarker(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
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

function requiredOutput(command, args, env, description) {
	const output = commandOutput(command, args, env);
	if (!output) throw new Error(`Could not read ${description}.`);
	return output;
}

function run(command, args, env, cwd) {
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
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

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
