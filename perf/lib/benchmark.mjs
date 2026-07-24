import { performance } from "node:perf_hooks";
import {
  buildCorpus,
  buildCorpusIndex,
  buildReadPoint2mFixture,
  contentFor,
  CORPUS_FILE_COUNT,
  corpusManifest,
  extensionOf,
  minimumTotalCommitsForFiles,
  SEED_FILES_PER_COMMIT,
  seedCommitCountForFiles,
  sha256,
} from "./corpus.mjs";
import { summarizeSamples } from "./statistics.mjs";

export const operationNames = Object.freeze([
  "read-point-4k",
  "read-point-32k",
  "read-point-2m",
  "list-paths-100",
  "diff-file-history",
  "branch-create",
  "branch-switch",
  "create-4k",
  "update-4k",
  "update-2m",
  "update-mixed",
  "update-mixed-native-single",
  "update-mixed-native-batch",
  "delete-1k",
]);

const mixedUpdateShapes = Object.freeze([
  { extension: "json", bytes: 4 * 1024 },
  { extension: "json", bytes: 4 * 1024 },
  { extension: "json", bytes: 4 * 1024 },
  { extension: "json", bytes: 4 * 1024 },
  { extension: "csv", bytes: 4 * 1024 },
  { extension: "csv", bytes: 4 * 1024 },
  { extension: "csv", bytes: 4 * 1024 },
  { extension: "pdf", bytes: 64 * 1024 },
  { extension: "pdf", bytes: 64 * 1024 },
  { extension: "bin", bytes: 256 * 1024 },
]);

export function isMutationOperation(operation) {
  return [
    "branch-create",
    "create-4k",
    "update-4k",
    "update-2m",
    "update-mixed",
    "update-mixed-native-single",
    "update-mixed-native-batch",
    "delete-1k",
  ].includes(operation);
}

export function minimumTotalCommitsForOperation(operation, corpusFiles) {
  return (
    minimumTotalCommitsForFiles(corpusFiles) +
    fixtureSeedCommitCountForOperation(operation)
  );
}

function fixtureForOperation(operation) {
  return operation === "read-point-2m" ? buildReadPoint2mFixture() : null;
}

function fixtureSeedCommitCountForOperation(operation) {
  return operation === "read-point-2m" ? 1 : 0;
}

function fixtureSeedCommitCountForFixture(fixture) {
  return fixture === null ? 0 : 1;
}

function fixtureMetadata(fixture) {
  return {
    id: fixture.id,
    path: fixture.path,
    bytes: fixture.data.length,
    sha256: sha256(fixture.data),
    seedCommitCount: fixtureSeedCommitCountForFixture(fixture),
    placement:
      "separate targeted seed commit outside the canonical /corpus namespace",
  };
}

