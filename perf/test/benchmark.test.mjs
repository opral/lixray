import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRowsAffected,
  expectedCorpusLookup,
  runBenchmark,
  seedCorpus,
} from "../lib/benchmark.mjs";
import { buildCorpus, buildCorpusIndex } from "../lib/corpus.mjs";
import { summarizeSamples } from "../lib/statistics.mjs";

test("seeding creates exactly target total commits including genesis", async () => {
  const corpus = buildCorpus();

  for (const targetTotalCommits of [2, 10, 1_000, 1_002]) {
    const protocol = new SeedProtocol();
    const state = await seedCorpus(protocol, corpus, targetTotalCommits);

    assert.equal(
      protocol.mutationRequests,
      targetTotalCommits - 1,
      `target ${targetTotalCommits}`,
    );
    assert.equal(protocol.insertedFiles, 1_000);
    assert.equal(state.size, 1_000);
    assert.equal(
      protocol.updateRequests,
      targetTotalCommits - 2,
    );
    assert.equal(protocol.insertBatchRequests, 1);
    const expected = expectedCorpusLookup(corpus, targetTotalCommits);
    for (const [path, data] of state) {
      assert.deepEqual(expected.get(path), data, path);
    }
  }
});

test("seed insert statements stay bounded while one batch remains one commit", async () => {
  const protocol = new SeedProtocol();
  await seedCorpus(protocol, buildCorpus(), 2);

  assert.equal(protocol.mutationRequests, 1);
  assert.equal(protocol.maximumStatementsPerBatch, 10);
  assert.equal(protocol.maximumFilesPerStatement, 100);
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
  assert.equal(result.measurement.kind, "distribution");
  assert.equal(result.measurement.samples.length, 1);
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

  async executeBatch(statements) {
    this.mutationRequests += 1;
    this.insertBatchRequests += 1;
    this.maximumStatementsPerBatch = Math.max(
      this.maximumStatementsPerBatch,
      statements.length,
    );
    return {
      value: statements.map((statement) => {
        const files = statement.params.length / 2;
        this.insertedFiles += files;
        this.maximumFilesPerStatement = Math.max(
          this.maximumFilesPerStatement,
          files,
        );
        return { rowsAffected: files };
      }),
    };
  }

  async execute() {
    this.mutationRequests += 1;
    this.updateRequests += 1;
    return { value: { rowsAffected: 1 } };
  }
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
