# dev-30-09 handoff — 2026-09-30

This is an **unfinished development checkpoint**, pushed at Samuel's request
to continue on another machine. Do not deploy this checkpoint or present its
smoke timings as a completed A/B comparison.

## Check out the work

Both repositories use the long-running `dev-30-09` branch:

- Lix: https://github.com/opral/lix/tree/dev-30-09
- Lixray: https://github.com/opral/lixray/tree/dev-30-09
- Lixray's `vendor/lix` submodule is pinned to Lix commit
  `c7ffa4643` (migration, read fulfillment, telemetry, RETURNING, and offline API).

```sh
git fetch origin
git switch dev-30-09
git pull --ff-only origin dev-30-09
git submodule update --init --recursive
```

The local source worktrees used here were
`/Users/samuel/git-repos/workspace-1/lix-dev-30-09` and
`/Users/samuel/git-repos/workspace-1/lixray-dev-30-09`.
Generated SDK/WASM/build artifacts are ignored and **are not pushed**. Rebuild
them on the destination; the last local normal WASM asset was
`ab301e544725ddc5d57d0bd9588ba5750a8cfdbc10b013e07af7612208d1e946`,
and predates the latest RETURNING overlay and native telemetry changes.

## Objective and constraints

Investigate and fix production opening failures for `@opral/monorepo` and
`@opral/demo`: unsupported partial receipt migration, malformed v2 receipt,
recovery admission 503, and missing sparse payload dependencies. Keep useful
dependency tracking, make locally available work feel immediate, and ensure
PostHog can explain failures and open-to-usable latency.

Samuel then paused deployment to compare architectures, and requested a
prototype, profiling, validation, A/B comparison, and GPT 6 Luna xhigh reviews.
Fix newly discovered bugs in both architectures. Push fixes to `dev-30-09` in
both repositories. **Do not file issues.** Backward compatibility is required
only for migrating old repository physical layouts; preserve pending user work.
The prototype has not been deployed.

## Implemented source

Lix includes frozen historical partial-receipt DTOs and exact migration guards;
canonical selected changelog payload + locator dependency closure; protocol
epoch 25; lossless typed RowPk transport; safe payload validation and bounded
failure diagnostics; metadata/read recipe handling for filesystem dependencies;
and fixes for sparse current-row/catalog payload recovery.

Newly discovered SQL `RETURNING lixcol_change_id` work remaps direct NEW result
cells and idempotency receipts to the final canonical commit IDs. OLD cells and
derived expressions are preserved. The last full gate showed staging hid the
existing provisional IDs as NULL. The latest staging patch exposes them when
the projection requests change IDs, so the existing canonical remap can work.
This last correction has **not passed the full gate yet**.

SDK changes include bounded `prepareOfflineEditing()` routed through the native
partial worker, offline admission fast failure when the browser reports offline,
and a content-fingerprinted WASM CacheStorage loader with corrupt-cache recovery
and safe fetch/compile failure diagnostics.

Lixray includes an isolated working-set prototype: disposable IndexedDB snapshot,
separate durable self-contained outbox, strict local durability, content CAS,
stable server idempotency keys, conflict preservation/resolution, cache reset,
and stale-tab protection. Its authority session is branch-pinned and checks the
authenticated account. See [the prototype contract](architecture-working-set-prototype.md).

Telemetry fixes correlate SDK spans using the authorized public repository ID
instead of the differing embedded database ID. Native/browser/gateway mappings
preserve bounded recipe masks/counts, required-input counts, payload phases and
failure reasons, and a fixed schema-kind enum. The gateway previously ignored
OTLP `doubleValue`, dropping browser numeric diagnostics; that is fixed.
These new changes are **not verified against deployed PostHog**.

## Current blocking bug — native first offline file edit

Actual Chromium/OPFS reproduction:

1. Fresh native partial open, read one file online.
2. `prepareOfflineEditing()` returns successfully.
3. Close, disconnect Chromium networking, reopen; loaded reads succeed.
4. First `UPDATE lix_file SET content=...` fails.

