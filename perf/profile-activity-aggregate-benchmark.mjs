#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openLix } from "../web-app/node_modules/@lix-js/sdk/dist/index.js";
import {
  PUBLIC_PROFILE_ACTIVITY_CATEGORY_COUNT,
  aggregatePublicProfileActivityFromCounts,
  publicProfileActivityAggregateSql,
} from "../web-app/src/lib/profile-activity-aggregate.ts";

import { aggregatePublicProfileActivity } from "../web-app/tests/fixtures/profile-activity-baseline.ts";

if (typeof globalThis.gc !== "function") {
  throw new Error("Run with node --expose-gc --experimental-strip-types");
}

const SAMPLES = 6;
const SIZES = [1_000, 10_000];
const sdkProvenance = JSON.parse(
  await readFile(
    new URL("../vendor/lix/packages/js-sdk/dist/.lixray-browser-build.json", import.meta.url),
    "utf8",
  ),
);
const repository = {
  id: "benchmark-lix",
  name: "Profile benchmark",
  slug: "profile-benchmark",
  namespaceHandle: "benchmark",
};
const extensions = ["md", "ts", "csv", "pptx", "png", "json", "txt"];

async function seed(lix, count) {
  const statementBatch = 250;
  for (let start = 0; start < count; start += statementBatch) {
    const batch = Math.min(statementBatch, count - start);
    const values = [];
    const rows = [];
    for (let offset = 0; offset < batch; offset++) {
      const index = start + offset;
      const extension = extensions[index % extensions.length];
      rows.push(`($${offset * 2 + 1}, $${offset * 2 + 2})`);
      values.push(`/benchmark/file-${String(index).padStart(6, "0")}.${extension}`);
      values.push(new Uint8Array([index % 251]));
    }
    await lix.execute(`INSERT INTO lix_file(path, content) VALUES ${rows.join(",")}`, values);
  }
}

function profileFromAggregateRow(row) {
  return aggregatePublicProfileActivityFromCounts([
    {
      repository,
      totalFiles: Number(row.total_files),
      categoryCounts: Array.from({ length: PUBLIC_PROFILE_ACTIVITY_CATEGORY_COUNT }, (_, index) =>
        Number(row[`category_${index}`]),
      ),
    },
  ]);
}

async function measure(lix, kind) {
  globalThis.gc();
  const started = performance.now();
  let profile;
  let queryRows;
  if (kind === "path-scan") {
    queryRows = (await lix.execute("SELECT path FROM lix_file ORDER BY path")).rows;
    profile = aggregatePublicProfileActivity([
      {
        repository,
        paths: queryRows.map((row) => String(row.path)),
      },
    ]);
  } else {
    queryRows = (await lix.execute(publicProfileActivityAggregateSql())).rows;
    profile = profileFromAggregateRow(queryRows[0]);
  }
  const milliseconds = performance.now() - started;
  globalThis.gc();
  const result = {
    milliseconds,
    queryRows: queryRows.length,
    queryResponseBytes: Buffer.byteLength(JSON.stringify(queryRows)),
    profileResponseBytes: Buffer.byteLength(JSON.stringify(profile)),
    profile,
  };
  return result;
}

for (const size of SIZES) {
  const lix = await openLix();
  try {
    await seed(lix, size);
    await measure(lix, "path-scan");
    await measure(lix, "aggregate");
    const pathScan = [];
    const aggregate = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      if (sample % 2 === 0) {
        pathScan.push(await measure(lix, "path-scan"));
        aggregate.push(await measure(lix, "aggregate"));
      } else {
        aggregate.push(await measure(lix, "aggregate"));
        pathScan.push(await measure(lix, "path-scan"));
      }
    }
    for (let sample = 0; sample < SAMPLES; sample++) {
      assert.deepEqual(pathScan[sample].profile, aggregate[sample].profile);
    }
    console.log(
      JSON.stringify(
        {
          sdk: "pinned workspace @lix-js/sdk",
          sdkProvenance,
          baselineCommit: "1c0da0159478946cc3c210131cdee82ce559feb2",
          node: process.version,
          workloadFilesInserted: size,
          baselineIncludesLixDefaultFile: true,
          samples: SAMPLES,
          measurementOrder: "alternating paired samples after warming both strategies",
          parity: "exact profile JSON",
          pathScan: pathScan.map(({ profile: _profile, ...metrics }) => metrics),
          aggregate: aggregate.map(({ profile: _profile, ...metrics }) => metrics),
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      ),
    );
  } finally {
    await lix.close();
  }
}
