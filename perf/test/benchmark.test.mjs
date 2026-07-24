import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRowsAffected,
  expectedCorpusLookup,
  minimumTotalCommitsForOperation,
  runBenchmark,
  seedCorpus,
} from "../lib/benchmark.mjs";
import {
  buildCorpus,
  buildCorpusIndex,
  buildReadPoint2mFixture,
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
  assert.equal(minimumTotalCommitsForOperation("read-point-2m", 1_000), 3);
  await assert.rejects(
    runBenchmark(
      {},
      {
        operation: "read-point-2m",
        targetTotalCommits: 2,
        warmupRuns: 0,
        measuredRuns: 1,
      },
    ),
    /at least 3 for 1000 files \(1 seed commits plus 1 targeted fixture seed commit\)/,
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
  const preconditionedPaths = protocol.readPaths.slice(0, 5);
  const measuredPaths = new Set(protocol.readPaths.slice(5));
  assert.ok(
    preconditionedPaths.every((path) => !measuredPaths.has(path)),
    "preconditions must exclude every later timed point-read path",
  );
  assert.equal(result.methodology.preconditionReadRuns, 5);
  assert.match(result.methodology.precondition, /unrelated exact-path reads/);
  assert.equal(typeof result.setup.preconditionReadMs, "number");
  assert.equal(result.methodology.settleMs, 1);
  assert.equal(result.setup.settleMs, 1);
  assert.equal(result.setup.seedFilesPerCommit, 1_000);
  assert.equal(result.setup.seedCommitCount, 1);
  assert.equal(result.methodology.targetedFixture, undefined);
  assert.equal(result.setup.targetedFixtureSeedCommitCount, undefined);
  assert.equal(result.setup.historyMutationCommits, 8);
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.measurement.samples.length, 1);
});

test("read-point-2m reads its explicit deterministic fixture", async () => {
  const protocol = new LargeReadProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "read-point-2m",
    targetTotalCommits: 10,
    preconditionReadRuns: 2,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });

  assert.equal(protocol.largeFixtureReads, 1);
  assert.equal(protocol.pointReads, 3);
  assert.equal(
    result.methodology.targetedFixture.id,
    "read-point-2m-binary-v1",
  );
  assert.equal(result.methodology.targetedFixture.bytes, 2 * 1024 * 1024);
  assert.equal(result.setup.targetedFixtureSeedCommitCount, 1);
  assert.equal(result.setup.historyMutationCommits, 7);
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.postTimingAccounting.totalCommits, 10);
  assert.equal(result.postTimingAccounting.corpusFiles, 1_000);
});

test("the targeted large fixture has its own seed commit before history", async () => {
  const protocol = new SeedProtocol();
  const fixture = buildReadPoint2mFixture();
  await seedCorpus(protocol, seedFixture(1_000), 4, { fixture });

  assert.equal(protocol.mutationRequests, 3);
  assert.equal(protocol.insertBatchRequests, 1);
  assert.equal(protocol.fixtureInsertRequests, 1);
  assert.equal(protocol.updateRequests, 1);
  assert.deepEqual(protocol.mutationKinds, ["corpus", "fixture", "history"]);
  assert.deepEqual(protocol.fixtureInserts, [
    { path: fixture.path, bytes: fixture.data.length },
  ]);
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
  assert.equal(protocol.historyIdLookups, 1);
  assert.equal(
    protocol.lastHistoryIdLookupSql,
    "SELECT id FROM lix_file WHERE path = $1",
  );
  assert.equal(protocol.lastHistoryIdLookupParams[0].kind, "text");
  assert.equal(protocol.lastHistoryParams[0].kind, "text");
  assert.equal(
    protocol.lastHistoryParams[0].value,
    protocol.lastResolvedHistoryId,
  );
  assert.match(protocol.lastHistorySql, /FROM lix_file_history/);
  assert.match(protocol.lastHistorySql, /WHERE id = \$1/);
  assert.doesNotMatch(protocol.lastHistorySql, /WHERE path = \$1/);
  assert.doesNotMatch(protocol.lastHistorySql, /lixcol_as_of_commit_id/);
  assert.match(result.methodology.preTimingOperationSetup, /stable lix_file\.id/);
  assert.equal(result.setup.preTimingOperationSetupQueries, 1);
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

test("file-write transport is explicit and defaults to JSON for reproducible A/Bs", async () => {
  const binaryProtocol = new FileWriteProtocol(10);
  const binary = await runBenchmark(binaryProtocol, {
    operation: "update-4k",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 1,
    fileWriteTransport: "binary",
    preseeded: true,
  });
  assert.equal(binaryProtocol.binaryWrites.length, 1);
  assert.equal(binaryProtocol.jsonWrites.length, 0);
  assert.equal(binary.methodology.fileWriteTransport, "binary");
  assert.equal(binary.methodology.fileWriteShape, "upsert");
  assert.match(binary.methodology.timingBoundary, /octet-stream/);
  assert.equal(binary.measurement.sample[1], 4 * 1024);

  const jsonProtocol = new FileWriteProtocol(10);
  const json = await runBenchmark(jsonProtocol, {
    operation: "update-4k",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 1,
    preseeded: true,
  });
  assert.equal(jsonProtocol.binaryWrites.length, 0);
  assert.equal(jsonProtocol.jsonWrites.length, 1);
  assert.equal(json.methodology.fileWriteTransport, "json");
  assert.equal(json.methodology.fileWriteShape, "update");
  assert.match(json.methodology.timingBoundary, /JSON serialization/);
  assert.ok(json.measurement.sample[1] > 4 * 1024);

  const upsertProtocol = new FileWriteProtocol(10);
  const upsert = await runBenchmark(upsertProtocol, {
    operation: "update-4k",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 1,
    fileWriteTransport: "json",
    fileWriteShape: "upsert",
    preseeded: true,
  });
  assert.equal(upsertProtocol.jsonWrites.length, 1);
  assert.equal(upsertProtocol.jsonWrites[0].shape, "upsert");
  assert.equal(upsert.methodology.fileWriteShape, "upsert");
});

test("hot-session mutation distributions retain accounting and session semantics", async () => {
  const protocol = new FileWriteProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "update-4k",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 3,
    fileWriteTransport: "binary",
    hotSession: true,
    preseeded: true,
  });

  assert.equal(protocol.binaryWrites.length, 3);
  assert.equal(result.methodology.hotSession, true);
  assert.match(result.methodology.mutationSampleIsolation, /live protocol session/);
  assert.equal(result.measurement.kind, "hot-mutation-distribution");
  assert.equal(result.measurement.samples.length, 3);
  assert.equal(result.postTimingAccounting.totalCommits, 13);
  assert.equal(result.postTimingAccounting.corpusFiles, 1_000);
});

