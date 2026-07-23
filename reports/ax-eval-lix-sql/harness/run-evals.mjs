#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  descriptionRounds,
  holdoutTasks,
  reflectionTasks,
  scoredTasks,
} from "./tasks.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repoRoot = resolve(reportRoot, "../..");
const rawRoot = resolve(reportRoot, "data/raw");
const descriptionRoot = resolve(reportRoot, "data/descriptions");
const serverPath = resolve(scriptDir, "lix-sql-mcp.mjs");
const workRoot = "/tmp/lixray-ax-eval-agents";
const codexHomeRoot = "/tmp/lixray-ax-eval-codex-home";
const model = process.env.AX_EVAL_MODEL ?? "gpt-5.6-sol";
const concurrency = Number(process.env.AX_EVAL_CONCURRENCY ?? 3);
const timeoutMs = Number(process.env.AX_EVAL_TIMEOUT_MS ?? 300_000);
const isolate = process.env.AX_EVAL_ISOLATE !== "0";
const requested = process.argv.slice(2);
const repetitionsArgument = requested
  .find((arg) => arg.startsWith("--repetitions="))
  ?.slice("--repetitions=".length);
const repetitions = parsePositiveInteger(
  repetitionsArgument ?? process.env.AX_EVAL_REPETITIONS ?? "1",
  "repetitions",
);
const reflectionsOnly = requested.includes("--reflections-only");
const includeReflections =
  reflectionsOnly || requested.includes("--reflections");
const holdoutsOnly = requested.includes("--holdouts-only");
const refreshDescription = requested.includes("--refresh-description");
const prepareDescriptionsOnly = requested.includes(
  "--prepare-descriptions-only",
);
const selectedTask = requested
  .find((arg) => arg.startsWith("--task="))
  ?.slice("--task=".length);
const selectedRoundIds = requested.filter((arg) => !arg.startsWith("--"));
const rounds = selectedRoundIds.length
  ? descriptionRounds.filter((candidate) =>
      selectedRoundIds.includes(candidate.id),
    )
  : descriptionRounds;

const unknownRounds = selectedRoundIds.filter(
  (id) => !rounds.some((round) => round.id === id),
);
if (unknownRounds.length > 0) {
  throw new Error(`Unknown round: ${unknownRounds.join(", ")}`);
}
if (holdoutsOnly && includeReflections) {
  throw new Error("Holdout runs cannot be combined with reflection runs.");
}

