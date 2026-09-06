#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ProtocolClient, readServerStorageIdentity } from "../lib/protocol.mjs";
import {
  buildMovieCorpusIndex,
  movieCorpusManifest,
  MOVIE_FILE_COUNT,
  MOVIE_LOGICAL_BYTES,
} from "./corpus.mjs";
import { MOVIE_STREAM_CHUNK_BYTES, moviePayloadChunk } from "./payload.mjs";

const MAX_BATCH_BYTES = 48 * 1024 * 1024;
const MAX_BATCH_FILES = 1_024;
const TARGET_COMMITS = 5_000;

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

async function main(args) {
  const config = parseArgs(args);
  const files = buildMovieCorpusIndex();
  const manifest = movieCorpusManifest(files);
  const segments = partitionByLogicalBytes(files, config.segmentCount);
  const selected = segments[config.segmentIndex];
  const client = new ProtocolClient({
    baseUrl: config.baseUrl,
    repositoryId: config.repositoryId,
    internalToken: config.internalToken,
  });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let transferredBytes = 0;
  let uploadedFiles = 0;

  const storage = await readServerStorageIdentity(config.baseUrl);
  if (storage.storageBackend !== "slatedb") {
    throw new Error(`remote movie qualification requires SlateDB, got ${storage.storageBackend}`);
  }

  await client.open();
  try {
    for (let index = 0; index < selected.length; ) {
      const file = selected[index];
      if (file.media) {
        transferredBytes += await uploadMediaFile(client, file, config.onProgress);
        uploadedFiles += 1;
        index += 1;
        continue;
      }

      const batch = [];
      let batchBytes = 0;
      while (index < selected.length && !selected[index].media) {
        const candidate = selected[index];
        if (
          batch.length > 0 &&
          (batch.length === MAX_BATCH_FILES || batchBytes + candidate.bytes > MAX_BATCH_BYTES)
        ) {
          break;
        }
        batch.push({
          path: candidate.path,
          data: moviePayloadChunk(candidate, 0, candidate.bytes),
        });
        batchBytes += candidate.bytes;
        index += 1;
      }
      if (batch.length > 0) {
        await client.upsertFileDataBatch(batch);
        transferredBytes += batchBytes;
        uploadedFiles += batch.length;
        config.onProgress(`uploaded ${uploadedFiles} files in segment ${config.segmentIndex + 1}`);
      }
    }

    await verifySegment(client, selected);
    let totalCommits = await countCommits(client);
    if (config.finalizeHistory) {
      const totalFiles = await countMovieFiles(client);
      if (totalFiles !== MOVIE_FILE_COUNT) {
        throw new Error(`history finalization requires ${MOVIE_FILE_COUNT} files, found ${totalFiles}`);
      }
      totalCommits = await extendHistory(client, totalCommits, config.onProgress);
    }

    const elapsedMs = performance.now() - started;
    const report = {
      schemaVersion: 1,
      benchmark: "lixray-remote-movie-qualification",
      startedAt,
      finishedAt: new Date().toISOString(),
      target: {
        baseUrl: config.baseUrl,
        repositoryId: config.repositoryId,
        ...storage,
      },
      corpus: manifest,
      segment: {
        index: config.segmentIndex,
        count: config.segmentCount,
        files: selected.length,
        logicalBytes: selected.reduce((sum, file) => sum + file.bytes, 0),
      },
      result: {
        uploadedFiles,
        transferredBytes,
        elapsedMs,
        throughputMiBPerSecond: transferredBytes / (1024 ** 2) / (elapsedMs / 1000),
        totalCommits,
        finalizedHistory: config.finalizeHistory,
      },
    };
    await mkdir(dirname(config.output), { recursive: true });
    await writeFile(config.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally {
    await client.close();
  }
}

export function partitionByLogicalBytes(files, count) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError("segment count must be positive");
  const target = Math.ceil(MOVIE_LOGICAL_BYTES / count);
  const segments = Array.from({ length: count }, () => []);
  let segment = 0;
  let bytes = 0;
  for (const file of files) {
    if (segment < count - 1 && segments[segment].length > 0 && bytes + file.bytes > target) {
      segment += 1;
      bytes = 0;
    }
    segments[segment].push(file);
    bytes += file.bytes;
  }
  return segments;
}

async function uploadMediaFile(client, file, onProgress) {
  const uploadId = `movie-v1-${file.seed}`;
  let transferred = 0;
  for (let offset = 0; offset < file.bytes; offset += MOVIE_STREAM_CHUNK_BYTES) {
    const length = Math.min(MOVIE_STREAM_CHUNK_BYTES, file.bytes - offset);
    const data = moviePayloadChunk(file, offset, length);
    const result = await retry(() =>
      client.upsertFileData(file.path, data, {
        uploadId,
        start: offset,
        totalSize: file.bytes,
      }),
    );
    const expected = offset + length;
    if (result.value?.nextOffset !== expected) {
      throw new Error(`${file.path} acknowledged ${result.value?.nextOffset}; expected ${expected}`);
    }
    transferred += length;
  }
  onProgress(`uploaded ${file.path} (${(file.bytes / 1024 ** 3).toFixed(2)} GiB)`);
  return transferred;
}

async function retry(operation) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
  throw lastError;
}