The original engine span reports `LIX_INTERNAL_ERROR`. A typed read-fulfillment
demand requires `commit_graph_record` for the **exact descriptor selected head**.
The preparation check said this same graph frontier was resident. On offline
reopen, outbound `headerProvider` identity probing masks the dependency failure
as `LIX_IDENTITY_UNVERIFIED_OFFLINE`. Without closing/reopening, the same edit
also fails, with `LIX_TRANSPORT_NETWORK`; therefore closing/durability alone is
not the explanation.

[Captured synthetic request evidence](experiments/native-offline-demand-wip.json)
contains the selected/global heads and bounded dependency summaries. No SQL,
file contents, credentials, or row keys were logged. Temporary SDK console
instrumentation was removed before the Lix commit.

Static review established:

- SharedEngineOwner child sessions reuse the root Engine/StorageAdapter.
- `handle/partial.rs` constructs engine and worker from the same routed adapter.
- `partial_write_frontier.rs` exact-loads selected/global jump-spine records.
- `partial_runtime.rs` uses that same check for preparation readiness.
- The failing tracked-state validation exact-reads COMMIT_SPACE in
  `tracked_state/context.rs` (`ensure_cached_commit_delta_winners` and related
  commit-root validation).
- No proven missing-ancestry issue or wrong logical-space mapping was found.

Next discriminator: instrument OPFS `js/provider.ts` `readMany` to compare the
requested snapshot generation with the current generation and exact head-key
presence, first during preparation and then in UPDATE. Its MVCC SQL returns old
NULL when a read is pinned before the graph import. Trace session/catalog cached
read contexts and hydration invalidation. The working hypothesis is a stale
pinned physical read used by later SQL writes despite raw-storage preparation
seeing the imported graph; this is **not confirmed**. Do not weaken validation,
fake a mutation to warm writes, or fetch all history to conceal the failure.

## Validation status

- Production physical clones: demo and monorepo both cold-opened and queried
  default branch/accounts locally with the earlier combined hardening source.
  Latest telemetry/staging corrections came afterward.
  The manual test harness is preserved at
  [physical-clone-probe.rs](experiments/physical-clone-probe.rs), outside the
  production build. To reuse it, temporarily place it under Lix server's
  `src/store/physical_clone_probe.rs` and register a test-only module in
  `store.rs`. It copies a physical clone into a disposable temporary directory;
  it must never point at live production storage.
- Working-set browser recovery: **5/5 passed** (real reload; pending cache reset;
  lost ACK replay with one authority commit; conflict resolution; stale tab).
  [Evidence](experiments/working-set-validation-wip.json).
- Prototype module/authority adapter unit tests: **15/15 passed**.
- SDK retry/worker API routing: **37/37 passed**; WASM loader: **10/10 passed**.
- Lixray worker suite: **414/414 passed**; final focused OTLP suite: **17/17**.
  Formatting, ESLint and TypeScript passed for the corresponding changes.
- Rust first complete all-sim gate: **4,683 passed, 8 failed, 74 skipped**;
  4,691 executed. Failures were four new RETURNING tests, checkpoint fixture,
  offline-prep fixture, direct-locator filesystem recipe, and typed-RowPk wire
  assertion. Source fixes are committed, but final runtime verification is pending.
- Second full gate started on Ryzen, then found a compile error in the new
  recipe-mask fold (`u8` vs `u16`). This was corrected to `0_u16` before commit;
  **the corrected commit has not been recompiled**.
- Doctests, relevant adapter gates, and host NAPI check remain pending.
- Full 6-sample × 4-workload × 2-architecture profile is **not completed**.
  [Latest one-sample smoke](experiments/architecture-hardened-smoke-wip.json)
  is explicitly provisional and has a failed native capability outcome.

## Remote environment and commands

Do not compile Rust on the Mac: an earlier rustc process reached approximately
82 GB. Builds ran on `ryzen-9950x-I`:

