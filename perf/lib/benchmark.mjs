import { performance } from "node:perf_hooks";
import {
  buildCorpus,
  buildCorpusIndex,
  contentFor,
  corpusManifest,
  extensionOf,
} from "./corpus.mjs";
import { summarizeSamples } from "./statistics.mjs";

export const operationNames = Object.freeze([
  "read-point-4k",
  "read-point-32k",
  "list-paths-100",
  "create-4k",
  "update-4k",
  "update-2m",
  "delete-1k",
]);

export function isMutationOperation(operation) {
  return ["create-4k", "update-4k", "update-2m", "delete-1k"].includes(
    operation,
  );
}

export async function runBenchmark(
  protocol,
  {
    operation,
    targetTotalCommits,
    preconditionReadRuns = 0,
    settleMs = 0,
    warmupRuns,
    measuredRuns,
    preseeded = false,
    onProgress,
  },
) {
  if (!operationNames.includes(operation)) {
    throw new Error(`unsupported operation: ${operation}`);
  }
  if (!Number.isSafeInteger(targetTotalCommits) || targetTotalCommits < 2) {
    throw new Error("targetTotalCommits must include genesis and be at least 2");
  }
  if (!Number.isSafeInteger(warmupRuns) || warmupRuns < 0) {
    throw new Error("warmupRuns must be a non-negative integer");
  }
  if (!Number.isSafeInteger(measuredRuns) || measuredRuns < 1) {
    throw new Error("measuredRuns must be a positive integer");
  }
  if (!Number.isSafeInteger(preconditionReadRuns) || preconditionReadRuns < 0) {
    throw new Error("preconditionReadRuns must be a non-negative integer");
  }
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) {
    throw new Error("settleMs must be a non-negative integer");
  }
  if (isMutationOperation(operation) && warmupRuns !== 0) {
    throw new Error(
      "mutation benchmarks require zero warmups so timing starts at the requested commit depth",
    );
  }
  if (isMutationOperation(operation) && measuredRuns !== 1) {
    throw new Error(
      "mutation benchmarks require one measured request per fresh workspace",
    );
  }

  const corpus = preseeded ? buildCorpusIndex() : buildCorpus();
  let state;
  let seedMs;
  if (preseeded) {
    state = expectedCorpusLookup(corpus, targetTotalCommits);
    seedMs = null;
  } else {
    const seedStarted = performance.now();
    state = await seedCorpus(protocol, corpus, targetTotalCommits, {
      onProgress,
    });
    seedMs = performance.now() - seedStarted;
  }

  const preconditionStarted = performance.now();
  await preconditionPointReads(
    protocol,
    corpus,
    state,
    preconditionReadRuns,
  );
  const preconditionReadMs =
    preconditionReadRuns === 0 ? null : performance.now() - preconditionStarted;
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const totalOperations = warmupRuns + measuredRuns;
  const prepared = prepareOperation(operation, corpus, state, totalOperations);
  for (let index = 0; index < warmupRuns; index += 1) {
    const sample = await prepared.execute(protocol, index);
    prepared.assert(sample.value, index);
  }

  const samples = [];
  for (let index = 0; index < measuredRuns; index += 1) {
    const operationIndex = warmupRuns + index;
    const sample = await prepared.execute(protocol, operationIndex);
    prepared.assert(sample.value, operationIndex);
    samples.push({
      elapsedMs: sample.elapsedMs,
      requestBytes: sample.requestBytes,
      responseBytes: sample.responseBytes,
    });
  }

  await prepared.verify(protocol);
  const postTimingAccounting = await readPostTimingAccounting(protocol);
  const expectedFinalCommits =
    targetTotalCommits + (prepared.mutates ? totalOperations : 0);
  const expectedCorpusFiles = corpus.length + prepared.corpusFileDelta;
  if (postTimingAccounting.totalCommits !== expectedFinalCommits) {
    throw new Error(
      `final commit count was ${postTimingAccounting.totalCommits}; expected ${expectedFinalCommits}`,
    );
  }
  if (postTimingAccounting.corpusFiles !== expectedCorpusFiles) {
    throw new Error(
      `final corpus file count was ${postTimingAccounting.corpusFiles}; expected ${expectedCorpusFiles}`,
    );
  }

  return {
    methodology: {
      version: 2,
      operation,
      operationDescription: prepared.description,
      targetTotalCommits,
      genesisIncludedInTarget: true,
      expectedStartTotalCommits: targetTotalCommits,
      knownStartTotalCommits: preseeded ? null : targetTotalCommits,
      freshWorkspaceRequired: !preseeded,
      preseededExactWorkspaceRequired: preseeded,
      historyPreparation: preseeded
        ? "externally-preseeded"
        : "same-session-post-ingest",
      backgroundCompactionQuiescence: preseeded
        ? "caller-managed"
        : "not-quiesced",
      commitDepthIsolation: preseeded
        ? "requires caller-cloned templates and graceful server restart"
        : "not-isolated; post-ingest operational profile",
      oneOperationFamilyPerInvocation: true,
      execution: "sequential",
      concurrency: 1,
      preconditionReadRuns,
      precondition:
        preconditionReadRuns === 0
          ? "none"
          : "unrelated exact-path reads before the timed operation",
      settleMs,
      settling:
        settleMs === 0
          ? "none"
          : "fixed wait after preconditioning and before timing",
      warmupRuns,
      measuredRuns,
      timer: "node:perf_hooks.performance.now",
      timingBoundary:
        "request JSON serialization through response body read and JSON decoding",
      assertionsInsideTiming: false,
      preTimingHistoryAccounting: false,
      postTimingHistoryAccounting: true,
      sampleColumns: ["elapsedMs", "requestBytes", "responseBytes"],
    },
    // A preseeded run keeps corpus payload generation out of the timing
    // prelude. Build the reproducibility manifest only after measurement.
    corpus: corpusManifest(preseeded ? buildCorpus() : corpus),
    setup: {
      seedMs,
      preconditionReadMs,
      settleMs,
      mutationCommitsCreated: preseeded ? 0 : targetTotalCommits - 1,
      expectedTotalCommitsBeforeTiming: targetTotalCommits,
      knownTotalCommitsAfterSeed: preseeded ? null : targetTotalCommits,
      preTimingChecks: {
        acknowledgedCorpusFiles: preseeded ? null : corpus.length,
        currentStateScanned: false,
        historyTablesRead: false,
      },
    },
    measurement: prepared.mutates
      ? {
          kind: "single-mutation",
          sample: compactSample(samples[0]),
        }
      : {
          kind: "distribution",
          summary: summarizeSamples(samples),
          samples: samples.map(compactSample),
        },
    postTimingAccounting: {
      ...postTimingAccounting,
      expectedTotalCommits: expectedFinalCommits,
      expectedCorpusFiles,
    },
  };
}

