import assert from "node:assert/strict";
import test from "node:test";
import { buildMovieCorpusIndex, MOVIE_LOGICAL_BYTES } from "../movie/corpus.mjs";
import { partitionByLogicalBytes } from "../movie/remote-qualification.mjs";

test("remote movie segments retain every file and balance logical bytes", () => {
  const files = buildMovieCorpusIndex();
  const segments = partitionByLogicalBytes(files, 4);
  assert.deepEqual(segments.flat(), files);
  const target = MOVIE_LOGICAL_BYTES / 4;
  for (const segment of segments) {
    const bytes = segment.reduce((sum, file) => sum + file.bytes, 0);
    assert.ok(Math.abs(bytes - target) <= 20 * 1024 ** 3);
  }
});
