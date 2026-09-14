# Reviewed production cutover: 42 source-backed live repositories

This is an execution plan, not a record of production changes. No services were
stopped and no production objects were written during this review. Refresh all
inventories and service settings before execution; the evidence files are
qualification snapshots.

## Scope and approval

The reviewed snapshot contains 65 control records: 59 live and six deleted.
There are 29 authority catalog entries: 28 live and one deleted. The intended
post-cutover catalog contains **42 live and three deleted** entries.

| Cohort | Count | Required disposition |
| --- | ---: | --- |
| Live controls with existing live catalogs | 26 | Migrate through catalog CAS; retain original physical namespaces and verified backups. |
| Live controls with identified uncatalogued sources | 16 | Explicit hosted-ID adoption of separately migrated, verified current destinations. |
| Deleted controls with incorrectly live catalogs | 2 | Metadata-only catalog tombstones using the original catalog version; retain every physical object. |
| Nonlive/unresolved unreferenced physical prefixes | 26 | Content-verified quarantine manifests; keep original objects in place. |
| Live controls without an identified source | 17 | Preserve controls, permissions, and missing catalog state unchanged; remain unavailable. |

The exact memberships come from the fresh counterpart of
`evidence/production-cohort-reconciliation.json`, joined against both complete
inventories. The 17 entries are **source-unidentified**, not proven empty or
unprovisioned. They must not be initialized, tombstoned, deleted, adopted from a
guessed source, or silently removed from reconciliation.

Storage and architecture reviewers approve deploying the verified 42 while
those exact 17 remain unchanged and unavailable. There is no cross-repository
preservation dependency that requires fabricating or resetting their contents.
This is a scoped restoration, not a claim that every control record is served or
that all historical browser data has been recovered.

## Exact execution order

1. **Pin and qualify the release.** Record the Lix commit, Lixray commit, server
   and web image digests, normal browser WASM and detached migration artifacts,
   historical base and patch checksum, and operator binary checksum. Require
   green combined-tree CI and optimized composed browser tests. Retain the old
   service configuration and image digests for pre-write recovery. Package the
   reviewed native historical bridge from `tooling/historical-migration`; do
   not depend on an uncommitted investigation worktree.

2. **Establish the external writer barrier.** Stop public WEB ingress/lifecycle
   activity and every SERVER writer, including any additional deployments,
   replicas or operator jobs. Capture enabled/disabled workflow and Railway
   deployment settings. Disable automatic production deployment and the
   `production-canary.yml` five-minute schedule for the barrier; ensure no
   manually triggered production movie-benchmark jobs remain active. The
   scheduled browser-performance workflow uses isolated integration containers
   and is not itself a production writer, but inspect active jobs explicitly.
   Disable automatic restarts and wakeups before stopping the services. Confirm graceful shutdown completed and no
   replacement instance started. The captured Railway configuration has one
   replica, zero overlap, 30-second draining, and `ON_FAILURE` with ten retries
   for both services; these settings alone are not a migration barrier. Keep
   WEB and SERVER stopped until step 9. Ensure the selected bucket and explicit
   prefix match the stopped production service configuration. WEB shutdown
   fences service-role registration/deletion RPCs and public server protocol
   writes, but does not freeze all Supabase metadata: authenticated users retain
   direct name-update permission. Capture that distinction and refresh the
   exact control snapshot at the final gate; do not infer identity/deletion
   changes from a name change or silently accept any snapshot mismatch.

3. **Capture the final source inventory under the barrier.** Export all control
   rows, including deleted rows, and relevant identity/permission provenance.
   Save exact authority catalog bytes plus ETags/version IDs. Inventory every
   physical object, including uncatalogued and retired prefixes. Create
   immutable, independently retained backups and content manifests. Do not open
   original physical databases for inspection: opening SlateDB can alter
   physical metadata. Compare with the reviewed cohort; any new record, source
   change or different classification requires renewed qualification before
   proceeding. Qualification copies made while writers were active are not
   final migration inputs.

4. **Prepare the 16 adoption destinations without publishing catalogs.** Copy
   each fresh original into an isolated native operator namespace. For the
   thirteen format68 and two format71 sources, run the pinned historical
   bridge to74, then copy the closed result into another isolated namespace and
   run the current detached migration to81. The remaining format77 authority
   uses the current detached migration directly. Require all semantic proofs,
   exact historical-output/current-input physical manifest linkage, matching
   patched-tool provenance and current format/role. Upload each final81
   destination under a new production physical UUID, verify uploaded content,
   and write the explicit adoption manifest. Reconcile hosted identity from
   control-plane provenance; neither an embedded ID nor an arbitrary physical
   prefix is sufficient. Keep original, intermediate, final, and failed stages.

5. **Retain nonlive data and reconcile deleted catalogs.** Publish the 26
   reviewed quarantine manifests with
   `scripts/retain-unreferenced-storage.py PLAN.json OUTPUT_DIR --control-inventory CONTROL.json --publish --writers-stopped`.
   Bind the plan to the exact fresh control-inventory digest; the tool rechecks
   source content and uses create-only writes. For the two deleted controls,
   use a reviewed **metadata-only CAS** operation on their existing catalog
   objects: preserve `storageId` and `retired`, set state `deleted`, clear
   admission/fingerprint, retain the prior bytes/version and verify no physical
   source changed. The detached command is
   `lix-server retain-tombstone MANIFEST.json`; its manifest binds the exact
   control-inventory BLAKE3 digest and deleted timestamp, original catalog BLAKE3,
   and complete active plus retired physical manifests. It saves the original
   catalog/version and prepared report before CAS and supports exact retries.
   **Do not invoke the ordinary lifecycle DELETE endpoint:**
   it sweeps both active and retired storage, even when a record is already
   deleted. The retention-only command was qualified on isolated MinIO with
   active and retired source hashes unchanged; do not substitute
   `upgrade-authority`, adoption, or lifecycle DELETE.

