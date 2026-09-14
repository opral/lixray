import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Reconcile both catalogs before deciding which repositories a fleet migration covers. */
export function reconcileAuthorityInventory(controlPlane, authorityInventory) {
  const issues = [];
  const controls = new Map();
  for (const record of controlPlane) {
    if (controls.has(record.id))
      issues.push({ kind: "duplicate-control-record", repositoryId: record.id });
    controls.set(record.id, record);
  }
  const authorities = new Map();
  for (const entry of authorityInventory.entries) {
    if (authorities.has(entry.repositoryId))
      issues.push({ kind: "duplicate-authority-record", repositoryId: entry.repositoryId });
    authorities.set(entry.repositoryId, entry);
    const control = controls.get(entry.repositoryId);
    if (!control)
      issues.push({
        kind: "authority-without-control-record",
        repositoryId: entry.repositoryId,
        state: entry.state,
      });
    else if ((control.deleted_at === null) !== (entry.state === "live"))
      issues.push({
        kind: "catalog-state-disagreement",
        repositoryId: entry.repositoryId,
        state: entry.state,
      });
    if (entry.state === "live" && !entry.storagePresent)
      issues.push({
        kind: "missing-authority-storage",
        repositoryId: entry.repositoryId,
        storageId: entry.storageId,
      });
  }
  for (const record of controlPlane) {
    if (record.deleted_at === null && !authorities.has(record.id))
      issues.push({ kind: "live-control-record-without-authority", repositoryId: record.id });
  }
  for (const storageId of authorityInventory.unreferencedStorage)
    issues.push({ kind: "unreferenced-physical-storage", storageId });
  for (const path of authorityInventory.malformedCatalog)
    issues.push({ kind: "malformed-authority-catalog", path });
  return {
    reconciled: issues.length === 0,
    controlPlaneCount: controls.size,
    authorityCount: authorities.size,
    issues,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [controlPath, authorityPath] = process.argv.slice(2);
  if (!controlPath || !authorityPath)
    throw new Error(
      "Usage: node scripts/reconcile-authority-inventory.mjs CONTROL.json AUTHORITIES.json",
    );
  const result = reconcileAuthorityInventory(
    JSON.parse(await readFile(controlPath, "utf8")),
    JSON.parse(await readFile(authorityPath, "utf8")),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.reconciled) process.exitCode = 1;
}
