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

test("rejects unsupported corpus sizes before opening a server connection", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-files-check",
      "--operation",
      "read-point-4k",
      "--files",
      "2000",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--files must be one of: 1000, 5000/);
});

test("requires enough commits for the transport-bounded 5,000-file seed", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-commits-check",
      "--operation",
      "read-point-4k",
      "--files",
      "5000",
      "--commits",
      "2",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--commits must be at least 6 for --files 5000/);
});
