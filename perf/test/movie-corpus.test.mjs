import assert from "node:assert/strict";
import test from "node:test";

import {
  GIB,
  MOVIE_FILE_COUNT,
  MOVIE_LOGICAL_BYTES,
  MOVIE_MAX_FILE_BYTES,
  MOVIE_MEDIA_FILE_COUNT,
  buildMovieCorpusIndex,
  movieCorpusManifest,
} from "../movie/corpus.mjs";

test("movie corpus describes the exact 1 TiB qualification envelope", () => {
  const files = buildMovieCorpusIndex();
  const manifest = movieCorpusManifest(files);

  assert.equal(files.length, MOVIE_FILE_COUNT);
  assert.equal(manifest.mediaFiles, MOVIE_MEDIA_FILE_COUNT);
  assert.equal(manifest.logicalBytes, MOVIE_LOGICAL_BYTES);
  assert.equal(manifest.largestFileBytes, MOVIE_MAX_FILE_BYTES);
  assert.equal(files.find((file) => file.kind === "master")?.bytes, 20 * GIB);
  assert.equal(new Set(files.map((file) => file.path)).size, MOVIE_FILE_COUNT);
});

test("movie corpus manifest and proxy allocation are deterministic", () => {
  const first = buildMovieCorpusIndex();
  const second = buildMovieCorpusIndex();

  assert.deepEqual(second, first);
  assert.deepEqual(movieCorpusManifest(second), movieCorpusManifest(first));
  assert.match(movieCorpusManifest(first).sha256, /^[a-f0-9]{64}$/);
  assert.ok(first.filter((file) => file.kind === "proxy").every((file) => file.bytes < GIB));
});
