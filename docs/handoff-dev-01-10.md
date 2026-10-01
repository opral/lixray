# October 1 exception and partial-replica corrections

## Delivery

The native browser architecture remains the goal: local working data and edits stay on the partial replica; whole-history inventory uses an explicitly authorized server reader in the background. Local working data renders independently of that reader. There is no compatibility shim, new mutation outbox, storage activation prompt or broad retry/reset suppression.

- Lix engine/SDK: `92d9969e6668b351c7ec5cb5b718345da3f10adf`, `dev-01-10`, [PR #1933](https://github.com/opral/lix/pull/1933).
- Atelier: `b5fe9925973f302b2d0e6cb4dba374f4cd49b0df`, `dev-01-10`, [PR #203](https://github.com/opral/atelier/pull/203). Includes Markdown capability correction `b4981c93` and concurrent Library layout work.
- Application: `dev-01-10`, [PR #549](https://github.com/opral/lixray/pull/549), including main `76cc65ce0495cdbd98b27ff87d0515335c12d105` and concurrent development update `3669ef8`.

These draft development branches are not a deployment. Local source builds do not establish cloud artifact qualification or post-deployment recovery.

## Incident evidence and corrections

PostHog project 512495 showed fresh failures on client `76cc65ce0495cdbd98b27ff87d0515335c12d105` around 21:41–22:13 Europe/Berlin on October 1. Controlled `LixRayBrowser*Probe` exceptions and older `52ee6d4` clients are separate evidence.

- [Missing stacks, issue #551](https://github.com/opral/lixray/issues/551): application `withSpan` set error status without recording the caught exception, and the OTLP gateway discarded supplied stack text when constructing PostHog's exception list. Both boundaries now preserve genuine bounded JavaScript frames and cause frames. MCP uses one explicit owner and safe SDK/application callsites. Source map IDs and frames are never invented.
- Native structured errors capture their genuine Rust constructor location through NAPI, WASM, server protocol diagnostics and SDK Worker serialization. SQL and protocol owner spans declare those attributes. `rust_origin.kind=source_location` identifies the producer; `rust_stacktrace_status=not_captured` explicitly states that this is not a full native call stack. The final compile gate caught and corrected a WASM partial move; the strict browser gate caught dropped worker metadata. The same strict browser gate then caught JSON numeric encoding of origin line/column; the WASM producer now uses the existing canonical JSON conversion helper. These boundaries were corrected before final qualification.
- [Partial history, issue #552](https://github.com/opral/lixray/issues/552): Home's complete `lix_change` aggregate ran against the partial working replica. Complete change and checkpoint inventory now use the authorized authority reader; local working counts render while it is pending. Branch/source changes invalidate old rows in the same render, and scoped publication views receive no whole-history capability.
- [Bounded preview, issue #553](https://github.com/opral/lixray/issues/553): `CASE WHEN OCTET_LENGTH(content) <= $2 THEN content END` missed native late materialization and demanded an unrelated content scan. The planner now uses resident size metadata and fetches content only for qualifying files. Unsupported CASE forms retain ordinary SQL semantics.
- [Markdown capability, issue #491](https://github.com/opral/lixray/issues/491): block/comment observers queried `markdown_node` before confirming the Markdown plugin was installed. Atelier observes the installed plugin archive before enabling those table reads. Missing capability and installed-but-empty content are distinct; genuine query errors still reach the error boundary.

Exception events retain operation, release, trace/span correlation, bounded causes and genuine safe source frames. Native diagnostic values use validated error categories because raw diagnostics can contain SQL or repository data. Stack headers, machine paths, credentials, private values and context tokens are excluded.

## Qualification

| Check | Result |
| --- | --- |
| Lix all-simulations + server-protocol | 4,966 passed, 88 skipped; final run 82.533s |
| Exact HTTP-backed partial-replica observe fixture | Passed; 0.108s |
| Lix doctests | 10 passed |
| Focused server exception-owner tests | Both passed |
| Rust formatting and strict all-targets/all-features Clippy | Passed |
| SDK worker origin/cause round-trip and unsafe metadata rejection | 2 passed |
| Final pinned browser/native SDK source builds | Passed; WASM 3m17s, native 2.10s |
| Browser recovery/directory/Home on final Atelier layout | 66 passed; 1.5m |
| Atelier conversation/Library selection and typecheck | 88 tests passed across 5 files; typecheck passed |
| Application CI check (before final binding-only JSON correction) | 56 analytics, 216 + 27 repository, 52 Railway, 443 worker/MCP; TypeScript and token checks passed |
| Application lint, formatting and web build | Passed |
| Actual PostHog Node-client receiver | 2 tests passed on the final pin; genuine JS and native SQL error through wrapped cause |
| Actual PostHog browser/WASM wire qualification | Passed on the final pin; Chromium 1/1, 4.5s; actual WASM origin/code and handled/uncaught/rejection events |

An incidental unfiltered Atelier run had one checkpoint layout failure among 2,928 passing tests. The same test passed in isolation; it is not claimed fixed.

The Node receiver checks genuine callsites and native origin/cause metadata while excluding SQL, private values, credentials, the missing-table identifier and context. The browser fixture uses the installed PostHog SDK, opens real WASM Lix and queries an absent table; it does not assign an origin to that error. The actual worker-executed WASM error exposed `packages/lix/src/sql2/error.rs:66:16`; no safe application JavaScript frames were available for that specific error. The test preserves available genuine frames and separately requires the real Rust origin. JavaScript failure cases verify actual frames independently. Outgoing payloads are captured locally so qualification does not create misleading production incidents.

## Remaining incident uncertainty

The production `LIX_INTERNAL_ERROR` events on registered-schema metadata, working diff and active-account reads are not proven fixed. Their exact initial `observe` query shapes passed over a genuine HTTP-backed partial replica. Read-only queries against the live `@opral/monorepo` authority also succeeded in 333–485ms per MCP call; this does not establish recovery of affected persisted browser state. No schema values, account names, context tokens or credentials were exported into the evidence.

The older opening trace contained HTTP 503 failures whose underlying state/transport cause cannot be reconstructed from the old stackless exception. The new native producer context is needed to identify that specific failure. No broad retry or automatic destructive reset masks it.

## Reproduction

From the application checkout:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
node scripts/prepare-vendored-lix-sdk.mjs --source --native
pnpm --dir web-app ci:prepare:web
pnpm --dir web-app ci:lint
pnpm --dir web-app ci:check
pnpm --dir web-app ci:build
pnpm --dir web-app test:snapshot-telemetry
pnpm --dir web-app exec playwright test --config playwright.file-component.config.ts tests/file-component/recovery.spec.ts tests/file-component/directory.spec.ts tests/file-component/home-history.spec.ts
```

From the Lix checkout:

```sh
RUST_MIN_STACK=16777216 cargo nextest run -p lix --features all-simulations,server-protocol --no-fail-fast
cargo test -p lix --doc
cargo clippy --profile test -p lix -p lix-server --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
```
