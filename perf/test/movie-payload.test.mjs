import assert from "node:assert/strict";
import test from "node:test";

import { buildMovieCorpusIndex } from "../movie/corpus.mjs";
import { moviePayloadChunk, moviePayloadStream } from "../movie/payload.mjs";

test("movie payload ranges reproduce the same deterministic byte stream", async () => {
  const file = { ...buildMovieCorpusIndex()[8_000], bytes: 2_000_000 };
  const whole = moviePayloadChunk(file, 0, file.bytes);
  const pieces = [
    moviePayloadChunk(file, 0, 17),
    moviePayloadChunk(file, 17, 999_983),
    moviePayloadChunk(file, 1_000_000, 1_000_000),
  ];

  assert.deepEqual(Buffer.concat(pieces), whole);
  assert.notDeepEqual(whole.subarray(0, 4096), Buffer.alloc(4096));

  const streamed = [];
  for await (const chunk of moviePayloadStream(file, { chunkBytes: 131_071 })) {
    streamed.push(chunk);
  }
  assert.deepEqual(Buffer.concat(streamed), whole);
});

test("movie payload rejects slices beyond the logical media file", () => {
  const file = { ...buildMovieCorpusIndex()[8_000], bytes: 100 };
  assert.throws(() => moviePayloadChunk(file, 99, 2), /fit inside/);
});
