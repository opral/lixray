import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const manager = resolve(import.meta.dirname, "manage-railway-preview.sh");

test("creates an ephemeral preview without initial source deployments", async () => {
  const fixture = await createFixture("production-only");
  const result = runManager(fixture, "ensure");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created Railway preview environment lixray-pr-214/);
  assert.match(await readFile(fixture.output, "utf8"), /environment_id=preview-id/);
  const calls = await readFile(fixture.calls, "utf8");
  assert.match(calls, /"name":"lixray-pr-214"/);
  assert.match(calls, /"sourceEnvironmentId":"production-id"/);
  assert.match(calls, /"ephemeral":true/);
  assert.match(calls, /"skipInitialDeploys":true/);
});

test("reuses an existing named preview", async () => {
  const fixture = await createFixture("with-preview");
  const result = runManager(fixture, "ensure", false);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing Railway preview environment/);
  assert.match(await readFile(fixture.output, "utf8"), /environment_id=existing-preview/);
  assert.doesNotMatch(await readFile(fixture.calls, "utf8"), /environmentCreate/);
});

test("deletes the exact CI-managed preview on PR close", async () => {
  const fixture = await createFixture("with-preview");
  const result = runManager(fixture, "delete");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deleted Railway preview environment/);
  assert.match(await readFile(fixture.calls, "utf8"), /environmentDelete/);
  assert.match(await readFile(fixture.calls, "utf8"), /existing-preview/);
});

async function createFixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "lixray-preview-"));
  const calls = join(directory, "calls.jsonl");
  const output = join(directory, "github-output");
  const curl = join(directory, "curl");
  await Promise.all([writeFile(calls, ""), writeFile(output, "")]);
  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
payload=""
while test "$#" -gt 0; do
	if test "$1" = --data-binary; then payload="$2"; shift 2; else shift; fi
done
printf '%s\n' "$payload" >> "$MOCK_CALLS"
if jq -e '.query | contains("environmentCreate")' <<<"$payload" >/dev/null; then
	printf '{"data":{"environmentCreate":{"id":"preview-id","name":"lixray-pr-214"}}}\n'
elif jq -e '.query | contains("environmentDelete")' <<<"$payload" >/dev/null; then
	printf '{"data":{"environmentDelete":true}}\n'
elif test "$MOCK_MODE" = with-preview; then
	printf '{"data":{"project":{"environments":{"edges":[{"node":{"id":"production-id","name":"preview-base"}},{"node":{"id":"existing-preview","name":"lixray-pr-214"}}]}}}}\n'
else
	printf '{"data":{"project":{"environments":{"edges":[{"node":{"id":"production-id","name":"preview-base"}}]}}}}\n'
fi
`,
  );
  await chmod(curl, 0o755);
  return { calls, directory, mode, output };
}

function runManager(fixture, action, includePreviewBase = true) {
  return spawnSync("bash", [manager, action], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: fixture.output,
      MOCK_CALLS: fixture.calls,
      MOCK_MODE: fixture.mode,
      PATH: `${fixture.directory}:${process.env.PATH}`,
      PR_NUMBER: "214",
      RAILWAY_API_TOKEN: "railway-token",
      RAILWAY_PROJECT_ID: "project",
      ...(includePreviewBase ? { RAILWAY_PREVIEW_BASE_ENVIRONMENT: "preview-base" } : {}),
    },
  });
}
