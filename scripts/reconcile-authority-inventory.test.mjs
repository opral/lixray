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
