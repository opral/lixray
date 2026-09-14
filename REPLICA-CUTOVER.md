# Replica architecture cutover

Target: storage format 81, sync protocol 15, SQL protocol 9, internal OPFS RPC 4. The ordinary SDK/server does not migrate historical data. Build the runtime and the separately loaded migration artifacts from the same Lix commit.

## Before cutover

1. Run the engine simulations, doctests, storage conformance, composed Chromium authority/SharedWorker/OPFS/migration tests, and Lixray checks. Test the optimized artifacts that will ship.
2. Inventory the authority object store with the detached server's `inventory-authorities` command. Export all control-plane `lixes` records (including tombstones), then run `node scripts/reconcile-authority-inventory.mjs CONTROL.json AUTHORITIES.json`. A nonzero result is an unresolved migration cohort, not permission to skip those records. Physical prefixes are not repository identity. Preserve the catalog’s hosted resource ID separately from the portable identity validated inside repository contents; restored snapshots can legitimately have a different embedded ID.
3. Qualify recognized source profiles on isolated copies. A copy made while production remains live is a qualification input, never the final cutover backup. Exclude changed/incomplete copies. Do not initialize missing stores or adopt orphaned stores without resolving their control-plane identity and provenance.
4. Prepare the complete matched deployment, including `@lix-js/sdk/migration`, its separate WASM, and `@lix-js/storage-opfs/migration` and its worker. Keep versioned same-origin historical migration assets available for returning offline devices.

## Write barrier and authority migration

Stop **all** serving hosts and other writers, disable automatic restarts/rollouts, and wait for graceful shutdown to finish. Keep this external barrier throughout backup, migration, verification and deployment. An `Arc` ownership check only protects one process. SlateDB can fence an older writer when a newer writer opens; it does not establish global quiescence. Source-byte checks detect concurrent changes but do not replace the barrier.

Use a binary built with `cargo build -p lix-server --features offline-migration`, configured for the intended object-store bucket/prefix. Run `lix-server migrate-authorities`, or `lix-server upgrade-authority UUID` for a reconciled individual repository. Ordinary server builds reject these operations.

For each old catalogued authority, the tool:

- Saves a content-verified physical backup, original catalog bytes and catalog version.
- Records a staged destination before copying into a new physical UUID namespace.
- Migrates only that destination, then verifies the logical-record witness, current format/role and portable repository identity (the hosted ID remains bound to the original catalog entry). Unsupported or unverified source profiles fail with retained source and destination.
- Persists a per-attempt report before publication, checks source content again, and atomically compares-and-swaps the catalog's physical storage ID/admission metadata.
- Retains the previous physical namespace and backup. Known interrupted stages are reported separately; a retry uses a fresh destination and preserves prior attempts. Unknown or malformed storage/catalog records block fleet migration.

Do not mark the fleet complete from a zero process exit alone. Reconcile the full control-plane inventory again, account for every live repository, and retain each verified migration report. Already current authorities are not recopied on fleet retries. Start the matched runtime only after all required authorities validate. Run `scripts/check-production-lix.mjs` against the production canary; unsupported/migration-required responses fail immediately.

## Browser stores

The browser router serializes migration under a route lock. The detached worker acquires the existing physical OPFS owner lock, so an old live owner must release it first. It copies every logical storage space to a new namespace, verifies preservation, closes storage durably, and only then publishes one atomic routing pointer. A genuinely empty store does not load historical WASM. Failed/quota/interrupted copies and the original source remain retained; retries never clear them.

Old tabs know only the old namespace and cannot modify the new destination. Their old network epoch is rejected before mutations. They can still make offline edits to their retained source; source-digest reconciliation is required before any future cleanup. Late edits in retained sources are not automatically detected or merged into the active workspace. This change deliberately performs no source cleanup. Server fleet completion is separate from browser migration coverage: offline devices migrate on return.

## Recovery

Before target-format writes are accepted, a failed candidate leaves the original authority/catalog available under the write barrier. Recover using its exact catalog provenance and verified backup, or retry forward. After target-format writes are accepted, do not restore a stale source or downgrade the runtime. Recover forward while preserving new writes and upload receipt identities.

No production mutation or deployment has been performed during this implementation's validation. The read-only inventory found catalog discrepancies; detailed inventories and qualification copies remain local investigation evidence, not deployment inputs that can be silently assumed current.

Retaining unreferenced physical sources
--------------------------------------

A reviewed nonlive source can remain at its original physical prefix with a
`.lix-quarantine/<storage-id>.json` manifest. This does not create a hosted
repository or certify that the source is empty. Inventory verifies every
object's byte length and BLAKE3 digest and the exact object set; changed,
malformed, or already catalogued sources block fleet migration.

`scripts/retain-unreferenced-storage.py PLAN.json OUTPUT_DIR --control-inventory CONTROL.json`
produces reviewable manifests without publishing them. The plan contains the
BLAKE3 digest of the exact control inventory and explicit `storageId`/`reason`
entries. The tool rejects live control IDs and catalogued physical sources.
Use standard AWS credentials plus explicit `S3_ENDPOINT`, `S3_BUCKET`, and
nonempty `S3_PREFIX`. Install `boto3` and `blake3` in the operator environment.
After the writer/restart barrier is established, `--publish --writers-stopped`
re-verifies the sources and publishes manifests with create-only writes.
Original objects are retained. This disposition must never be used to hide a
live repository whose source still needs migration.
