# Partial replica with on-demand sync

Lixray’s repository browser uses OPFS with explicit `server.mode: "partial_replica"`.
Opening fetches bounded metadata. Ordinary SQL hydrates missing native inputs and
retains them locally; resident reads and supported writes need no foreground
network round trip. Background sync updates retained scopes and uploads edits.
Prefetch means executing the expected SELECT on hover. There is no `lix.prepare()`
or replacement prefetch API. A later write can require additional inputs.

The SDK server mode defaults to `remote`; it does not infer replication from
storage. `partial_replica` requires storage. SSR, MCP, diagnostics, and anonymous
links that authorize only one published path use remote SQL. Path-only links
must not receive native chunks, which can contain unrelated repository content.
Public access to an entire repository can hydrate a read-only partial replica.

The browser preserves its current per-account, per-repository replica identity and
OPFS name. A supported old complete replica converts in place only after the
failed open releases ownership. Conversion failures preserve data and surface an
error; they never reset the cache or change its name to bypass pending edits.
The canonical default branch comes from tracked, fileless GLOBAL SQL. Pending
initial switches keep the cached branch available. Retrying a create-and-switch
uses its already-created branch ID within that session.

Tabs opening the same browser replica share one SDK engine through a SharedWorker,
with separate SQL sessions. Closing one tab leaves the other tabs connected to
the same resident data and pending edits. This browser path requires SharedWorker,
Web Locks, and OPFS support.

Independent browser replicas reconcile valid concurrent row edits in the same
native merge pipeline as branch merges. Registered schema/plugin merge hooks
run for their rows; the default for overlapping values is last write wins in
server acceptance order. Files parsed by plugins are serialized from the merged
rows. Opaque file content is atomic. Once background acknowledgment and updates
settle, each replica and its editors show the authoritative result. Retrying a
lost acknowledgment preserves the original acceptance order, and newer local
edits remain pending. No foreground server round trip is required for resident
reads and writes.

The native engine can prepare a plugin-managed file's parsed rows and executable
through a content SELECT when its host supplies a plugin runtime. The current
browser SDK does not execute installed WASM file plugins locally. Such files can
be read, but local edits requiring their parser or serializer remain unsupported;
server/native plugin row merging uses the shared pipeline. This is distinct from
opaque file editing, which the browser supports locally.

The first SQL read can also prepare registered schema metadata needed to open
later local write transactions, without loading rows from those schemas.
Repository opening does not perform this preparation. Prefetch through ordinary
SQL; no separate preparation API is required.

Cold file creation or rename can require namespace metadata for path validation.
That preparation can grow with file count; content-only edits to an already
loaded file do not need this namespace scan. This does not add repository-wide
work to opening.

The SDK and reference server use Lix main revision
`8d2ffc51c303c844b2b6f15e13968e057c0a6997`, merged through
[Lix PR #1758](https://github.com/opral/lix/pull/1758) and
[Lix PR #1759](https://github.com/opral/lix/pull/1759). Upgrade both together.
Server protocol is 8 and sync protocol is 12. Browser conversion is separate from
any authoritative repository migration; never reset server storage for an upgrade.

Controlled local profiling of this integration used three fresh small replicas
and three with 320 MiB of unrelated content (335,547,662 physical blob bytes).
The native authority, release WASM, SDK and app source were held fixed throughout.

| Median measurement                      |       Small |     320 MiB |
| --------------------------------------- | ----------: | ----------: |
| SDK opening                             |    271.5 ms |    283.1 ms |
| Session ready, including navigation SQL |    449.2 ms |    469.4 ms |
| Opening requests / response body bytes  | 2 / 2,320 B | 2 / 2,326 B |
| Warm offline read                       |      6.0 ms |      6.1 ms |
| Warm offline write                      |      8.6 ms |     9.8 ms |
| Offline reopen session ready            |    252.1 ms |    266.9 ms |

All 180 offline writes, 360 reads, and six reopens passed with no native-input
requests or successful offline network responses. Background upload and reopen
admission attempts were blocked, not absent. First offline writes took 38.9/42.2
ms; first data SELECTs took 67.3/102.3 ms. The large arm had a slow third opening
sample of 485 ms; all samples remain in the report.

These are local key/value measurements after module import. They exclude
application/SDK/WASM downloads, HTTP headers, full UI rendering, production
network latency and server startup. They show bounded opening transfers for an
unchanged working set as unrelated content grows, not constant cost for every
query or write dependency.

A separate 96 KiB opaque-file test passed both acceptance orders with 16 rows,
16,000 rows, and 320 MiB unrelated content. SELECT-only prefetch supported first
offline writes with zero hydration attempts, and both replicas converged after
reconnection. Cold file preparation measured approximately 0.37/0.59/3.09 seconds
across those dimensions; it is not constant-cost. The parsed-file browser profile
reached the unsupported plugin-runtime boundary described above and is not
reported as passing.

Pending edits and checkpoint dependencies upload in bounded waves. A single
native commit or minimal checkpoint publication closure over the 1 MiB JSON
request budget remains pending until multipart preparation is supported. Binary
file content uses a separate blob uploader and does not count toward that limit.

## Optional history totals

Directory change badges begin after the tree loads and the existing idle gate
opens. Their background diff still covers changed descendants and can load
repository-wide changed-file metadata; the opening measurements above do not
include that background work.

The Home sidebar keeps its working-change summary on the local partial replica,
including pending edits. Repository-wide `lix_commit` checkpoint totals and
`lix_change` daily totals require an authoritative inventory that the partial
replica does not provide. Those two optional queries treat the SDK's exact
`LIX_PARTIAL_REPLICA_SCOPE_UNSUPPORTED` result as unavailable: counts remain
unknown, inventory graphs are omitted, and the sidebar says complete history
totals are unavailable. Available working changes and their review action remain
visible. Other query failures continue to be reported. The app does not replace
these totals with server-only counts that would omit pending local commits.