export async function runBenchmark(
  protocol,
  {
    operation,
    targetTotalCommits,
    corpusFiles,
    preconditionReadRuns = 0,
    settleMs = 0,
    warmupRuns,
    measuredRuns,
    fileWriteTransport = "json",
    fileWriteShape = "update",
    hotSession = false,
    preseeded = false,
    onProgress,
  },
) {
  if (!operationNames.includes(operation)) {
    throw new Error(`unsupported operation: ${operation}`);
  }
  const requestedCorpusFiles = corpusFiles ?? CORPUS_FILE_COUNT;
  const fixture = fixtureForOperation(operation);
  const commitPlan = commitPlanForCorpus(
    requestedCorpusFiles,
    targetTotalCommits,
    fixture,
  );
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
  if (typeof hotSession !== "boolean") {
    throw new Error("hotSession must be a boolean");
  }
  if (!["binary", "json"].includes(fileWriteTransport)) {
    throw new Error('fileWriteTransport must be either "binary" or "json"');
  }
  if (!["update", "upsert"].includes(fileWriteShape)) {
    throw new Error('fileWriteShape must be either "update" or "upsert"');
  }
  if (
    ["update-mixed-native-single", "update-mixed-native-batch"].includes(
      operation,
    ) &&
    fileWriteTransport !== "binary"
  ) {
    throw new Error(
      "native mixed file-update comparisons require fileWriteTransport: binary",
    );
  }
  if (
    hotSession &&
    ["update-mixed-native-single", "update-mixed-native-batch"].includes(
      operation,
    )
  ) {
    // These two arms create different numbers of commits per logical
    // operation (ten versus one). Keeping several samples in one clone would
    // therefore compare systematically different history depths. The useful
    // comparison is one operation from each independently cloned template.
    throw new Error(
      "native mixed file-update comparisons require isolated one-sample workspaces; hotSession is not supported",
    );
  }
  if (isMutationOperation(operation) && warmupRuns !== 0) {
    throw new Error(
      "mutation benchmarks require zero warmups so timing starts at the requested commit depth",
    );
  }
  if (hotSession && !isMutationOperation(operation)) {
    throw new Error("hotSession is only valid for mutation benchmarks");
  }
  if (hotSession && measuredRuns < 2) {
    throw new Error("hotSession mutation benchmarks require at least two samples");
  }
  if (hotSession && !preseeded) {
    throw new Error("hotSession mutation benchmarks require preseeded: true");
  }
  if (
    operation === "update-mixed" &&
    (!hotSession || measuredRuns % mixedUpdateShapes.length !== 0)
  ) {
    throw new Error(
      "update-mixed requires hotSession and a multiple of " +
        mixedUpdateShapes.length +
        " samples",
    );
  }
  if (
    isMutationOperation(operation) &&
    measuredRuns !== 1 &&
    !hotSession
  ) {
    throw new Error(
      "mutation benchmarks require one measured request per fresh workspace unless hotSession is enabled",
    );
  }

  const corpus = preseeded
    ? buildCorpusIndex(requestedCorpusFiles)
    : buildCorpus(requestedCorpusFiles);
  let state;
  let seedMs;
  if (preseeded) {
    state = expectedCorpusLookup(corpus, targetTotalCommits, { fixture });
    seedMs = null;
  } else {
    const seedStarted = performance.now();
    state = await seedCorpus(protocol, corpus, targetTotalCommits, {
      onProgress,
      fixture,
    });
    seedMs = performance.now() - seedStarted;
  }

  const totalOperations = warmupRuns + measuredRuns;
  const prepared = prepareOperation(
    operation,
    corpus,
    state,
    totalOperations,
    commitPlan,
    fileWriteTransport,
    fileWriteShape,
    fixture,
  );
  const preTimingOperationSetupStarted = performance.now();
  await prepared.setup?.(protocol);
  const preTimingOperationSetupMs = prepared.setup
    ? performance.now() - preTimingOperationSetupStarted
    : null;

  const preconditionStarted = performance.now();
  await preconditionPointReads(
    protocol,
    corpus,
    state,
    preconditionReadRuns,
    prepared.preconditionExcludedPaths,
  );
  const preconditionReadMs =
    preconditionReadRuns === 0 ? null : performance.now() - preconditionStarted;
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

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
  const mutationCommitsPerOperation =
    prepared.mutationCommitsPerOperation ?? (prepared.mutates ? 1 : 0);
  const expectedFinalCommits =
    targetTotalCommits +
    (prepared.preTimingMutationCommits ?? 0) +
    mutationCommitsPerOperation * totalOperations;
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
      ...(fixture
        ? {
            targetedFixture: fixtureMetadata(fixture),
          }
        : {}),
      targetTotalCommits,
      genesisIncludedInTarget: true,
      expectedStartTotalCommits: targetTotalCommits,
      knownStartTotalCommits: preseeded ? null : targetTotalCommits,
      freshWorkspaceRequired: !preseeded,
      preseededExactWorkspaceRequired: preseeded,
      historyPreparation: preseeded
        ? "externally-preseeded"
        : "same-session-post-ingest",
      preTimingOperationSetup:
        prepared.preTimingSetupDescription ?? "none",
      backgroundCompactionQuiescence: preseeded
        ? "caller-managed"
        : "not-quiesced",
      commitDepthIsolation: preseeded
        ? "requires caller-cloned templates and graceful server restart"
        : "not-isolated; post-ingest operational profile",
      oneOperationFamilyPerInvocation: true,
      execution: "sequential",
      concurrency: 1,
      hotSession: prepared.mutates ? hotSession : false,
      mutationCommitsPerOperation,
      mutationSampleIsolation: prepared.mutates
        ? hotSession
          ? "one fresh workspace and one live protocol session; sequential writes form a hot-session distribution"
          : `one timed mutation operation per fresh workspace (${mutationCommitsPerOperation} commit${mutationCommitsPerOperation === 1 ? "" : "s"})`
        : "not applicable",
      fileWriteTransport: prepared.fileWriteTransport ?? null,
      fileWriteShape: prepared.fileWriteShape ?? null,
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
        prepared.timingBoundary ??
        "request JSON serialization through response body read and JSON decoding",
      assertionsInsideTiming: false,
      preTimingHistoryAccounting: false,
      postTimingHistoryAccounting: true,
      sampleColumns: ["elapsedMs", "requestBytes", "responseBytes"],
    },
    // A preseeded run keeps corpus payload generation out of the timing
    // prelude. Build the reproducibility manifest only after measurement.
    corpus: corpusManifest(
      preseeded ? buildCorpus(requestedCorpusFiles) : corpus,
    ),
    setup: {
      seedMs,
      preTimingOperationSetupMs,
      preTimingOperationSetupQueries: prepared.preTimingSetupQueries ?? 0,
      preTimingOperationMutationCommits:
        prepared.preTimingMutationCommits ?? 0,
      preconditionReadMs,
      settleMs,
      seedFilesPerCommit: SEED_FILES_PER_COMMIT,
      seedCommitCount: commitPlan.seedCommitCount,
      ...(fixture
        ? {
            targetedFixtureSeedCommitCount: commitPlan.fixtureSeedCommitCount,
          }
        : {}),
      historyMutationCommits: commitPlan.historyMutationCommits,
      timedMutationCommitsPerOperation: mutationCommitsPerOperation,
      mutationCommitsCreated: preseeded ? 0 : targetTotalCommits - 1,
      expectedTotalCommitsBeforeTiming: targetTotalCommits,
      knownTotalCommitsAfterSeed: preseeded ? null : targetTotalCommits,
      preTimingChecks: {
        acknowledgedCorpusFiles: preseeded ? null : corpus.length,
        currentStateScanned: false,
        historyTablesRead: false,
      },
    },
    measurement: prepared.mutates && !hotSession
      ? {
          kind: "single-mutation",
          sample: compactSample(samples[0]),
        }
      : {
          kind:
            prepared.mutates && hotSession
              ? "hot-mutation-distribution"
              : "distribution",
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

async function preconditionPointReads(
  protocol,
  corpus,
  state,
  count,
  excludedPaths = new Set(),
) {
  const candidates = corpus.filter((file) => !excludedPaths.has(file.path));
  if (count > 0 && candidates.length === 0) {
    throw new Error("precondition reads excluded every corpus path");
  }
  for (let index = 0; index < count; index += 1) {
    // Every timed file path is excluded, so these reads warm the
    // server/runtime/storage path without priming any measured row.
    const file = candidates[(517 + index * 131) % candidates.length];
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

export function expectedCorpusLookup(
  corpus,
  targetTotalCommits,
  { fixture = null } = {},
) {
  const { seedCommitCount, targetMutationCommits } = commitPlanForCorpus(
    corpus.length,
    targetTotalCommits,
    fixture,
  );
  const latestMutationByFile = new Int32Array(corpus.length);
  latestMutationByFile.fill(-1);
  for (
    let mutation = seedCommitCount + fixtureSeedCommitCountForFixture(fixture);
    mutation < targetMutationCommits;
    mutation += 1
  ) {
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
  { onProgress, fixture = null } = {},
) {
  const {
    seedCommitCount,
    fixtureSeedCommitCount,
    historyMutationCommits,
    targetMutationCommits,
  } = commitPlanForCorpus(corpus.length, targetTotalCommits, fixture);
  const state = new Map();
  // A 1,000-file execute-batch is one atomic Lix commit and is small enough
  // to remain under the protocol's 64 MiB JSON request ceiling. Keep this
  // fixed across the file-count matrix: a 5k/10k corpus is several identical
  // seed commits, not one oversized request or one differently-shaped commit.
  for (const [seedIndex, seedFiles] of chunks(
    corpus,
    SEED_FILES_PER_COMMIT,
  ).entries()) {
    // Keep individual SQL statements bounded while execute-batch preserves
    // atomicity for all 1,000 files in this seed commit.
    const statements = chunks(seedFiles, 100).map(fileInsertStatement);
    const result = await protocol.executeBatch(statements);
    assertBatchRowsAffected(
      result.value,
      statements.map((statement) => statement.params.length / 2),
      "corpus insert",
    );
    for (const file of seedFiles) {
      state.set(file.path, file.data);
    }
    onProgress?.({
      phase: "insert",
      filesSeeded: state.size,
      totalFiles: corpus.length,
      seedCommitCount,
      seedFilesPerCommit: SEED_FILES_PER_COMMIT,
      completedSeedCommits: seedIndex + 1,
      completedMutationCommits: seedIndex + 1,
      targetMutationCommits,
    });
  }

  if (fixture) {
    const result = await protocol.execute(
      "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
      [wireText(fixture.path), wireBlob(fixture.data)],
    );
    assertRowsAffected(result.value, 1, "targeted fixture insert");
    state.set(fixture.path, fixture.data);
    onProgress?.({
      phase: "fixture",
      fixtureId: fixture.id,
      fixtureBytes: fixture.data.length,
      completedMutationCommits: seedCommitCount + fixtureSeedCommitCount,
      targetMutationCommits,
    });
  }

  for (
    let historyMutationIndex = 0;
    historyMutationIndex < historyMutationCommits;
    historyMutationIndex += 1
  ) {
    const mutation =
      seedCommitCount + fixtureSeedCommitCount + historyMutationIndex;
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
      totalFiles: corpus.length,
      seedCommitCount,
      seedFilesPerCommit: SEED_FILES_PER_COMMIT,
      historyMutationCommits,
      completedHistoryMutationCommits: historyMutationIndex + 1,
      completedMutationCommits:
        seedCommitCount + fixtureSeedCommitCount + historyMutationIndex + 1,
      targetMutationCommits,
    });
  }

  return state;
}

function commitPlanForCorpus(fileCount, targetTotalCommits, fixture = null) {
  const seedCommitCount = seedCommitCountForFiles(fileCount);
  const fixtureSeedCommitCount = fixtureSeedCommitCountForFixture(fixture);
  const minimumTotalCommits =
    minimumTotalCommitsForFiles(fileCount) + fixtureSeedCommitCount;
  if (
    !Number.isSafeInteger(targetTotalCommits) ||
    targetTotalCommits < minimumTotalCommits
  ) {
    throw new Error(
      `targetTotalCommits must include genesis and be at least ${minimumTotalCommits} for ${fileCount} files (${seedCommitCount} seed commits${
        fixtureSeedCommitCount === 0
          ? ""
          : ` plus ${fixtureSeedCommitCount} targeted fixture seed commit`
      })`,
    );
  }
  return {
    seedCommitCount,
    fixtureSeedCommitCount,
    historyMutationCommits: targetTotalCommits - minimumTotalCommits,
    targetMutationCommits: targetTotalCommits - 1,
  };
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

function prepareOperation(
  name,
  corpus,
  state,
  totalOperations,
  commitPlan,
  fileWriteTransport,
  fileWriteShape,
  fixture,
) {
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      execute: (protocol, index) =>
        protocol.execute(
          "SELECT path, data FROM lix_file WHERE path = $1",
          [wireText(cases[index].path)],
        ),
      assert: (result, index) => assertFileRow(result, cases[index]),
      verify: async () => {},
    };
  }

  if (name === "read-point-2m") {
    if (!fixture) {
      throw new Error("read-point-2m requires its targeted binary fixture");
    }
    const cases = Array.from({ length: totalOperations }, () => ({
      path: fixture.path,
      data: fixture.data,
    }));
    return {
      description:
        "point-read one deterministic 2 MiB binary fixture by exact path",
      mutates: false,
      corpusFileDelta: 0,
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
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
      preconditionExcludedPaths: new Set(expectedPaths),
      execute: (protocol) =>
        protocol.execute(
          "SELECT path FROM lix_file WHERE path LIKE '/corpus/%' ORDER BY path LIMIT 100",
          [],
        ),
      assert: (result) => assertPathRows(result, expectedPaths),
      verify: async () => {},
    };
  }

  if (name === "diff-file-history") {
    const cases = historyDiffCases(corpus, state, commitPlan, totalOperations);
    // Lix's optimized history route is keyed by a file's stable identity, not
    // its path. Resolve the identity before timing so the measured request is
    // the intended history lookup rather than a path-filtered materialization.
    const casesByPath = new Map(cases.map((value) => [value.path, value]));
    return {
      description:
        "read the current and prior logical revisions of one changed 4 KiB file through lix_file_history",
      mutates: false,
      corpusFileDelta: 0,
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      preTimingSetupDescription:
        "resolved each history target's stable lix_file.id by exact path before timing",
      preTimingSetupQueries: casesByPath.size,
      setup: async (protocol) => {
        for (const expected of casesByPath.values()) {
          const result = await protocol.execute(
            "SELECT id FROM lix_file WHERE path = $1",
            [wireText(expected.path)],
          );
          expected.id = assertFileIdRow(result.value, expected.path);
        }
      },
      execute: (protocol, index) =>
        protocol.execute(
          `SELECT path, data, lixcol_depth, lixcol_observed_commit_id
             FROM lix_file_history
            WHERE id = $1
            ORDER BY lixcol_depth`,
          [wireText(historyCaseId(cases[index]))],
        ),
      assert: (result, index) => assertHistoryDiffRows(result, cases[index]),
      verify: async () => {},
    };
  }

  if (name === "branch-create") {
    const cases = Array.from({ length: totalOperations }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return {
        id: `perf-branch-${suffix}`,
        name: `Lixray perf branch ${suffix}`,
        commitId: undefined,
      };
    });
    return {
      description:
        "create one named branch at the active branch head through the protocol branch endpoint",
      mutates: true,
      corpusFileDelta: 0,
      execute: (protocol, index) => protocol.createBranch(cases[index]),
      assert: (result, index) =>
        assertBranchCreateResponse(result, cases[index]),
      verify: async (protocol) => {
        for (const expected of cases) {
          const result = await protocol.execute(
            "SELECT id, name, hidden, commit_id FROM lix_branch WHERE id = $1",
            [wireText(expected.id)],
          );
          assertBranchRow(result.value, expected);
        }
      },
    };
  }

  if (name === "branch-switch") {
    // Branch creation is intentionally outside the timer. A switch is a
    // distinct lifecycle primitive: it changes the pinned branch for a live
    // protocol session but does not write a new workspace commit.
    const branches = [
      {
        id: "perf-switch-a",
        name: "Lixray perf switch branch A",
        commitId: undefined,
      },
      {
        id: "perf-switch-b",
        name: "Lixray perf switch branch B",
        commitId: undefined,
      },
    ];
    const cases = Array.from(
      { length: totalOperations },
      (_, index) => branches[index % branches.length],
    );
    return {
      description:
        "switch the live protocol session between two pre-created sibling branches",
      mutates: false,
      corpusFileDelta: 0,
      preTimingMutationCommits: branches.length,
      preTimingSetupDescription:
        "created two sibling branches through the protocol endpoint before timing branch switches",
      setup: async (protocol) => {
        for (const branch of branches) {
          const result = await protocol.createBranch(branch);
          assertBranchCreateResponse(result.value, branch);
        }
      },
      execute: (protocol, index) => protocol.switchBranch(cases[index].id),
      assert: (result, index) =>
        assertBranchSwitchResponse(result, cases[index].id),
      verify: async (protocol) => {
        const result = await protocol.sessionInfo();
        const expected = cases.at(-1).id;
        if (result.value?.activeBranchId !== expected) {
          throw new Error(
            `branch-switch left the session on ${result.value?.activeBranchId}; expected ${expected}`,
          );
        }
      },
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      fileWriteTransport,
      fileWriteShape: fileWriteTransport === "binary" ? "upsert" : "insert",
      timingBoundary: fileWriteTimingBoundary(fileWriteTransport),
      execute: (protocol, index) =>
        executeFileWrite(
          protocol,
          fileWriteTransport,
          cases[index],
          "create",
          "insert",
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      fileWriteTransport,
      fileWriteShape: fileWriteTransport === "binary" ? "upsert" : fileWriteShape,
      timingBoundary: fileWriteTimingBoundary(fileWriteTransport),
      execute: (protocol, index) =>
        executeFileWrite(
          protocol,
          fileWriteTransport,
          cases[index],
          "update",
          fileWriteShape,
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      fileWriteTransport,
      fileWriteShape: fileWriteTransport === "binary" ? "upsert" : fileWriteShape,
      timingBoundary: fileWriteTimingBoundary(fileWriteTransport),
      execute: (protocol, index) =>
        executeFileWrite(
          protocol,
          fileWriteTransport,
          cases[index],
          "update",
          fileWriteShape,
        ),
      assert: (result) => assertRowsAffected(result, 1, "update-2m"),
      verify: (protocol) => verifyFinalCases(protocol, cases),
    };
  }

  if (name === "update-mixed") {
    const cases = Array.from({ length: totalOperations }, (_, index) => {
      const shape = mixedUpdateShapes[index % mixedUpdateShapes.length];
      const candidates = byExtension(shape.extension);
      return {
        path: candidates[(index * 17) % candidates.length].path,
        data: contentFor(shape.extension, shape.bytes, 5_000_000 + index),
      };
    });
    return {
      description:
        "deterministic 10-write mix: 4x 4 KiB JSON, 3x 4 KiB CSV, 2x 64 KiB PDF, and 1x 256 KiB binary replacement",
      mutates: true,
      corpusFileDelta: 0,
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
      fileWriteTransport,
      fileWriteShape: fileWriteTransport === "binary" ? "upsert" : fileWriteShape,
      timingBoundary: fileWriteTimingBoundary(fileWriteTransport),
      execute: (protocol, index) =>
        executeFileWrite(
          protocol,
          fileWriteTransport,
          cases[index],
          "update",
          fileWriteShape,
        ),
      assert: (result) => assertRowsAffected(result, 1, "update-mixed"),
      verify: (protocol) => verifyFinalCases(protocol, cases),
    };
  }

  if (
    name === "update-mixed-native-single" ||
    name === "update-mixed-native-batch"
  ) {
    const cases = Array.from({ length: totalOperations }, (_, operationIndex) =>
      mixedUpdateShapes.map((shape, shapeIndex) => {
        const candidates = byExtension(shape.extension);
        const extensionOffset = mixedUpdateShapes
          .slice(0, shapeIndex)
          .filter((candidate) => candidate.extension === shape.extension).length;
        return {
          // Keep all ten paths distinct inside a logical operation. Reuse the
          // same deterministic paths and bytes for the sequential control and
          // the one-frame batch treatment.
          path: candidates[
            (operationIndex * 31 + extensionOffset * 17) % candidates.length
          ].path,
          data: contentFor(
            shape.extension,
            shape.bytes,
            6_000_000 + operationIndex * mixedUpdateShapes.length + shapeIndex,
          ),
        };
      }),
    );
    const isBatch = name === "update-mixed-native-batch";
    return {
      description: isBatch
        ? "replace a deterministic 10-file mixed payload through one raw binary batch request and one commit"
        : "replace the same deterministic 10-file mixed payload through ten sequential raw binary requests and ten commits",
      mutates: true,
      mutationCommitsPerOperation: isBatch ? 1 : mixedUpdateShapes.length,
      corpusFileDelta: 0,
      preconditionExcludedPaths: new Set(
        cases.flatMap((files) => files.map(({ path }) => path)),
      ),
      fileWriteTransport: "binary",
      fileWriteShape: "upsert",
      timingBoundary: isBatch
        ? "client u32 batch-frame encoding, one raw octet-stream request, response body read, and JSON decoding"
        : "ten sequential raw octet-stream requests through response body reads and JSON decoding",
      execute: (protocol, index) =>
        isBatch
          ? protocol.upsertFileDataBatch(cases[index])
          : executeSequentialNativeFileUpserts(protocol, cases[index]),
      assert: (result) =>
        assertRowsAffected(result, mixedUpdateShapes.length, name),
      verify: (protocol) => verifyFinalCases(protocol, cases.flat()),
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
      preconditionExcludedPaths: new Set(cases.map(({ path }) => path)),
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

function historyDiffCases(corpus, state, commitPlan, totalOperations) {
  if (commitPlan.historyMutationCommits < 1) {
    throw new Error(
      "diff-file-history requires at least one post-seed history mutation",
    );
  }
  const latestMutationByFile = new Int32Array(corpus.length);
  const previousMutationByFile = new Int32Array(corpus.length);
  latestMutationByFile.fill(-1);
  previousMutationByFile.fill(-1);
  for (
    let mutation = commitPlan.seedCommitCount;
    mutation < commitPlan.targetMutationCommits;
    mutation += 1
  ) {
    const fileIndex = (mutation * 131) % corpus.length;
    previousMutationByFile[fileIndex] = latestMutationByFile[fileIndex];
    latestMutationByFile[fileIndex] = mutation;
  }

  const candidates = [];
  for (let index = 0; index < corpus.length; index += 1) {
    const latestMutation = latestMutationByFile[index];
    if (latestMutation < 0) {
      continue;
    }
    const file = corpus[index];
    const extension = file.extension ?? extensionOf(file.path);
    const bytes = file.bytes ?? file.data.length;
    if (bytes !== 4 * 1024) {
      continue;
    }
    const priorMutation = previousMutationByFile[index];
    const currentData = state.get(file.path);
    if (!currentData) {
      throw new Error(`history diff state was missing ${file.path}`);
    }
    candidates.push({
      path: file.path,
      data: currentData,
      previousData: contentFor(
        extension,
        bytes,
        priorMutation < 0 ? file.seed ?? index : 1_000_000 + priorMutation,
      ),
    });
  }
  if (candidates.length === 0) {
    throw new Error("diff-file-history did not find a changed corpus file");
  }
  return Array.from(
    { length: totalOperations },
    (_, index) => candidates[(index * 17) % candidates.length],
  );
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

function assertFileIdRow(result, path) {
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].length !== 1) {
    throw new Error(`stable id lookup for ${path} did not return one file id`);
  }
  const id = rows[0][0];
  if (id?.kind !== "text" || typeof id.value !== "string" || id.value.length === 0) {
    throw new Error(`stable id lookup for ${path} did not return a text id`);
  }
  return id.value;
}

function historyCaseId(value) {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(
      `history diff target ${value.path} did not resolve a stable lix_file.id before timing`,
    );
  }
  return value.id;
}

function assertHistoryDiffRows(result, expected) {
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(
      `history-backed diff for ${expected.path} did not return two revisions`,
    );
  }
  const [current, previous] = rows;
  if (current.length !== 4 || previous.length !== 4) {
    throw new Error(`history-backed diff for ${expected.path} had malformed rows`);
  }
  const [currentPath, currentData, currentDepth, currentCommit] = current;
  const [previousPath, previousData, previousDepth, previousCommit] = previous;
  if (
    currentPath?.kind !== "text" ||
    currentPath.value !== expected.path ||
    previousPath?.kind !== "text" ||
    previousPath.value !== expected.path
  ) {
    throw new Error(`history-backed diff returned the wrong path for ${expected.path}`);
  }
  const currentBytes = blobWireValue(currentData, "current history revision");
  const previousBytes = blobWireValue(previousData, "prior history revision");
  if (!currentBytes.equals(expected.data)) {
    throw new Error(
      `history-backed diff returned the wrong current data for ${expected.path}`,
    );
  }
  if (!previousBytes.equals(expected.previousData)) {
    throw new Error(
      `history-backed diff returned the wrong prior data for ${expected.path}`,
    );
  }
  const currentDepthValue = integerWireValue(
    currentDepth,
    "current history revision depth",
  );
  const previousDepthValue = integerWireValue(
    previousDepth,
    "prior history revision depth",
  );
  // A file can have been last changed many commits before the pinned branch
  // head. `lixcol_depth` is that distance, so the current revision need not
  // have depth zero; ascending depth still places it ahead of its prior
  // revision.
  if (previousDepthValue <= currentDepthValue) {
    throw new Error(
      `history-backed diff did not return ordered current and prior revisions for ${expected.path}`,
    );
  }
  if (currentBytes.equals(previousBytes)) {
    throw new Error(
      `history-backed diff did not return distinct payloads for ${expected.path}`,
    );
  }
  if (
    currentCommit?.kind !== "text" ||
    currentCommit.value.length === 0 ||
    previousCommit?.kind !== "text" ||
    previousCommit.value.length === 0
  ) {
    throw new Error(
      `history-backed diff did not return observed commit ids for ${expected.path}`,
    );
  }
}

function assertBranchCreateResponse(result, expected) {
  if (
    !result ||
    result.id !== expected.id ||
    result.name !== expected.name ||
    result.hidden !== false ||
    typeof result.commitId !== "string" ||
    result.commitId.length === 0
  ) {
    throw new Error(`branch-create returned an invalid receipt for ${expected.id}`);
  }
  expected.commitId = result.commitId;
}

function assertBranchSwitchResponse(result, expectedBranchId) {
  if (result?.branchId !== expectedBranchId) {
    throw new Error(
      `branch-switch returned ${result?.branchId}; expected ${expectedBranchId}`,
    );
  }
}

function assertBranchRow(result, expected) {
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].length !== 4) {
    throw new Error(`branch-create did not persist ${expected.id}`);
  }
  const [id, name, hidden, commitId] = rows[0];
  if (
    id?.kind !== "text" ||
    id.value !== expected.id ||
    name?.kind !== "text" ||
    name.value !== expected.name ||
    hidden?.kind !== "bool" ||
    hidden.value !== false ||
    commitId?.kind !== "text" ||
    commitId.value !== expected.commitId
  ) {
    throw new Error(`branch-create persisted an unexpected branch row for ${expected.id}`);
  }
}

