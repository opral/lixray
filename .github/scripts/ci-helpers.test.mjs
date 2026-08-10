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
		ss: "exit 1\n",
		supabase: 'printf "%s\\n" "$*" >> "$MOCK_CALLS"\n',
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(calls.trim().split("\n"), [
		"stop --all --no-backup",
		"start --exclude edge-runtime,gotrue,imgproxy,kong,logflare,mailpit,postgres-meta,postgrest,realtime,storage-api,studio,supavisor,vector",
		"test db",
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

test("server-image helper exports and pulls the immutable digest", async () => {
	const output = path.join(
		await mkdtemp(path.join(os.tmpdir(), "lixray-image-output-")),
		"github-output",
	);
	await writeFile(output, "");
	const { calls, result } = await runWithMocks(
		"wait-for-server-image.sh",
		{
			docker: `
printf "%s\\n" "$*" >> "$MOCK_CALLS"
if test "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect"; then
	printf "sha256:0123456789abcdef\\n"
fi
`,
			git: 'printf "0123456789abcdef0123456789abcdef01234567\\n"\n',
		},
		{
			GITHUB_OUTPUT: output,
			GITHUB_REPOSITORY_OWNER: "Opral",
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		await readFile(output, "utf8"),
		/^image=ghcr\.io\/opral\/lixray-server@sha256:0123456789abcdef$/m,
	);
	assert.match(
		calls,
		/pull ghcr\.io\/opral\/lixray-server@sha256:0123456789abcdef/,
	);
});
