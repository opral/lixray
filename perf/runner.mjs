#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isMutationOperation,
  minimumTotalCommitsForOperation,
  operationNames,
  runBenchmark,
} from "./lib/benchmark.mjs";
import {
  CORPUS_FILE_COUNT,
  SEED_FILES_PER_COMMIT,
  SUPPORTED_CORPUS_FILE_COUNTS,
} from "./lib/corpus.mjs";
import {
  ProtocolClient,
  ProtocolError,
  readServerStorageIdentity,
  ServerIdentityError,
} from "./lib/protocol.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(args) {
  // pnpm 10 forwards the conventional script/argument separator to the
  // script itself. Accept exactly one leading separator so the documented
  // `pnpm perf:run -- --workspace ...` form reaches the real option parser.
  args = args[0] === "--" ? args.slice(1) : args;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const config = parseArgs(args);
  const client = new ProtocolClient({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    internalToken: process.env.LIXRAY_INTERNAL_TOKEN?.trim(),
  });

  let primaryError;
  const startedAt = new Date().toISOString();
  // Revision discovery runs git subprocesses. Finish it before opening the
  // runtime so cold/preseeded measurements cannot overlap repository I/O.
  const revisions = await readRevisions(config.targetRevision);

  try {
    const storageIdentity = await readStorageIdentityWhenReady(
      config.baseUrl,
      config.readyTimeoutMs,
    );
    if (
      config.declaredStorageBackend !== null &&
      config.declaredStorageBackend !== storageIdentity.storageBackend
    ) {
      throw new Error(
        `declared storage backend ${config.declaredStorageBackend} does not match server attestation ${storageIdentity.storageBackend}`,
      );
    }
    const handshake = await openWhenReady(client, config.readyTimeoutMs);
    const benchmark = await runBenchmark(client, {
      operation: config.operation,
      targetTotalCommits: config.targetTotalCommits,
      corpusFiles: config.corpusFiles,
      preconditionReadRuns: config.preconditionReadRuns,
      settleMs: config.settleMs,
      warmupRuns: config.warmupRuns,
      measuredRuns: config.measuredRuns,
      fileWriteTransport: config.fileWriteTransport,
      fileWriteShape: config.fileWriteShape,
      hotSession: config.hotSession,
      preseeded: config.preseeded,
      onProgress: config.quiet ? undefined : showProgress,
    });
    const report = {
      schemaVersion: 4,
      benchmark: "lixray-e2e-crud",
      startedAt,
      finishedAt: new Date().toISOString(),
      revisions,
      target: {
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
        storageBackend: storageIdentity.storageBackend,
        storageLayout: storageIdentity.storageLayout,
        storageCohort: config.storageCohort,
      },
      methodology: benchmark.methodology,
      corpus: benchmark.corpus,
      setup: {
        handshake: {
          elapsedMs: handshake.elapsedMs,
          protocolVersion: handshake.protocolVersion,
          activeBranchId: handshake.activeBranchId,
          capabilities: handshake.capabilities,
        },
        ...benchmark.setup,
      },
      measurement: benchmark.measurement,
      postTimingAccounting: benchmark.postTimingAccounting,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    printResult(report, config.outputPath);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (client.hasSession) {
      try {
        await client.close();
      } catch (closeError) {
        if (primaryError) {
          console.error(
            `session close also failed: ${
              closeError instanceof Error ? closeError.message : closeError
            }`,
          );
        } else {
          throw closeError;
        }
      }
    }
  }
}

