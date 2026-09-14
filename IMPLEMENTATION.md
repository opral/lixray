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

- Engine: 3,942 simulation tests passed; 74 skipped. Doctests: 10 passed.
- Server: 94 tests passed; the browser launcher is ignored in the ordinary suite and was run separately.
- SlateDB adapter: 87 conformance tests passed.
- OPFS: 36 ownership, watch and concurrent-read tests passed. Sustained-write prototype completed opening in approximately 27 ms, with maximum measured read 20 ms and write 1.6 ms; these are local measurements, not production latency guarantees.
- SDK: 139 focused transport/admission and actual-WASM tests passed; typecheck passed.
- Final real Chromium + Rust authority + SharedWorker + OPFS composition: 3 tests passed using optimized runtime and migration artifacts.
- Lixray repository tests: 124 passed; worker/MCP tests: 307 passed. Typecheck, changed-code lint and production Vite build passed.
- Isolated production copies: all 27 stable catalogued authorities passed migration verification. Format 80 uses exact logical-record preservation; format 79 uses a source-derived canonicalization witness whose expected digest matched the migrated destination. One changing source was excluded from qualification. No production writes were performed.

Lix implementation commit: `0fec4119a`. Lixray pins that exact revision.

Local test logs and raw operational inventories are retained under `evidence/` but excluded from Git. Failed exploratory runs are also retained there; the results above describe final qualifying runs.

## Remaining production work

This is not a completed production cutover. Read-only reconciliation found 33 live control-plane records without authority catalog entries and 42 unreferenced physical prefixes. Resolve their identity and provenance before declaring complete migration coverage; do not initialize or discard them automatically. The changing source also needs a stable qualification/final backup.

Stop every serving writer and automatic restart, perform a fresh reconciled backup/migration under that barrier, deploy the matched artifacts, and validate the production canary. Local qualification copies do not substitute for that final backup.

Returning offline devices migrate on return. Late edits made by old tabs remain in retained source stores; they are not automatically detected or merged into the new workspace. This implementation performs no source cleanup.
