import { createHash } from "node:crypto";

export const MOVIE_CORPUS_VERSION = 1;
export const TIB = 1024 ** 4;
export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const KIB = 1024;
export const MOVIE_FILE_COUNT = 10_000;
export const MOVIE_MEDIA_FILE_COUNT = 2_000;
export const MOVIE_LOGICAL_BYTES = TIB;
export const MOVIE_MAX_FILE_BYTES = 20 * GIB;

const SHAPES = Object.freeze([
  Object.freeze({ kind: "project", count: 200, extension: "prproj", bytes: 8 * MIB }),
  Object.freeze({ kind: "interchange", count: 300, extension: "otio", bytes: MIB }),
  Object.freeze({ kind: "subtitle", count: 500, extension: "srt", bytes: 64 * KIB }),
  Object.freeze({ kind: "sidecar", count: 7_000, extension: "json", bytes: 16 * KIB }),
  Object.freeze({ kind: "proxy", count: 1_300, extension: "mov", bytes: 400 * MIB, media: true }),
  Object.freeze({ kind: "audio", count: 400, extension: "wav", bytes: 128 * MIB, media: true }),
  Object.freeze({ kind: "graphic", count: 150, extension: "png", bytes: 32 * MIB, media: true }),
  Object.freeze({ kind: "original", count: 100, extension: "mxf", bytes: 3 * GIB, media: true }),
  Object.freeze({ kind: "review", count: 40, extension: "mp4", bytes: GIB, media: true }),
  Object.freeze({ kind: "master", count: 10, extension: "mov", bytes: 9 * GIB, media: true }),
]);

export function buildMovieCorpusIndex() {
  const files = [];
  let seed = 0;
  for (const shape of SHAPES) {
    for (let ordinal = 0; ordinal < shape.count; ordinal += 1) {
      files.push({
        path: `/movie/${shape.kind}/${String(ordinal).padStart(5, "0")}.${shape.extension}`,
        kind: shape.kind,
        extension: shape.extension,
        bytes:
          shape.kind === "master" && ordinal === 0
            ? MOVIE_MAX_FILE_BYTES
            : shape.bytes,
        media: shape.media === true,
        seed,
      });
      seed += 1;
    }
  }

  // Fill the exact logical envelope through proxy clips. Their initial size
  // leaves enough headroom that this remains a realistic sub-GiB proxy
  // distribution and never disturbs the explicit 20 GiB maximum fixture.
  let remaining = MOVIE_LOGICAL_BYTES - logicalBytes(files);
  const proxies = files.filter((file) => file.kind === "proxy");
  for (let index = 0; index < proxies.length && remaining > 0; index += 1) {
    const slots = proxies.length - index;
    const addition = Math.ceil(remaining / slots);
    proxies[index].bytes += addition;
    remaining -= addition;
  }

  validateMovieCorpus(files);
  return files;
}

export function movieCorpusManifest(files = buildMovieCorpusIndex()) {
  validateMovieCorpus(files);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.bytes}\0${file.seed}\n`);
  }
  return Object.freeze({
    version: MOVIE_CORPUS_VERSION,
    sha256: digest.digest("hex"),
    files: files.length,
    mediaFiles: files.filter((file) => file.media).length,
    logicalBytes: logicalBytes(files),
    largestFileBytes: Math.max(...files.map((file) => file.bytes)),
  });
}

export function logicalBytes(files) {
  return files.reduce((total, file) => total + file.bytes, 0);
}

export function validateMovieCorpus(files) {
  if (files.length !== MOVIE_FILE_COUNT) {
    throw new Error(`movie corpus must contain ${MOVIE_FILE_COUNT} files`);
  }
  if (files.filter((file) => file.media).length !== MOVIE_MEDIA_FILE_COUNT) {
    throw new Error(`movie corpus must contain ${MOVIE_MEDIA_FILE_COUNT} media files`);
  }
  if (logicalBytes(files) !== MOVIE_LOGICAL_BYTES) {
    throw new Error(`movie corpus must contain exactly ${MOVIE_LOGICAL_BYTES} logical bytes`);
  }
  if (Math.max(...files.map((file) => file.bytes)) !== MOVIE_MAX_FILE_BYTES) {
    throw new Error(`movie corpus must contain one ${MOVIE_MAX_FILE_BYTES}-byte maximum file`);
  }
  const paths = new Set();
  for (const file of files) {
    if (!file.path.startsWith("/movie/") || paths.has(file.path)) {
      throw new Error(`movie corpus contains an invalid or duplicate path: ${file.path}`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MOVIE_MAX_FILE_BYTES) {
      throw new Error(`movie corpus contains an invalid size for ${file.path}`);
    }
    paths.add(file.path);
  }
}

