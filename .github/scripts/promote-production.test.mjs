import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const coordinator = resolve(import.meta.dirname, "promote-production.sh");

test("promotes both immutable images and waits for both deployments", async () => {
  const fixture = await createFixture();
  const result = runCoordinator(fixture, {
    MOCK_SERVER_STATUS: "SUCCESS",
    MOCK_WEB_STATUS: "SUCCESS",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Railway production release is healthy/);
  assert.match(await readFile(fixture.output, "utf8"), /web_deployment_id=new-web-service/);
  const calls = await readFile(fixture.calls, "utf8");
  assert.match(calls, /ghcr\.io\/opral\/lixray-web@sha256:web/);
  assert.match(calls, /ghcr\.io\/opral\/lixray-server@sha256:server/);
});

test("fails immediately when either deployment reaches a terminal state", async () => {
  const fixture = await createFixture();
  const result = runCoordinator(fixture, {
    MOCK_SERVER_STATUS: "FAILED",
    MOCK_WEB_STATUS: "SUCCESS",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ended with FAILED/);
});

test("prints bounded deployment logs when Railway never becomes healthy", async () => {
  const fixture = await createFixture();
  const result = runCoordinator(fixture, {
    MOCK_SERVER_STATUS: "DEPLOYING",
    MOCK_WEB_STATUS: "DEPLOYING",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become healthy/);
  assert.match(result.stdout, /mock deployment log for new-web-service/);
  assert.match(result.stdout, /mock deployment log for new-server-service/);
});

test("uses preview deployment policy for a CI-managed PR environment", async () => {
  const fixture = await createFixture();
  const result = runCoordinator(
    fixture,
    {
      MOCK_SERVER_STATUS: "SUCCESS",
      MOCK_WEB_STATUS: "SUCCESS",
    },
    {
      RAILWAY_DEPLOY_POLICY: "pr",
      RAILWAY_RELEASE_LABEL: "preview",
      RAILWAY_TARGET_ENVIRONMENT: "preview-environment",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Railway preview release is healthy/);
  const calls = await readFile(fixture.calls, "utf8");
  assert.match(calls, /"sleepApplication":true/);
  assert.match(calls, /"environmentId":"preview-environment"/);
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "lixray-promotion-"));
  const calls = join(directory, "calls.jsonl");
  const deployed = join(directory, "deployed");
  const railway = join(directory, "railway");
  const curl = join(directory, "curl");

  await writeFile(
    railway,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${1:-}"
shift || true
service=""
deployment=""
while test "$#" -gt 0; do
	if test "$1" = --service; then
		service="$2"
		shift 2
	elif [[ "$1" != --* ]]; then
		deployment="$1"
		shift
	else
		shift
		if test "$#" -gt 0 && [[ "$1" != --* ]]; then shift; fi
	fi
done
if test "$command" = logs; then
	printf 'mock deployment log for %s\n' "$deployment"
	exit 0
fi
if grep -qx "$service" "$MOCK_DEPLOYED" 2>/dev/null; then
	if test "$service" = "$RAILWAY_WEB_SERVICE"; then status="$MOCK_WEB_STATUS"; else status="$MOCK_SERVER_STATUS"; fi
	printf '[{"id":"new-%s","status":"%s"}]\n' "$service" "$status"
else
	printf '[{"id":"old-%s","status":"SUCCESS"}]\n' "$service"
fi
`,
  );
  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
payload=""
while test "$#" -gt 0; do
	if test "$1" = --data-binary; then payload="$2"; shift 2; else shift; fi
done
printf '%s\n' "$payload" >> "$MOCK_CALLS"
service="$(jq -r '.variables.serviceId' <<<"$payload")"
if jq -e '.query | contains("serviceInstanceUpdate")' <<<"$payload" >/dev/null; then
	printf '{"data":{"serviceInstanceUpdate":true}}\n'
else
	printf '%s\n' "$service" >> "$MOCK_DEPLOYED"
	printf '{"data":{"serviceInstanceDeploy":true}}\n'
fi
`,
  );
  await Promise.all([chmod(railway, 0o755), chmod(curl, 0o755)]);
  return { calls, curl, deployed, directory, output: join(directory, "output"), railway };
}

function runCoordinator(fixture, statuses, extraEnv = {}) {
  return spawnSync("bash", [coordinator], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...statuses,
      ...extraEnv,
      GHCR_READ_TOKEN: "registry-token",
      GHCR_READ_USERNAME: "registry-user",
      GITHUB_STEP_SUMMARY: join(fixture.directory, "summary.md"),
      GITHUB_OUTPUT: fixture.output,
      MOCK_CALLS: fixture.calls,
      MOCK_DEPLOYED: fixture.deployed,
      PATH: `${fixture.directory}:${process.env.PATH}`,
      POLL_ATTEMPTS: "2",
      POLL_INTERVAL_SECONDS: "0",
      RAILWAY_API_TOKEN: "railway-token",
      RAILWAY_BIN: fixture.railway,
      RAILWAY_PRODUCTION_ENVIRONMENT: "production",
      RAILWAY_PROJECT_ID: "project",
      RAILWAY_SERVER_SERVICE: "server-service",
      RAILWAY_WEB_SERVICE: "web-service",
      SERVER_IMAGE: "ghcr.io/opral/lixray-server@sha256:server",
      WEB_IMAGE: "ghcr.io/opral/lixray-web@sha256:web",
    },
  });
}