function parseArgs(args) {
  const values = new Map();
  const booleanFlags = new Set(["--hot-session", "--preseeded", "--quiet"]);
  const allowed = new Set([
    "--url",
    "--workspace",
    "--operation",
    "--files",
    "--commits",
    "--precondition-reads",
    "--settle-ms",
    "--warmups",
    "--samples",
    "--file-write-transport",
    "--file-write-shape",
    "--output",
    "--ready-timeout-ms",
    "--target-revision",
    "--storage-backend",
    "--storage-cohort",
    ...booleanFlags,
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name)) {
      throw new Error(`unknown option ${name}\n\n${usage()}`);
    }
    if (booleanFlags.has(name)) {
      values.set(name, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }

  const operation = required(values, "--operation");
  if (!operationNames.includes(operation)) {
    throw new Error(
      `--operation must be one of: ${operationNames.join(", ")}`,
    );
  }

  const workspaceId = required(values, "--workspace");
  if (!/^perf-[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/.test(workspaceId)) {
    throw new Error(
      "--workspace must start with 'perf-' and use at most 128 letters, digits, '.', '_' or '-'",
    );
  }

  const corpusFiles = integer(values, "--files", CORPUS_FILE_COUNT, 1);
  if (!SUPPORTED_CORPUS_FILE_COUNTS.includes(corpusFiles)) {
    throw new Error(
      `--files must be one of: ${SUPPORTED_CORPUS_FILE_COUNTS.join(", ")}`,
    );
  }
  const minimumTotalCommits = minimumTotalCommitsForOperation(
    operation,
    corpusFiles,
  );
  const targetTotalCommits = integer(values, "--commits", 1_000, 1);
  if (targetTotalCommits < minimumTotalCommits) {
    const targetedFixture = operation === "read-point-2m";
    throw new Error(
      `--commits must be at least ${minimumTotalCommits} for --files ${corpusFiles}: genesis plus ${minimumTotalCommits - 1} seed commits${
        targetedFixture ? " including 1 targeted fixture seed commit" : ""
      }`,
    );
  }
  const preconditionReadRuns = integer(
    values,
    "--precondition-reads",
    0,
    0,
  );
  const settleMs = integer(values, "--settle-ms", 0, 0);
  const fileWriteTransport = values.get("--file-write-transport") ?? "json";
  if (!["binary", "json"].includes(fileWriteTransport)) {
    throw new Error('--file-write-transport must be either "binary" or "json"');
  }
  if (
    ["update-mixed-native-single", "update-mixed-native-batch"].includes(
      operation,
    ) &&
    fileWriteTransport !== "binary"
  ) {
    throw new Error(
      "native mixed file-update comparisons require --file-write-transport binary",
    );
  }
  const fileWriteShape = values.get("--file-write-shape") ?? "update";
  if (!["update", "upsert"].includes(fileWriteShape)) {
    throw new Error('--file-write-shape must be either "update" or "upsert"');
  }
  const mutationOperation = isMutationOperation(operation);
  const warmupRuns = integer(
    values,
    "--warmups",
    mutationOperation ? 0 : 3,
    0,
  );
  const measuredRuns = integer(
    values,
    "--samples",
    mutationOperation ? 1 : 30,
    1,
  );
  const hotSession = values.has("--hot-session");
  const preseeded = values.has("--preseeded");
  if (
    hotSession &&
    ["update-mixed-native-single", "update-mixed-native-batch"].includes(
      operation,
    )
  ) {
    throw new Error(
      "native mixed file-update comparisons require isolated one-sample workspaces; --hot-session is not supported",
    );
  }
  if (hotSession && !mutationOperation) {
    throw new Error("--hot-session is only valid for mutation operations");
  }
  if (hotSession && measuredRuns < 2) {
    throw new Error("--hot-session requires --samples of at least 2");
  }
  if (hotSession && !preseeded) {
    throw new Error("--hot-session requires --preseeded");
  }
  if (operation === "update-mixed" && measuredRuns % 10 !== 0) {
    throw new Error("update-mixed requires --samples to be a multiple of 10");
  }
  if (
    mutationOperation &&
    (warmupRuns !== 0 || (measuredRuns !== 1 && !hotSession))
  ) {
    throw new Error(
      "mutation operations require --warmups 0 and --samples 1; use --hot-session for a same-session mutation distribution",
    );
  }
  const readyTimeoutMs = integer(
    values,
    "--ready-timeout-ms",
    60_000,
    1,
  );
  const baseUrl = (
    values.get("--url") ??
    process.env.LIXRAY_PERF_URL ??
    "http://127.0.0.1:8080"
  ).replace(/\/+$/, "");
  const outputPath = resolve(
    root,
    values.get("--output") ??
      `perf/results/${workspaceId}-${operation}.json`,
  );
  const declaredStorageBackend = optionalStorageBackend(
    values,
    "--storage-backend",
  );
  const storageCohort = optionalStorageCohort(values, "--storage-cohort");

  return {
    baseUrl,
    workspaceId,
    operation,
    corpusFiles,
    targetTotalCommits,
    preconditionReadRuns,
    settleMs,
    fileWriteTransport,
    fileWriteShape,
    hotSession,
    warmupRuns,
    measuredRuns,
    readyTimeoutMs,
    outputPath,
    targetRevision: values.get("--target-revision"),
    declaredStorageBackend,
    storageCohort,
    preseeded,
    quiet: values.has("--quiet"),
  };
}

function optionalStorageBackend(values, name) {
  const value = values.get(name);
  if (value === undefined) {
    return null;
  }
  if (!["slatedb", "rocksdb"].includes(value)) {
    throw new Error(`${name} must be either "slatedb" or "rocksdb"`);
  }
  return value;
}

function optionalStorageCohort(values, name) {
  const value = values.get(name);
  if (value === undefined) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(
      `${name} must start with a letter or digit and use at most 128 letters, digits, '.', '_' or '-'`,
    );
  }
  return value;
}

async function readStorageIdentityWhenReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await readServerStorageIdentity({ baseUrl });
    } catch (error) {
      lastError = error;
      if (error instanceof ServerIdentityError && !error.retryable) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  throw new Error(
    `lix-server storage identity was not ready after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
}

async function openWhenReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await client.open();
    } catch (error) {
      lastError = error;
      if (
        error instanceof ProtocolError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  throw new Error(
    `lix-server was not ready after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
}

async function readRevisions(targetRevision) {
  const [lixray, lix] = await Promise.all([
    readGitRevision(root),
    readGitRevision(resolve(root, "vendor/lix")),
  ]);
  return {
    target: targetRevision ?? null,
    clientCheckout: { lixray, lix },
  };
}

async function readGitRevision(cwd) {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
    execFileAsync("git", ["status", "--porcelain"], { cwd }),
  ]);
  return {
    commit: commit.trim(),
    dirty: status.trim().length > 0,
  };
}

