# dev-30-09 verification and architecture handoff

The native partial replica and working-set prototype completed the paired comparison on 2026-09-30. Both branches contain the verified fixes; Lixray pins the matching Lix commit. No production deployment was performed.

- Lix: `38dd17445501e3293f1e626eec53dd94ee709460` on `dev-30-09`.
- Lixray: use this document's containing commit on `dev-30-09`.
- [Raw paired profile](experiments/architecture-verified-profile.json), [derived report](experiments/architecture-verified-summary.json), and [browser recovery evidence](experiments/working-set-verified-validation.json).
- [Experiment contract and reproduction](architecture-working-set-prototype.md).

## Resolved defects

The native first offline edit failed even after a successful `prepareOfflineEditing()`. Preparation was not losing OPFS graph imports: diagnostic reads found the selected/main graph records resident in the requested generation. The filesystem transaction layer recorded a narrow file dependency but executed a broad path-index request. Its staged path-index path also discarded the file-ID scope, pulling unrelated initial-branch directory/file descriptors into an otherwise loaded file's write dependencies.

The corrected implementation uses the same normalized file-ID scope for recording and execution, and resolves the selected files plus their directory ancestry through the transaction overlay. Exact commit-delta winner checks use authenticated point replay; filtered working-diff reads route only requested schema ranges. A matching warm full path index can serve a scoped projection containing just the selected file lanes and parents. Branch, revision and projection options must match. Cold reads stay bounded; complete-root validation remains available.

A new native-worker regression test reads a file online, prepares offline editing, closes and reopens, then performs the first UPDATE directly through the session without a hydration/retry wrapper. It also verifies repeated edits inside an explicit transaction. Chromium/OPFS independently verifies offline read, first edit, close/reopen durability and reconnect in both comparison arms.

`RETURNING lixcol_change_id` now allocates provisional IDs when the requested expression needs them and returns canonical persisted IDs after commit. Explicit OLD/NEW projection preserves those cells without exposing provisional IDs in ordinary default hot-state rows. The idempotency tests now use a test-only synchronous durable-memory wrapper rather than asking ordinary Memory storage for a durability guarantee it intentionally rejects. Production durability checks are unchanged. The native host also dispatches `prepareOfflineEditing()` for both supported storage variants.

The recipe-mask type correction from the previous handoff has compiled. Numeric OTLP `doubleValue` measurements are retained, and bounded categorical schema diagnostics are tested independently from numeric bounds. These checks do not establish deployed PostHog coverage.

## Verification

| Check                                                            | Result                                        |
| ---------------------------------------------------------------- | --------------------------------------------- |
| Full Rust nextest, all simulations including integration targets | 4,697 passed; 0 failed; 74 skipped            |
| Rust doctests                                                    | 10 passed                                     |
| SlateDB / RocksDB adapter suites                                 | 89 / 25 passed                                |
| Native SDK host check / final WASM / authority build             | Passed                                        |
| SDK retry, worker routing and WASM loader focused tests          | 68 passed across 5 files                      |
| Prototype module and authority adapter tests                     | 15 passed                                     |
| Lixray worker suite                                              | 414 passed                                    |
| Browser working-set recovery scenarios                           | 5 passed; 0 failed                            |
| TypeScript, ESLint and formatting for changed experiment source  | Passed                                        |
| Physical clone probes                                            | 2 passed; disposable demo and monorepo copies |
| Full paired browser capabilities                                 | 48 passed; 0 failed; 24 per architecture      |

GPT-6 Luna at xhigh reviewed native dependencies, transaction overlay/read-set scope, RETURNING IDs, cache projection and paired-report methodology. Review findings were corrected before the final gate and measurement. Source review identified the same-schema working-diff limitation recorded below; no blocking finding remained.

The physical production clone parents at `/root/repos-iv/incident-30-09/{demo,monorepo}` were preserved. Read-only probes used disposable copies and queried default branch/accounts successfully for both repositories. The test-only [physical clone harness](experiments/physical-clone-probe.rs) is retained outside the production build; never point it at live storage. The detached historical investigation worktree was also preserved.

## Paired comparison

**48/48 capability scenarios passed**: 24 native partial and 24 working-set; zero failures and zero successful offline requests. Every workload has all six pairs. No cold protocol response body was incomplete in this run. Chromium version: `149.0.7827.55`.

| Text / unrelated files / delay per fetch | Native partial cold median | Working-set cold median | Median paired native − working-set |
| ---------------------------------------- | -------------------------: | ----------------------: | ---------------------------------: |
| 1 KiB / 0 / 0 ms                         |                   904.4 ms |                504.8 ms |                           398.6 ms |
| 1 KiB / 0 / 80 ms                        |                  1231.6 ms |                541.8 ms |                           682.7 ms |
| 96 KiB / 0 / 80 ms                       |                  1244.4 ms |                541.7 ms |                           697.1 ms |
| 1 KiB / 500 / 80 ms                      |                  1311.3 ms |                637.3 ms |                           610.8 ms |

