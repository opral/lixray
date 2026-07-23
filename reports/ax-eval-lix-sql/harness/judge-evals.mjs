#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptionRounds, holdoutTasks, scoredTasks } from "./tasks.mjs";
import {
  createJudgeInvocationId,
  indexedJudgmentPath,
  uniqueJudgeIndexPath,
} from "./judge-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repoRoot = resolve(reportRoot, "../..");
const schemaPath = resolve(scriptDir, "judge.schema.json");
const model = process.env.AX_EVAL_JUDGE_MODEL ?? "gpt-5.6-sol";
const concurrency = Number(process.env.AX_EVAL_JUDGE_CONCURRENCY ?? 3);
const timeoutMs = Number(process.env.AX_EVAL_JUDGE_TIMEOUT_MS ?? 180_000);
const requested = process.argv.slice(2);
const holdoutsOnly = requested.includes("--holdouts-only");
const rawRoot = resolve(reportRoot, holdoutsOnly ? "data/raw/holdout" : "data/raw/scored");
const judgeRoot = resolve(reportRoot, holdoutsOnly ? "data/judges/holdout" : "data/judges");
const runIndexArgument = requested
  .find((arg) => arg.startsWith("--run-index="))
  ?.slice("--run-index=".length);
const repetitionsArgument = requested
  .find((arg) => arg.startsWith("--repetitions="))
  ?.slice("--repetitions=".length);
const repetitionsValue = repetitionsArgument ?? process.env.AX_EVAL_REPETITIONS;
const requestedRepetitions =
  repetitionsValue === undefined ? null : parsePositiveInteger(repetitionsValue, "repetitions");
const indexedMode = runIndexArgument !== undefined || requestedRepetitions !== null;
const selectedRoundIds = requested.filter((arg) => !arg.startsWith("--"));
const rounds = selectedRoundIds.length
  ? descriptionRounds.filter((round) => selectedRoundIds.includes(round.id))
  : descriptionRounds;
const unknownRounds = selectedRoundIds.filter((id) => !rounds.some((round) => round.id === id));
if (unknownRounds.length > 0) {
  throw new Error(`Unknown round: ${unknownRounds.join(", ")}`);
}

const selectedTasks = holdoutsOnly ? holdoutTasks : scoredTasks;
const runIndex = indexedMode ? await loadRunIndex() : null;
const judgeInvocationStartedAt = new Date();
const judgeInvocationId = createJudgeInvocationId(judgeInvocationStartedAt);
const judgedRoundIds = indexedMode
  ? selectedRoundIds.length > 0
    ? selectedRoundIds
    : runIndex.roundIds
  : rounds.map((round) => round.id);
const jobs = indexedMode
  ? jobsFromRunIndex(runIndex)
  : rounds.flatMap((round) =>
      selectedTasks.map((task) => ({
        round,
        task,
        runId: `${round.id}__${task.id}`,
        repetition: null,
        repetitions: 1,
        sourceInvocationId: null,
        logPath: resolve(rawRoot, round.id, `${task.id}.jsonl`),
      })),
    );
let next = 0;
const outcomes = [];