async function preconditionPointReads(protocol, corpus, state, count) {
  for (let index = 0; index < count; index += 1) {
    // Stay away from the first member of each format, which the mutation
    // cases target. These reads warm the server/runtime/storage path without
    // priming the exact row used by the timed operation or changing history.
    const file = corpus[(517 + index * 131) % corpus.length];
    const result = await protocol.execute(
      "SELECT path, data FROM lix_file WHERE path = $1",
      [wireText(file.path)],
    );
    assertFileRow(result.value, {
      path: file.path,
      data: state.get(file.path),
    });
  }
}

function compactSample(sample) {
  return [sample.elapsedMs, sample.requestBytes, sample.responseBytes];
}

export function expectedCorpusLookup(corpus, targetTotalCommits) {
  const targetMutationCommits = targetTotalCommits - 1;
  if (targetMutationCommits < 1) {
    throw new Error("at least one mutation commit is required to seed the corpus");
  }
  const latestMutationByFile = new Int32Array(corpus.length);
  latestMutationByFile.fill(-1);
  for (let mutation = 1; mutation < targetMutationCommits; mutation += 1) {
    latestMutationByFile[(mutation * 131) % corpus.length] = mutation;
  }
  const fileIndexByPath = new Map(
    corpus.map((file, index) => [file.path, index]),
  );
  const generated = new Map();
  return {
    get(path) {
      const index = fileIndexByPath.get(path);
      if (index === undefined) {
        return undefined;
      }
      const mutation = latestMutationByFile[index];
      if (!generated.has(path)) {
        const file = corpus[index];
        generated.set(
          path,
          contentFor(
            file.extension ?? extensionOf(file.path),
            file.bytes ?? file.data.length,
            mutation < 0 ? file.seed ?? index : 1_000_000 + mutation,
          ),
        );
      }
      return generated.get(path);
    },
  };
}

