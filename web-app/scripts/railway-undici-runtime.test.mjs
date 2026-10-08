import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = fileURLToPath(new URL(".", import.meta.url));

async function bundleUndiciRuntime(directory) {
	const outfile = join(directory, "undici-runtime.mjs");
	await build({
		entryPoints: [join(scriptsRoot, "undici-runtime.mjs")],
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "bundle",
		external: ["node:*"],
		banner: {
			js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
		},
		outfile,
	});
	return outfile;
}

function runChild(scenario, runtimeBundle) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[join(scriptsRoot, "railway-undici-runtime.child.mjs")],
			{
				env: {
					...process.env,
					LIXRAY_UNDICI_RUNTIME_BUNDLE: runtimeBundle,
					LIXRAY_UNDICI_RUNTIME_SCENARIO: scenario,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${scenario} child timed out\n${stdout}\n${stderr}`));
		}, 10_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

test("bundled Undici survives a 64 KiB response FIN while its body is backpressured", async () => {
	const directory = await mkdtemp(join(tmpdir(), "railway-undici-finish-"));
	try {
		const runtimeBundle = await bundleUndiciRuntime(directory);
		const result = await runChild("fin", runtimeBundle);
		assert.equal(
			result.code,
			0,
			`child exited ${result.signal ?? result.code}\n${result.stdout}\n${result.stderr}`,
		);
		assert.match(result.stdout, /read 65536 bytes after FIN/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bundled Undici aborts an upstream response when the proxy client disconnects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "railway-undici-cancel-"));
	try {
		const runtimeBundle = await bundleUndiciRuntime(directory);
		const result = await runChild("disconnect", runtimeBundle);
		assert.equal(
			result.code,
			0,
			`child exited ${result.signal ?? result.code}\n${result.stdout}\n${result.stderr}`,
		);
		assert.match(result.stdout, /upstream closed after downstream disconnect/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bundled Undici consumes a response larger than 64 KiB normally", async () => {
	const directory = await mkdtemp(join(tmpdir(), "railway-undici-consumed-"));
	try {
		const runtimeBundle = await bundleUndiciRuntime(directory);
		const result = await runChild("consumed-control", runtimeBundle);
		assert.equal(
			result.code,
			0,
			`child exited ${result.signal ?? result.code}\n${result.stdout}\n${result.stderr}`,
		);
		assert.match(result.stdout, /consumed 131072 bytes before FIN/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