6. **Publish the 16 verified adoptions.** Run the detached current server
   `adopt-staged-repository MANIFEST.json` for each explicit identity. It
   rechecks original objects, validates the actual destination's logical
   digest, serves/closes the candidate, verifies exact authority activation
   (or unchanged existing-authority content), persists its prepared report,
   rechecks the source and performs catalog Create. An existing conflicting or
   deleted catalog is a stop condition, never an overwrite instruction. Keep
   all reports and catalog versions. Do not run generic fleet migration while
   these new destination prefixes are still unreferenced staging objects.

7. **Migrate the 26 existing catalogued authorities.** With the barrier still
   held, run the detached `migrate-authorities` after the 16 adoptions and 26
   quarantines have accounted for orphan/staged prefixes. Alternatively, use
   `upgrade-authority UUID` on the exact reviewed existing cohort. Each
   migration retains a verified source backup and catalog provenance, migrates
   a distinct physical destination, verifies preservation and publishes only
   by catalog CAS. Already-current admitted authorities remain current on
   retries. Any failed semantic proof, source mutation, missing physical store,
   malformed catalog or unexpected unreferenced prefix blocks completion.

8. **Apply the explicit scoped reconciliation gate.** Refresh both inventories.
   Require exactly 42 live catalogs, current admission and physical storage for
   every one, and one verified migration/adoption chain per changed repository.
   Require three deleted catalogs, including the two corrected entries with
   their source bytes unchanged. Require all 26 quarantine manifests and source
   content to validate; retain all backups and failed stages. Run the ordinary
   reconciler and retain its complete output: it should still exit nonzero for
   the exact 17 `live-control-record-without-authority` IDs. Compare the whole
   issue set against that reviewed exception set, not merely its count. There
   must be no additional missing storage, state disagreement, malformed
   catalog, orphan source or unexpected control changes. Never replace this
   check with `|| true` or report global reconciliation as successful. Supply
   the reviewed unavailable manifest as the reconciler's optional third input;
   require `cutoverReady: true` as well as the exact17 issue set. It binds the
   exact control snapshot, excludes any physically present source ID, and
   separately requires current admission epochs for every live authority.
   `reconciled` and `fullyMigrated` remain false while those17 are unresolved.

9. **Start the matched release and release ingress.** Start the pinned SERVER
   while WEB ingress and direct SERVER mutation traffic remain fenced.
   The server requires the internal Bearer token for protocol and lifecycle
   routes; browser OAuth alone cannot bypass stopped WEB. Reverify that boundary
   and exclude token-bearing operator/benchmark jobs, then allow only operator
   read-only probes. A separate invented firewall is unnecessary if this
   verified gateway boundary remains intact. Require health and typed protocol
   admission for the 42 using read-only probes. Confirm old protocol requests
   fail before mutations, the two tombstones cannot open, and the 17 missing
   catalog identities remain unavailable without creating storage. Start the
   matched WEB image and expose the production canary. Run
   `scripts/check-production-lix.mjs` and the authenticated Atelier open/sync
   canary against the intended repository. Restore the approved restart and
   deployment policy and previously enabled production-canary schedule only after
   both services pass. Restore the captured workflow states, not assumed defaults. Preserve versioned
   same-origin migration assets for returning current-namespace browsers.

## Recovery constraints

- Before any target-format user writes, a failure leaves the writer barrier in
  place. Retry forward using retained sources and a fresh candidate where
  required. To restore the old service, first restore every affected catalog
  from its exact pre-cutover bytes/version using CAS, remove only newly
  published adoption catalog pointers through a reviewed conditional operation,
  and verify the original destinations. Keep physical sources, candidate data,
  reports and backups. Do not simply restart an old image against a partially
  published current catalog.
- A prepared adoption report supports publication retry; a completed exact
  manifest returns its existing report after a lost acknowledgement. A crash
  during activation before the prepared report exists fails closed: retain the
  failed stage and build a new stage from the verified migration output.
- Once any target-format user writes or accepted uploads are possible, recover
  forward. Restoring a pre-cutover source can discard those writes and receipts.
  Keeping WEB stopped alone does not prove absence of writes if another client
  can reach SERVER.
- Never run retired-prefix cleanup during or as part of this cutover. The
  retained originals and independent backups are the recovery evidence.
- The 17 source-unidentified controls remain a separate recovery investigation.
  The 26 quarantines do not resolve their identity. Earlier browser namespaces
  and format68/71 replicas likewise remain retained; the native hosted bridge
  does not qualify their pending or lost-acknowledgement edits.

## Review result

**Approved with execution gates:** storage reviewer and architecture reviewer
agree that verified42 deployment preserves data while the exact17 unresolved
controls remain unchanged. The metadata-only tombstone CAS tool is implemented
and locally qualified. Fresh barrier inventory/proofs and exact-exception
reconciliation remain mandatory before production publication. This review records the preservation requirements for the requested deployment;
it performed no production actions.
