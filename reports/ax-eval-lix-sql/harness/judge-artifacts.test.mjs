import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createJudgeInvocationId,
  indexedJudgmentPath,
  uniqueJudgeIndexPath,
} from "./judge-artifacts.mjs";

void test("independent judge invocations cannot overwrite one another", async (t) => {
  const root = await mkdtemp("/tmp/lixray-judge-artifacts-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceInvocationId = "source-1";
  const firstJudgeInvocationId = createJudgeInvocationId(new Date("2026-07-23T00:00:00Z"), {
    pid: 1,
    randomHex: "aaaaaaaa",
  });
  const secondJudgeInvocationId = createJudgeInvocationId(new Date("2026-07-23T00:00:00Z"), {
    pid: 1,
    randomHex: "bbbbbbbb",
  });
  const common = {
    judgeRoot: root,
    roundId: "production-hard-cut-v5",
    sourceInvocationId,
    repetition: 1,
    taskId: "direct-docs",
  };
  const first = indexedJudgmentPath({
    ...common,
    judgeInvocationId: firstJudgeInvocationId,
  });
  const second = indexedJudgmentPath({
    ...common,
    judgeInvocationId: secondJudgeInvocationId,
  });

  assert.notEqual(first, second);
  await mkdir(dirname(first), { recursive: true });
  await mkdir(dirname(second), { recursive: true });
  await writeFile(first, "first\n", { encoding: "utf8", flag: "wx" });
  await writeFile(second, "second\n", { encoding: "utf8", flag: "wx" });
  await assert.rejects(writeFile(first, "replacement\n", { encoding: "utf8", flag: "wx" }), {
    code: "EEXIST",
  });
  assert.equal(await readFile(first, "utf8"), "first\n");

  const firstIndex = uniqueJudgeIndexPath({
    judgeRoot: root,
    invocationLabel: "scored.production-hard-cut-v5",
    sourceInvocationId,
    judgeInvocationId: firstJudgeInvocationId,
  });
  const secondIndex = uniqueJudgeIndexPath({
    judgeRoot: root,
    invocationLabel: "scored.production-hard-cut-v5",
    sourceInvocationId,
    judgeInvocationId: secondJudgeInvocationId,
  });
  assert.notEqual(firstIndex, secondIndex);
  assert.equal(dirname(firstIndex), root);
  assert.equal(dirname(secondIndex), root);
  assert.equal(join(root, firstIndex.slice(root.length + 1)), firstIndex);
});
