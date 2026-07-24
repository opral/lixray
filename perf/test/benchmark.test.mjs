import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRowsAffected,
  expectedCorpusLookup,
  runBenchmark,
  seedCorpus,
} from "../lib/benchmark.mjs";
import {
  buildCorpus,
  buildCorpusIndex,
  contentFor,
  SEED_FILES_PER_COMMIT,
} from "../lib/corpus.mjs";
import { summarizeSamples } from "../lib/statistics.mjs";

test("seeding creates fixed 1,000-file commits and the exact total depth", async () => {
  for (const { files, targetTotalCommits } of [
    { files: 1_000, targetTotalCommits: 2 },
    { files: 1_000, targetTotalCommits: 1_000 },
    { files: 5_000, targetTotalCommits: 6 },
    { files: 5_000, targetTotalCommits: 1_000 },
    { files: 10_000, targetTotalCommits: 11 },
    { files: 10_000, targetTotalCommits: 5_000 },
  ]) {
    const corpus = seedFixture(files);
    const protocol = new SeedProtocol();
    const state = await seedCorpus(protocol, corpus, targetTotalCommits);
    const seedCommitCount = files / SEED_FILES_PER_COMMIT;
    const historyMutationCommits =
      targetTotalCommits - 1 - seedCommitCount;

    assert.equal(
      protocol.mutationRequests,
      targetTotalCommits - 1,
      `${files} files, target ${targetTotalCommits}`,
    );
    assert.equal(protocol.insertedFiles, files);
    assert.equal(state.size, files);
    assert.equal(protocol.updateRequests, historyMutationCommits);
    assert.equal(protocol.insertBatchRequests, seedCommitCount);
    assert.deepEqual(
      protocol.filesPerInsertBatch,
      Array(seedCommitCount).fill(SEED_FILES_PER_COMMIT),
    );
    const expected = expectedCorpusLookup(corpus, targetTotalCommits);
    for (const index of [0, 1, 17, 131, Math.floor(files / 2), files - 1]) {
      const { path } = corpus[index];
      assert.deepEqual(expected.get(path), state.get(path), path);
    }
  }
});

test("seed insert statements stay bounded inside each atomic seed commit", async () => {
  const protocol = new SeedProtocol();
  await seedCorpus(protocol, seedFixture(5_000), 6);

  assert.equal(protocol.mutationRequests, 5);
  assert.equal(protocol.maximumStatementsPerBatch, 10);
  assert.equal(protocol.maximumFilesPerStatement, 100);
});

test("the requested total must accommodate every seed commit", async () => {
  const corpus = seedFixture(5_000);

  assert.throws(
    () => expectedCorpusLookup(corpus, 5),
    /at least 6 for 5000 files \(5 seed commits\)/,
  );
  await assert.rejects(
    seedCorpus(new SeedProtocol(), corpus, 5),
    /at least 6 for 5000 files \(5 seed commits\)/,
  );
  await assert.rejects(
    runBenchmark(
      {},
      {
        operation: "read-point-4k",
        corpusFiles: 10_000,
        targetTotalCommits: 10,
        warmupRuns: 0,
        measuredRuns: 1,
      },
    ),
    /at least 11 for 10000 files \(10 seed commits\)/,
  );
});

test("metadata-only corpus lookup reproduces seeded state lazily", () => {
  const fullCorpus = buildCorpus();
  const indexedCorpus = buildCorpusIndex();

  for (const targetTotalCommits of [2, 10, 1_000, 5_000]) {
    const expectedFromPayloads = expectedCorpusLookup(
      fullCorpus,
      targetTotalCommits,
    );
    const expectedFromIndex = expectedCorpusLookup(
      indexedCorpus,
      targetTotalCommits,
    );
    for (const index of [0, 1, 17, 131, 999]) {
      const path = fullCorpus[index].path;
      assert.deepEqual(
        expectedFromIndex.get(path),
        expectedFromPayloads.get(path),
        `${targetTotalCommits} commits: ${path}`,
      );
    }
  }
});

test("read preconditioning is asserted and reported outside measurement", async () => {
  const protocol = new PreconditionProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "read-point-4k",
    targetTotalCommits: 10,
    preconditionReadRuns: 5,
    settleMs: 1,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });

  assert.equal(protocol.pointReads, 6);
  assert.equal(result.methodology.preconditionReadRuns, 5);
  assert.match(result.methodology.precondition, /unrelated exact-path reads/);
  assert.equal(typeof result.setup.preconditionReadMs, "number");
  assert.equal(result.methodology.settleMs, 1);
  assert.equal(result.setup.settleMs, 1);
  assert.equal(result.setup.seedFilesPerCommit, 1_000);
  assert.equal(result.setup.seedCommitCount, 1);
  assert.equal(result.setup.historyMutationCommits, 8);
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.measurement.samples.length, 1);
});

