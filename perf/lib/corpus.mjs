import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const CORPUS_VERSION = 1;
// Keep the file-count dimension deliberately small and explicit. These are
// the comparable namespace sizes in the end-to-end storage matrix, rather
// than an open-ended workload generator whose results cannot be reproduced.
export const CORPUS_FILE_COUNT = 1_000;
export const SUPPORTED_CORPUS_FILE_COUNTS = Object.freeze([
  1_000,
  5_000,
  10_000,
]);
export const SEED_FILES_PER_COMMIT = 1_000;

// This is deliberately not part of the default corpus. The large-read
// operation opts into it as a separately accounted seed commit so the normal
// 1k/5k/10k namespace and corpus digest stay unchanged.
export const READ_POINT_2M_FIXTURE = Object.freeze({
  id: "read-point-2m-binary-v1",
  path: "/__lixray_perf_read_point_2m_v1.bin",
  extension: "bin",
  bytes: 2 * 1024 * 1024,
  seed: 6_000_000,
});

export const formatSpecifications = Object.freeze([
  Object.freeze({ extension: "json", bytes: 4 * 1024 }),
  Object.freeze({ extension: "csv", bytes: 4 * 1024 }),
  Object.freeze({ extension: "md", bytes: 4 * 1024 }),
  Object.freeze({ extension: "txt", bytes: 1 * 1024 }),
  Object.freeze({ extension: "xml", bytes: 4 * 1024 }),
  Object.freeze({ extension: "yaml", bytes: 4 * 1024 }),
  Object.freeze({ extension: "pdf", bytes: 32 * 1024 }),
  Object.freeze({ extension: "png", bytes: 32 * 1024 }),
  Object.freeze({ extension: "bin", bytes: 16 * 1024 }),
  Object.freeze({ extension: "log", bytes: 8 * 1024 }),
]);

export function buildCorpus(fileCount = CORPUS_FILE_COUNT) {
  return buildCorpusIndex(fileCount).map((file) => ({
    path: file.path,
    data: contentFor(file.extension, file.bytes, file.seed),
  }));
}

export function buildCorpusIndex(fileCount = CORPUS_FILE_COUNT) {
  assertSupportedCorpusFileCount(fileCount);
  return Array.from({ length: fileCount }, (_, index) => {
    const specification = formatSpecifications[index % formatSpecifications.length];
    return {
      path: `/corpus/${String(index).padStart(4, "0")}.${
        specification.extension
      }`,
      extension: specification.extension,
      bytes: specification.bytes,
      seed: index,
    };
  });
}

export function buildReadPoint2mFixture() {
  return {
    ...READ_POINT_2M_FIXTURE,
    data: contentFor(
      READ_POINT_2M_FIXTURE.extension,
      READ_POINT_2M_FIXTURE.bytes,
      READ_POINT_2M_FIXTURE.seed,
    ),
  };
}

export function seedCommitCountForFiles(fileCount) {
  assertSupportedCorpusFileCount(fileCount);
  return Math.ceil(fileCount / SEED_FILES_PER_COMMIT);
}

export function minimumTotalCommitsForFiles(fileCount) {
  return 1 + seedCommitCountForFiles(fileCount);
}

export function assertSupportedCorpusFileCount(fileCount) {
  if (!SUPPORTED_CORPUS_FILE_COUNTS.includes(fileCount)) {
    throw new Error(
      `corpus file count must be one of: ${SUPPORTED_CORPUS_FILE_COUNTS.join(", ")}`,
    );
  }
}

export function contentFor(extension, bytes, seed) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("content size must be a positive integer");
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("content seed must be a non-negative integer");
  }

  switch (extension) {
    case "json":
      return exactText(
        `{"kind":"lixray-perf","seed":${seed},"payload":"`,
        '"}\n',
        bytes,
        "x",
      );
    case "csv":
      return csvContent(bytes, seed);
    case "md":
      return repeatedText(
        `# Benchmark document ${seed}\n\n` +
          `Deterministic mixed-corpus prose; bucket ${seed % 97}.\n\n`,
        bytes,
      );
    case "txt":
      return repeatedText(
        `document=${seed} category=profile status=active value=${seed % 31}\n`,
        bytes,
      );
    case "xml":
      return exactText(
        `<?xml version="1.0" encoding="UTF-8"?><document seed="${seed}">`,
        "</document>",
        bytes,
        " ",
      );
    case "yaml":
      return exactText(
        `id: ${seed}\nkind: lixray-perf\nactive: true\npadding: #`,
        "\n",
        bytes,
        "x",
      );
    case "pdf":
      return pdfContent(bytes, seed);
    case "png":
      return pngContent(bytes, seed);
    case "bin":
      return deterministicBytes(bytes, `bin:${seed}`);
    case "log":
      return repeatedText(
        `2026-07-23T00:00:00Z level=info seed=${seed} event=profile status=ok\n`,
        bytes,
      );
    default:
      throw new Error(`unsupported corpus extension: ${extension}`);
  }
}