- source: `/root/repos-iv/lix-dev-30-09-investigation`
- shared target: `/root/repos-iv/lix-dev-29-09/target`
- full logs: `/tmp/lix-dev-30-09-all-simulations-final.log` (8 failures) and
  `/tmp/lix-dev-30-09-all-simulations-second.log` (compile error, fixed locally).
- The remote source may lag the corrected committed `0_u16` fold; sync/fetch it.

Read-only production clone parents remain on Ryzen at
`/root/repos-iv/incident-30-09/demo` (storage ID
`b044bffb-a85a-4ce8-a771-38fac128840b`, public repository ID
`759295bc-c5b4-4be1-bceb-50bad09e8f7d`) and
`/root/repos-iv/incident-30-09/monorepo` (storage ID
`1adf419d-af8d-4346-98cd-0a6c89ddcc00`, public repository ID
`a29c0712-0af2-4da0-ba91-b05a0374f059`). The harness reads these through
`LIX_PHYSICAL_CLONE_ROOT`, `LIX_PHYSICAL_CLONE_STORAGE_ID`, and
`LIX_PHYSICAL_CLONE_REPOSITORY_ID`; preserve the source clones.

Required Rust checks after the fix:

```sh
export RUST_MIN_STACK=16777216
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR=/root/repos-iv/lix-dev-29-09/target
export CARGO_BUILD_JOBS=8
cargo nextest run -p lix --features all-simulations --no-fail-fast -j8
cargo test -p lix --doc
cargo nextest run -p lix-storage-slatedb
cargo nextest run -p lix-storage-rocksdb
cargo check -p lix_js_sdk --lib
```

Use the full nextest command, **without `--lib`**, to include integration targets.
For long SSH commands use `ServerAliveInterval=15`, `ServerAliveCountMax=3`.

The disposable debug Lix authority was on Ryzen loopback `18309`, backed by the
existing MinIO service at `127.0.0.1:53623`, bucket `lixray`, independent prefix
`architecture-prototype-30-09-hardened`. Development-only credentials are
`lixray` / `lixray-local-secret`; its internal token is
`lixray-local-internal-token`. The binary was
`/root/repos-iv/lix-dev-29-09/target/debug/lix-server`.
Set `RUST_MIN_STACK=16777216` for this unoptimized authority: a debug CAS call
overflowed the default Tokio worker stack; the 16 MiB test setting fixed it.
Do not touch other remote services or production storage.

Forward the server to the destination machine:

```sh
ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N \
  -L 18309:127.0.0.1:18309 ryzen-9950x-I
```

The source prototype's Vite proxy uses port `18309`; build/preview on port `8830`.
From Lixray `web-app`, after rebuilding the vendored SDK and OPFS package:

```sh
pnpm exec vite build --config experiments/vite.config.ts
pnpm exec vite preview --config experiments/vite.config.ts
node experiments/seed-architecture.mjs
node experiments/validate-architecture.mjs
PROTOTYPE_SMOKE=1 PROTOTYPE_SAMPLES=1 node experiments/profile-architecture.mjs
```

Once both capability arms pass, run the full profile with
`PROTOTYPE_SAMPLES=6` and exact `PROTOTYPE_AUTHORITY_BUILD` metadata: source HEAD,
source-diff SHA-256 if dirty, binary SHA-256, and debug/release profile. The
harness alternates AB/BA, uses fresh synthetic fixtures, separates offline
preparation cost, forbids successful offline I/O and remote SQL attempts, and
retains capability failures independently from cold timing.

Its “usable” means one UTF-8 text file present/editable; production auth, tree,
Atelier/plugins, subscriptions, rich documents and full navigation while offline
are excluded. Never label these measurements production repository E2E latency.

Finish: resolve native visibility; rerun all checks and browser recovery; collect
paired measurements and review them with Luna xhigh; update docs/evidence; push
both branches and the matching Lix submodule. No production deployment is
authorized by this handoff request.
