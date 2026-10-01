# Native working scope prototype

This prototype keeps the Rust Lix engine in the browser, with durable OPFS storage and native commits for offline work. Opening a document automatically loads its exact file content and prepares the native branch write frontier before enabling editing. Reads and saves then execute native SQL locally; native synchronization publishes committed work asynchronously. There is no application snapshot database, mutation replay layer, or separate application outbox.

## 787b prepared-document profile baseline; Library qualification pending

The 2026-10-01 prepared-document baseline used app revision `5844e3d413a9fb9dba65044858f7628cfd064c21`, vendored engine revision `787b30226c1c621b752334a1dbffe8993b752038`, and the matching SDK and server artifacts from successful full CI run `36841323230`. The server came from the CI release image; its extracted `lix-server` binary SHA-256 is `569443a5d9bf0a01c530f5c67f7a90901d9addae43c5b22f11cdae331dc804ca`. The profile JSON records `productionScope: true` as the harness mode and carries source/build hashes. That flag does not mean the complete Library browser flow was qualified.

This profile covers a deep-linked, already-selected plain-text document through preparation, offline reads and edits, close/reopen, and reconnect convergence. It does not exercise Library directory discovery or cold directory-registry recipes. Actual Library browser gates subsequently exposed a cold directory-registry recipe bug. Full Library release qualification is pending the guarded engine fix, a matching SDK/server pair from the exact passing CI run, and a fresh profile of those Library gates. The 787b results below remain a useful baseline for the narrower prepared-document flow; they are not evidence that the full Library release is qualified.

All 24 prepared-document capability cases passed: six fresh Chromium contexts for each of 0, 500, and 5000 unrelated files, plus 500 unrelated history writes. Bootstrap used three measured responses totaling 2598–2624 bytes across the grid; workload medians ranged from 984.8 to 992.0 ms. The separate selected-file preparation medians ranged from 918.1 to 1440.7 ms, and all cases verified twenty local reads, three offline edits, close/reopen persistence, and authority convergence after reconnect. The 2/2 held-publication checks also passed with 63.7 ms and 70.6 ms durable edits while the actual publish request was blocked.

One of six 500-file samples had a 27.7-second bootstrap and 28.7-second ready time. Its completed bootstrap responses took 83–85 ms and its selected-file responses took 82–92 ms; capability and convergence checks passed. This is a single browser-side open outlier in this sample set, and the raw report retains it. The authority, preview, and object store were all loopback-only fixtures. No production endpoint or deployment was used.

- [24-case summary and observed outlier](experiments/native-production-scope-787b3022-summary.md)
- [Raw profile JSON](experiments/native-production-scope-787b3022-profile.json)
- [Held-publication validation](experiments/native-production-scope-787b3022-publication-validation.json)
- [Runtime load context](experiments/native-production-scope-787b3022-runtime-context.json)
- [CI artifact and build provenance](experiments/native-production-scope-787b3022-build-provenance.json)

## Opening and readiness

The prototype measures two separate operations:

1. **Repository bootstrap:** `openLix` opens the native partial replica using admission, repository identity, and a bounded selected/global branch descriptor. It does not enumerate the repository or download history.
2. **Document preparation:** select the requested branch, read one file by stable file identity, then call `prepareOfflineEditing`. Only after both succeed does the UI become editable. Unknown inputs are not treated as absent data.

The prepared capability is intentionally one existing plain-text file's content reads and updates. `prepareOfflineEditing` prepares the branch graph frontier; it is not a general API certifying arbitrary SQL, plugin edits, file creation, rename, or directory operations. Different operations need their own dependency preparation. The prototype rejects demand-hydration requests during prepared reads/edits instead of silently putting a network round trip back on that path.

The browser test disconnects actual Chromium networking, reads and writes the prepared document, closes and reopens the same OPFS store while offline, and checks that native pending edits survive. It then reconnects and checks the authority's file content separately. Background publication attempts are recorded separately from successful foreground work.

## Ownership and migration