function showProgress(progress) {
  if (
    progress.phase === "history" &&
    progress.completedHistoryMutationCommits % 100 !== 0 &&
    progress.completedHistoryMutationCommits !== progress.historyMutationCommits
  ) {
    return;
  }
  const label =
    progress.phase === "insert"
      ? `${progress.filesSeeded}/${progress.totalFiles} files (${progress.completedSeedCommits}/${progress.seedCommitCount} seed commits)`
      : progress.phase === "fixture"
        ? `${progress.fixtureId} (${(progress.fixtureBytes / (1024 * 1024)).toFixed(1)} MiB fixture)`
        : `${progress.completedHistoryMutationCommits}/${progress.historyMutationCommits} history mutations`;
  process.stdout.write(
    `\rsetup ${progress.completedMutationCommits}/${progress.targetMutationCommits} commits (${label})`,
  );
  if (progress.completedMutationCommits === progress.targetMutationCommits) {
    process.stdout.write("\n");
  }
}

function printResult(report, outputPath) {
  if (report.measurement.kind === "single-mutation") {
    const [elapsedMs, requestBytes, responseBytes] = report.measurement.sample;
    console.table([
      {
        operation: report.methodology.operation,
        "latency ms": elapsedMs.toFixed(3),
        "request KiB": (requestBytes / 1024).toFixed(1),
        "response KiB": (responseBytes / 1024).toFixed(1),
      },
    ]);
  } else {
    const summary = report.measurement.summary;
    console.table([
      {
        operation: report.methodology.operation,
        "p50 ms": summary.p50Ms.toFixed(3),
        "p95 ms": summary.p95Ms.toFixed(3),
        "mean ms": summary.meanMs.toFixed(3),
        "request KiB": (summary.meanRequestBytes / 1024).toFixed(1),
        "response KiB": (summary.meanResponseBytes / 1024).toFixed(1),
      },
    ]);
  }
  console.log(
    JSON.stringify(
      {
        workspaceId: report.target.workspaceId,
        corpusFiles: report.corpus.files,
        targetTotalCommits: report.methodology.targetTotalCommits,
        seedFilesPerCommit: report.setup.seedFilesPerCommit,
        seedCommitCount: report.setup.seedCommitCount,
        ...(report.methodology.targetedFixture
          ? {
              targetedFixture: report.methodology.targetedFixture.id,
              targetedFixtureSeedCommitCount:
                report.setup.targetedFixtureSeedCommitCount,
            }
          : {}),
        historyMutationCommits: report.setup.historyMutationCommits,
        verifiedFinalCommits: report.postTimingAccounting.totalCommits,
        output: outputPath,
      },
      null,
      2,
    ),
  );
}