test("branch-create measures the protocol endpoint and verifies the persisted branch", async () => {
  const protocol = new BranchProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "branch-create",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });

  assert.equal(protocol.createdBranches.length, 1);
  assert.equal(protocol.branchLookups, 1);
  assert.equal(result.measurement.kind, "single-mutation");
  assert.equal(result.postTimingAccounting.totalCommits, 11);
  assert.equal(result.postTimingAccounting.corpusFiles, 1_000);
});

test("branch-switch times session switching after explicit branch setup", async () => {
  const protocol = new BranchSwitchProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "branch-switch",
    targetTotalCommits: 10,
    warmupRuns: 1,
    measuredRuns: 2,
    preseeded: true,
  });

  assert.equal(protocol.createdBranches.length, 2);
  assert.deepEqual(protocol.switchedBranches, [
    "perf-switch-a",
    "perf-switch-b",
    "perf-switch-a",
  ]);
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.measurement.samples.length, 2);
  assert.equal(result.setup.preTimingOperationMutationCommits, 2);
  assert.match(result.methodology.preTimingOperationSetup, /two sibling branches/);
  assert.equal(result.postTimingAccounting.totalCommits, 12);
  assert.equal(result.postTimingAccounting.corpusFiles, 1_000);
});

test("diff-file-history reads distinct current and prior file revisions", async () => {
  const protocol = new HistoryDiffProtocol(3, 1_000, { currentDepth: 2 });
  const result = await runBenchmark(protocol, {
    operation: "diff-file-history",
    targetTotalCommits: 3,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });

  assert.equal(protocol.historyQueries, 1);
  assert.match(protocol.lastHistorySql, /FROM lix_file_history/);
  assert.doesNotMatch(protocol.lastHistorySql, /lixcol_as_of_commit_id/);
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.postTimingAccounting.totalCommits, 3);
});

test("preseeded history-backed diff preserves the multi-seed corpus plan", async () => {
  const protocol = new HistoryDiffProtocol(7, 5_000);
  const result = await runBenchmark(protocol, {
    operation: "diff-file-history",
    corpusFiles: 5_000,
    targetTotalCommits: 7,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });

  assert.equal(result.corpus.files, 5_000);
  assert.equal(result.setup.seedCommitCount, 5);
  assert.equal(result.setup.historyMutationCommits, 1);
  assert.equal(result.postTimingAccounting.totalCommits, 7);
  assert.equal(result.postTimingAccounting.corpusFiles, 5_000);
});

test("diff-file-history requires a post-seed revision to compare", async () => {
  await assert.rejects(
    runBenchmark(
      {},
      {
        operation: "diff-file-history",
        targetTotalCommits: 2,
        warmupRuns: 0,
        measuredRuns: 1,
        preseeded: true,
      },
    ),
    /requires at least one post-seed history mutation/,
  );
});

test("rows-affected assertions reject semantic failures", () => {
  assert.doesNotThrow(() =>
    assertRowsAffected({ rowsAffected: 1 }, 1, "update"),
  );
  assert.throws(
    () => assertRowsAffected({ rowsAffected: 0 }, 1, "update"),
    /affected 0 rows; expected 1/,
  );
});

test("sample summaries use nearest-rank percentiles", () => {
  const summary = summarizeSamples(
    [1, 2, 3, 4, 100].map((elapsedMs) => ({
      elapsedMs,
      requestBytes: 10,
      responseBytes: 20,
    })),
  );
  assert.equal(summary.p50Ms, 3);
  assert.equal(summary.p95Ms, 100);
  assert.equal(summary.meanMs, 22);
  assert.equal(summary.meanRequestBytes, 10);
  assert.equal(summary.meanResponseBytes, 20);
});

class SeedProtocol {
  mutationRequests = 0;
  insertBatchRequests = 0;
  insertedFiles = 0;
  updateRequests = 0;
  maximumStatementsPerBatch = 0;
  maximumFilesPerStatement = 0;
  filesPerInsertBatch = [];

  async executeBatch(statements) {
    this.mutationRequests += 1;
    this.insertBatchRequests += 1;
    this.maximumStatementsPerBatch = Math.max(
      this.maximumStatementsPerBatch,
      statements.length,
    );
    let filesInBatch = 0;
    const value = statements.map((statement) => {
      const files = statement.params.length / 2;
      filesInBatch += files;
      this.insertedFiles += files;
      this.maximumFilesPerStatement = Math.max(
        this.maximumFilesPerStatement,
        files,
      );
      return { rowsAffected: files };
    });
    this.filesPerInsertBatch.push(filesInBatch);
    return {
      value,
    };
  }

