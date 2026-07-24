import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const runner = resolve(import.meta.dirname, "../runner.mjs");

test("accepts the separator forwarded by pnpm scripts", () => {
  const result = spawnSync(process.execPath, [runner, "--", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/m);
  assert.match(result.stdout, /--files <1000\|5000\|10000>/);
  assert.match(result.stdout, /--storage-backend <slatedb\|rocksdb>/);
  assert.match(result.stdout, /--file-read-transport <json\|binary>/);
});

test("rejects a declared backend that disagrees with health before handshake", async (t) => {
  let healthRequests = 0;
  let protocolRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      healthRequests += 1;
      if (healthRequests === 1) {
        response.statusCode = 503;
        response.end("starting");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          service: "lix-server",
          storageBackend: "slatedb",
          storageLayout: "lix-slatedb-lz4-v1",
        }),
      );
      return;
    }
    protocolRequests += 1;
    response.statusCode = 500;
    response.end("protocol must not be opened after an identity mismatch");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  );
  const address = server.address();
  assert.notEqual(typeof address, "string");

  const result = await runRunner([
    "--workspace",
    "perf-attestation-mismatch",
    "--operation",
    "read-point-4k",
    "--files",
    "1000",
    "--commits",
    "2",
    "--warmups",
    "0",
    "--samples",
    "1",
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--storage-backend",
    "rocksdb",
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /declared storage backend rocksdb does not match server attestation slatedb/,
  );
  assert.equal(healthRequests, 2);
  assert.equal(protocolRequests, 0);
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

test("requires a preseeded clone for hot-session mutation distributions", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "update-4k",
      "--samples",
      "2",
      "--hot-session",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--hot-session requires --preseeded/);
});

test("requires full deterministic cycles for mixed hot writes", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "update-mixed",
      "--samples",
      "2",
      "--hot-session",
      "--preseeded",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --samples to be a multiple of 10/);
});

test("requires raw transport for the native mixed comparison", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "update-mixed-native-batch",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /require --file-write-transport binary/);
});

test("rejects binary file reads for operations without an exact-file endpoint", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "list-paths-100",
      "--file-read-transport",
      "binary",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--file-read-transport binary is only valid for exact point-read operations/,
  );
});

test("rejects hot sessions for the native mixed comparison", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "update-mixed-native-batch",
      "--file-write-transport",
      "binary",
      "--samples",
      "2",
      "--hot-session",
      "--preseeded",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /require isolated one-sample workspaces/);
});

test("rejects corpus sizes outside the reproducible matrix", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "read-point-4k",
      "--files",
      "2000",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--files must be one of: 1000, 5000, 10000/);
});

test("requires enough commits to cover all fixed-size seed commits", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "read-point-4k",
      "--files",
      "5000",
      "--commits",
      "5",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--commits must be at least 6 for --files 5000: genesis plus 5 seed commits/,
  );
});

test("requires the extra targeted seed commit for read-point-2m", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      "--workspace",
      "perf-cli-check",
      "--operation",
      "read-point-2m",
      "--files",
      "1000",
      "--commits",
      "2",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--commits must be at least 3 for --files 1000: genesis plus 2 seed commits including 1 targeted fixture seed commit/,
  );
});

function runRunner(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [runner, "--", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (status, signal) => {
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}