The storage registry's mutable/immutable classification tells the engine whether bytes can change; it does not decide whether they may be discarded. A downloaded immutable base object can become necessary to an unpublished native commit. The pending commit and its base/recovery dependencies must remain owned even if a downloaded view is replaceable. Rebuildable indexes likewise do not replace their authoritative inputs.

This prototype retains the native store on close/reopen and performs no cache reset or eviction. Existing native partial-replacement code retains the source bank and pending conversion journal across a format change. It does not justify deleting an incompatible old bank merely because a new view opened. A self-contained versioned native work journal and ownership-aware partial cache collection remain distinct engine work; this prototype does not implement or claim them. See the vendored Lix `docs/partial-replica-gc-design.md` and `docs/partial-read-discovery.md` for those contracts.

Synced historical state can be fetched on demand outside the active editing path. Unpublished local history belongs to durable local work. This prototype does not fetch or render history during repository opening.

## Run locally

Use a disposable loopback authority at port 18309 and the existing fixture-only Vite proxy. The proxy supplies local test authority credentials; this is not a production authentication configuration.

```sh
pnpm --filter @lixray/web-app exec vite build --config experiments/vite.config.ts
pnpm --filter @lixray/web-app exec vite preview --config experiments/vite.config.ts
cd web-app
node experiments/seed-native.mjs
```

Open the printed `native.html` URL. The query contains the repository, branch, and selected file identities, as a document deep link would. File discovery and paginated tree navigation are not included in this measurement. Opening a new document can require preparation; the local capability applies after its readiness boundary.

```sh
PROTOTYPE_SMOKE=1 PROTOTYPE_SAMPLES=1 node experiments/profile-native.mjs
# Full run: six fresh browser/OPFS contexts per remote-size/history workload.
PROTOTYPE_AUTHORITY_BINARY=/path/to/the/running/lix-server \
PROTOTYPE_AUTHORITY_BUILD='sdk-source-head=<40-hex>;sdk-diff-sha256=<64-hex>;authority-source-head=<40-hex>;authority-diff-sha256=<64-hex>;authority-binary-sha256=<64-hex>;authority-profile=debug' \
PROTOTYPE_SAMPLES=6 node experiments/profile-native.mjs
node experiments/summarize-native-profile.mjs
node experiments/validate-native.mjs
```

Replace the provenance placeholders with the actual build source heads and SHA-256 hashes. For a clean source diff, the SHA-256 of empty bytes is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The binary must be the immutable copy running the authority, not a build target another command could overwrite.

The profile records source and served bundle hashes, native SDK/authority identity, cold browser navigation, repository bootstrap, document readiness, measured response bytes, offline reads/edits/reopen, and eventual authority convergence. Seeding and convergence verification are outside measured foreground opening. The default authority is already open after seeding. A separate cold-process run restarts the disposable authority after each fixture is seeded, before browser navigation. This preserves remote objects and makes the first measured repository request reopen the authority storage. It does not flush operating-system or MinIO caches. Native WASM loading is a fixed browser startup cost and is reported separately from remote protocol bytes.

For the Linux loopback cold-process run, create `/tmp/native-prototype-authority.pid` containing the PID of your own fixture authority. Add `PROTOTYPE_COLD_AUTHORITY=1` and `PROTOTYPE_AUTHORITY_PID_FILE=/tmp/native-prototype-authority.pid` to the full command. The helper verifies that `/proc/<pid>/exe` is the pinned authority binary before restarting it; its fixture S3 prefix is `native-prototype-01-10`. It must only be used with that disposable authority. Cold-process evidence is written separately as `profile-native-cold-authority.json`.

## Historical baseline evidence (engine `38dd174`)

**48/48 profile cases passed** on 2026-10-01: six fresh browser/OPFS contexts per workload, with both a warm authority and a restarted authority process. Every case asserts the actual 80 ms delay on measured bootstrap/scope responses, twenty local reads, three offline native edits, offline close/reopen persistence, and authority convergence after reconnect. No successful offline protocol responses occurred. Native background publication attempts are permitted and recorded separately.