const invocationStartedAt = new Date();
const invocationId = createInvocationId(invocationStartedAt);
await mkdir(rawRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
await mkdir(codexHomeRoot, { recursive: true });
await prepareDescriptionSnapshots(rounds);
if (prepareDescriptionsOnly) {
  const snapshots = await Promise.all(
    rounds
      .filter((round) => round.descriptionSnapshot)
      .map(async (round) => {
        const path = resolve(reportRoot, round.descriptionSnapshot);
        const text = await readFile(path, "utf8");
        return {
          round: round.id,
          path,
          chars: text.length,
          sha256: createHash("sha256").update(text).digest("hex"),
        };
      }),
  );
  await new Promise((resolveWrite) =>
    process.stdout.write(
      `${JSON.stringify({ snapshots }, null, 2)}\n`,
      resolveWrite,
    ),
  );
  process.exit(0);
}

const selectedTasks = holdoutsOnly ? holdoutTasks : scoredTasks;
const selectedKind = holdoutsOnly ? "holdout" : "scored";
const jobs = reflectionsOnly
  ? []
  : selectedTasks
      .filter((task) => !selectedTask || task.id === selectedTask)
      .flatMap((task, taskIndex) => {
        return Array.from({ length: repetitions }, (_, repetitionIndex) => {
          const taskRounds = counterbalancedRounds(
            rounds,
            taskIndex,
            repetitionIndex,
          );
          return taskRounds.map((round) => ({
            round,
            task,
            kind: selectedKind,
            repetition: repetitionIndex + 1,
          }));
        }).flat();
      });
if (!reflectionsOnly && selectedTask && jobs.length === 0) {
  throw new Error(`Unknown task: ${selectedTask}`);
}
if (includeReflections) {
  if (rounds.length !== 1) {
    throw new Error("Reflection runs require exactly one selected round.");
  }
  const current = rounds[0];
  jobs.push(
    ...reflectionTasks.flatMap((task) =>
      Array.from({ length: repetitions }, (_, repetitionIndex) => ({
        round: current,
        task,
        kind: "reflection",
        repetition: repetitionIndex + 1,
      })),
    ),
  );
}

let next = 0;
const outcomes = [];

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `--${name} must be a positive integer; received ${JSON.stringify(value)}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `--${name} is too large; received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function createInvocationId(startedAt) {
  const timestamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function counterbalancedRounds(selectedRounds, taskIndex, repetitionIndex) {
  if (selectedRounds.length < 2) return selectedRounds;
  const offset = (taskIndex + repetitionIndex) % selectedRounds.length;
  return [...selectedRounds.slice(offset), ...selectedRounds.slice(0, offset)];
}

function repetitionDirectory(repetition) {
  return `repetition-${String(repetition).padStart(3, "0")}`;
}

async function prepareDescriptionSnapshots(selectedRounds) {
  await mkdir(descriptionRoot, { recursive: true });
  for (const round of selectedRounds) {
    if (!round.descriptionSource) continue;
    if (!round.descriptionSnapshot) {
      throw new Error(`Round ${round.id} needs a descriptionSnapshot path.`);
    }
    const snapshotPath = resolve(reportRoot, round.descriptionSnapshot);
    if (!refreshDescription && (await pathExists(snapshotPath))) continue;
    const descriptorJson =
      round.descriptionSource === "worktree"
        ? await readFile(resolve(repoRoot, "web-app/mcp-tools.json"), "utf8")
        : execFileSync(
            "git",
            ["show", `${round.revision}:web-app/mcp-tools.json`],
            {
              cwd: repoRoot,
              encoding: "utf8",
            },
          );
    const descriptors = JSON.parse(descriptorJson);
    const execute = descriptors.find((tool) => tool.name === "execute");
    if (!execute?.description) {
      throw new Error("The worktree MCP artifact has no execute description.");
    }
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, execute.description, "utf8");
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareIsolatedCodexHome(target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const source = process.env.CODEX_HOME ?? "/root/.codex";
  await copyFile(resolve(source, "auth.json"), resolve(target, "auth.json"));
  for (const optional of ["installation_id", "models_cache.json"]) {
    const sourcePath = resolve(source, optional);
    if (await pathExists(sourcePath)) {
      await copyFile(sourcePath, resolve(target, optional));
    }
  }
}

function isolationArgs({ workdir, codexHome, sdkEntry, codexArgs }) {
  const sdkRoot = resolve(dirname(sdkEntry), "..");
  const isolatedReportRoot = "/eval/reports/ax-eval-lix-sql";
  return [
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/usr/local",
    "/usr/local",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--ro-bind",
    "/run",
    "/run",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/root",
    "--dir",
    "/eval",
    "--dir",
    "/eval/web-app",
    "--ro-bind",
    resolve(repoRoot, "node_modules"),
    "/eval/node_modules",
    "--ro-bind",
    resolve(repoRoot, "web-app/node_modules"),
    "/eval/web-app/node_modules",
    "--ro-bind",
    resolve(repoRoot, "web-app/package.json"),
    "/eval/web-app/package.json",
    "--dir",
    "/eval/reports",
    "--dir",
    isolatedReportRoot,
    "--ro-bind",
    scriptDir,
    `${isolatedReportRoot}/harness`,
    "--dir",
    `${isolatedReportRoot}/data`,
    "--ro-bind",
    descriptionRoot,
    `${isolatedReportRoot}/data/descriptions`,
    "--dir",
    "/eval/sdk",
    "--ro-bind",
    resolve(sdkRoot, "dist"),
    "/eval/sdk/dist",
    "--ro-bind",
    resolve(sdkRoot, "lix_js_sdk.node"),
    "/eval/sdk/lix_js_sdk.node",
    "--ro-bind",
    resolve(sdkRoot, "package.json"),
    "/eval/sdk/package.json",
    "--ro-bind",
    resolve(sdkRoot, "node_modules"),
    "/eval/sdk/node_modules",
    "--bind",
    workdir,
    "/workspace",
    "--bind",
    codexHome,
    "/codex-home",
    "--setenv",
    "HOME",
    "/root",
    "--setenv",
    "CODEX_HOME",
    "/codex-home",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--chdir",
    "/workspace",
    "/usr/local/bin/codex",
    ...codexArgs,
  ];
}

async function worker(workerId) {
  while (true) {
    const jobIndex = next++;
    if (jobIndex >= jobs.length) return;
    const job = jobs[jobIndex];
    const outcome = await runJob(job, workerId);
    outcomes.push(outcome);
    process.stderr.write(
      `[${outcomes.length}/${jobs.length}] ${job.round.id}/${job.task.id}/r${job.repetition}: ${outcome.exitCode === 0 ? "done" : `exit ${outcome.exitCode}`} (${outcome.durationSec}s)\n`,
    );
  }
}

async function runJob({ round, task, kind, repetition }, workerId) {
  const repetitionId = repetitionDirectory(repetition);
  const runId = `${round.id}__${task.id}__${invocationId}__${repetitionId}`;
  const workdir = resolve(workRoot, runId);
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  const outputDir = resolve(
    rawRoot,
    kind,
    round.id,
    "invocations",
    invocationId,
    repetitionId,
  );
  await mkdir(outputDir, { recursive: true });
  const logPath = resolve(outputDir, `${task.id}.jsonl`);
  const stderrPath = resolve(outputDir, `${task.id}.stderr.txt`);
  const metaPath = resolve(outputDir, `${task.id}.meta.json`);

  const sdkEntry = process.env.AX_EVAL_LIX_SDK_ENTRY;
  const nativeBatch = process.env.AX_EVAL_NATIVE_BATCH === "1";
  if (isolate && !sdkEntry) {
    throw new Error("AX_EVAL_LIX_SDK_ENTRY is required for isolated runs.");
  }
  const descriptionText = round.descriptionSnapshot
    ? await readFile(resolve(reportRoot, round.descriptionSnapshot), "utf8")
    : null;
  const descriptionSha256 = descriptionText
    ? createHash("sha256").update(descriptionText).digest("hex")
    : null;
  const isolatedServerPath =
    "/eval/reports/ax-eval-lix-sql/harness/lix-sql-mcp.mjs";
  const isolatedSdkEntry = "/eval/sdk/dist/index.js";
  const effectiveServerPath = isolate ? isolatedServerPath : serverPath;
  const effectiveSdkEntry = isolate ? isolatedSdkEntry : sdkEntry;
  const fixtureProfile = task.fixtureProfile ?? "default";
  const mcpCommand = sdkEntry ? "env" : "node";
  const mcpArgs = sdkEntry
    ? [
        `AX_EVAL_LIX_SDK_ENTRY=${effectiveSdkEntry}`,
        `AX_EVAL_NATIVE_BATCH=${nativeBatch ? "1" : "0"}`,
        "node",
        effectiveServerPath,
        round.id,
        fixtureProfile,
      ]
    : [effectiveServerPath, round.id, fixtureProfile];
  const codexWorkdir = isolate ? "/workspace" : workdir;
  const codexArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "computer_use",
    "--skip-git-repo-check",
    "-C",
    codexWorkdir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="medium"',
    "-c",
    'web_search="disabled"',
    "-c",
    `mcp_servers.lixray.command=${JSON.stringify(mcpCommand)}`,
    "-c",
    `mcp_servers.lixray.args=${JSON.stringify(mcpArgs)}`,
    "--json",
    task.prompt,
  ];
  let spawnCommand = "codex";
  let spawnArgs = codexArgs;
  let spawnCwd = workdir;
  let isolatedCodexHome = null;
  if (isolate) {
    isolatedCodexHome = resolve(codexHomeRoot, runId);
    await prepareIsolatedCodexHome(isolatedCodexHome);
    spawnCommand = "bwrap";
    spawnArgs = isolationArgs({
      workdir,
      codexHome: isolatedCodexHome,
      sdkEntry,
      codexArgs,
    });
    spawnCwd = "/";
  }
  const startedAt = new Date();
  const startedMs = Date.now();
  const childEnv = { ...process.env, NO_COLOR: "1" };
  delete childEnv.AX_EVAL_LIX_SDK_ENTRY;
  delete childEnv.AX_EVAL_NATIVE_BATCH;
  const child = spawn(spawnCommand, spawnArgs, {
    cwd: spawnCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);
  const exitCode = await new Promise((resolveExit) =>
    child.on("close", (code) => resolveExit(code ?? 1)),
  );
  clearTimeout(timer);
  const completedAt = new Date();
  const durationSec = Number(((Date.now() - startedMs) / 1000).toFixed(1));
  await writeFile(logPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const metadata = {
    runId,
    invocationId,
    repetition,
    repetitions,
    kind,
    round: round.id,
    descriptionRevision: round.revision ?? null,
    descriptionSnapshot: round.descriptionSnapshot ?? null,
    descriptionSha256,
    descriptionChars: descriptionText?.length ?? null,
    wireFormat: round.wireFormat ?? "tagged",
    taskId: task.id,
    fixtureProfile,
    expectedError: task.expectedError === true,
    prompt: task.prompt,
    ...(task.expectation ? { expectation: task.expectation } : {}),
    model,
    modelReasoningEffort: "medium",
    lixSdkEntry: sdkEntry ?? null,
    nativeBatch,
    isolated: isolate,
    workerId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSec,
    exitCode,
    timedOut,
    artifactPaths: {
      log: logPath.slice(reportRoot.length + 1),
      stderr: stderrPath.slice(reportRoot.length + 1),
      meta: metaPath.slice(reportRoot.length + 1),
    },
  };
  await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, (_, index) =>
    worker(index + 1),
  ),
);

outcomes.sort((a, b) => a.runId.localeCompare(b.runId));
const indexPayload = `${JSON.stringify(
  {
    schema: 2,
    invocationId,
    generatedAt: new Date().toISOString(),
    startedAt: invocationStartedAt.toISOString(),
    kind: reflectionsOnly ? "reflection" : selectedKind,
    roundIds: rounds.map((round) => round.id),
    taskIds: [...new Set(outcomes.map((outcome) => outcome.taskId))],
    model,
    concurrency,
    repetitions,
    ordering: "task-first-counterbalanced",
    isolated: isolate,
    totalRuns: outcomes.length,
    runs: outcomes,
  },
  null,
  2,
)}\n`;
const invocationLabel = `${reflectionsOnly ? "reflection" : selectedKind}.${rounds
  .map((round) => round.id)
  .join("+")}`;
const uniqueIndexPath = resolve(
  rawRoot,
  `run-index.${invocationLabel}.${invocationId}.json`,
);
const latestIndexPath = resolve(
  rawRoot,
  `run-index.latest.${reflectionsOnly ? "reflection" : selectedKind}.json`,
);
await Promise.all([
  writeFile(uniqueIndexPath, indexPayload, { encoding: "utf8", flag: "wx" }),
  writeFile(latestIndexPath, indexPayload, "utf8"),
]);
process.stderr.write(`Run index: ${uniqueIndexPath}\n`);
process.stdout.write(`${uniqueIndexPath}\n`);