  async execute() {
    this.mutationRequests += 1;
    this.updateRequests += 1;
    return { value: { rowsAffected: 1 } };
  }
}

function seedFixture(files) {
  return Array.from({ length: files }, (_, index) => ({
    path: `/corpus/${String(index).padStart(4, "0")}.txt`,
    data: contentFor("txt", 1_024, index),
  }));
}

class PreconditionProtocol {
  pointReads = 0;

  constructor(targetTotalCommits) {
    this.targetTotalCommits = targetTotalCommits;
    this.state = expectedCorpusLookup(
      buildCorpusIndex(),
      targetTotalCommits,
    );
  }

  async execute(sql, params) {
    if (sql.includes("COUNT(*) FROM lix_file")) {
      return {
        value: {
          rows: [
            [
              { kind: "int", value: 1_000 },
              { kind: "int", value: this.targetTotalCommits },
            ],
          ],
        },
      };
    }

    this.pointReads += 1;
    const path = params[0].value;
    return {
      value: {
        rows: [
          [
            { kind: "text", value: path },
            {
              kind: "blob",
              base64: this.state.get(path).toString("base64"),
            },
          ],
        ],
      },
      elapsedMs: 1,
      requestBytes: 2,
      responseBytes: 3,
    };
  }
}

class BranchProtocol {
  createdBranches = [];
  branchLookups = 0;

  constructor(targetTotalCommits) {
    this.targetTotalCommits = targetTotalCommits;
  }

  async createBranch(branch) {
    const receipt = {
      ...branch,
      hidden: false,
      commitId: `commit-${this.targetTotalCommits}`,
    };
    this.createdBranches.push(receipt);
    return {
      value: receipt,
      elapsedMs: 1,
      requestBytes: 2,
      responseBytes: 3,
    };
  }

  async execute(sql, params) {
    if (sql.includes("FROM lix_branch WHERE id = $1")) {
      this.branchLookups += 1;
      const branch = this.createdBranches.find(
        (candidate) => candidate.id === params[0].value,
      );
      return {
        value: {
          rows: [
            [
              { kind: "text", value: branch.id },
              { kind: "text", value: branch.name },
              { kind: "bool", value: false },
              { kind: "text", value: branch.commitId },
            ],
          ],
        },
      };
    }
    if (sql.includes("COUNT(*) FROM lix_file")) {
      return {
        value: {
          rows: [
            [
              { kind: "int", value: 1_000 },
              {
                kind: "int",
                value: this.targetTotalCommits + this.createdBranches.length,
              },
            ],
          ],
        },
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

class BranchSwitchProtocol extends BranchProtocol {
  switchedBranches = [];

  async switchBranch(branchId) {
    this.switchedBranches.push(branchId);
    return {
      value: { branchId },
      elapsedMs: 1,
      requestBytes: 2,
      responseBytes: 3,
    };
  }

  async sessionInfo() {
    return {
      value: { activeBranchId: this.switchedBranches.at(-1) },
      elapsedMs: 1,
      requestBytes: 0,
      responseBytes: 3,
    };
  }
}

class HistoryDiffProtocol {
  historyQueries = 0;
  lastHistorySql = "";

  constructor(targetTotalCommits, corpusFiles = 1_000, { currentDepth = 0 } = {}) {
    this.targetTotalCommits = targetTotalCommits;
    this.corpusFiles = corpusFiles;
    this.currentDepth = currentDepth;
    this.corpus = buildCorpusIndex(corpusFiles);
    this.byPath = new Map(this.corpus.map((file, index) => [file.path, index]));
    this.state = expectedCorpusLookup(this.corpus, targetTotalCommits);
  }

  async execute(sql, params) {
    if (sql.includes("FROM lix_file_history")) {
      this.historyQueries += 1;
      this.lastHistorySql = sql;
      const path = params[0].value;
      const index = this.byPath.get(path);
      const file = this.corpus[index];
      const current = this.state.get(path);
      const previous = contentFor(file.extension, file.bytes, file.seed);
      return {
        value: {
          rows: [
            [
              { kind: "text", value: path },
              { kind: "blob", base64: current.toString("base64") },
              { kind: "int", value: this.currentDepth },
              { kind: "text", value: "head" },
            ],
            [
              { kind: "text", value: path },
              { kind: "blob", base64: previous.toString("base64") },
              { kind: "int", value: this.currentDepth + 1 },
              { kind: "text", value: "prior" },
            ],
          ],
        },
        elapsedMs: 1,
        requestBytes: 2,
        responseBytes: 3,
      };
    }
    if (sql.includes("COUNT(*) FROM lix_file")) {
      return {
        value: {
          rows: [
            [
              { kind: "int", value: this.corpusFiles },
              { kind: "int", value: this.targetTotalCommits },
            ],
          ],
        },
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}