await mkdir(judgeRoot, { recursive: true });

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`--${name} must be a positive integer; received ${JSON.stringify(value)}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} is too large; received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

async function loadRunIndex() {
  const indexPath = runIndexArgument
    ? resolve(process.cwd(), runIndexArgument)
    : resolve(reportRoot, `data/raw/run-index.latest.${holdoutsOnly ? "holdout" : "scored"}.json`);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const expectedKind = holdoutsOnly ? "holdout" : "scored";
  if (index.schema !== 2 || index.kind !== expectedKind || !Array.isArray(index.runs)) {
    throw new Error(`${indexPath} is not a ${expectedKind} repetition run index.`);
  }
  if (requestedRepetitions !== null && index.repetitions !== requestedRepetitions) {
    throw new Error(
      `${indexPath} has ${index.repetitions} repetitions, not ${requestedRepetitions}.`,
    );
  }
  if (
    selectedRoundIds.length > 0 &&
    selectedRoundIds.some((roundId) => !index.roundIds.includes(roundId))
  ) {
    throw new Error(
      `${indexPath} does not contain every requested round: ${selectedRoundIds.join(", ")}.`,
    );
  }
  return { ...index, indexPath };
}

function jobsFromRunIndex(index) {
  const roundsById = new Map(descriptionRounds.map((round) => [round.id, round]));
  const tasksById = new Map(selectedTasks.map((task) => [task.id, task]));
  const indexedTaskIds = new Set(index.taskIds ?? selectedTasks.map((task) => task.id));
  const selectedIds =
    selectedRoundIds.length > 0 ? new Set(selectedRoundIds) : new Set(index.roundIds);
  const indexedJobs = index.runs
    .filter((run) => selectedIds.has(run.round) && indexedTaskIds.has(run.taskId))
    .map((run) => {
      const round = roundsById.get(run.round);
      const task = tasksById.get(run.taskId);
      if (!round) throw new Error(`Run index contains unknown round: ${run.round}`);
      if (!task) throw new Error(`Run index contains unknown task: ${run.taskId}`);
      const logRelativePath = run.artifactPaths?.log;
      if (!logRelativePath) {
        throw new Error(`Run ${run.runId} has no artifactPaths.log.`);
      }
      return {
        round,
        task,
        runId: run.runId,
        repetition: run.repetition,
        repetitions: run.repetitions,
        sourceInvocationId: run.invocationId,
        logPath: resolve(reportRoot, logRelativePath),
      };
    });
  const actualKeys = indexedJobs.map((job) => `${job.round.id}/${job.task.id}/${job.repetition}`);
  const expectedKeys = [];
  for (const roundId of selectedIds) {
    for (const taskId of indexedTaskIds) {
      for (let repetition = 1; repetition <= index.repetitions; repetition++) {
        expectedKeys.push(`${roundId}/${taskId}/${repetition}`);
      }
    }
  }
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const duplicates = actualKeys.filter((key, position) => actualKeys.indexOf(key) !== position);
  if (actualKeys.length !== expectedKeys.length || missing.length > 0 || duplicates.length > 0) {
    throw new Error(
      `Run index is incomplete: expected ${expectedKeys.length} unique selected runs, found ${actualKeys.length}; missing ${missing.join(", ") || "none"}; duplicates ${[...new Set(duplicates)].join(", ") || "none"}.`,
    );
  }
  return indexedJobs;
}

async function worker(workerId) {
  while (true) {
    const index = next++;
    if (index >= jobs.length) return;
    const job = jobs[index];
    const outcome = await judge(job, workerId);
    outcomes.push(outcome);
    process.stderr.write(
      `[${outcomes.length}/${jobs.length}] ${job.round.id}/${job.task.id}${job.repetition ? `/r${job.repetition}` : ""}: ${outcome.verdict.success ? "success" : outcome.verdict.failure_mode}\n`,
    );
  }
}

async function judge(
  { round, task, runId, repetition, repetitions, sourceInvocationId, logPath },
  workerId,
) {
  await readFile(logPath, "utf8");
  const outputPath = sourceInvocationId
    ? indexedJudgmentPath({
        judgeRoot,
        roundId: round.id,
        sourceInvocationId,
        judgeInvocationId,
        repetition,
        taskId: task.id,
      })
    : resolve(judgeRoot, round.id, `${task.id}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  const prompt = `You are an ax-eval judge. Read this agent's complete JSONL session log and decide whether it completed the task.\n\nTask: ${task.prompt}\n\nFixture-grounded success criteria: ${task.expectation}\n\nSession log: ${logPath}\n\nRead the log end-to-end. Inspect actual tool arguments, tool results, failures, and the final answer. Do not trust self-narration when it conflicts with results. A recovered intermediate error does not fail the run if the final answer is correct and all task constraints are met. Judge only task completion, not style. Return the required JSON object.`;
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    repoRoot,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="low"',
    "--output-schema",
    schemaPath,
    "--json",
    prompt,
  ];
  const startedMs = Date.now();
  const child = spawn("codex", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
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
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        messages.push(event.item.text);
      }
    } catch {
      // Non-JSON diagnostics are retained below for audit.
    }
  }
  let verdict;
  try {
    verdict = JSON.parse(messages.at(-1));
  } catch {
    verdict = {
      success: false,
      reason: `Judge produced no parseable verdict (exit ${exitCode}).`,
      failure_mode: "tool_failure",
    };
  }
  const record = {
    runId,
    invocationId: sourceInvocationId,
    sourceInvocationId,
    judgeInvocationId: indexedMode ? judgeInvocationId : null,
    repetition,
    repetitions,
    kind: holdoutsOnly ? "holdout" : "scored",
    round: round.id,
    taskId: task.id,
    fixtureProfile: task.fixtureProfile ?? "default",
    expectedError: task.expectedError === true,
    model,
    workerId,
    durationSec: Number(((Date.now() - startedMs) / 1000).toFixed(1)),
    exitCode,
    timedOut,
    verdict,
    stderr,
    sourceLog: logPath.slice(reportRoot.length + 1),
    artifactPaths: {
      judgment: outputPath.slice(reportRoot.length + 1),
    },
  };
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: indexedMode ? "wx" : "w",
  });
  return record;
}

await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, (_, index) => worker(index + 1)),
);

outcomes.sort((a, b) =>
  `${a.round}/${a.taskId}/${a.repetition ?? 0}`.localeCompare(
    `${b.round}/${b.taskId}/${b.repetition ?? 0}`,
  ),
);
const indexPayload = `${JSON.stringify(
  {
    schema: indexedMode ? 3 : 1,
    sourceInvocationId: runIndex?.invocationId ?? null,
    judgeInvocationId: indexedMode ? judgeInvocationId : null,
    sourceRunIndex: runIndex?.indexPath ? runIndex.indexPath.slice(reportRoot.length + 1) : null,
    generatedAt: new Date().toISOString(),
    startedAt: judgeInvocationStartedAt.toISOString(),
    kind: holdoutsOnly ? "holdout" : "scored",
    roundIds: judgedRoundIds,
    model,
    repetitions: runIndex?.repetitions ?? 1,
    totalJudgments: outcomes.length,
    judgments: outcomes,
  },
  null,
  2,
)}\n`;
const invocationLabel = `${holdoutsOnly ? "holdout" : "scored"}.${judgedRoundIds.join("+")}`;
if (indexedMode) {
  const sourceInvocationId = runIndex.invocationId;
  const uniqueIndexPath = uniqueJudgeIndexPath({
    judgeRoot,
    invocationLabel,
    sourceInvocationId,
    judgeInvocationId,
  });
  await writeFile(uniqueIndexPath, indexPayload, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(resolve(judgeRoot, "judge-index.latest.json"), indexPayload, "utf8");
  process.stderr.write(`Judge index: ${uniqueIndexPath}\n`);
  process.stdout.write(`${uniqueIndexPath}\n`);
} else {
  await Promise.all([
    writeFile(resolve(judgeRoot, "judge-index.json"), indexPayload, "utf8"),
    writeFile(resolve(judgeRoot, `judge-index.${invocationLabel}.json`), indexPayload, "utf8"),
  ]);
}