function required(values, name) {
  const value = values.get(name);
  if (!value) {
    throw new Error(`${name} is required\n\n${usage()}`);
  }
  return value;
}

function integer(values, name, fallback, minimum) {
  const raw = values.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function usage() {
  return `Usage:
  node perf/runner.mjs \\
    --workspace <fresh-workspace-id> \\
    --operation <${operationNames.join("|")}> \\
    [--files <${SUPPORTED_CORPUS_FILE_COUNTS.join("|")}>] \\
    [--commits <total-including-genesis>] \\
    [--precondition-reads <count>] \\
    [--settle-ms <milliseconds>] \\
    [--warmups <count>] [--samples <count>] \\
    [--file-write-transport <json|binary>] \\
    [--file-write-shape <update|upsert>] \\
    [--hot-session] \\
    [--url <lix-server-url>] [--output <path>] \\
    [--target-revision <deployed-revision>] \\
    [--storage-backend <slatedb|rocksdb>] [--storage-cohort <label>] \\
    [--preseeded] [--quiet]

Each invocation seeds a new deterministic workspace with ${SUPPORTED_CORPUS_FILE_COUNTS.join(
  ", ",
)} files and measures one operation family. The runner commits exactly
${SEED_FILES_PER_COMMIT} files per atomic execute-batch seed request, so a
target must include genesis plus every seed commit. Mutations default to one
timed request with no mutating warmup; reads default to three warmups and 30 samples. Use
--precondition-reads to warm unrelated point-read infrastructure without
changing commit depth. Use --settle-ms to keep runtime-open background work out
of an active-path measurement. Pass --preseeded only for an exact, externally
cloned workspace at the requested commit depth. File create/update operations
use JSON by default so an unchanged baseline remains runnable; pass
--file-write-transport binary to measure the raw octet-stream transfer path.
JSON updates use SQL UPDATE by default; pass --file-write-shape upsert for
the matched INSERT ON CONFLICT(path) DO UPDATE control. Mutation benchmarks
normally require one request per fresh workspace. Pass --hot-session with two
or more samples to measure sequential mutations in one fresh workspace and
one live protocol session; --hot-session requires --preseeded. update-mixed
also requires --samples to be a multiple of 10. read-point-2m explicitly adds
one deterministic 2 MiB binary fixture in its own seed commit outside
/corpus; use the same operation when creating a preseeded template.
update-mixed-native-single
and update-mixed-native-batch require --file-write-transport binary; they use
the same 10-file mixed payload, with ten sequential commits versus one atomic
raw batch commit, and require one isolated sample per externally cloned
workspace (they reject --hot-session).`;
}