export async function seedCorpus(
  protocol,
  corpus,
  targetTotalCommits,
  { onProgress } = {},
) {
  const targetMutationCommits = targetTotalCommits - 1;
  if (targetMutationCommits < 1) {
    throw new Error("at least one mutation commit is required to seed the corpus");
  }
  const state = new Map();
  // Keep history shape independent of the requested depth: every workspace
  // gets the same one-commit corpus insert, then deterministic single-file
  // updates extend history. Otherwise c2, c10, and c1000 would use radically
  // different file counts per insertion commit and confound scaling.
  const statements = chunks(corpus, 100).map(fileInsertStatement);
  const result = await protocol.executeBatch(statements);
  assertBatchRowsAffected(
    result.value,
    statements.map((_, index) =>
      Math.min(100, corpus.length - index * 100),
    ),
    "corpus insert",
  );
  for (const file of corpus) {
    state.set(file.path, file.data);
  }
  onProgress?.({
    phase: "insert",
    filesSeeded: corpus.length,
    completedMutationCommits: 1,
    targetMutationCommits,
  });

  for (let mutation = 1; mutation < targetMutationCommits; mutation += 1) {
    const { file, data } = historyMutation(corpus, mutation);
    // Keep history seeding distinct from the timed update in the SQL plan
    // cache without relying on DML target aliases, which Lix does not support.
    const result = await protocol.execute(
      "UPDATE lix_file SET data = $2 WHERE path = $1",
      [wireText(file.path), wireBlob(data)],
    );
    assertRowsAffected(result.value, 1, "history extension");
    state.set(file.path, data);
    onProgress?.({
      phase: "history",
      filesSeeded: corpus.length,
      historyCommits: mutation,
      completedMutationCommits: mutation + 1,
      targetMutationCommits,
    });
  }

  return state;
}

function historyMutation(corpus, mutation) {
  const file = corpus[(mutation * 131) % corpus.length];
  return {
    file,
    data: contentFor(
      extensionOf(file.path),
      file.data.length,
      1_000_000 + mutation,
    ),
  };
}

