#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isMutationOperation,
  operationNames,
  runBenchmark,
} from "./lib/benchmark.mjs";
import {
  CORPUS_FILE_COUNT,
  minimumTotalCommitsForFiles,
  SEED_FILES_PER_COMMIT,
  SUPPORTED_CORPUS_FILE_COUNTS,
} from "./lib/corpus.mjs";
import { ProtocolClient, ProtocolError } from "./lib/protocol.mjs";

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
    const handshake = await openWhenReady(client, config.readyTimeoutMs);
    const benchmark = await runBenchmark(client, {
      operation: config.operation,
      targetTotalCommits: config.targetTotalCommits,
      corpusFiles: config.corpusFiles,
      preconditionReadRuns: config.preconditionReadRuns,
      settleMs: config.settleMs,
      warmupRuns: config.warmupRuns,
      measuredRuns: config.measuredRuns,
      preseeded: config.preseeded,
      onProgress: config.quiet ? undefined : showProgress,
    });
    const report = {
      schemaVersion: 3,
      benchmark: "lixray-e2e-crud",
      startedAt,
      finishedAt: new Date().toISOString(),
      revisions,
      target: {
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
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
  const booleanFlags = new Set(["--preseeded", "--quiet"]);
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
    "--output",
    "--ready-timeout-ms",
    "--target-revision",
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
  const minimumTotalCommits = minimumTotalCommitsForFiles(corpusFiles);
  const targetTotalCommits = integer(values, "--commits", 1_000, 1);
  if (targetTotalCommits < minimumTotalCommits) {
    throw new Error(
      `--commits must be at least ${minimumTotalCommits} for --files ${corpusFiles}: genesis plus ${minimumTotalCommits - 1} seed commits`,
    );
  }
  const preconditionReadRuns = integer(
    values,
    "--precondition-reads",
    0,
    0,
  );
  const settleMs = integer(values, "--settle-ms", 0, 0);
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
  if (mutationOperation && (warmupRuns !== 0 || measuredRuns !== 1)) {
    throw new Error(
      "mutation operations require --warmups 0 and --samples 1; repeat with fresh workspace IDs",
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

  return {
    baseUrl,
    workspaceId,
    operation,
    corpusFiles,
    targetTotalCommits,
    preconditionReadRuns,
    settleMs,
    warmupRuns,
    measuredRuns,
    readyTimeoutMs,
    outputPath,
    targetRevision: values.get("--target-revision"),
    preseeded: values.has("--preseeded"),
    quiet: values.has("--quiet"),
  };
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
    [--url <lix-server-url>] [--output <path>] \\
    [--target-revision <deployed-revision>] [--preseeded] [--quiet]

Each invocation seeds a new deterministic workspace with ${SUPPORTED_CORPUS_FILE_COUNTS.join(
  ", ",
)} files and measures one operation family. The runner commits exactly
${SEED_FILES_PER_COMMIT} files per atomic execute-batch seed request, so a
target must include genesis plus every seed commit. Mutations default to one
timed request with no mutating warmup; reads default to three warmups and 30 samples. Use
--precondition-reads to warm unrelated point-read infrastructure without
changing commit depth. Use --settle-ms to keep runtime-open background work out
of an active-path measurement. Pass --preseeded only for an exact, externally
cloned workspace at the requested commit depth.`;
}
