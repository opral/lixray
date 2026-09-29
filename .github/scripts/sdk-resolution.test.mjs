import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("SDK resolve-only mode reports misses without requiring any Rust toolchain", (t) => {
	const root = mkdtempSync(join(tmpdir(), "lix-sdk-resolve-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of [
		"scripts",
		"vendor/lix/packages/js-sdk/src",
		"vendor/lix/packages/storage-opfs/dist",
	])
		mkdirSync(join(root, directory), { recursive: true });
	for (const file of ["prepare-vendored-lix-sdk.mjs", "lix-ci-artifacts.mjs"])
		cpSync(join(repository, "scripts", file), join(root, "scripts", file));
	const git = (...args) =>
		execFileSync("git", args, {
			cwd: join(root, "vendor/lix"),
			encoding: "utf8",
		});
	git("init", "--quiet");
	git(
		"-c",
		"user.name=CI test",
		"-c",
		"user.email=ci@example.test",
		"commit",
		"--allow-empty",
		"--quiet",
		"-m",
		"fixture",
	);
	const output = join(root, "outputs");
	const run = (skip = "0") =>
		spawnSync(
			process.execPath,
			[join(root, "scripts/prepare-vendored-lix-sdk.mjs"), "--resolve-only"],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					LIXRAY_LIX_ARTIFACTS: "off",
					LIXRAY_SKIP_VENDORED_LIX_WASM: skip,
					GITHUB_OUTPUT: output,
				},
			},
		);
	let result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(output, "utf8"), "ready=false\n");
	assert.doesNotMatch(result.stdout, /SOURCE BUILD/);
	// An already prepared exact-revision artifact takes the hit path, also
	// without a toolchain, package manager, or build scripts in this fixture.
	const sdk = join(root, "vendor/lix/packages/js-sdk");
	mkdirSync(join(sdk, "dist/wasm"), { recursive: true });
	writeFileSync(join(sdk, "dist/index.js"), "export {};");
	mkdirSync(join(sdk, "dist/migration-wasm"), { recursive: true });
	writeFileSync(join(sdk, "dist/migration.js"), "export {};");
	writeFileSync(join(sdk, "dist/migration-wasm/lix_js_sdk_bg.wasm"), "fixture");
	writeFileSync(join(root, "vendor/lix/packages/storage-opfs/dist/migration.worker.js"), "export {};");
	writeFileSync(join(sdk, "dist/wasm/lix_js_sdk_bg.wasm"), "fixture");
	writeFileSync(
		join(root, "vendor/lix/packages/storage-opfs/dist/index.js"),
		"export {};",
	);
	writeFileSync(
		join(sdk, "dist/.lixray-browser-build.json"),
		JSON.stringify({ source: "calling-workflow", sourceRevision: git("rev-parse", "HEAD").trim() }),
	);
	writeFileSync(output, "");
	result = run("1");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(output, "utf8"), "ready=false\n");
	assert.doesNotMatch(result.stdout, /Adopting/);
	writeFileSync(
		join(sdk, "dist/.lixray-browser-build.json"),
		JSON.stringify({ source: "lix-ci-artifact", sourceRevision: git("rev-parse", "HEAD").trim() }),
	);
	writeFileSync(output, "");
	result = run("1");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(output, "utf8"), "ready=true\n");
	assert.doesNotMatch(result.stdout, /SOURCE BUILD/);
});