function prepareOperation(name, corpus, state, totalOperations) {
  const byExtension = (extension) =>
    corpus.filter((file) => extensionOf(file.path) === extension);

  if (name === "read-point-4k") {
    const candidates = byExtension("json");
    const cases = Array.from({ length: totalOperations }, (_, index) => {
      const file = candidates[(index * 17) % candidates.length];
      return { path: file.path, data: state.get(file.path) };
    });
    return {
      description: "point-read one 4 KiB JSON file by exact path",
      mutates: false,
      corpusFileDelta: 0,
      execute: (protocol, index) =>
        protocol.execute(
          "SELECT path, data FROM lix_file WHERE path = $1",
          [wireText(cases[index].path)],
        ),
      assert: (result, index) => assertFileRow(result, cases[index]),
      verify: async () => {},
    };
  }

  if (name === "read-point-32k") {
    const candidates = byExtension("pdf");
    const cases = Array.from({ length: totalOperations }, (_, index) => {
      const file = candidates[(index * 17) % candidates.length];
      return { path: file.path, data: state.get(file.path) };
    });
    return {
      description: "point-read one 32 KiB PDF file by exact path",
      mutates: false,
      corpusFileDelta: 0,
      execute: (protocol, index) =>
        protocol.execute(
          "SELECT path, data FROM lix_file WHERE path = $1",
          [wireText(cases[index].path)],
        ),
      assert: (result, index) => assertFileRow(result, cases[index]),
      verify: async () => {},
    };
  }

  if (name === "list-paths-100") {
    const expectedPaths = corpus.slice(0, 100).map((file) => file.path);
    return {
      description: "list the first 100 corpus paths in lexical order",
      mutates: false,
      corpusFileDelta: 0,
      execute: (protocol) =>
        protocol.execute(
          "SELECT path FROM lix_file WHERE path LIKE '/corpus/%' ORDER BY path LIMIT 100",
          [],
        ),
      assert: (result) => assertPathRows(result, expectedPaths),
      verify: async () => {},
    };
  }

  if (name === "create-4k") {
    const cases = Array.from({ length: totalOperations }, (_, index) => ({
      // `/corpus` already exists after seeding. This measures the common case
      // of adding a file to an existing directory without conflating it with
      // implicit parent-directory creation.
      path: `/corpus/create-${String(index).padStart(4, "0")}.json`,
      data: contentFor("json", 4 * 1024, 2_000_000 + index),
    }));
    return {
      description:
        "create one unique 4 KiB JSON file in an existing directory per request",
      mutates: true,
      corpusFileDelta: totalOperations,
      execute: (protocol, index) =>
        protocol.execute(
          "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
          [wireText(cases[index].path), wireBlob(cases[index].data)],
        ),
      assert: (result) => assertRowsAffected(result, 1, "create-4k"),
      verify: (protocol) => verifyFile(protocol, cases.at(-1)),
    };
  }

  if (name === "update-4k") {
    const candidates = byExtension("json");
    const cases = Array.from({ length: totalOperations }, (_, index) => ({
      path: candidates[(index * 17) % candidates.length].path,
      data: contentFor("json", 4 * 1024, 3_000_000 + index),
    }));
    return {
      description: "replace one existing JSON file with 4 KiB per request",
      mutates: true,
      corpusFileDelta: 0,
      execute: (protocol, index) =>
        protocol.execute(
          "UPDATE lix_file SET data = $1 WHERE path = $2",
          [wireBlob(cases[index].data), wireText(cases[index].path)],
        ),
      assert: (result) => assertRowsAffected(result, 1, "update-4k"),
      verify: (protocol) => verifyFinalCases(protocol, cases),
    };
  }

  if (name === "update-2m") {
    const candidates = byExtension("bin");
    const cases = Array.from({ length: totalOperations }, (_, index) => ({
      path: candidates[(index * 17) % candidates.length].path,
      data: contentFor("bin", 2 * 1024 * 1024, 4_000_000 + index),
    }));
    return {
      description:
        "replace one existing binary file with 2 MiB of deterministic high-entropy data per request",
      mutates: true,
      corpusFileDelta: 0,
      execute: (protocol, index) =>
        protocol.execute(
          "UPDATE lix_file SET data = $1 WHERE path = $2",
          [wireBlob(cases[index].data), wireText(cases[index].path)],
        ),
      assert: (result) => assertRowsAffected(result, 1, "update-2m"),
      verify: (protocol) => verifyFinalCases(protocol, cases),
    };
  }

  if (name === "delete-1k") {
    const candidates = byExtension("txt");
    if (totalOperations > candidates.length) {
      throw new Error(
        `delete-1k supports at most ${candidates.length} warmup plus measured runs`,
      );
    }
    const cases = candidates.slice(0, totalOperations);
    return {
      description: "delete one unique existing 1 KiB text file per request",
      mutates: true,
      corpusFileDelta: -totalOperations,
      execute: (protocol, index) =>
        protocol.execute(
          "DELETE FROM lix_file WHERE path = $1",
          [wireText(cases[index].path)],
        ),
      assert: (result) => assertRowsAffected(result, 1, "delete-1k"),
      verify: async (protocol) => {
        const result = await protocol.execute(
          "SELECT COUNT(*) FROM lix_file WHERE path LIKE '/corpus/%.txt'",
          [],
        );
        assertScalarInteger(
          result.value,
          candidates.length - totalOperations,
          "remaining text files",
        );
      },
    };
  }

  throw new Error(`unsupported operation: ${name}`);
}

