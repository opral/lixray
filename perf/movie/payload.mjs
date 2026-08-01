import { createCipheriv, createHash } from "node:crypto";
import { Readable } from "node:stream";

export const MOVIE_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;
const AES_BLOCK_BYTES = 16;

/**
 * Generates deterministic, incompressible fixture bytes for one logical file
 * without retaining any other part of the file. AES-CTR makes arbitrary
 * offsets reproducible, so range verification and resumed uploads share the
 * same source of truth.
 */
export function moviePayloadChunk(file, offset, length) {
  validateSlice(file, offset, length);
  if (length === 0) return Buffer.alloc(0);

  const alignedOffset = offset - (offset % AES_BLOCK_BYTES);
  const prefix = offset - alignedOffset;
  const key = createHash("sha256")
    .update(`lix-movie-corpus-v1\0${file.seed}\0${file.path}`)
    .digest();
  const counter = Buffer.alloc(AES_BLOCK_BYTES);
  counter.writeBigUInt64BE(BigInt(alignedOffset / AES_BLOCK_BYTES), 8);
  const cipher = createCipheriv("aes-256-ctr", key, counter);
  const generated = Buffer.concat([
    cipher.update(Buffer.alloc(prefix + length)),
    cipher.final(),
  ]);
  return generated.subarray(prefix, prefix + length);
}

export function moviePayloadStream(
  file,
  { start = 0, endExclusive = file.bytes, chunkBytes = MOVIE_STREAM_CHUNK_BYTES } = {},
) {
  validateSlice(file, start, endExclusive - start);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("movie payload chunkBytes must be a positive safe integer");
  }
  return Readable.from(
    (function* generate() {
      for (let offset = start; offset < endExclusive; offset += chunkBytes) {
        const length = Math.min(chunkBytes, endExclusive - offset);
        yield moviePayloadChunk(file, offset, length);
      }
    })(),
  );
}

function validateSlice(file, offset, length) {
  if (
    typeof file?.path !== "string" ||
    !Number.isSafeInteger(file?.seed) ||
    !Number.isSafeInteger(file?.bytes)
  ) {
    throw new TypeError("movie payload file must come from the corpus index");
  }
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > file.bytes
  ) {
    throw new RangeError("movie payload slice must fit inside the logical file");
  }
}