async function verifySegment(client, files) {
  for (const file of [files[0], files.at(-1)].filter(Boolean)) {
    const start = Math.max(0, Math.floor(file.bytes / 2) - 32 * 1024);
    const endExclusive = Math.min(file.bytes, start + 64 * 1024);
    const result = await retry(() => client.readFileData(file.path, { start, endExclusive }));
    const expected = moviePayloadChunk(file, start, endExclusive - start);
    if (!result.value.found || !result.value.data.equals(expected)) {
      throw new Error(`range verification failed for ${file.path}`);
    }
  }
}

async function countMovieFiles(client) {
  const result = await client.execute("SELECT COUNT(*) FROM lix_file WHERE path LIKE '/movie/%'");
  return integerWireValue(result.value?.rows?.[0]?.[0], "movie file count");
}

async function countCommits(client) {
  const result = await client.execute("SELECT COUNT(*) FROM lix_commit");
  return integerWireValue(result.value?.rows?.[0]?.[0], "commit count");
}

async function extendHistory(client, current, onProgress) {
  if (current > TARGET_COMMITS) throw new Error(`repository already has ${current} commits; target is ${TARGET_COMMITS}`);
  const path = "/movie/sidecar/00000.json";
  for (let commit = current; commit < TARGET_COMMITS; commit += 1) {
    const digest = createHash("sha256").update(`movie-project-save-v1\0${commit}`).digest();
    const data = Buffer.alloc(16 * 1024);
    for (let offset = 0; offset < data.length; offset += digest.length) digest.copy(data, offset);
    await client.upsertFileData(path, data);
    if ((commit + 1) % 250 === 0) onProgress(`history reached ${commit + 1} commits`);
  }
  const total = await countCommits(client);
  if (total !== TARGET_COMMITS) throw new Error(`commit qualification found ${total}; expected ${TARGET_COMMITS}`);
  return total;
}

function integerWireValue(value, description) {
  if (!value || !["int", "integer"].includes(value.kind) || !Number.isSafeInteger(Number(value.value))) {
    throw new Error(`${description} was not an integer wire value`);
  }
  return Number(value.value);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const baseUrl = required(values, "--url").replace(/\/+$/, "");
  const repositoryId = required(values, "--repository");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(repositoryId)) {
    throw new Error("--repository must be a canonical Lix UUID");
  }
  const segmentIndex = integer(values, "--segment-index", 0);
  const segmentCount = integer(values, "--segment-count", 1);
  if (segmentIndex >= segmentCount) throw new RangeError("segment index must be smaller than segment count");
  const internalToken = process.env.LIXRAY_INTERNAL_TOKEN?.trim();
  if (!internalToken) throw new Error("LIXRAY_INTERNAL_TOKEN is required");
  return {
    baseUrl,
    repositoryId,
    segmentIndex,
    segmentCount,
    internalToken,
    finalizeHistory: values.get("--finalize-history") === "true",
    output: resolve(values.get("--output") ?? `perf/results/movie-segment-${segmentIndex}.json`),
    onProgress: (message) => console.error(`[${new Date().toISOString()}] ${message}`),
  };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(values, name, fallback) {
  const raw = values.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
