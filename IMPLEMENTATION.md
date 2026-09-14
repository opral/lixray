# Replica architecture implementation

The implementation replaces SQL-based identity probing with authenticated catalog admission, replaces hidden fetch extensions with a typed transport contract, and separates historical migration from ordinary opening. Runtime epochs are storage 81, sync 15, SQL 9 and OPFS RPC 4. See `ARCHITECTURE-PLAN.md` for the approved design and `REPLICA-CUTOVER.md` for deployment and recovery procedures.

The immediate opening failure was a transport contract mismatch before the network request. The broader changes address distinct architectural weaknesses found during investigation: credential/lifecycle ownership, coherent reads during background writes, and migration coupled to opening. These were not all manifestations of one underlying bug.

## Implemented behavior

- Admission reads authenticated catalog metadata without opening an engine. Credential snapshots are verified before use; failed refresh preserves an existing local session while suspending its remote lease.
- Shared engine shutdown waits for acknowledged detachment. OPFS ownership drains outstanding operations and fences delayed requests from closed clients.
- Complete read attempts have bounded deadlines and result sizes. OPFS retains bounded changed-key preimages instead of blocking writers or copying the database. Accepted writes and emitted results are never generically replayed.
- Ordinary opening accepts only the current format. Detached native/WASM migration artifacts contain historical readers. Browser migration copies into a separate namespace, verifies preservation and durable closure, then publishes its routing pointer.
- Authority migration backs up and verifies physical data, stages a distinct destination, verifies logical preservation, persists its report, and compares-and-swaps the original hosted catalog mapping. Sources, backups and failed stages are retained.
- Fleet inventory and control-plane reconciliation refuse silently skipped missing, malformed or orphaned repositories.

## Validation

Initial implementation checks (before the additional CI and cohort fixes):

- Engine: 3,942 simulation tests passed; 74 skipped. Doctests: 10 passed.
- Server: 94 tests passed; the browser launcher is ignored in the ordinary suite and was run separately.
- SlateDB adapter: 87 conformance tests passed.
- OPFS: 36 ownership, watch and concurrent-read tests passed. Sustained-write prototype completed opening in approximately 27 ms, with maximum measured read 20 ms and write 1.6 ms; these are local measurements, not production latency guarantees.
- SDK: 139 focused transport/admission and actual-WASM tests passed; typecheck passed.
- Final real Chromium + Rust authority + SharedWorker + OPFS composition: 3 tests passed using optimized runtime and migration artifacts.
- Lixray repository tests: 124 passed; worker/MCP tests: 307 passed. Typecheck, changed-code lint and production Vite build passed.
- Isolated production copies: all 28 catalogued authorities passed migration verification, including a subsequently refreshed stable copy of `@opral/monorepo`. Format 80 uses exact logical-record preservation; format 79 uses a source-derived canonicalization witness whose expected digest matched the migrated destination. The initially changing source was qualified from a later unchanged, conditionally downloaded snapshot. No production writes were performed.

PRs: https://github.com/opral/lix/pull/1779 and https://github.com/opral/lixray/pull/392. Lixray still pins `0fec4119a` pending the final qualified Lix artifact revision. Neither PR has been merged.

Additional qualification in progress:

- Optimized native SDK: 312 tests passed after bounding the inline read futures.
- Full Rust end-to-end suite: 228 passed, 27 skipped.
- Historical 68/71 bridge: 18 copied repositories passed source/history/current-row preservation checks; independent negative checks and the subsequent current-format hop are being qualified.
- Deterministic OPFS regression reproduces a competing initializer changing the source revision during seed planning. The targeted conflict classification is awaiting final browser verification.
- Retained quarantine publication passed local object-store checks for source retention, create-only publication, live-control rejection, and exact control-inventory binding.
- Final full-workspace CI is pending new verifier and reconciliation code; earlier focused passes do not qualify these later changes.

Local test logs and raw operational inventories are retained under `evidence/` but excluded from Git. Failed exploratory runs are also retained there; the results above identify their respective implementation stages.

## Remaining production work

This is not a completed production cutover. Read-only reconciliation found 33 live control-plane records without authority catalog entries and 42 unreferenced physical prefixes. Resolve their identity and provenance before declaring complete migration coverage; do not initialize or discard them automatically. Further inspection found 15 live uncatalogued stores on formats 68/71 and one authority on format 77. The former require a separately pinned historical migration bridge; they must not be initialized as empty. The 17 records with no matching physical prefix match the old onboarding-placeholder creation path. PostHog linked 14 only to OAuth consent-page activity; this supports the explanation but does not prove empty contents. Preserve their hosted IDs and unresolved disposition, and retain all possible source storage.

Stop every serving writer and automatic restart, perform a fresh reconciled backup/migration under that barrier, deploy the matched artifacts, and validate the production canary. Local qualification copies do not substitute for that final backup.

Returning offline devices migrate on return. Late edits made by old tabs remain in retained source stores; they are not automatically detected or merged into the new workspace. This implementation performs no source cleanup.

Production promotion now requires explicit manual dispatch with `promote=true`; ordinary pushes build and validate only. The Production workflow was temporarily disabled in preparation for merging to prevent the previous automatic promotion path from bypassing migration.
