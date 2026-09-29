import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "preview-pr-state.sh");

async function check(state, prNumber = "513") {
  const directory = await mkdtemp(join(tmpdir(), "lixray-preview-state-"));
  const output = join(directory, "output");
  const calls = join(directory, "calls");
  const gh = join(directory, "gh");
  await writeFile(gh, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_GH_CALLS"
if test "$MOCK_GH_STATE" = api-error; then exit 23; fi
printf '%s\\n' "$MOCK_GH_STATE"
`);
  await chmod(gh, 0o755);
  try {
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "opral/lixray",
        GITHUB_OUTPUT: output,
        PR_NUMBER: prNumber,
        MOCK_GH_STATE: state,
        MOCK_GH_CALLS: calls,
      },
    });
    return {
      ...result,
      output: await readFile(output, "utf8").catch(() => ""),
      calls: await readFile(calls, "utf8").catch(() => ""),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("open PR admits preview creation", async () => {
  const result = await check("open");
  assert.equal(result.status, 0);
  assert.equal(result.output, "open=true\n");
  assert.equal(result.calls, "api repos/opral/lixray/pulls/513 --jq .state\n");
});

test("closed PR skips obsolete preview without failing CI", async () => {
  const result = await check("closed");
  assert.equal(result.status, 0);
  assert.equal(result.output, "open=false\n");
  assert.match(result.stdout, /preview creation is obsolete/);
});

test("unknown state and API failure cannot admit a preview", async () => {
  for (const state of ["unknown", "api-error"]) {
    const result = await check(state);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
  }
});

test("invalid PR number is rejected before API access", async () => {
  const result = await check("open", "513/other");
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, "");
});