test("hot-session preconditioning excludes every timed mutation path", async () => {
  const protocol = new FileWriteProtocol(10);
  await runBenchmark(protocol, {
    operation: "update-mixed",
    targetTotalCommits: 10,
    preconditionReadRuns: 10,
    warmupRuns: 0,
    measuredRuns: 10,
    fileWriteTransport: "binary",
    hotSession: true,
    preseeded: true,
  });

  const mutationPaths = new Set(
    protocol.binaryWrites.map((write) => write.path),
  );
  assert.equal(protocol.preconditionReadPaths.length, 10);
  assert.ok(
    protocol.preconditionReadPaths.every((path) => !mutationPaths.has(path)),
  );
});

test("hot-session mutation distributions require an externally preseeded clone", async () => {
  await assert.rejects(
    runBenchmark(new FileWriteProtocol(10), {
      operation: "update-4k",
      targetTotalCommits: 10,
      warmupRuns: 0,
      measuredRuns: 2,
      hotSession: true,
      preseeded: false,
    }),
    /require preseeded: true/,
  );
});

test("mixed hot writes use the fixed happy-path payload distribution", async () => {
  const protocol = new FileWriteProtocol(10);
  const result = await runBenchmark(protocol, {
    operation: "update-mixed",
    targetTotalCommits: 10,
    warmupRuns: 0,
    measuredRuns: 10,
    fileWriteTransport: "binary",
    hotSession: true,
    preseeded: true,
  });

  assert.deepEqual(
    protocol.binaryWrites.map((write) => write.data.byteLength),
    [
      4 * 1024,
      4 * 1024,
      4 * 1024,
      4 * 1024,
      4 * 1024,
      4 * 1024,
      4 * 1024,
      64 * 1024,
      64 * 1024,
      256 * 1024,
    ],
  );
  assert.equal(result.measurement.kind, "hot-mutation-distribution");
  assert.equal(result.postTimingAccounting.totalCommits, 20);

  await assert.rejects(
    runBenchmark(new FileWriteProtocol(10), {
      operation: "update-mixed",
      targetTotalCommits: 10,
      warmupRuns: 0,
      measuredRuns: 1,
      preseeded: true,
    }),
    /requires hotSession and a multiple of 10 samples/,
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
  fixtureInsertRequests = 0;
  fixtureInserts = [];
  mutationKinds = [];
  maximumStatementsPerBatch = 0;
  maximumFilesPerStatement = 0;
  filesPerInsertBatch = [];

  async executeBatch(statements) {
    this.mutationRequests += 1;
    this.insertBatchRequests += 1;
    this.mutationKinds.push("corpus");
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

  async execute(sql, params) {
    this.mutationRequests += 1;
    if (sql.startsWith("INSERT INTO lix_file")) {
      this.fixtureInsertRequests += 1;
      this.mutationKinds.push("fixture");
      this.fixtureInserts.push({
        path: params[0].value,
        bytes: Buffer.from(params[1].base64, "base64").length,
      });
      return { value: { rowsAffected: 1 } };
    }
    this.updateRequests += 1;
    this.mutationKinds.push("history");
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
  readPaths = [];

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
    this.readPaths.push(path);
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

class LargeReadProtocol extends PreconditionProtocol {
  largeFixtureReads = 0;

  constructor(targetTotalCommits) {
    super(targetTotalCommits);
    this.fixture = buildReadPoint2mFixture();
    this.state = expectedCorpusLookup(buildCorpusIndex(), targetTotalCommits, {
      fixture: this.fixture,
    });
  }

  async execute(sql, params) {
    if (sql.includes("COUNT(*) FROM lix_file")) {
      return super.execute(sql, params);
    }
    const path = params[0].value;
    if (path !== this.fixture.path) {
      return super.execute(sql, params);
    }
    this.pointReads += 1;
    this.largeFixtureReads += 1;
    return {
      value: {
        rows: [
          [
            { kind: "text", value: path },
            {
              kind: "blob",
              base64: this.fixture.data.toString("base64"),
            },
          ],
        ],
      },
      elapsedMs: 1,
      requestBytes: 2,
      responseBytes: this.fixture.data.length,
    };
  }
}

class FileWriteProtocol {
  binaryWrites = [];
  jsonWrites = [];
  preconditionReadPaths = [];

  constructor(targetTotalCommits) {
    this.targetTotalCommits = targetTotalCommits;
    this.state = expectedCorpusLookup(
      buildCorpusIndex(),
      targetTotalCommits,
    );
    this.written = new Map();
  }

  async upsertFileData(path, data) {
    this.binaryWrites.push({ path, data });
    this.written.set(path, data);
    return {
      value: { rowsAffected: 1 },
      elapsedMs: 1,
      requestBytes: data.byteLength,
      responseBytes: 3,
    };
  }

  async executeFileData(path, data, { shape }) {
    this.jsonWrites.push({ path, data, shape });
    this.written.set(path, data);
    const blob = { kind: "blob", base64: data.toString("base64") };
    const text = { kind: "text", value: path };
    const body =
      shape === "update"
        ? {
            sql: "UPDATE lix_file SET data = $1 WHERE path = $2",
            params: [blob, text],
          }
        : {
            sql:
              shape === "insert"
                ? "INSERT INTO lix_file (path, data) VALUES ($1, $2)"
                : "INSERT INTO lix_file (path, data) VALUES ($1, $2) " +
                  "ON CONFLICT (path) DO UPDATE SET data = excluded.data",
            params: [text, blob],
          };
    return {
      value: { rowsAffected: 1 },
      elapsedMs: 1,
      requestBytes: Buffer.byteLength(JSON.stringify(body)),
      responseBytes: 3,
    };
  }

  async execute(sql, params) {
    if (sql.includes("COUNT(*) FROM lix_file")) {
      return {
        value: {
          rows: [
            [
              { kind: "int", value: 1_000 },
              {
                kind: "int",
                value:
                  this.targetTotalCommits +
                  this.binaryWrites.length +
                  this.jsonWrites.length,
              },
            ],
          ],
        },
      };
    }
    if (sql.startsWith("SELECT path, data FROM lix_file WHERE path")) {
      const path = params[0].value;
      if (this.binaryWrites.length === 0 && this.jsonWrites.length === 0) {
        this.preconditionReadPaths.push(path);
      }
      return {
        value: {
          rows: [
            [
              { kind: "text", value: path },
              {
                kind: "blob",
                base64: (this.written.get(path) ?? this.state.get(path)).toString(
                  "base64",
                ),
              },
            ],
          ],
        },
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
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
  historyIdLookups = 0;
  lastHistoryIdLookupSql = "";
  lastHistoryIdLookupParams = [];
  lastHistorySql = "";
  lastHistoryParams = [];
  lastResolvedHistoryId = "";

  constructor(targetTotalCommits, corpusFiles = 1_000, { currentDepth = 0 } = {}) {
    this.targetTotalCommits = targetTotalCommits;
    this.corpusFiles = corpusFiles;
    this.currentDepth = currentDepth;
    this.corpus = buildCorpusIndex(corpusFiles);
    this.byPath = new Map(this.corpus.map((file, index) => [file.path, index]));
    this.idByPath = new Map(
      this.corpus.map((file, index) => [file.path, `file-id-${index}`]),
    );
    this.byId = new Map(
      this.corpus.map((file, index) => [`file-id-${index}`, index]),
    );
    this.state = expectedCorpusLookup(this.corpus, targetTotalCommits);
  }

  async execute(sql, params) {
    if (sql === "SELECT id FROM lix_file WHERE path = $1") {
      this.historyIdLookups += 1;
      this.lastHistoryIdLookupSql = sql;
      this.lastHistoryIdLookupParams = params;
      const id = this.idByPath.get(params[0].value);
      if (id === undefined) {
        throw new Error(`unknown history path: ${params[0].value}`);
      }
      this.lastResolvedHistoryId = id;
      return {
        value: {
          rows: [[{ kind: "text", value: id }]],
        },
      };
    }
    if (sql.includes("FROM lix_file_history")) {
      this.historyQueries += 1;
      this.lastHistorySql = sql;
      this.lastHistoryParams = params;
      const index = this.byId.get(params[0].value);
      if (index === undefined) {
        throw new Error(`unknown history id: ${params[0].value}`);
      }
      const file = this.corpus[index];
      const path = file.path;
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