async function readPostTimingAccounting(protocol) {
  const result = await protocol.execute(
    `SELECT
       (SELECT COUNT(*) FROM lix_file WHERE path LIKE '/corpus/%') AS corpus_files,
       (SELECT COUNT(*) FROM lix_commit) AS total_commits`,
    [],
  );
  const row = result.value?.rows?.[0];
  return {
    corpusFiles: integerWireValue(row?.[0], "corpus file count"),
    totalCommits: integerWireValue(row?.[1], "total commit count"),
  };
}

async function verifyFile(protocol, expected) {
  const result = await protocol.execute(
    "SELECT path, data FROM lix_file WHERE path = $1",
    [wireText(expected.path)],
  );
  assertFileRow(result.value, expected);
}

async function verifyFinalCases(protocol, cases) {
  const finalByPath = new Map();
  for (const value of cases) {
    finalByPath.set(value.path, value);
  }
  for (const expected of finalByPath.values()) {
    await verifyFile(protocol, expected);
  }
}

function fileInsertStatement(files) {
  const params = [];
  const values = [];
  for (const file of files) {
    const first = params.length + 1;
    values.push(`($${first}, $${first + 1})`);
    params.push(wireText(file.path), wireBlob(file.data));
  }
  return {
    sql: `INSERT INTO lix_file (path, data) VALUES ${values.join(", ")}`,
    params,
  };
}

function assertBatchRowsAffected(result, expected, operation) {
  if (!Array.isArray(result) || result.length !== expected.length) {
    throw new Error(
      `${operation} returned ${Array.isArray(result) ? result.length : "non-array"} results; expected ${expected.length}`,
    );
  }
  result.forEach((entry, index) =>
    assertRowsAffected(entry, expected[index], `${operation} statement ${index}`),
  );
}

export function assertRowsAffected(result, expected, operation) {
  const actual = Number(result?.rowsAffected);
  if (actual !== expected) {
    throw new Error(`${operation} affected ${actual} rows; expected ${expected}`);
  }
}

function assertFileRow(result, expected) {
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].length !== 2) {
    throw new Error(`point read for ${expected.path} did not return one file`);
  }
  const path = rows[0][0];
  const data = rows[0][1];
  if (path?.kind !== "text" || path.value !== expected.path) {
    throw new Error(`point read returned the wrong path for ${expected.path}`);
  }
  if (data?.kind !== "blob" || typeof data.base64 !== "string") {
    throw new Error(`point read did not return blob data for ${expected.path}`);
  }
  if (!Buffer.from(data.base64, "base64").equals(expected.data)) {
    throw new Error(`point read returned the wrong data for ${expected.path}`);
  }
}

function assertPathRows(result, expectedPaths) {
  const rows = result?.rows;
  const actual = Array.isArray(rows)
    ? rows.map((row) => (row[0]?.kind === "text" ? row[0].value : undefined))
    : [];
  if (
    actual.length !== expectedPaths.length ||
    actual.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error("list-paths-100 returned unexpected paths or ordering");
  }
}

function assertScalarInteger(result, expected, description) {
  const value = integerWireValue(result?.rows?.[0]?.[0], description);
  if (value !== expected) {
    throw new Error(`${description} was ${value}; expected ${expected}`);
  }
}

function integerWireValue(value, description) {
  if (
    !value ||
    !["int", "integer"].includes(value.kind) ||
    !Number.isSafeInteger(Number(value.value))
  ) {
    throw new Error(`${description} was not an integer wire value`);
  }
  return Number(value.value);
}

function wireText(value) {
  return { kind: "text", value };
}

function wireBlob(value) {
  return { kind: "blob", base64: Buffer.from(value).toString("base64") };
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
