# Performance observations

## Workspace runtime can remain poisoned after an object-store failure — measured and recovered

**Evidence.** During replay, MinIO marked its `/data` drive offline after a
42.969-second write/read probe. A single workspace open then fanned out through
LixRay's shared `OnceCell`, blocking requests for 62–303 seconds. [LixRay
#83](https://github.com/opral/lixray/pull/83) bounds an individual S3 request
and its retry budget, so a failed cold open is removed from the `OnceCell` and
can be retried. A post-open SlateDB WAL write or flush failure is different: it
sets a terminal durability-failure state while the workspace manager retains
its already-successful runtime.

**Fault-injection baseline.** The real LixRay router now has a deterministic
post-open WAL-failure scenario: it holds the first SlateDB WAL PUT, starts one
write plus eight workspace protocol reads, then fails the PUT. With the legacy
retained runtime, the failed write returned after **305 ms**, all **8** queued
requests inherited the terminal storage error, no request reached **503**, and
no fresh open occurred until an explicit manager teardown. That teardown took
under 1 ms and the intentional fresh open took **26 ms**; the rejected row was
not durable (`0` rows after reopening).

**Implemented lifecycle.** LixRay monitors SlateDB's public storage boundary:
a failed commit or an observed `Durability` error marks the service terminal.
It then transitions a workspace from `Active` to `Recovering` exactly once.
The triggering request and all queued requests receive **503** while a reaper
waits for existing Lix service leases, calls `Lix::close`, and drops the old
service on a blocking task so SlateDB can join its manager thread. Only after
that drain finishes does the manager remove the entry and permit a fresh shared
open. Warm reruns of the same fault injection reach 503 in **86–93 ms** (about
**70%** faster than the 305 ms legacy failure response), return 503 to all
**8** queued requests, drain and reopen in **6–8 ms** after the final old lease,
share one fresh runtime, and still expose `0` rejected rows.

**Correctness constraint.** Do not simply clear the `OnceCell` or open a
second service. A failed commit continues holding Lix's visibility lock and
SlateDB's sole-writer permit until its durable outcome is known, and dropping
SlateDB joins its manager thread. Recovery must drain the old service before
reopening, otherwise it can create concurrent writers or expose a write whose
durability has failed.

**Remaining cross-cutting work.** Recovery deliberately has no forced close
deadline: while SlateDB drains or joins its manager thread, the workspace stays
at 503 rather than risking a second writer. Production should add lifecycle
metrics/alerts for prolonged recovery and validate the same single-writer
boundary across multiple LixRay instances before introducing horizontal
failover.

**Status:** #83 bounds cold-open request time; terminal post-open recovery is
now covered by a real router/object-store fault injection and drains before a
fresh runtime opens.

## Staged filesystem writes rebuild the complete path index — observing

**Evidence.** Committed-state readers share a revision-keyed
`FilesystemPathIndexCache`. Transaction readers can use that cache only before
they stage a filesystem descriptor. Once
`has_staged_filesystem_descriptors()` becomes true, every subsequent
`filesystem_path_index()` request scans the transaction's complete visible file
and directory descriptor state and rebuilds `FilesystemPathIndex` from scratch.
Repeated path-based statements in one transaction therefore turn workspace
size into repeated write latency. Lix #637 removes an unnecessary topology
resolver for payload/metadata-only updates, but required path-conflict and
resolver lookups still cannot reuse an index after staged topology changes.

**Architectural direction.** Give each transaction a path-index view keyed by
branch scope and staged-write generation. Start from the immutable committed
index, then maintain an overlay of staged descriptor inserts, updates, and
deletes—or incrementally update a transaction-owned index—so later statements
preserve read-your-writes without rescanning the complete workspace.

**Correctness constraint.** The overlay must preserve branch/global/untracked
lanes, path uniqueness, statement failure and transaction rollback semantics,
and directory reachability. Directory moves and deletes change derived paths
for whole subtrees, so overlaying only the directly written path would leave
stale descendants and is not safe.

This crosses transaction staging/generation tracking, file and directory DML,
path derivation, conflict handling, rollback behavior, and cache accounting in
Lix—well beyond a bounded provider patch.

**Next measurement.** Count full path-index builds and descriptor rows scanned
for repeated path upserts/moves in one transaction at 1k, 10k, and 100k files;
then compare an overlay prototype for latency, memory, and rollback cost.

**Status:** observing; no transaction-local overlay implemented.

## Workspace session requests repeatedly select the active branch — observing

