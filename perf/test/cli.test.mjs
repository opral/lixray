import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const runner = resolve(import.meta.dirname, "../runner.mjs");

test("accepts the separator forwarded by pnpm scripts", () => {
  const result = spawnSync(process.execPath, [runner, "--", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/m);
});

test("rejects mutating warmups before opening a server connection", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "create-4k",
      "--warmups",
      "1",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /mutation operations require --warmups 0 and --samples 1/,
  );
});
