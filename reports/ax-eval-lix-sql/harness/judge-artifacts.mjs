import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export function createJudgeInvocationId(
  startedAt = new Date(),
  { pid = process.pid, randomHex = randomBytes(4).toString("hex") } = {},
) {
  const timestamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${pid}-${randomHex}`;
}

export function repetitionDirectory(repetition) {
  return `repetition-${String(repetition).padStart(3, "0")}`;
}

export function indexedJudgmentPath({
  judgeRoot,
  roundId,
  sourceInvocationId,
  judgeInvocationId,
  repetition,
  taskId,
}) {
  return resolve(
    judgeRoot,
    roundId,
    "invocations",
    sourceInvocationId,
    "judgments",
    judgeInvocationId,
    repetitionDirectory(repetition),
    `${taskId}.json`,
  );
}

export function uniqueJudgeIndexPath({
  judgeRoot,
  invocationLabel,
  sourceInvocationId,
  judgeInvocationId,
}) {
  return resolve(
    judgeRoot,
    `judge-index.${invocationLabel}.${sourceInvocationId}.${judgeInvocationId}.json`,
  );
}
