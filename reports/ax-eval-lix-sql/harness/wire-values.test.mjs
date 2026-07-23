import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeWireParam } from "./wire-values.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const workspaceRequire = createRequire(resolve(repoRoot, "web-app/package.json"));
const sdkEntry = process.env.AX_EVAL_LIX_SDK_ENTRY
  ? resolve(process.env.AX_EVAL_LIX_SDK_ENTRY)
  : workspaceRequire.resolve("@lix-js/sdk");
const { Value, openLix } = await import(pathToFileURL(sdkEntry).href);
const primitive = (value) => decodeWireParam(value, { wireFormat: "primitive", Value });

void test("primitive wire values preserve SQL integer, REAL, and scalar JSON types", async (t) => {
  const lix = await openLix();
  t.after(async () => lix.close());

  const results = await lix.executeBatch([
    { sql: "SELECT $1 / 2 AS value", params: [primitive(1)] },
    {
      sql: "SELECT $1 / 2 AS value",
      params: [primitive({ kind: "float", value: 1 })],
    },
    {
      sql: "SELECT $1 AS value",
      params: [primitive({ kind: "float", value: 1e100 })],
    },
    {
      sql: "SELECT $1 AS value",
      params: [primitive({ kind: "json", value: "scalar" })],
    },
  ]);

  assert.deepEqual(
    results.map((result) => ({
      kind: result.rows[0]?.value("value").kind,
      value: result.rows[0]?.value("value").toJS(),
    })),
    [
      { kind: "integer", value: 0 },
      { kind: "real", value: 0.5 },
      { kind: "real", value: 1e100 },
      { kind: "json", value: "scalar" },
    ],
  );
});

void test("primitive wire values reject legacy tags and malformed wrappers", () => {
  for (const value of [
    { kind: "null", value: null },
    { kind: "bool", value: true },
    { kind: "int", value: 1 },
    { kind: "text", value: "x" },
  ]) {
    assert.throws(() => primitive(value), /Legacy tagged/);
  }
  assert.throws(() => primitive({ kind: "blob", base64: "AB==" }), /canonical standard base64/);
  assert.throws(() => primitive({ kind: "float", value: 1, extra: true }), /unexpected properties/);
});

void test("tagged historical rounds retain explicit SDK value semantics", () => {
  const decode = (value) => decodeWireParam(value, { wireFormat: "tagged", Value });
  assert.equal(decode({ kind: "int", value: 1 }).kind, "integer");
  assert.equal(decode({ kind: "float", value: 1 }).kind, "real");
  assert.equal(decode({ kind: "json", value: 1 }).kind, "json");
  assert.deepEqual([...decode({ kind: "blob", base64: "AA==" }).asBytes()], [0]);
});
