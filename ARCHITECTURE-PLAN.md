# Architectural resolution plan

Revision 2 — September 14, 2026. APPROVED for implementation by all three reviewers: transport/admission, storage/migration, and architecture.

Resolve the architectural causes of repeated opening failures: inconsistent transport contracts, overlapping lifecycle ownership, read-lifetime assumptions, and migration inside ordinary opening. Backward compatibility is explicitly out of scope. Change APIs, storage formats, and protocol versions together; migrate all hosted repositories. Preserve pending local work when migrating browser repositories.

## 1. Final runtime design

### Explicit transport and admission

Use one internal request contract across remote, sync, and admission operations. A request explicitly selects `buffered(maxBytes)` or `streaming`; ordinary public `fetch` remains an adapter at the actual network boundary. Remove hidden `lixResponseLimit` / `lixResponseStream` conventions between independently implemented clients. Define request cancellation, bounded buffering, streaming/backpressure and owner disposal in the contract.

Replace the remote-SQL-session identity probe with an authenticated metadata operation returning stable repository ID, principal ID, and protocol/storage epoch. It must not open an engine, create a SQL session, start synchronization, or initiate migration. Authorization comes from server authentication/catalog policy, never a caller-supplied account ID or unchecked decoded token.

Capture credentials once for admission; bind the resulting proof and outgoing requests to that exact credential snapshot. Updating the credential provider creates a candidate transport lease that must be verified before use. Do not authenticate A and then send B. Custom fetch cannot invisibly substitute identity outside this contract; credential sourcing must be explicit.

Offline rules are explicit:

- Existing admitted sessions keep local access and pending work when refreshed credentials cannot be verified. Suspend that client's remote transport lease; never install unverified credentials.
- New ports with unseen credentials fail clearly with identity-unverified-offline. Do not infer identity from a claimed account ID.
- A same-worker, previously verified exact-credential proof may permit cached local attachment on actual network unavailability. Bind proof to authority, repository, principal and epoch; keep it in memory. No new persistent cross-worker proof system in this scope.
- HTTP authentication rejection never authorizes a new attachment through fallback. An existing session's failed remote authorization suspends synchronization without deleting local work. A different principal cannot join the owner.

Classify contract, actual network, HTTP authentication, protocol/version, abort, and worker-loss errors separately. A generic TypeError is not proof of a network outage. Preserve bounded, redacted structured causes through worker RPC and telemetry; never include authorization headers. Retry transport operations only with their original immutable operation identity.

### One lifecycle coordinator

Retain the SharedWorker engine plus dedicated OPFS storage worker topology. The dedicated worker is required by the existing SQLite OPFS sync-access-handle arrangement. Consolidate lifecycle authority, not worker count.

| State | Allowed work and exit condition |
|---|---|
| Closed | No root engine or active sessions. Inspect current-format header; route legacy storage to separate migration before opening. |
| Opening | One serialized owner acquires actual storage ownership, validates epoch and principal, initializes current-format engine. Other attach requests await it. Failure releases acquired resources. |
| Ready | Independently scoped port sessions use one root engine. Credential leases are replaceable independently of local sessions. Background work belongs to this owner. |
| Closing | Stop new attachments, settle/cancel in-flight operations according to completion status, close child/root/storage resources. Do not create a competing owner after failed close. |
| Migration-exclusive | Separate migrator owns the physical storage fence; no ordinary root, sessions, or sync may operate against the source. Publish validated destination before returning to current-format opening. |

Owner identity includes repository, principal, physical store and epoch. Port identities and request IDs remain scoped. Losing a tab/transport selects another verified live lease where available; losing physical storage ownership invalidates stale handles. Conversion, recovery, close and attach use the same authority over physical ownership. Never hold a lifecycle lock while recursively asking the same lifecycle to open.

### Complete coherent read operations

The existing three-second expired-read retry helper stays; adding another helper is not the solution. Introduce an engine-owned coherent-read executor that owns the complete attempt, its read handles, attempt-local caches and buffered results. Expiry discards all attempt-local state and restarts the whole side-effect-free unit. No result is exposed as successful before the coherent attempt completes.

