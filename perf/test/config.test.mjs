import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "scripts/validate-lix-uuid.sh");

test("the destructive benchmark reset accepts only canonical UUIDs", () => {
  const valid = spawnSync("/bin/sh", [validator, "11111111-1111-4111-8111-111111111111"]);
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

  assert.equal(packageJson.scripts["perf:up"], "node scripts/perf-compose.mjs up");
  const fixtureBin = mkdtempSync(resolve(tmpdir(), "lixray-perf-compose-"));
  try {
    writeFileSync(
      resolve(fixtureBin, "docker"),
      `#!${process.execPath}
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), prefix: process.env.LIXRAY_STORAGE_PREFIX, image: process.env.LIXRAY_SERVER_IMAGE }));
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [resolve(root, "scripts/perf-compose.mjs"), "up"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureBin}:${process.env.PATH}`,
        LIXRAY_SERVER_IMAGE: "test-image",
        LIXRAY_STORAGE_PREFIX: "ordinary-storage",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["compose", "up", "-d", "lix-server"],
      prefix: "local/perf",
      image: "test-image",
    });
  } finally {
    rmSync(fixtureBin, { recursive: true, force: true });
  }
  assert.match(compose, /S3_PREFIX: \$\{LIXRAY_STORAGE_PREFIX:-local\}/);
  assert.match(compose, /local\/lixray\/local\/perf\/\$\$\{LIXRAY_PERF_REPOSITORY\}\//);
});

test("local Lix server advertises the web gateway origin", () => {
  const compose = readFileSync(resolve(root, "compose.yml"), "utf8");
  const dev = readFileSync(resolve(root, "scripts/dev.mjs"), "utf8");
  assert.match(
    compose,
    /LIX_SERVER_PUBLIC_URL: \$\{LIXRAY_PUBLIC_URL:-http:\/\/127\.0\.0\.1:8787\}/,
  );
  assert.match(dev, /LIXRAY_PUBLIC_URL: `http:\/\/\$\{devHost\}:\$\{devPort\}`/);
});
