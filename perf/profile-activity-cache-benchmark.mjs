#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASELINE_PATH = "web-app/src/worker/profile-activity-cache.ts";
const COUNT = 10_000;
const SAMPLES = 5;
const baselineRef =
  process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length) ??
  "1c0da01";

if (typeof globalThis.gc !== "function") {
  throw new Error("Run with node --expose-gc --experimental-strip-types");
}

const baselineCommit = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], {
  encoding: "utf8",
}).trim();
const baselineSource = execFileSync("git", ["show", `${baselineCommit}:${BASELINE_PATH}`], {
  encoding: "utf8",
});
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "lixray-profile-cache-baseline-"));
const baselineModulePath = path.join(tempDirectory, "baseline.ts");
await writeFile(baselineModulePath, baselineSource);

try {
  const { PublicProfileActivityCache: BaselineCache } = await import(
    pathToFileURL(baselineModulePath).href
  );
  const { PublicProfileActivityCache: BoundedCache } =
    await import("../web-app/src/worker/profile-activity-cache.ts");
  const activity = {
    totalFiles: 42,
    repositories: [
      {
        id: "lix",
        name: "repo",
        slug: "repo",
        namespaceHandle: "user",
        fileCount: 42,
      },
    ],
    fileMix: [],
    failedRepositories: 0,
  };

  const measure = async (Cache) => {
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const cache = new Cache({ maxEntries: 256 });
    await Promise.all(
      Array.from({ length: COUNT }, (_, index) =>
        cache.resolve(`namespace-${index}`, async () => activity),
      ),
    );
    const milliseconds = performance.now() - started;
    globalThis.gc();
    return {
      milliseconds,
      retainedHeapBytes: process.memoryUsage().heapUsed - heapBefore,
      retainedEntries: Cache === BaselineCache ? COUNT : cache.size,
    };
  };
  const baseline = [];
  const bounded = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    baseline.push(await measure(BaselineCache));
    bounded.push(await measure(BoundedCache));
  }
  const median = (values) =>
    [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const summarize = (samples) => ({
    medianMilliseconds: median(samples.map((sample) => sample.milliseconds)),
    medianRetainedHeapBytes: median(samples.map((sample) => sample.retainedHeapBytes)),
    medianRetainedEntries: median(samples.map((sample) => sample.retainedEntries)),
  });
  console.log(
    JSON.stringify(
      {
        baselineRef: baselineCommit,
        candidateHead: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        candidateWorktreeDirty:
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
          }).trim().length > 0,
        node: process.version,
        workload: {
          uniqueNamespaces: COUNT,
          concurrentLoads: COUNT,
          samples: SAMPLES,
          payload: "shared 1-repository profile object",
        },
        baseline,
        bounded,
        medians: {
          baseline: summarize(baseline),
          bounded: summarize(bounded),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