Network hydration and mutations are explicit phases outside replayable read units. Read-interest registration or plugin work that has side effects cannot be silently replayed. Executed SQL, accepted commits, streamed/emitted results and unknown commit outcomes never enter generic retry. Streaming must either use a stable snapshot or complete a coherent materialization before exposing results; it cannot restart after yielding an inconsistent prefix.

Keep owner-epoch fencing and invalidation. Define deadlines and result/resource limits for each operation class; exhaustion is a structured progress/resource error, not raw adapter expiry or infinite retries.

A mandatory prototype gate settles progress before migration implementation: run actual OPFS reads/opening under uninterrupted background writes, measuring completion time, retry count, memory, and writer delay. Initial mechanism is whole-unit optimistic retry. If it fails the declared latency/progress budget, implement and qualify a bounded owner-protected read window or immutable snapshot mechanism in this phase. Do not ship failing progress behind another caller-specific retry. Protection must not hold across network hydration or unbounded plugin execution, and full-database copying is not the default. Record the selected mechanism and numeric budgets in an ADR before Phase 2 can pass. This is a bounded engineering decision gate, not permission to leave the read guarantee unresolved at rollout.

### Current authority acceptance and durable pending work

Retain acceptance against current authority state, durable immutable upload identities, and receipt-first deduplication. An accepted upload whose reply was lost cannot apply again as new work. Preserve later local edits during settlement. Keep necessary ancestry, selected-branch scope, mappings and blob dependencies for pending work.

Treat hydrated cache separately from the durable pending-work journal. Cache reconstruction never resets pending changes or acknowledgment identity. One current runtime storage/protocol contract supports this behavior; no old-format fallback or dual-version mode.

## 2. Migration design: hard cut with data preservation

Inventory every hosted authority, including inactive/catalog-backed repositories, with stable ID, role, format, integrity result, source location and migration status. Reconcile the inventory against catalog/storage records; investigate orphaned or inconsistent records rather than silently skip them. Authority migration is explicit and resumable under exclusive ownership. Existing `upgrade-authority` tooling is a starting point, not evidence that fleet migration is complete.

For each authority: quiesce writers, retain a recoverable backup, migrate to the target format, and verify repository identity, branch/history/content semantics and accepted-upload receipt identities. Mark completion only after validation. One failure keeps its inventory entry incomplete. Block opening unsupported roles/formats rather than automatically adopting/migrating them.

For each browser store: a small format router chooses ordinary current-format opening or a separate same-origin migration/recovery entry. The normal engine/bundle contains no historical readers. The isolated migrator acquires the actual existing physical-owner lock, stages a new store, preserves pending work and its dependency closure, validates semantic equivalence, then durably publishes the active-store pointer. Retain source until validated preservation and cleanup eligibility; unresolved dependencies stop with a recoverable source, never an automatic destructive reset. Crash and quota failures at every transition must be resumable.

Fencing old tabs requires mechanisms old code cannot evade accidentally:

- Reject obsolete network protocol/epoch before server mutations.
- Do not assume adding a new client-side epoch flag fences already-running old code.
- Acquire the existing storage-owner lock and wait for/release old owners before migration. If an old live tab owns it, migration cannot proceed until that owner closes; source remains intact.
- Publish the new replica in a distinct physical namespace so old code cannot write the destination by reopening its old known name. New runtime checks durable identity/epoch and holds the ownership fence.
- Old namespaces remain quarantined recovery sources. Their later writes cannot affect the new authority (old network protocol is rejected) or destination. Reinspect/reconcile a changed source before eventual cleanup; do not assume a one-time pointer switch stopped every stale tab from editing its old store.

Hosted repositories can all migrate during the cutover. OPFS on offline devices cannot: returning devices run the detached migrator before normal opening. Retain the versioned same-origin migration artifact for supported historical profiles; this is migration tooling, not compatibility in the runtime. Report server-fleet completion separately from observed browser migration coverage.

Rollback before target writes may restore validated backups under a write fence. After new-format writes are accepted, do not downgrade or restore a stale backup: recover forward or perform a separate data-preserving migration including those writes.

