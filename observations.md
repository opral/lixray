# Performance observations

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