export function corpusManifest(corpus) {
  const extensionCounts = {};
  let logicalBytes = 0;
  const digest = createHash("sha256");

  for (const file of corpus) {
    const extension = extensionOf(file.path);
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
    logicalBytes += file.data.length;
    digest.update(file.path);
    digest.update("\0");
    digest.update(sha256(file.data));
    digest.update("\n");
  }

  return {
    version: CORPUS_VERSION,
    files: corpus.length,
    logicalBytes,
    extensionCounts,
    sha256: digest.digest("hex"),
  };
}

export function extensionOf(path) {
  return path.slice(path.lastIndexOf(".") + 1);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactText(prefix, suffix, bytes, fill) {
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  if (fixedBytes > bytes) {
    throw new Error(`content size ${bytes} is too small for its format`);
  }
  return Buffer.from(
    `${prefix}${fill.repeat(bytes - fixedBytes)}${suffix}`,
    "utf8",
  );
}

function repeatedText(text, bytes) {
  const repeated = text.repeat(Math.ceil(bytes / Buffer.byteLength(text)));
  return Buffer.from(repeated).subarray(0, bytes);
}

function csvContent(bytes, seed) {
  let value = "id,name,value,active\n";
  for (let row = 0; ; row += 1) {
    const next = `${row},item-${seed % 100},${row % 17},true\n`;
    if (Buffer.byteLength(value) + Buffer.byteLength(next) > bytes) {
      break;
    }
    value += next;
  }
  return Buffer.from(`${value}${" ".repeat(bytes - Buffer.byteLength(value))}`);
}

function pdfContent(bytes, seed) {
  let fillerBytes = Math.max(0, bytes - 512);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rendered = renderPdf(fillerBytes, seed);
    const difference = bytes - rendered.length;
    if (difference === 0) {
      return rendered;
    }
    fillerBytes += difference;
    if (fillerBytes < 0) {
      break;
    }
  }
  throw new Error(`could not render an exact ${bytes}-byte PDF`);
}

function renderPdf(fillerBytes, seed) {
  const comment = printableEntropy(fillerBytes, `pdf:${seed}`);
  const stream = Buffer.concat([
    Buffer.from("q\n%", "ascii"),
    comment,
    Buffer.from("\nQ\n", "ascii"),
  ]);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream.toString(
      "ascii",
    )}endstream`,
    `<< /Producer (lixray-perf) /Subject (seed-${seed}) >>`,
  ];
  let document = "%PDF-1.7\n%Lix\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

function pngContent(bytes, seed) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdr = pngChunk("IHDR", ihdrData);
  const pixel = Buffer.from([0, seed & 0xff, (seed >>> 8) & 0xff, 0x7f]);
  const idat = pngChunk("IDAT", deflateSync(pixel));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const fixedBytes = signature.length + ihdr.length + idat.length + iend.length;
  const ancillaryPayloadBytes = bytes - fixedBytes - 12;
  if (ancillaryPayloadBytes < 0) {
    throw new Error(`content size ${bytes} is too small for a PNG`);
  }
  const ancillary = pngChunk(
    "raNd",
    deterministicBytes(ancillaryPayloadBytes, `png:${seed}`),
  );
  return Buffer.concat([signature, ihdr, ancillary, idat, iend]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function deterministicBytes(bytes, domain) {
  const output = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (let counter = 0; offset < bytes; counter += 1) {
    const block = createHash("sha256")
      .update(`${domain}:${counter}`)
      .digest();
    block.copy(output, offset, 0, Math.min(block.length, bytes - offset));
    offset += block.length;
  }
  return output;
}

function printableEntropy(bytes, domain) {
  const output = deterministicBytes(bytes, domain);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = 33 + (output[index] % 90);
  }
  return output;
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