## 3. Implementation and delivery sequence

1. **Freeze contracts and reproduce.** Document transport, admission/offline policy, lifecycle transitions, operation completion and read guarantees. Convert the isolated reproduction into real SDK/WASM/SharedWorker/OPFS/authority regression coverage. Declare workloads and numeric latency/resource budgets before measuring.
2. **Build current-format runtime.** Implement typed transport and lightweight admission, lifecycle coordinator, and coherent read executor. Complete the mandatory read-progress prototype/ADR. Preserve convergence/receipt invariants. No migration rollout until the real-browser and sustained-concurrency gates pass.
3. **Build detached migration and inventory tooling.** Implement exhaustive authority inventory, resumable validators/converters, same-origin browser migration, physical fencing and namespace isolation. Remove legacy migration from normal opening; keep only explicit format routing outside the runtime.
4. **Qualify migration and cutover.** Use representative copies of every inventoried source format, including pending writes/accepted-but-unacknowledged uploads. Inject crashes, lost responses, quota errors, owner loss and stale-tab races. Verify semantic preservation, convergence, and rollback/forward-recovery procedures.
5. **Migrate and activate.** Quiesce hosted writes, back up/migrate/verify every inventory entry, deploy matching current SDK/server/protocol, reject old protocol before mutations, and activate returning-device migration routing. No request-triggered authority migration. Track incomplete browser sources explicitly.
6. **Prove simplification and completion.** Delete obsolete runtime readers/adoption/conversion branches, SQL identity probing, hidden transport extensions, superseded credential workarounds and ad hoc read retries. Retain migration artifacts outside normal runtime and correctness machinery for pending work. Record deleted paths, fleet status, observed latency, convergence and failure diagnostics.

## 4. Acceptance gates

- Actual browser composition: first opener, same token, refreshed same-account token making successful admission request, different account/authority rejection, malformed contract before network, genuine network failure, HTTP 401/403, cancellation, worker loss and owner-tab loss.
- Existing local work remains usable during refresh/network outage; new unknown credentials never acquire offline admission. No credential leakage in causes or telemetry.
- Concurrent background commits during opening/query preparation/branch admission meet declared progress bounds with coherent results; no raw read-expiry leakage, unbounded retry, or writer starvation. Streaming completion semantics are tested.
- Sustained independent two-replica edits converge against independent authority reads, including edits made during upload, lost acknowledgments and unknown commit outcomes. No duplicate application.
- Every historical source format found by inventory is migration-tested. Pending work, dependency closure and original upload/receipt identities are semantically equivalent, not merely equal row counts.
- Crash/quota failure at every migration transition leaves a recoverable source or destination. Active old/new tabs, old-owner reentry, storage worker death and protocol rejection cannot create competing writers to destination.
- Every hosted inventory entry is completed and verified. Dormant returning profiles migrate through detached tooling; browser coverage is reported honestly.
- Normal opening starts neither migration nor remote SQL admission. Runtime supports one target format/protocol. Old bundle/protocol cannot mutate new authority or destination storage.

## 5. Review record

The transport/admission, storage/migration and architecture agents independently inspected the code, exchanged findings, and required changes to the original proposal. Revision 2 incorporates their combined requirements. Each reviewer read the full revision and explicitly approved it without further required changes.

| Reviewer | Final vote | Review conclusion |
|---|---|---|
| `review_transport` | APPROVE revision 2 | No remaining transport/admission blockers; credential binding, offline semantics and error boundaries are concrete. |
| `review_storage` | APPROVE revision 2 | No required changes; coherent-read qualification, receipt/dependency preservation and dormant/stale-source handling resolve storage blockers. |
| `review_architecture` | APPROVE revision 2 | No further architectural changes required before implementation; lifecycle, read gate and real physical migration fences are explicit. |

The agents discussed the proposal with one another before final approval. Their requested amendments are incorporated in sections 1–4; no substantive design changes followed the votes.

Review approval is approval of this implementation plan. Production readiness requires the acceptance gates; no production changes have been made in this review task.
