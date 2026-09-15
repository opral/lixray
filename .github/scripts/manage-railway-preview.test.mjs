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

test("publishes a Railway domain for the GitHub deployment URL", async () => {
  const fixture = await createFixture("with-preview");
  const result = runManager(fixture, "url", false);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/lixray-pr-214\.up\.railway\.app/);
  assert.match(
    await readFile(fixture.output, "utf8"),
    /preview_url=https:\/\/lixray-pr-214\.up\.railway\.app/,
  );
  const calls = await readFile(fixture.calls, "utf8");
  assert.match(calls, /railway domain list/);
  assert.match(calls, /--environment existing-preview/);
  assert.match(calls, /--service web-service/);
});

test("reconciliation discovers only exact managed preview names", async () => {
  const fixture = await createFixture("with-preview");
  const result = runManager(fixture, "list-previews");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["214"]);
  assert.doesNotMatch(await readFile(fixture.calls, "utf8"), /environmentDelete/);
});

for (const state of ["open", "closed", "unknown", "api-error"]) {
  test(`reconciliation handles GitHub PR state ${state} safely`, async () => {
    const fixture = await createFixture("with-preview");
    const result = runManager(fixture, "delete-if-closed", true, { MOCK_PR_STATE: state });
    assert.equal(result.status === 0, ["open", "closed"].includes(state), result.stderr);
    const calls = await readFile(fixture.calls, "utf8");
    if (state === "closed") {
      assert.match(calls, /environmentDelete/);
      assert.match(calls, /"id":"existing-preview"/);
    } else {
      assert.doesNotMatch(calls, /environmentDelete/);
    }
  });
}

test("rejects malformed PR numbers before any API call", async () => {
  const fixture = await createFixture("with-preview");
  for (const value of ["production", "../production", "0", "214-extra", "-1"]) {
    const result = runManager(fixture, "delete", true, { PR_NUMBER: value });
    assert.notEqual(result.status, 0);
  }
  assert.equal(await readFile(fixture.calls, "utf8"), "");
});

test("deleting an absent preview is idempotent", async () => {
  const fixture = await createFixture("production-only");
  const result = runManager(fixture, "delete-if-closed");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(await readFile(fixture.calls, "utf8"), /environmentDelete/);
});

test("refuses configured production or preview-base even if misnamed", async () => {
  for (const variable of ["RAILWAY_PRODUCTION_ENVIRONMENT", "RAILWAY_PREVIEW_BASE_ENVIRONMENT"]) {
    const fixture = await createFixture("with-preview");
    const result = runManager(fixture, "delete", true, { [variable]: "existing-preview" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /protected Railway environment/);
    assert.doesNotMatch(await readFile(fixture.calls, "utf8"), /environmentDelete/);
  }
});

async function createFixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "lixray-preview-"));
  const calls = join(directory, "calls.jsonl");
  const output = join(directory, "github-output");
  const curl = join(directory, "curl");
  const railway = join(directory, "railway");
  const gh = join(directory, "gh");
  await writeFile(gh, `#!/usr/bin/env bash
set -euo pipefail
if test "$MOCK_PR_STATE" = api-error; then exit 1; fi
printf '%s\\n' "$MOCK_PR_STATE"
`);
  await chmod(gh, 0o755);
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
	printf '{"data":{"project":{"environments":{"edges":[{"node":{"id":"production-id","name":"preview-base"}},{"node":{"id":"existing-preview","name":"lixray-pr-214"}},{"node":{"id":"production","name":"production"}},{"node":{"id":"unmanaged","name":"lixray-pr-214-backup"}}]}}}}\n'
else
	printf '{"data":{"project":{"environments":{"edges":[{"node":{"id":"production-id","name":"preview-base"}}]}}}}\n'
fi
`,
  );
  await writeFile(
    railway,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'railway %s\n' "$*" >> "$MOCK_CALLS"
if test "$1" = domain && test "\${2:-}" = list; then
	printf '{"serviceDomains":[]}\n'
elif test "$1" = domain; then
	printf '{"domain":"lixray-pr-214.up.railway.app"}\n'
else
	exit 2
fi
`,
  );
  await Promise.all([chmod(curl, 0o755), chmod(railway, 0o755)]);
  return { calls, directory, mode, output, railway };
}

function runManager(fixture, action, includePreviewBase = true, overrides = {}) {
  return spawnSync("bash", [manager, action], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: fixture.output,
      MOCK_CALLS: fixture.calls,
      MOCK_MODE: fixture.mode,
      MOCK_PR_STATE: "closed",
      GITHUB_REPOSITORY: "opral/lixray",
      PATH: `${fixture.directory}:${process.env.PATH}`,
      PR_NUMBER: "214",
      RAILWAY_API_TOKEN: "railway-token",
      RAILWAY_BIN: fixture.railway,
      RAILWAY_PROJECT_ID: "project",
      RAILWAY_WEB_SERVICE: "web-service",
      ...(includePreviewBase ? { RAILWAY_PREVIEW_BASE_ENVIRONMENT: "preview-base" } : {}),
      ...overrides,
    },
  });
}

test("close and reconciliation cleanup share the deployment lock without cancellation", async () => {
  const cleanup = await readFile(resolve(repositoryRoot, ".github/workflows/railway-preview-cleanup.yml"), "utf8");
  const pr = await readFile(resolve(repositoryRoot, ".github/workflows/pr.yml"), "utf8");
  assert.match(cleanup, /schedule:\n\s+- cron:/);
  assert.match(cleanup, /workflow_dispatch:/);
  assert.match(cleanup, /group: railway-preview-\$\{\{ matrix.pr \}\}\n\s+cancel-in-progress: false/);
  assert.match(pr, /group: railway-preview-\$\{\{ github.event.pull_request.number \}\}\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(cleanup, /cancel-in-progress: true/);
  assert.match(pr, /cancel-in-progress: \$\{\{ github.event.action != 'closed' \}\}/);
  assert.match(cleanup, /manage-railway-preview.sh list-previews/);
  assert.match(cleanup, /manage-railway-preview.sh delete-if-closed/);
  assert.match(pr, /Retire preview if PR closed during deployment\n\s+if: always\(\)/);
  assert.match(pr, /state=.*gh api[\s\S]*?test "\$state" = open[\s\S]*?manage-railway-preview.sh ensure/);
});