Working-set had a lower cold-open arm median and a favorable median paired difference in all four configurations. Four of the 24 individual pairs favored native partial (two in the zero-delay case and two with 500 unrelated files), so this is a small descriptive comparison, not a universal per-sample win. Median within-pair native/working-set cold ratios were about 2.00–2.29; these are medians of six ratios, not divisions of the arm medians. Native first durable local edits had workload medians of 70.5–74.8 ms, versus 0.4–0.9 ms for the working-set draft. Native preparation was 1.4–1.7 ms in these already-loaded cases and is reported separately; it was not omitted or replaced with a fake mutation.

Cold protocol response counts were four for native partial and three for working-set. For the 1 KiB file, completed response-body medians were about 20 KiB versus 2.1 KiB without unrelated files, and 77.7 KiB versus 2.1 KiB with 500 unrelated files. The 96 KiB case was about 146.5 KiB versus 97.1 KiB. These are protocol bodies, not total browser download size.

This evidence supports continuing the working-set approach for a narrow loaded-file editing surface. It does not establish feature parity or justify replacing the production architecture without integrating and measuring the omitted product behavior. The complete generated report contains warm reads, preparation, reopen, edits, reconnect, byte counts, all denominators and all six paired effects for each workload.

Each workload has six separately seeded repository pairs. AB/BA order alternates. Four configurations vary text size (1 KiB or 96 KiB), unrelated files (0 or 500), and an artificial delay before each protocol fetch (0 or 80 ms). The delay is not a full network emulator. Results are descriptive medians with per-sample paired effects, not a statistical significance claim.

“Usable” means one UTF-8 text file loaded and editable. Preparation for native offline editing is measured separately. Durable edits compare OPFS SQL commits with strict IndexedDB draft transactions. Reconnect measures each arm's `sync()` completion: working-set publishes and refreshes; native partial polls authority convergence every 50 ms while its background publisher runs. It includes polling granularity and is not pure transport latency. The test excludes production authentication, the directory tree, Atelier/plugins, rich documents, subscriptions, and full disconnected navigation. It does not measure production repository end-to-end usability.

Protocol bytes include only completed cold-open response bodies and exclude browser assets, request bodies, headers and open streams; the profile separately records incomplete response counts. During offline local work, successful remote I/O is forbidden. Only failing native background `POST /sync/push` attempts are allowed; every other protocol attempt fails the capability check. Pending edits and cache-reset recovery are verified separately from latency.

## Reproduce from clean source

```sh
git fetch origin
git switch dev-30-09
git pull --ff-only origin dev-30-09
git submodule update --init --recursive
```

Generated SDK/WASM and other build artifacts are ignored and must be rebuilt. The profile records the actual WASM asset identity, browser version, SDK/authority source revisions, source-diff hashes, binary hash and debug/release profile. Do not substitute an older asset while retaining this run's provenance.

On the verified Linux host: Ryzen 9950X, 16 cores, about 186 GiB RAM; Rust `1.97.0-nightly (b954122bb 2026-05-20)`; Node `v22.23.2`. Rust's unoptimized async SQL chains need the test stack setting below. Use a capable build host; an earlier Mac build exhausted substantial memory.

From Lix:

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
cargo build -p lix-server
node packages/js-sdk/scripts/build-wasm.js
```

Use nextest without `--lib` so integration targets are included. From the Lixray root, build browser packages from the pinned submodule:

```sh
pnpm install --ignore-scripts
pnpm --filter @lix-js/sdk run build:browser
pnpm --filter @lix-js/storage-opfs run build
```

`build:browser` generates both normal and migration WASM artifacts required by a clean TypeScript build. This profile imports the normal browser artifact; it does not benchmark the migration bundle. Then follow the prototype's reproduction commands for Vite, recovery validation, the six-sample profile and report generator.

The disposable authority uses loopback `18309`, MinIO at `127.0.0.1:53623`, bucket `lixray`, and independent prefix `architecture-prototype-30-09-verified`. The preview uses port `8830`. The verified immutable running authority binary is `/tmp/lix-server-30-09-pinned`; its SHA-256 is recorded in the raw profile. Fixture authentication values are defined in the experiment's proxy and seed code. Runtime data and build logs under `/tmp` are machine-local; committed JSON evidence is the portable record. On this machine the final logs are `/tmp/lix-dev-30-09-final5-all-simulations.log`, `/tmp/lix-dev-30-09-final4-doctests.log`, `/tmp/lix-dev-30-09-final-{slatedb,rocksdb}.log`, `/tmp/lix-dev-30-09-final3-napi.log`, `/tmp/lix-dev-30-09-wasm-pinned.log`, `/tmp/lix-physical-clone-final-{demo,monorepo}.log`, `/tmp/lixray-30-09-recovery-verified.log`, and `/tmp/lixray-30-09-profile-verified.log`. Do not touch unrelated services or production storage.

## Remaining scope

This development comparison is complete. The schema-filtered native working-diff path can still scan unrelated identities within a requested schema before file/row filtering. These loaded-file scenarios do not establish arbitrary repository-wide offline readiness. Production rollout remains a separate decision. The working-set prototype still needs a versioned outbox/recovery contract, authentication lifecycle, refresh/subscriptions, multi-file and rich-document semantics, and integration with actual editing surfaces before it can replace the current product architecture. Ordinary browser reload does not establish power-loss or storage-eviction durability. No production deployment or deployed PostHog end-to-end verification is included here.
