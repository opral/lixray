# dev-30-09 verification and architecture handoff

The release target is **native browser Lix**, with repository admission separated from active-document preparation. The native engine owns SQL execution, dependency tracking, unpublished commits and their durable OPFS journal. It fetches missing authenticated inputs before declaring a document ready; prepared reads and edits then commit locally without waiting for publication. The application has no separate mutation outbox. The earlier application working-set A/B comparison below is historical evidence for a narrower editing surface.

## Current release qualification

[PR #543](https://github.com/opral/lixray/pull/543) and [PR #548](https://github.com/opral/lixray/pull/548) restore quiet normal opening and traceability across browser, native request and MCP adapter errors. Known broken local copies offer only **Reset from server** in the main error view, retaining original bytes internally. Normal opening has no storage activation, backup prompt or saved-copy panel. Remote snapshot export uses the authenticated snapshot endpoint directly, bypassing the diagnostic handshake that returned 404.

Snapshot failures include bounded action/request context. Shared handled errors, uncaught exceptions and rejected promises carry validated error IDs, release, operation and actual trace/span context. Requestless errors get a labeled standalone trace; missing or opaque context is explicit. Gateway projections accept native catch-all route templates and use the verified browser actor. MCP-owned typed result-conversion and serialization failures have explicit sanitized Node SDK exception capture. Installed Zone.js swallowed browser promise-rejection events; the interop correction restores normal EventTarget delivery without introducing duplicate promise rejections.

Final [app CI 36908584117](https://github.com/opral/lixray/actions/runs/36908584117) passed on `7966c8ff811fba81e9498b104ff52c8ea9010979`: all four browser lanes, recovery/directory components, rendering components, Compose E2E and real PostHog SDK telemetry. The browser regression sends actual SDK HTTP payloads for a snapshot 404, successful retry, natural uncaught error and natural rejected promise, with exactly one exception per trigger and matching OTLP traces. The Node regression verifies actual SDK batch payloads for MCP failures. Local worker/analytics tests passed 427/55; MCP/runtime tests passed 49; gateway context tests passed 26. GPT-6 Luna xhigh reviewed and profiled this work. The automatic [production run 36910416674](https://github.com/opral/lixray/actions/runs/36910416674) passed on merge `76cc65ce0495cdbd98b27ff87d0515335c12d105`, completing at **21:07 Berlin on October 1**. All four candidate browser gates, migration checks, image promotion and the public repository canary passed. An independent canary also passed with protocol 12.

Live PostHog ingestion was confirmed on this release for handled browser errors, uncaught exceptions, rejected promises, native request failures and MCP adapter conversion failures. The native 404 carries `lix.protocol.request`, its catch-all route and request ID. The previously missing MCP conversion exception carries `sdk_result_encoding`, POST `/mcp`, the deployed release and the active tool trace. [Exact deployment and ingestion evidence](experiments/exception-traceability-76cc65c-deployment.json) records error/trace/span IDs and usable PostHog issue links. The headless browser probe overrides only its ephemeral SDK bot filter; production settings are unchanged. Native inner/outer SQL exception projections are still separate events ([issue #546](https://github.com/opral/lixray/issues/546)); this release fixes the missing MCP capture rather than global deduplication. Unsupported row_ref encoding ([issue #544](https://github.com/opral/lixray/issues/544)) remains a functional limitation, now traceable.

Persisted browser upgrades are **not fully qualified**: production Safari and Chromium clients on `4095463523cb68df76b203d225c88d278fc4b22b` reported `LIX_PARTIAL_INTEREST_JOURNAL_INVALID` for legacy v2 read-interest journals ([incident #539](https://github.com/opral/lixray/issues/539)). The regression established rejection and unchanged source bytes, not successful recovery. Separate Safari events on the older September 30 client reported admission/protocol mismatch; after loading the current release Safari encountered the journal failure too. Server canaries and fresh-replica browser tests do not establish persisted browser recovery.

The earlier [Recovery PR #540](https://github.com/opral/lixray/pull/540), whose warning/backup/storage UI is superseded by PR #543, added an explicit **Reset OPFS cache** action for blocked repository opens, with an unsynced-work warning, raw physical ZIP backup, acknowledgement, both provider ownership fences and the existing durable replacement-intent/canonical-ack protocol. The old physical copy is retained. Unsupported old journals are not automatically replayed: unsynced changes may require manual recovery. `.lixsnap` export is available when the engine can open a copy; incompatible copies get a ZIP, not a mislabeled snapshot. Admission/protocol mismatch instead offers a real **Reload LixRay** action. Full [app CI 36878872368](https://github.com/opral/lixray/actions/runs/36878872368) passed, including all four Library lanes; GPT-6 Luna xhigh reviewed the implementation and its Retry/reset race finding was fixed. Chromium recovery components passed 12/12. An additional Linux WebKit run is not OPFS qualification: `navigator.storage.getDirectory` is unavailable in that installed build, and other cases also had intermittent page-load timeouts. Actual macOS Safari persisted-copy recovery remains unconfirmed. Recovery deployment [36880967405](https://github.com/opral/lixray/actions/runs/36880967405) **passed and is live**, completing at 17:18 Berlin on October 1, on merged app `52ee6d49500311a42dfff4c161811f83fc6c6461`; engine pin remains `98397ecf730587829fa3c115f2d62300724424cb`. All four production browser gates, migration checks, paired promotion and live canary passed. Independent read-only canary and `@opral/demo` / `@opral/monorepo` SQL probes also passed. [Recovery deployment evidence](experiments/opfs-reset-52ee6d4-deployment.json) records exact release and images. This does not demonstrate automatic restoration of previously unpublished work or successful reset on the affected user device.

The native release was deployed successfully at [lixray.com](https://lixray.com), application merge `4095463523cb68df76b203d225c88d278fc4b22b`. The corrected engine candidate is `98397ecf730587829fa3c115f2d62300724424cb`, pinned by this application branch. Local qualification passed **4,959 all-simulation and HTTP tests, 10 doctests, and 30 HTTP sync-mode E2E tests** (88 and 3 respective skips). [Full engine CI 36858697176](https://github.com/opral/lix/actions/runs/36858697176) passed: 6,035 Rust tests, 261 E2E tests, 69 tooling tests, 10 doctests, 425 native SDK tests and 65 SDK browser tests. Matching native profiling passed all 28 cases; Full application CI and all four Library browser gates passed. [Production run 36864074092, attempt 2](https://github.com/opral/lixray/actions/runs/36864074092) completed successfully after migration checks, paired Railway image promotion, and the existing live repository canary. The live contract is **server 12 / sync 25 / storage 85**. Read-only MCP health checks passed for `@opral/demo` and `@opral/monorepo`. [Deployment and post-deploy evidence](experiments/native-production-98397ecf-deployment.json) records exact image digests, timings and preflight.

- [Architecture PR 1930](https://github.com/opral/lix/pull/1930) is merged. [Filesystem correction PR 1932](https://github.com/opral/lix/pull/1932) is merged at `1a75a052973c9834055e6aaccbb90deba56aac08`. [Application release PR 536](https://github.com/opral/lixray/pull/536) is merged at `4095463523cb68df76b203d225c88d278fc4b22b`, preserving the exact engine pin.
- [Matched final native evidence](experiments/native-production-scope-98397ecf-summary.md) records 24/24 document cases, 2/2 held-publication cases, and 2/2 incoming-generation cases. Both first reads and first edits after native head adoption made zero foreground protocol attempts. Bootstrap used at most three responses and 2603–2627 body bytes across 0/500/5000 unrelated files and 500 history writes. Selected-document preparation remains separate and its proof/frontier cost grows. Raw measurements used clean app `b4c671c4d4d4647516dd2b46caed90a0340824fd`; the subsequent storage-notice layout correction does not relabel those measurements.
- [Application CI 36859173032](https://github.com/opral/lixray/actions/runs/36859173032) passed native Library navigation, editing and conflicts, but history failed because the floating device-storage notice intercepted Checkpoint clicks. The notice now occupies a reserved footer below Atelier. [Full application CI 36862753622](https://github.com/opral/lixray/actions/runs/36862753622) passed on `e3cf2dd5374deaba70b97d3d10cd80c2b70ada4c`, including history, navigation, editing, conflicts, frontend, recovery/rendering components and Compose E2E.
- Incoming clean generations prepare retained moving scopes and write dependencies before adoption, with registry revision and durable-journal guards. Fixed history remains on demand. Runtime and maintenance share the browser WASM artifact.
- Directory preparation matches query execution's directory-only index. The parsed-file HTTP regression proves cold folder listing hydrates zero file descriptors or owners; a selected file-ID metadata read then admits its own canonical owner, uses no authority SQL fallback, and survives offline reopen. Owner admission requires a separately recipe-selected row for the same file and physical branch. Directories, unrelated keys/files/branches, malformed owners and owner-only closures remain rejected.
- Engine `b87fe28c94` passed [full CI 36852414209](https://github.com/opral/lix/actions/runs/36852414209): 6035 Rust tests, 261 E2E tests, 69 tooling tests, 10 doctests, 425 native SDK tests and 65 SDK browser tests. App `15dacf2253` failed Library editing/history/conflict gates in [CI 36853184558](https://github.com/opral/lixray/actions/runs/36853184558), exposing the owner dependency and directory scope mismatch now corrected. No promotion occurred.
- Earlier app `5844e3d` / engine `787b30226` failed cold-directory registry validation in [Production run 36843834144](https://github.com/opral/lixray/actions/runs/36843834144), before migrations or promotion. Its [matched document baseline](experiments/native-production-scope-787b3022-summary.md) passed 24/24 capabilities and 2/2 held-publication tests: bootstrap bodies 2598–2624 bytes across 0/500/5000 unrelated files and 500 history writes, workload medians 985–992 ms. Document preparation is separate and grows with proof/index and write-frontier dependencies. This baseline does not qualify the Library or corrected release.
- That raw baseline retains a 27.7-second browser-side bootstrap outlier. Protocol responses were fast; its cause remains unproven. The medians do not guarantee constant startup wall time.

[Production run 36864074092](https://github.com/opral/lixray/actions/runs/36864074092) validates merge `4095463523cb68df76b203d225c88d278fc4b22b`. Its first attempt passed navigation, editing and conflicts, but strict history cleanup failed after a transient push returned 503 and its exact request body replay returned 200 683 ms later. All functional history assertions passed; Playwright could not retain the failed response body, so the tracker refused to classify it as recovered. Evidence and limitations are recorded in [issue 501](https://github.com/opral/lixray/issues/501#issuecomment-5932017407). Attempt 2 reran the failed history gate unchanged and passed, then completed migration checks, promotion and the live canary. Migrations and promotion did not run on the first attempt. The strict recovery assertion was retained.

Before promotion, the existing production canary admitted successfully with sync protocol 24/storage format 85. GPT-6 Luna xhigh compared previous engine `7844dbb` and the candidate: both use `certified-authority-v6-replica-retirement`, format 85, and a byte-identical authority eligibility fence. No authority-marker conversion is required. Railway replaces the services separately; sync 24/25 clients fail closed on protocol mismatch during the brief transition. Both deployed images must match before declaring the release healthy.

Replaceable cache inputs and irreplaceable local work have different ownership even when both live in native storage. Immutable keys identify content that can be verified and fetched again; they do not alone prove that all dependencies needed for a particular SQL operation are resident. Native read recipes supply that dependency boundary. Pending publication and format-conversion journals remain protected, and incompatible conversion recovery fails closed while preserving the source. General automatic cache eviction is disabled; unsupported cross-format semantic replay requires explicit recovery rather than dropping local work.

## Historical prototype qualification

The paired comparison and first native document prototype completed on 2026-09-30/2026-10-01 at Lix `38dd17445501e3293f1e626eec53dd94ee709460`. The historical native follow-up passed 48/48 profile cases and 2/2 held-publication tests, including warm and restarted authority runs. Their evidence remains separate from the current production candidate.

- [Historical paired raw profile](experiments/architecture-verified-profile.json), [derived report](experiments/architecture-verified-summary.json), and [browser recovery evidence](experiments/working-set-verified-validation.json).
- [Historical experiment contract and reproduction](architecture-working-set-prototype.md).
- [Native working-scope design and profiles](native-working-scope-prototype.md).

## Resolved defects

The native first offline edit failed even after a successful `prepareOfflineEditing()`. Preparation was not losing OPFS graph imports: diagnostic reads found the selected/main graph records resident in the requested generation. The filesystem transaction layer recorded a narrow file dependency but executed a broad path-index request. Its staged path-index path also discarded the file-ID scope, pulling unrelated initial-branch directory/file descriptors into an otherwise loaded file's write dependencies.

The corrected implementation uses the same normalized file-ID scope for recording and execution, and resolves the selected files plus their directory ancestry through the transaction overlay. Exact commit-delta winner checks use authenticated point replay; filtered working-diff reads route only requested schema ranges. A matching warm full path index can serve a scoped projection containing just the selected file lanes and parents. Branch, revision and projection options must match. Cold reads stay bounded; complete-root validation remains available.

A new native-worker regression test reads a file online, prepares offline editing, closes and reopens, then performs the first UPDATE directly through the session without a hydration/retry wrapper. It also verifies repeated edits inside an explicit transaction. Chromium/OPFS independently verifies offline read, first edit, close/reopen durability and reconnect in both comparison arms.

`RETURNING lixcol_change_id` now allocates provisional IDs when the requested expression needs them and returns canonical persisted IDs after commit. Explicit OLD/NEW projection preserves those cells without exposing provisional IDs in ordinary default hot-state rows. The idempotency tests now use a test-only synchronous durable-memory wrapper rather than asking ordinary Memory storage for a durability guarantee it intentionally rejects. Production durability checks are unchanged. The native host also dispatches `prepareOfflineEditing()` for both supported storage variants.

The recipe-mask type correction from the previous handoff has compiled. Numeric OTLP `doubleValue` measurements are retained, and bounded categorical schema diagnostics are tested independently from numeric bounds. These checks do not establish deployed PostHog coverage.

## Historical verification at `38dd174455`

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

This evidence shows that the application working-set draft is faster for a narrow loaded-file editing surface. It does not establish feature parity or justify replacing the native architecture. The follow-up keeps the native engine and makes its active-document readiness explicit. The complete generated report contains warm reads, preparation, reopen, edits, reconnect, byte counts, all denominators and all six paired effects for each workload.

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
cargo nextest run -p lix --features all-simulations --features server-protocol --no-fail-fast -j8
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

`build:browser` generates the shared browser WASM used by both ordinary opening and maintenance, along with the TypeScript artifacts. The historical profiles at `38dd174` and `787b302` used the earlier separate runtime and migration bundles; their recorded binary identities remain unchanged. Then follow the prototype's reproduction commands for Vite, recovery validation, the six-sample profile and report generator.

The disposable authority uses loopback `18309`, MinIO at `127.0.0.1:53623`, bucket `lixray`, and independent prefix `architecture-prototype-30-09-verified`. The preview uses port `8830`. The verified immutable running authority binary is `/tmp/lix-server-30-09-pinned`; its SHA-256 is recorded in the raw profile. Fixture authentication values are defined in the experiment's proxy and seed code. Runtime data and build logs under `/tmp` are machine-local; committed JSON evidence is the portable record. On this machine the final logs are `/tmp/lix-dev-30-09-final5-all-simulations.log`, `/tmp/lix-dev-30-09-final4-doctests.log`, `/tmp/lix-dev-30-09-final-{slatedb,rocksdb}.log`, `/tmp/lix-dev-30-09-final3-napi.log`, `/tmp/lix-dev-30-09-wasm-pinned.log`, `/tmp/lix-physical-clone-final-{demo,monorepo}.log`, `/tmp/lixray-30-09-recovery-verified.log`, and `/tmp/lixray-30-09-profile-verified.log`. Do not touch unrelated services or production storage.

## Remaining scope

The historical A/B comparison is complete. Current production qualification is tracked at the top of this document. Prepared existing-file text/Markdown editing is the measured scope; it does not establish arbitrary repository-wide offline navigation or plugin readiness. General ownership-aware automatic cache eviction is disabled. Unsupported cross-format journal conversion preserves the source and requires explicit recovery. Ordinary OPFS close/reopen does not prove power-loss or browser storage-eviction durability. The schema-filtered native working-diff path can still inspect unrelated identities within a requested schema before file/row filtering. Deployed PostHog end-to-end verification is not part of these measurements.