| Unrelated files / history writes | Warm bootstrap median | Cold-process bootstrap median | Warm document-ready median | Cold-process document-ready median |
| -------------------------------- | --------------------: | ----------------------------: | -------------------------: | ---------------------------------: |
| 0 / 0                            |              989.4 ms |                     1056.3 ms |                  1221.7 ms |                          1297.2 ms |
| 500 / 0                          |              996.7 ms |                     1157.4 ms |                  1241.0 ms |                          1411.3 ms |
| 5000 / 0                         |             1002.0 ms |                     1259.3 ms |                  1252.1 ms |                          1535.2 ms |
| 0 / 500                          |             1003.8 ms |                     1081.8 ms |                  1239.2 ms |                          1325.5 ms |

Repository bootstrap completed **three finite responses, totaling 2598–2621 bytes**, in every case. A fourth transport attempt is the background descriptor request canceled during startup. Bootstrap bytes are effectively unchanged across this grid. **Identical cold-start latency is not achieved:** the restarted-authority workload with 5000 files has a higher median, and client initialization has outliers. Root handshake and browser initialization costs remain visible in the raw data. These loopback/debug results are not production latency forecasts or a proof for all possible repository layouts.

The active-document read uses exactly one `file_content` and one `filesystem_paths(FileIds)` recipe for the selected ID. Its preparation response grows with authenticated native tree dependencies: the separate redacted probe found 3 tree chunks / 2033 decoded bytes at zero unrelated files and 31 chunks / 83382 bytes at 5000 files. It does not fetch 5000 file descriptors. Native chunks have a 16 KiB cap; exact-key paths grow with index depth. See the [closure inspection](experiments/native-closure-inspection.json) for categories and server storage-call/byte counts. Active-document preparation is deliberately separate from the bounded repository descriptor.

Prepared local read medians are about 3.6–3.8 ms. The pooled edit medians in the reports include three edits per case; later edits reuse warmed native paths, so they should not be read as first-edit latency. The independent **held-publication test passed 2/2 cases**: a local native edit committed in 64.5 ms with zero unrelated files and 67.3 ms with 5000, while its actual publication request remained blocked. Native SQL reads saw the edit, the authority still had the original content, and releasing publication produced convergence. This tests that editing does not await a failed or successful network acknowledgment.

The measured normal SDK WASM is 79,179,303 decoded bytes, SHA-256 `884eb3cfe0ff0088cad0828302eb72816a2d2f9a4154bbcaacb04a12cb685e3a`. This fixed asset-loading/initialization cost is included in cold browser navigation. Parent-page Resource Timing omits some worker resources; its transfer sum is not a complete browser download total. The cold browser request list and build file inventory identify those assets separately from repository protocol bodies.

- [Warm raw profile](experiments/native-verified-profile.json) and [derived report](experiments/native-verified-summary.md).
- [Cold-authority raw profile](experiments/native-cold-authority-profile.json) and [derived report](experiments/native-cold-authority-summary.md).
- [Held-publication evidence](experiments/native-publication-validation.json).

Both profiles record identical source/build hashes at the beginning and end, and their measured source-file hashes match the committed experiment files. The engine, normal SDK WASM and immutable authority binary remain pinned to Lix `38dd17445501e3293f1e626eec53dd94ee709460`; this follow-up changes only the prototype and evidence, and reuses that revision's completed Rust verification. The immutable authority SHA-256 is `8b610d5ab855ffe0726b547b0d907a22203faea12a23788ca5e76846658acdc2`.

GPT-6 Luna at xhigh reviewed native dependency preparation, inspected the exact authority closure, implemented/reviewed the profile, and reviewed UI readiness, transport guards and ownership claims. Findings fixed during the work include missing actual SQL endpoints in the hot-path guard, dropped artificial-delay configuration, deduplicated unrelated fixture content, disabled-state rendering, cold-process ownership checks, and response cancellation accounting. The profiler now correlates a canceled request with its exact fully measured successful response using a request ID; missing, failed, or incomplete responses remain failures.

Full TypeScript, changed-file ESLint, experiment formatting, production experiment build, source/hash consistency, both six-sample profiles and held-publication validation pass. No production deployment was performed.
