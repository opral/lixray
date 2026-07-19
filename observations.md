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

This crosses browser and MCP clients, remote binding queues, branch switching,
server protocol, coherent-read execution, cancellation/retry, and observer
ordering semantics—well beyond a bounded local patch.

**Next measurement.** Trace request count and p50/p95 for three-to-five real
read workflows on a warm and switched branch, then compare a branch-stable
session or read-batch design while preserving observer and cancellation tests.

**Status:** observing; not changed by this PR.