**Evidence.** Browser calls queue through `useLixrayApi`, probe
`activeBranchId()` before each execution, and then execute. MCP calls queue per
workspace session and select the branch before each execution. The remote Lix
binding serializes those operations again. As a result, independent reads in a
single workspace do not overlap: a network-bound multi-query workflow pays a
branch/session protocol round trip and an execution round trip for each read.

The 2,500-file local Docker fixture measured a two-read browser-shaped sequence
at 8.336 ms p50 versus 4.786 ms for one equivalent read. A coherent read/session
protocol that eliminates repeated branch selection can plausibly exceed 50% for
three-or-more network-bound reads, but needs end-to-end measurement before any
design is chosen.

The ZIP workflow provides a concrete large fan-out instance: its former
four-worker fetch pool still queued each read through `useLixrayApi`, so 2,500
file-data requests did not overlap. It measured 8.315 s p50 as serialized point
reads versus 0.618 s for 50-path reads; the bounded batching patch addresses
that caller only, not the shared-session behavior for other read workflows.

**Constraint discovered.** A per-client active-branch cache is not a safe
bounded fix. Lix resolves `lix_workspace_branch_id` from shared untracked global
state and `switch_branch` writes that same selector; LixRay explicitly tests
that the active branch is shared and persists across remote clients. Another
client can switch after a cached client's last check, so skipping its next
switch can execute a requested branch against the wrong branch. A tempting
current-stack `read_file` sequence measured 9.656→6.641 ms p50 (−31.2%) and
11.288→7.716 ms p95, but is rejected for correctness. A safe >50% solution
needs branch-scoped execute/session semantics and crosses Lix session storage,
server protocol, browser/MCP clients, observer/retry/cancellation behavior, and
runtime tests.

This crosses browser and MCP clients, remote binding queues, branch switching,
server protocol, coherent-read execution, cancellation/retry, and observer
ordering semantics—well beyond a bounded local patch.

**Next measurement.** Trace request count and p50/p95 for three-to-five real
read workflows on a warm and switched branch, then compare a branch-stable
session or read-batch design while preserving observer and cancellation tests.

**Status:** observing; not changed by this PR.

## Checkpoint diff materializes every file snapshot — observing

**Evidence.** Atelier's `loadFileSnapshotsAtCommit()` in
`src/shell/checkpoint-diff.ts` intentionally runs
`lix_file_history` with only `lixcol_start_commit_id`, then chooses the
shallowest historical row for each file in JavaScript. At a 2,500-file commit,
the query therefore asks for every file snapshot; the bounded exact-ID history
pushdown cannot safely narrow this result.

**Architectural direction.** A likely >50% solution is a maintained
commit-level file-set/diff surface with explicit rebuild and invalidation rules,
not a broader point-lookup filter. It crosses the history provider, storage and
index lifecycle, engine correctness tests, SDK/Atelier query migration, and
end-to-end benchmarks—well beyond a bounded patch.

**Next measurement.** Benchmark the full checkpoint query at 2,500, 10k, and
100k files before choosing snapshot materialization versus a dedicated diff
surface.

**Status:** observing; no bounded code change proposed.

## Root substring path search remains an O(files) scan — observing

**Evidence.** Root `find_files` emits `LOWER(path) LIKE '%q%' ORDER BY path`.
`EXPLAIN` shows a `Sort` over `TableScan: lix_file` with the `lower(path) LIKE`
filter and a physical `SortExec → SpecScanExec(lix_file)`: there is no path
range or indexable prefix, so every file path must be examined for a root
substring search.

A bounded Lix fast path in [Lix #625](https://github.com/opral/lix/pull/625)
uses the existing cached descriptor index to avoid hydrating blob-reference rows
for simple lowercase ASCII literal searches. On the 2,500-file Docker fixture,
the real MCP projection fell from 31.57 ms to 5.07 ms p50 for a root hit. It
deliberately remains an O(files) descriptor scan and adds no persistent storage;
it is not a substitute for an index that can make root substring search
sublinear at much larger workspace sizes.

An FTS or trigram index might help at large workspace sizes, but it crosses
Lix's schema and write-maintenance path, stored-index space/lifecycle, path
case and substring/token semantics, branch/version behavior, and MCP/client
contracts. No workload threshold or actual speedup has been measured yet.

**Next measurement.** Measure p50/p95 and `EXPLAIN` for representative root
searches at 10k and 100k files before choosing a path-search index design.

**Status:** observing; the bounded blob-hydration avoidance merged in
[Lix #625](https://github.com/opral/lix/pull/625), while a persistent
root-substring index remains out of scope.