function blobWireValue(value, description) {
  if (value?.kind !== "blob" || typeof value.base64 !== "string") {
    throw new Error(`${description} was not a blob wire value`);
  }
  return Buffer.from(value.base64, "base64");
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

function executeFileWrite(protocol, transport, file, operation, shape) {
  if (transport === "binary") {
    return protocol.upsertFileData(file.path, file.data);
  }
  return protocol.executeFileData(file.path, file.data, {
    shape: operation === "create" ? "insert" : shape,
  });
}

async function executeSequentialNativeFileUpserts(protocol, files) {
  const started = performance.now();
  const responses = [];
  for (const file of files) {
    responses.push(await protocol.upsertFileData(file.path, file.data));
  }
  const elapsedMs = performance.now() - started;

  return {
    value: {
      rowsAffected: responses.reduce((total, response) => {
        const rows = response.value?.rowsAffected;
        if (!Number.isSafeInteger(rows)) {
          throw new Error(
            "native single-file upsert response did not contain an integer rowsAffected",
          );
        }
        return total + rows;
      }, 0),
    },
    elapsedMs,
    // Match ProtocolClient: response aggregation and byte accounting happen
    // after the logical request sequence has stopped the timer.
    requestBytes: responses.reduce(
      (total, response) => total + response.requestBytes,
      0,
    ),
    responseBytes: responses.reduce(
      (total, response) => total + response.responseBytes,
      0,
    ),
  };
}

function fileWriteTimingBoundary(transport) {
  return transport === "binary"
    ? "raw octet-stream request transfer through response body read and JSON decoding"
    : "client base64 and JSON serialization through response body read and JSON decoding";
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
