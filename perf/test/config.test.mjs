import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "scripts/validate-lix-uuid.sh");

test("the destructive benchmark reset accepts only canonical UUIDs", () => {
  const valid = spawnSync("/bin/sh", [
    validator,
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.equal(valid.status, 0);

  for (const invalid of [
    "perf-cli-check",
    "1111111--111-4111-8111-111111111111",
    "------------------------------------",
    "11111111-1111-4111-8111-11111111111A",
  ]) {
    const result = spawnSync("/bin/sh", [validator, invalid]);
    assert.equal(result.status, 2, invalid);
  }
});

test("benchmark reset is isolated from ordinary local Lix storage", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json")));
  const compose = readFileSync(resolve(root, "compose.yml"), "utf8");

  assert.match(
    packageJson.scripts["perf:up"],
    /LIXRAY_STORAGE_PREFIX=local\/perf/,
  );
  assert.match(compose, /S3_PREFIX: \$\{LIXRAY_STORAGE_PREFIX:-local\}/);
  assert.match(
    compose,
    /local\/lixray\/local\/perf\/\$\$\{LIXRAY_PERF_REPOSITORY\}\//,
  );
});
