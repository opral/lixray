import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "../..");

async function executable(directory, name, source) {
	const filename = path.join(directory, name);
	await writeFile(filename, `#!/usr/bin/env bash\nset -euo pipefail\n${source}`);
	await chmod(filename, 0o755);
}

async function runWithMocks(script, mocks, extraEnv = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lixray-ci-test-"));
	const calls = path.join(directory, "calls");
	await writeFile(calls, "");
	for (const [name, source] of Object.entries(mocks)) {
		await executable(directory, name, source);
	}
	const result = spawnSync(path.join(scriptsDirectory, script), {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: {
			...process.env,
			...extraEnv,
			MOCK_CALLS: calls,
			PATH: `${directory}:${process.env.PATH}`,
		},
	});
	return { calls: await readFile(calls, "utf8"), result };
}

test("database helper cleans every stack before and after testing", async () => {
	const { calls, result } = await runWithMocks("test-database.sh", {
		docker: "exit 1\n",
		node: 'printf "node %s\\n" "$*" >> "$MOCK_CALLS"\n',
		ss: "exit 1\n",
		supabase: 'printf "%s\\n" "$*" >> "$MOCK_CALLS"\n',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(calls.trim().split("\n"), [
		"stop --all --no-backup",
		"start --exclude edge-runtime,imgproxy,kong,logflare,mailpit,postgres-meta,realtime,storage-api,studio,supavisor,vector",
		"test db",
		`node --experimental-strip-types ${repositoryRoot}/database/scripts/test-oauth-resource.mjs`,
		"stop --all --no-backup",
	]);
});

test("database helper fails before startup when the port remains occupied", async () => {
	const { calls, result } = await runWithMocks("test-database.sh", {
		docker: 'printf "container\\tforeign-postgres\\t0.0.0.0:54322->5432/tcp\\n"\n',
		ss: 'printf "LISTEN 0 4096 0.0.0.0:54322 0.0.0.0:*\\n"\n',
		supabase: 'printf "%s\\n" "$*" >> "$MOCK_CALLS"\n',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /port 54322 is still occupied/);
	assert.deepEqual(calls.trim().split("\n"), [
		"stop --all --no-backup",
		"stop --all --no-backup",
	]);
});

test("submodule validation checks each configured vendored branch", async () => {
	const { calls, result } = await runWithMocks("validate-submodule-branches.sh", {
		git: 'printf "%s %s\\n" "$1" "$2" >> "$MOCK_CALLS"\n',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(calls.trim(), "submodule foreach");
});
