import { getCompatibility } from "../vendor/lix/scripts/compatibility.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Reconcile both catalogs before deciding which repositories a fleet migration covers. */
export function reconcileAuthorityInventory(controlPlane, authorityInventory, unavailable = []) {
  const compatibility = getCompatibility();
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
  const unavailableById = new Map();
  const acceptedUnavailable = [];
  for (const disposition of unavailable) {
    const record = controls.get(disposition.repositoryId);
    if (unavailableById.has(disposition.repositoryId)
      || !record || record.deleted_at !== null
      || authorities.has(disposition.repositoryId)
      || !Array.isArray(authorityInventory.physicalStorage)
      || authorityInventory.physicalStorage.includes(disposition.repositoryId)
      || disposition.state !== "unavailable-source-unresolved"
      || typeof disposition.reason !== "string" || !disposition.reason.trim()
      || !isDeepStrictEqual(record, disposition.expectedControlRecord)) {
      issues.push({ kind: "invalid-unavailable-disposition", repositoryId: disposition.repositoryId });
      continue;
    }
    unavailableById.set(disposition.repositoryId, disposition);
    acceptedUnavailable.push({ repositoryId: disposition.repositoryId, state: disposition.state, reason: disposition.reason });
  }
  for (const record of controlPlane) {
    if (record.deleted_at === null && !authorities.has(record.id) && !unavailableById.has(record.id))
      issues.push({ kind: "live-control-record-without-authority", repositoryId: record.id });
  }
  for (const storageId of authorityInventory.unreferencedStorage)
    issues.push({ kind: "unreferenced-physical-storage", storageId });
  for (const path of authorityInventory.malformedCatalog)
    issues.push({ kind: "malformed-authority-catalog", path });
  const readinessIssues = authorityInventory.entries
    .filter((entry) => entry.state === "live" && (entry.requiresMigration !== false
      || entry.storageEpoch !== compatibility.storageFormatVersion
      || entry.protocolEpoch !== compatibility.syncProtocolVersion))
    .map((entry) => ({ kind: "authority-not-current", repositoryId: entry.repositoryId,
      storageEpoch: entry.storageEpoch ?? null, protocolEpoch: entry.protocolEpoch ?? null }));
  return {
    reconciled: issues.length === 0 && acceptedUnavailable.length === 0,
    cutoverReady: issues.length === 0 && readinessIssues.length === 0,
    readinessIssues,
    fullyMigrated: issues.length === 0 && acceptedUnavailable.length === 0 && readinessIssues.length === 0,
    unavailableRepositories: acceptedUnavailable,
    controlPlaneCount: controls.size,
    authorityCount: authorities.size,
    issues: [...issues, ...acceptedUnavailable.map((entry) => ({
      kind: "live-control-record-without-authority", repositoryId: entry.repositoryId,
      disposition: entry.state,
    }))],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [controlPath, authorityPath, unavailablePath] = process.argv.slice(2);
  if (!controlPath || !authorityPath)
    throw new Error(
      "Usage: node scripts/reconcile-authority-inventory.mjs CONTROL.json AUTHORITIES.json [REVIEWED_UNAVAILABLE.json]",
    );
  const controlBytes = await readFile(controlPath);
  const unavailable = unavailablePath ? JSON.parse(await readFile(unavailablePath, "utf8")) : null;
  if (unavailable && unavailable.controlSnapshotSha256 !== createHash("sha256").update(controlBytes).digest("hex"))
    throw new Error("Unavailable dispositions do not match the exact reviewed control inventory");
  const result = reconcileAuthorityInventory(
    JSON.parse(controlBytes),
    JSON.parse(await readFile(authorityPath, "utf8")),
    unavailable?.entries ?? [],
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.reconciled) process.exitCode = 1;
}
