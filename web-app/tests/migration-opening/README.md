# Existing-cache app opening regression

This opt-in Playwright fixture imports the actual `openRepositoryLixSession`,
cache identity helpers, current browser SDK and current OPFS provider. It seeds
an existing file with a historical OPFS writer, closes that page, then opens the
same cache through the app. Test-side retries are deliberately absent. It checks
first opening, pending data or retained recovery exports, simultaneous opening,
interruption during migration, two tabs, and reload. The pending legacy case also
mounts the actual recovery component and downloads the original tracked and
untracked changes, then verifies the open repository remains unchanged after
download and reload.
The legacy authority includes a registered custom schema row plus inline and
300 KiB binary files; the custom row and every byte are
checked after opening, in a second tab, and after reload. Its concurrent HTTP
fixture handles update polling alongside immutable-object hydration.
No production repository or credential is used.

Four fixture families must remain distinct:

- `legacy_browser_app_fixture_authority` exports the engine's supported synthetic
  sparse v77 full-sync shape. Historical commit bodies are intentionally absent.
  This is migration-route evidence, **not** a historical codec export. Set
  `LIX_BROWSER_LEGACY_PENDING=1` to include tracked and untracked local edits.
- `v2_partial_browser_app_fixture_authority` exports a synthetic v82 partial
  replica with a v2 read-interest journal and a pending local row. It is seeded
  by the historical OPFS writer but is **not** a historical codec export. The
  actual app opener must convert the v2 journal and preserve the pending row.
- `v3_history_partial_browser_app_fixture_authority` exports a current-format
  partial replica with a prerelease v3 read-interest journal and a pending local
  row. It tests journal migration without downgrading the storage format. The
  app must convert the journal to v4, remove its obsolete History anchor, and
  preserve the pending row.
- `pending_browser_conversion_fixture_authority` exports a complete current-format
  full replica at a real acknowledged baseline, with independent local/remote
  edits on two branches, files and a custom schema. Its authority deliberately
  loses committed merge replies. This covers app retry/resumption, not old-format
  admission.

Build the current SDK and historical writer **before** starting the authority.
Start the ignored fixture immediately before the browser tests: native baseline
leases last five minutes. An intentionally aged cache is a separate lifecycle
case; leave its app session open to reconcile the baseline.

Start the ignored fixture from `vendor/lix` (or a matching engine worktree):

```sh
LIX_BROWSER_LEGACY_MANIFEST=/tmp/lix-legacy-qa.json \
LIX_BROWSER_LEGACY_STOP=/tmp/lix-legacy-qa-stop \
RUST_MIN_STACK=16777216 \
cargo test -p lix --features all-simulations,server-protocol,server-protocol-client \
  legacy_browser_app_fixture_authority -- --ignored --nocapture
```

For the v2 partial-replica fixture, use fresh paths and run:

```sh
LIX_BROWSER_V2_PARTIAL_MANIFEST=/tmp/lix-v2-partial-qa.json \
LIX_BROWSER_V2_PARTIAL_STOP=/tmp/lix-v2-partial-qa-stop \
RUST_MIN_STACK=16777216 \
cargo test -p lix --features all-simulations,server-protocol,server-protocol-client \
  v2_partial_browser_app_fixture_authority -- --ignored --nocapture
```

For the current-format partial replica with a v3 journal, use fresh paths and run:

```sh
LIX_BROWSER_V3_PARTIAL_MANIFEST=/tmp/lix-v3-partial-qa.json \
LIX_BROWSER_V3_PARTIAL_STOP=/tmp/lix-v3-partial-qa-stop \
RUST_MIN_STACK=16777216 \
cargo test -p lix --features all-simulations,server-protocol,server-protocol-client \
  v3_history_partial_browser_app_fixture_authority -- --ignored --nocapture
```

For the pending current-format fixture, use `LIX_BROWSER_CONVERSION_MANIFEST`,
`LIX_BROWSER_CONVERSION_STOP` and `pending_browser_conversion_fixture_authority`.
Wait for its ready message. Use fresh manifest/stop paths and a fresh authority
for **each selected test case**; successful conversion changes the synthetic
authority. A single suite invocation shares that authority across browser
contexts and does not independently qualify fresh migration for later cases.
Select one case per invocation with `--grep`, stop its authority afterward, then
start a new authority before the next case.

The complete matrix has fifteen isolated cases:

- Clean v77 full replica: opening/reload, second tab, and tab closed during migration.
- Pending v77 full replica: the same three cases plus recovery download.
- v82 partial replica with a v2 journal: opening/reload, second tab, and tab closed during migration.
- Current-format partial replica with a v3 journal and pending row: the same three cases.
- Current-format pending full replica: opening/reload with lost merge acknowledgements.
- Clean v77 full replica: durable-admission offline reopen after owner teardown.

The migration-pause and legacy-recovery cases do not apply to the current-format
pending fixture. The offline-reopen case closes the historical writer, opens
through the current app online, closes that sole current owner, then reopens
with the repository transport unavailable. Assets still load normally. This
proves that the persisted current-epoch admission proof survives owner teardown,
without an in-memory proof or another open tab.

Prepare a historical OPFS writer without copying binary artifacts into Git.
The reproduced pre-partial writer is Lix commit
`4d1c219e5f08a6b342e7a013f72f9097ad7261e4` (`@lix-js/storage-opfs` 0.16.0).
Export its `packages/storage-opfs` directory with `git archive` into a temporary
folder, install its build dependencies, and run its normal build command. Its
SQLite tables and `/lix/sqlite-sahpool` physical directory convention match the
upgrade path. Set `LIXRAY_MIGRATION_OLD_OPFS` to that package directory containing
`dist/index.js`. This historical physical writer does not change the provenance
of the synthetic logical fixture above.

From `web-app`, after preparing the current browser SDK normally:

```sh
LIXRAY_MIGRATION_FIXTURE=/tmp/lix-legacy-qa.json \
LIXRAY_MIGRATION_OLD_OPFS=/tmp/old-lix/packages/storage-opfs \
pnpm exec playwright test --config playwright.migration-opening.config.mjs \
  --grep "existing OPFS replica opens through the app"
```

The default uses the app's installed SDK. For a local engine candidate, set
`LIXRAY_MIGRATION_SDK` to its `packages/js-sdk` directory after building it;
this changes only the SDK import, while retaining the actual app opener.

Legacy tests pause a real successful candidate receipt read for 1.5 seconds,
allowing the actual migration heartbeat to invalidate its physical read. They
assert the pause occurred. The helper never throws a fabricated storage error.
The app must resume with its ordinary production opening logic.

Stop only the synthetic authority by creating its chosen stop file. Preserve
failed Playwright traces and do not clear a user's browser storage.
