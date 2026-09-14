# Atelier opening failure and Lix architecture investigation

Investigated September 13–14, 2026 UTC. Lixray baseline `3397497`; its pinned Lix revision `5e498d3352984e4ff9571686834c07ce225f6a1f`. Existing working directories were left untouched. This investigation adds reproductions and evidence, not a production fix or deployment.

**Conclusion: a reproducible SDK integration bug produces the reported error without a network request. The history also supports broader architectural problems, especially inconsistent transport contracts, storage-read lifetime assumptions, and migration in the normal opening path. It does not support attributing every recent bug to one cause, or concluding that partial replication itself is fundamentally wrong.**

## Exact failure

The shared engine authenticates a newly attaching port by opening a remote Lix client, reading its active account, and closing it. That remote client receives the port's sync fetch bridge as its custom fetch.

1. `packages/js-sdk/native/wasm_remote.rs:390` builds an ordinary fetch init: method, headers, body, signal. It supplies neither `lixResponseLimit` nor `lixResponseStream`.
2. `packages/js-sdk/src/worker/host.ts:515` implements a fetch-shaped function with an extra, undocumented-in-its-type requirement: one of those metadata fields must be present. Otherwise it throws `TypeError("Browser sync fetch has no valid response limit")`, before sending a fetch RPC to the page.
3. `packages/js-sdk/src/worker/entry.shared.browser.ts:48` passes that bridge into the remote client. Lines 55–61 classify a non-aborted `TypeError` as network failure and replace it with `Shared identity probe could not reach the authority`.
4. `packages/js-sdk/src/worker/shared-admission.ts:30` falls back to a previously admitted exact credential key on that supposed network failure. Same-token attachment therefore masks the broken probe. A previously unseen/refreshed token has no proof and fails.
5. The original exception is stored as `.original`, but `worker/protocol.ts:183` serializes only name/message/stack/code/hint/details. The actionable cause is lost at the worker boundary.

This is a transport-contract mismatch plus incorrect error classification, not evidence of an authority outage. It does not depend on old repository data. Lixray always supplies a custom telemetry fetch for ordinary partial-replica opening, so the production route uses this bridge. Its headers are dynamically obtained from the access-token provider.

The exact trigger in the user's live browser is not independently established: I did not access its credentials or OPFS profile. A fresh token while another port keeps the engine alive is a demonstrated trigger, not a claim that the user's token definitely refreshed.

## Local reproduction and controls

Downloaded the exact pinned browser WASM artifact from successful GitHub Actions run **34781686894**, artifact SHA256 `c528db5c17d4ff28ca1a4b116dd05213b6b0e8d9e6ac5b92b4184018afa2e644`.

Reproductions import the production shared-worker entry, host, admission cache, and actual remote WASM client. Only the already-open local root/session binding is replaced with a small fixture. There is no simulated network rejection. This deliberately isolates the failing composition; it is not a full authenticated Lixray UI/OPFS reproduction.

| Scenario | Result |
|---|---|
| First opener, token A | Opens |
| Second port, same token A | Opens using admission fallback |
| Third port, previously unseen token B | Exact reported error |
| Number of page fetch RPCs across these opens | **0** |
| Control: add explicit bounded-response metadata | One fetch RPC; simulated HTTP 401 returns as an error normally |

The three diagnostic tests plus existing shared-engine/admission tests pass: **20 tests**. An additional **Chromium test with a real SharedWorker** passes with the same first/same/refreshed-token sequence and zero fetch RPCs. These tests intentionally assert the present bug; they are reproduction evidence, not green regression tests asserting fixed behavior.

Files:
- `/root/repos/lix-identity-investigation/packages/js-sdk/src/worker/identity-investigation.test.ts`
- `/root/repos/lix-identity-investigation/packages/js-sdk/src/worker/identity-investigation.browser.test.ts`
- `/root/repos/lix-identity-investigation/packages/js-sdk/identity-investigation.browser.config.ts`
- `/root/repos/lix-identity-investigation/packages/js-sdk/identity-investigation-binding.ts`
- `evidence/reproduction.log`, `evidence/browser-reproduction.log`

