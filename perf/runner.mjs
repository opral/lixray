#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const baseUrl = (process.env.LIXRAY_PERF_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
);
const internalToken = process.env.LIXRAY_INTERNAL_TOKEN?.trim();
const storageBackend = process.env.LIXRAY_PERF_STORAGE ?? "s3-minio";

const [command, ...args] = process.argv.slice(2);

if (command === "seed") {
  await seed(args);
} else if (command === "run") {
  await run(args);
} else {
  fail("usage: node perf/runner.mjs <seed|run> [options]");
}

async function seed(args) {
  const fixturePath = resolve(
    root,
    option(args, "--fixture") ?? "perf/fixtures/slow-workspace.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  validateFixture(fixture);
  await waitForServer(fixture.workspaceId);

  const countResult = await execute(
    fixture.workspaceId,
    "SELECT COUNT(*) AS file_count FROM lix_file WHERE path LIKE '/perf/%'",
    [],
  );
  const existingCount = Number(countResult.rows?.[0]?.[0]?.value ?? 0);
  if (existingCount === fixture.fileCount) {
    console.log(
      `fixture already seeded: ${fixture.workspaceId} (${existingCount} files)`,
    );
    return;
  }
  if (existingCount > fixture.fileCount) {
    fail(
      `fixture contains ${existingCount} files, more than the expected ${fixture.fileCount}`,
    );
  }
  if (existingCount > 0) {
    console.log(
      `resuming fixture seed: ${fixture.workspaceId} (${existingCount}/${fixture.fileCount} files)`,
    );
  }

  const content = Buffer.alloc(fixture.contentBytes, "x").toString("base64");
  for (
    let offset = existingCount;
    offset < fixture.fileCount;
    offset += fixture.batchSize
  ) {
    const end = Math.min(offset + fixture.batchSize, fixture.fileCount);
    const statements = [];
    for (let index = offset; index < end; index += 1) {
      statements.push({
        sql: "INSERT INTO lix_file (path, data) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET data = excluded.data",
        params: [
          {
            kind: "text",
            value: `/perf/${String(index).padStart(4, "0")}.json`,
          },
          { kind: "blob", base64: content },
        ],
      });
    }
    await protocolRequest(fixture.workspaceId, "execute-batch", { statements });
    process.stdout.write(`\rseeded ${end}/${fixture.fileCount} files`);
  }
  process.stdout.write("\n");

  const finalResult = await execute(
    fixture.workspaceId,
    "SELECT COUNT(*) AS file_count FROM lix_file WHERE path LIKE '/perf/%'",
    [],
  );
  const finalCount = Number(finalResult.rows?.[0]?.[0]?.value ?? 0);
  if (finalCount !== fixture.fileCount) {
    fail(`seed verification failed: expected ${fixture.fileCount}, got ${finalCount}`);
  }
  console.log(`fixture ready: ${fixture.workspaceId} (${finalCount} files)`);
}

async function run(args) {
  const workloadPath = resolve(
    root,
    option(args, "--workload") ?? "perf/workloads/slow-queries.json",
  );
  const outputPath = resolve(
    root,
    option(args, "--output") ?? "perf/results/latest.json",
  );
  const comparePath = option(args, "--compare");
  const workload = JSON.parse(await readFile(workloadPath, "utf8"));
  validateWorkload(workload);
  await waitForServer(workload.workspaceId);

  const queries = [];
  for (const query of workload.queries) {
    for (let index = 0; index < workload.warmupRuns; index += 1) {
      await execute(workload.workspaceId, query.sql, query.params);
    }

    const samplesMs = [];
    for (let index = 0; index < workload.measuredRuns; index += 1) {
      const started = performance.now();
      await execute(workload.workspaceId, query.sql, query.params);
      samplesMs.push(performance.now() - started);
    }
    queries.push({ name: query.name, ...summarize(samplesMs), samplesMs });
  }

  const result = {
    version: 1,
    measuredAt: new Date().toISOString(),
    baseUrl,
    storageBackend,
    workspaceId: workload.workspaceId,
    workload: workloadPath.replace(`${root}/`, ""),
    warmupRuns: workload.warmupRuns,
    measuredRuns: workload.measuredRuns,
    queries,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let rows = queries.map((query) => ({
    query: query.name,
    "p50 ms": query.p50Ms.toFixed(2),
    "p95 ms": query.p95Ms.toFixed(2),
    "mean ms": query.meanMs.toFixed(2),
  }));

  if (comparePath) {
    const baseline = JSON.parse(
      await readFile(resolve(root, comparePath), "utf8"),
    );
    const baselineByName = new Map(
      baseline.queries.map((query) => [query.name, query]),
    );
    rows = rows.map((row, index) => {
      const current = queries[index];
      const previous = baselineByName.get(current.name);
      return {
        ...row,
        "p50 delta": previous
          ? percentageDelta(current.p50Ms, previous.p50Ms)
          : "n/a",
        "p95 delta": previous
          ? percentageDelta(current.p95Ms, previous.p95Ms)
          : "n/a",
      };
    });
  }

  console.table(rows);
  console.log(`wrote ${outputPath.replace(`${root}/`, "")}`);
}

async function waitForServer(workspaceId) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/lix/v1/`,
        { headers: requestHeaders() },
      );
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail(`lix-server was not ready after 60s: ${lastError}`);
}

async function execute(workspaceId, sql, params) {
  return protocolRequest(workspaceId, "execute", { sql, params });
}

async function protocolRequest(workspaceId, operation, body) {
  const response = await fetch(
    `${baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/lix/v1/${operation}`,
    {
      method: "POST",
      headers: requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    fail(`${operation} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function requestHeaders(headers = {}) {
  return internalToken
    ? { ...headers, authorization: `Bearer ${internalToken}` }
    : headers;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    meanMs: sum / sorted.length,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function percentageDelta(current, previous) {
  const delta = ((current - previous) / previous) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) fail(`${name} requires a value`);
  return args[index + 1];
}

function validateFixture(fixture) {
  for (const key of ["workspaceId", "fileCount", "contentBytes", "batchSize"]) {
    if (!fixture[key]) fail(`fixture is missing ${key}`);
  }
}

function validateWorkload(workload) {
  if (!workload.workspaceId || !Array.isArray(workload.queries)) {
    fail("workload requires workspaceId and queries");
  }
  if (workload.warmupRuns < 0 || workload.measuredRuns < 1) {
    fail("workload run counts are invalid");
  }
  for (const query of workload.queries) {
    if (!query.name || !query.sql || !Array.isArray(query.params)) {
      fail("each workload query requires name, sql, and params");
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
