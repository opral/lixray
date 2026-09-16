# Document opening profile

## Read-only browser profile

Run from the repository root after installing web dependencies:

```sh
PROFILE_URL='https://lixray.com/@namespace/repository/file/ID/path.csv' \
PROFILE_STORAGE_STATE='/secure/local/playwright-state.json' \
node web-app/scripts/profile-document-open.mjs
```

`PROFILE_STORAGE_STATE` is optional for public documents. It is an existing
Playwright authenticated state file; keep it outside the repository and never
commit it. This script does not sign in as another user or modify a document.

The default two runs use a new browser context and then reload in the same
context. The report includes network categories, response durations, long tasks,
loading-indicator appearance, and time to an interactive CSV or Markdown editor.
It prints no URLs, file paths, document contents, credentials, or SQL parameters.
An access screen, error, or timeout exits nonzero and is never reported as a
successful open. `PROFILE_RUNS`, `PROFILE_TIMEOUT_MS`, and `PROFILE_HEADLESS`
control the run. Other renderer types need an appropriate readiness selector.

## Findings, 2026-09-15

- The reported production document requires authentication. The anonymous run
  reaches an access screen; this is not a measurement of its opening latency.
- Atelier's generic loading fallback and CSV fallback were screen-reader-only;
  Markdown and pending comparisons also rendered blank placeholders. They now
  use a visible, reduced-motion-aware spinner and “Opening document…” status.
- A delayed-load regression reproduced two loader calls on initial open, with
  the initial observer frame cancelling and restarting the mount-triggered read.
  Cancellation is checked after SQL returns, so it does not cancel that work.
  Loading from the first observation removes the duplicate. Changes arriving
  during a read coalesce into one follow-up instead of overlapping reads.
- The selected-file local SQL profile is in
  `vendor/lix/packages/js-sdk/scripts/profile-document-open.md`. For a 106 KB
  CSV among 1,600 unrelated files, prepared content took 23.71 ms on the first
  measured read and 1.00 ms at the warm median. This isolates in-memory engine
  work; it does not measure production network, OPFS, or partial sync.
- Existing `document_viewed` events fire at navigation time, before loading.
  New `document_loaded` events measure mount-to-first-content-commit time,
  including the loader wait. They contain extension, view kind, and duration,
  but no document path. This measures the prepared content, not necessarily
  full interactive-editor hydration or media decoding. Background refreshes
  do not emit another event.

## Validation limits

Loading/refresh, standalone-file, prepared-file, and CSV tests pass against the
CI-built SDK. The existing Markdown working-review test fails with duplicate
“title value” controls on both original and changed Markdown code. Existing
CSV lint findings are also present on the development baseline.
