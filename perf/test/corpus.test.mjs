import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCorpus,
  buildCorpusIndex,
  corpusManifest,
  formatSpecifications,
  minimumTotalCommitsForFiles,
  SEED_FILES_PER_COMMIT,
  seedCommitCountForFiles,
  SUPPORTED_CORPUS_FILE_COUNTS,
} from "../lib/corpus.mjs";

test("the corpus is deterministic and has 100 valid files per format", () => {
  const first = buildCorpus();
  const second = buildCorpus();
  const manifest = corpusManifest(first);

  assert.equal(first.length, 1_000);
  assert.deepEqual(manifest, corpusManifest(second));
  assert.equal(
    manifest.sha256,
    "337079755ce996d2566b26cac6897f64283d8b1bf13ae98727d3880be8c7f580",
  );
  assert.deepEqual(
    manifest.extensionCounts,
    Object.fromEntries(
      formatSpecifications.map(({ extension }) => [extension, 100]),
    ),
  );

  for (const file of first) {
    const extension = file.path.slice(file.path.lastIndexOf(".") + 1);
    const specification = formatSpecifications.find(
      (candidate) => candidate.extension === extension,
    );
    assert.equal(file.data.length, specification.bytes, file.path);
  }
});

test("the corpus matrix has fixed 1,000-file seed commit accounting", () => {
  for (const fileCount of SUPPORTED_CORPUS_FILE_COUNTS) {
    const index = buildCorpusIndex(fileCount);
    assert.equal(index.length, fileCount);
    assert.equal(
      seedCommitCountForFiles(fileCount),
      fileCount / SEED_FILES_PER_COMMIT,
    );
    assert.equal(
      minimumTotalCommitsForFiles(fileCount),
      1 + fileCount / SEED_FILES_PER_COMMIT,
    );
    assert.deepEqual(
      Object.fromEntries(
        formatSpecifications.map(({ extension }) => [
          extension,
          index.filter((file) => file.extension === extension).length,
        ]),
      ),
      Object.fromEntries(
        formatSpecifications.map(({ extension }) => [
          extension,
          fileCount / formatSpecifications.length,
        ]),
      ),
    );
  }

  assert.throws(() => buildCorpusIndex(2_000), /must be one of/);
  assert.throws(() => seedCommitCountForFiles(2_000), /must be one of/);
});

test("structured corpus members are parseable and binary containers are valid", () => {
  const corpus = buildCorpus();
  const find = (extension) =>
    corpus.find((file) => file.path.endsWith(`.${extension}`)).data;

  assert.doesNotThrow(() => JSON.parse(find("json").toString("utf8")));

  const csv = find("csv").toString("utf8");
  assert.equal(csv.split("\n")[0], "id,name,value,active");
  assert.match(csv.split("\n")[1], /^\d+,item-\d+,\d+,true$/);

  const xml = find("xml").toString("utf8");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><document/);
  assert.match(xml, /<\/document>$/);

  const yaml = find("yaml").toString("utf8");
  assert.match(yaml, /^id: \d+\nkind: lixray-perf\nactive: true\n/);

  assertValidPdf(find("pdf"));
  assertValidPng(find("png"));
});

function assertValidPdf(pdf) {
  const text = pdf.toString("ascii");
  assert.match(text, /^%PDF-1\.7\n/);
  assert.match(text, /%%EOF\n$/);

  const startXref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  assert.equal(text.slice(startXref, startXref + 4), "xref");
  const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)];
  assert.equal(entries.length, 5);
  entries.forEach((entry, index) => {
    const offset = Number(entry[1]);
    assert.equal(text.slice(offset, offset + 7), `${index + 1} 0 obj`);
  });
}

function assertValidPng(png) {
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const types = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const dataEnd = offset + 8 + length;
    const expectedCrc = png.readUInt32BE(dataEnd);
    const actualCrc = crc32(png.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `${type} CRC`);
    types.push(type);
    offset = dataEnd + 4;
  }
  assert.equal(offset, png.length);
  assert.deepEqual(types, ["IHDR", "raNd", "IDAT", "IEND"]);
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