Run from `/root/repos/lix-identity-investigation/packages/js-sdk`:

```sh
./node_modules/.bin/vitest run src/worker/identity-investigation.test.ts src/worker/shared-admission.test.ts src/worker/shared-engine.test.ts
./node_modules/.bin/vitest run --config identity-investigation.browser.config.ts
```

## PostHog

Queried the production project's event API directly using existing Infisical credentials; no credentials are in the evidence scripts. Project **512495**. The exact-message search over seven days returned **zero events**. Therefore PostHog does not establish the live incident's frequency or cause.

The three-day exception query returned 21 events, including:

- September 13, 15:59:59 UTC: repository opening failed with `LIX_STORAGE_READ_EXPIRED`, “the coherent storage read was invalidated by a concurrent commit.” [Issue](https://us.posthog.com/project/512495/error_tracking/01a09b7f-3f62-7f00-8c3c-fb749b88ee58).
- September 12: migration failure and generic inability to open a sync session. [Issue](https://us.posthog.com/project/512495/error_tracking/01a096e5-f3ff-7c70-95c4-46a7af852ad6).
- September 12: server diagnostic “a persisted sync replica cannot be served as a protocol authority,” represented twice. [Issue](https://us.posthog.com/project/512495/error_tracking/01a096ff-62e2-79b2-a919-761ced38aa25).
- September 12: actual HTTP 502s during opening. These are a separate class from the reproduced pre-network failure.
- September 11: OPFS owner discovery did not complete within two seconds. [Issue](https://us.posthog.com/project/512495/error_tracking/01a08e25-7fc0-7730-96e8-ceeea5dc8149).

The query included repeated “Lix not found” and generic script errors; these should not be counted as proven manifestations of the same architecture issue. Evidence files contain reduced fields; HTML errors are truncated. No explanation for the missing exact-message telemetry has been proven.

## How the shipped changes led here

The following changes are reachable from the inspected Lixray main baseline through its pinned engine. “Merged/pinned” is established; this does not prove which JS bundle was loaded in the user's already-open tab.

| Change | What it tells us |
|---|---|
| Lix `e82a6c6fd`, Aug 19, sparse-browser convergence fix | Added the sync bridge's strict response-limit requirement. Reasonable for bounded sync, but it is an extra contract on a function typed as fetch. |
| Lix `87817cfb7`, partial replicas; Lixray `42ebb89`, Sept 11 | Browser opening switched to partial replicas with SQL-driven on-demand hydration. |
| Lix `de5b48224`, Sept 11, [PR1757](https://github.com/opral/lix/pull/1757) | Shared partial engines were introduced to share loaded inputs and offline edits across tabs. This added the remote-client identity probe over the incompatible existing bridge. |
| Lix `f76760039`, Sept 12, [PR1761](https://github.com/opral/lix/pull/1761) | Child-session opening gained retries around read/admission validation when concurrent writes expire reads. |
| Lix `c9fc98224`, [PR1769](https://github.com/opral/lix/pull/1769) | Frozen migration source inspection needed bounded read retries under heartbeat commits. |
| Lix `16240e45a`, [PR1773](https://github.com/opral/lix/pull/1773) | The same treatment expanded to migration planning/snapshot verification; conversion was serialized through the same shared-engine admission queue. |
| Lix `0699966dd`, [PR1777](https://github.com/opral/lix/pull/1777) | Legacy initialization/snapshot installation needed further coherence handling during migration heartbeats. |
| Lix `7435a0355`, then `f6136a19c` / [PR1772](https://github.com/opral/lix/pull/1772) | Restarting when initial authority anchors drifted did not cover drift later in upload. Acceptance moved to the current authority state with immutable retry identity. This changes the underlying convergence rule rather than merely adding retries. |
| Lix `e89249325`, [PR1774](https://github.com/opral/lix/pull/1774) | Shared S3 connections needed a long-lived server runtime. This is a distinct resource-lifetime bug, not an OPFS identity bug. |

The existing actual-SharedWorker test uses `shared-engine.fixture.bench.worker.ts`, whose `verifyIdentity` is stubbed to return an account. Admission-cache tests inject failures directly. They exercise ownership and policy individually, but miss the real remote-client/bridge composition and token rotation. The new reproductions cover that gap.

## Architectural assessment and recommended simplification

**Transport and identity:** There are two HTTP clients with different expectations, composed through a fetch-compatible type that does not express the difference. Authentication also requires a whole remote session lifecycle just to learn a principal. Introduce one explicit bounded/streaming transport contract shared by remote and sync clients. Use a minimal authenticated repository/principal admission operation instead of opening a remote SQL session. Keep credential verification; a caller-supplied account ID or unchecked decoded token is not a substitute. Classify actual fetch rejection at the actual network boundary, and preserve structured causes through worker RPC.

**Read lifetime:** OPFS increments its generation after every committed write (`storage-opfs/js/provider.ts:399`) and rejects reads from prior generations. This supplies revocable coherent reads, not long-lived MVCC snapshots. Background sync and migration heartbeat commits make expiry ordinary. The successive opening, frozen-read, planning-read, and legacy-init fixes are evidence that higher layers repeatedly assumed more read stability than this adapter guarantees. There already is a shared retry/backoff policy; the missing consistency is which complete read units own retries. Define those units centrally, or evaluate storage snapshots/immutable read generations. Do not retry arbitrary SQL or accepted writes: completion boundaries and idempotency still matter.

**Opening and migration:** Normal opening currently traverses ownership discovery, credential admission, initialization, format inspection/migration, full-to-partial conversion, retained-edit recovery, branch admission, and synchronization. The recent fixes coordinate overlapping lifecycle states. With no compatibility requirement, migrate authorities explicitly during deployment, convert browser stores once under exclusive ownership, and run the ordinary client against one current replica format. Move old readers/converters into a migration path that can be retired after rollout. Preserve/export pending local edits before replacing a browser replica. Rebuilding hydrated cache is safe only when it cannot discard the unsynced journal. Browser migration must remain available long enough for dormant devices to return.

**Worker ownership:** There are two coordination layers: a SharedWorker owns the partial engine; a dedicated worker owns SQLite/OPFS via BroadcastChannel and Web Locks. The dedicated worker has a documented OPFS sync-access-handle constraint. Do not assume putting SQLite in the SharedWorker is supported. First make authority over the lifecycle explicit and shared by attach/close/convert/recovery. Collapsing the engine and storage into a dedicated elected owner could be explored, but failover and owner-tab lifetime need validation; the evidence does not justify an immediate worker rewrite.

**Convergence:** Partial replicas necessarily need a durable pending-work journal, idempotent upload acceptance, conflict resolution, and acknowledgment handling. The current-authority acceptance correction is the right kind of simplification: encode correctness in one acceptance transaction rather than chase head movement with repeated restarts. Removing legacy APIs will not eliminate those distributed-system obligations.

Recommended order: fix and regression-test the transport composition/error-cause bug; establish one admission/transport contract; move migration out of steady-state opening; define the revocable-read boundary; then measure whether worker consolidation is worth it. Require realistic multi-port token-rotation, concurrent-write opening, and saved-pending-edit migration tests alongside isolated unit tests.

## Historical reproduction relocation

During architectural implementation, the four original reproduction source/config files were moved byte-for-byte to `/root/repos/lixray-identity-investigation/evidence/legacy-reproduction/`. They document the pinned pre-fix ABI and intentionally assert its failure, so they no longer belong in current test discovery. The commands and paths above describe the original investigation baseline. Fixed-behavior regression coverage is now `packages/js-sdk/src/worker/shared-admission.browser.test.ts`, with `admission-regression.browser.config.ts`; transport and admission unit tests cover the new contract.
