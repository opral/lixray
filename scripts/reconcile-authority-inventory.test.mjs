import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAuthorityInventory } from "./reconcile-authority-inventory.mjs";
const entry = { repositoryId: "a", state: "live", storageId: "physical-a", storagePresent: true };
const inventory = { entries: [entry], unreferencedStorage: [], malformedCatalog: [] };
await test("uses physical mapping and reconciles live and deleted catalogs", () => {
  assert.equal(
    reconcileAuthorityInventory([{ id: "a", deleted_at: null }], inventory).reconciled,
    true,
  );
  assert.equal(
    reconcileAuthorityInventory([{ id: "a", deleted_at: "yesterday" }], {
      ...inventory,
      entries: [{ ...entry, state: "deleted", storagePresent: false }],
    }).reconciled,
    true,
  );
});
await test("never silently excludes missing, orphaned, malformed or conflicting records", () => {
  const result = reconcileAuthorityInventory(
    [
      { id: "a", deleted_at: "yesterday" },
      { id: "b", deleted_at: null },
    ],
    {
      entries: [{ ...entry, storagePresent: false }],
      unreferencedStorage: ["orphan"],
      malformedCatalog: ["broken"],
    },
  );
  assert.equal(result.reconciled, false);
  assert.deepEqual(
    result.issues.map((x) => x.kind),
    [
      "catalog-state-disagreement",
      "missing-authority-storage",
      "live-control-record-without-authority",
      "unreferenced-physical-storage",
      "malformed-authority-catalog",
    ],
  );
});

await test("explicit unchanged unavailable records are accounted for but never called migrated", () => {
  const record = { id: "missing", deleted_at: null, updated_at: "original" };
  const disposition = { repositoryId: record.id, state: "unavailable-source-unresolved",
    reason: "No identified source; retain identity and do not initialize replacement", expectedControlRecord: record };
  const empty = { entries: [], physicalStorage: [], unreferencedStorage: [], malformedCatalog: [] };
  const result = reconcileAuthorityInventory([record], empty, [disposition]);
  assert.equal(result.reconciled, false);
  assert.equal(result.cutoverReady, true);
  assert.equal(result.fullyMigrated, false);
  assert.equal(result.unavailableRepositories.length, 1);
  for (const candidate of [
    { ...empty, physicalStorage: [record.id] },
    { ...empty, physicalStorage: undefined },
    { ...empty, entries: [{ ...entry, repositoryId: record.id }] },
  ]) assert.equal(reconcileAuthorityInventory([record], candidate, [disposition]).cutoverReady, false);
  assert.equal(reconcileAuthorityInventory([{ ...record, updated_at: "changed" }], empty, [disposition]).cutoverReady, false);
  assert.equal(reconcileAuthorityInventory([record], empty, [disposition, disposition]).cutoverReady, false);
  assert.equal(reconcileAuthorityInventory([record, { id: "new-missing", deleted_at: null }], empty, [disposition]).cutoverReady, false);
});

await test("cutover readiness requires current admission for every live authority", () => {
  const controls = [{ id: "a", deleted_at: null }];
  const current = { ...entry, requiresMigration: false, storageEpoch: 81, protocolEpoch: 15 };
  assert.equal(reconcileAuthorityInventory(controls, { ...inventory, entries: [current] }).cutoverReady, true);
  for (const changed of [{ requiresMigration: true }, { storageEpoch: 80 }, { protocolEpoch: 14 }, { storageEpoch: undefined }]) {
    const result = reconcileAuthorityInventory(controls, { ...inventory, entries: [{ ...current, ...changed }] });
    assert.equal(result.reconciled, true);
    assert.equal(result.cutoverReady, false);
    assert.equal(result.fullyMigrated, false);
    assert.equal(result.readinessIssues[0].kind, "authority-not-current");
  }
});
