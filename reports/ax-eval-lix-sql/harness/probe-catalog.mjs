#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const sdkEntry = process.env.AX_EVAL_LIX_SDK_ENTRY;
if (!sdkEntry) {
  throw new Error("AX_EVAL_LIX_SDK_ENTRY is required.");
}

const { openLix } = await import(pathToFileURL(sdkEntry).href);
const lix = await openLix();

try {
  await lix.execute(
    "INSERT INTO lix_file (id, path, data) VALUES (NULL, $1, $2)",
    ["/catalog-probe.bin", new Uint8Array([0])],
  );
  const catalog = await lix.execute(
    `SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = $1 AND column_name IN ($2, $3, $4)
ORDER BY column_name`,
    ["lix_file", "data", "id", "path"],
  );
  const inserted = await lix.execute(
    "SELECT id, path FROM lix_file WHERE path = $1",
    ["/catalog-probe.bin"],
  );
  const casts = [];
  for (const [type, sql] of [
    ["Utf8", "SELECT CAST(path AS Utf8) FROM lix_file LIMIT 1"],
    ["LargeBinary", "SELECT CAST(data AS LargeBinary) FROM lix_file LIMIT 1"],
    ["Int64", "SELECT CAST(1 AS Int64)"],
    ["TEXT", "SELECT CAST(path AS TEXT) FROM lix_file LIMIT 1"],
    ["BIGINT", "SELECT CAST(1 AS BIGINT)"],
  ]) {
    try {
      await lix.execute(sql);
      casts.push({ type, accepted: true });
    } catch (error) {
      casts.push({
        type,
        accepted: false,
        error: String(error instanceof Error ? error.message : error).split(
          "\n",
        )[0],
      });
    }
  }
  let activeBranchId;
  try {
    const result = await lix.execute(
      "SELECT lix_active_branch_id() AS branch_id",
    );
    activeBranchId = {
      supported: true,
      value: result.rows[0]?.toObject().branch_id ?? null,
    };
  } catch (error) {
    activeBranchId = {
      supported: false,
      error: String(error instanceof Error ? error.message : error).split(
        "\n",
      )[0],
    };
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        catalog: catalog.rows.map((row) => row.toObject()),
        inserted: inserted.rows.map((row) => row.toObject()),
        casts,
        activeBranchId,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await lix.close();
}
