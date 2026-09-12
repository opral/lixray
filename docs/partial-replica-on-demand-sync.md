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
`852c1151f9fad27b640570c18a2caebbc5e41d55`, including
[Lix PR #1758](https://github.com/opral/lix/pull/1758),
[Lix PR #1759](https://github.com/opral/lix/pull/1759),
[Lix PR #1761](https://github.com/opral/lix/pull/1761),
[Lix PR #1763](https://github.com/opral/lix/pull/1763), and
[Lix PR #1767](https://github.com/opral/lix/pull/1767). Upgrade both together.
Server protocol is 8 and sync protocol is 13. Browser conversion is separate from
any authoritative repository migration; never reset server storage for an upgrade.

The original opening profile at Lix `7b2b4402e` used three fresh small replicas
and three with 320 MiB of unrelated content (335,547,662 physical blob bytes).
The native authority, release WASM, SDK and app source were held fixed throughout.

| Median measurement                      |       Small |     320 MiB |
| --------------------------------------- | ----------: | ----------: |
| SDK opening                             |    285.1 ms |    290.9 ms |
| Session ready, including navigation SQL |    470.2 ms |    465.4 ms |
| Opening requests / response body bytes  | 2 / 2,318 B | 2 / 2,325 B |
| Warm offline read                       |      5.9 ms |      6.3 ms |
| Warm offline write                      |      9.0 ms |     10.1 ms |
| Offline reopen session ready            |    248.8 ms |    252.4 ms |

All 180 offline writes, 360 reads, and six reopens passed with no native-input
requests or successful offline network responses. Background upload and reopen
admission attempts were blocked, not absent. First offline writes took 42.5/42.1
ms; first data SELECTs took 63.6/106.0 ms. Both arms had a slow first opening
sample of approximately 480 ms; all samples remain in the report.

These are local key/value measurements after module import. They exclude
application/SDK/WASM downloads, HTTP headers, full UI rendering, production
network latency and server startup. They show bounded opening transfers for an
unchanged working set as unrelated content grows, not constant cost for every
query or write dependency.

A separate 96 KiB opaque-file test passed both acceptance orders with 16 rows,
16,000 rows, and 320 MiB unrelated content. SELECT-only prefetch supported first
offline writes with zero hydration attempts, and both replicas converged after
reconnection. Cold file preparation measured approximately 0.40/0.59/3.07 seconds
across those dimensions; it is not constant-cost. The parsed-file browser profile
reached the unsupported plugin-runtime boundary described above and is not
reported as passing.

Pending edits and checkpoint dependencies upload in bounded waves. A single
native commit or minimal checkpoint publication closure over the 1 MiB JSON
request budget remains pending until multipart preparation is supported. Small binary file content can travel inline with publication; larger content
uses manifest/chunk upload. The combined request is bounded separately from the
frozen native commit batch.

## Edit propagation latency

Markdown persistence uses a 20 ms coalescing window from the first edit. Further
typing does not reset its deadline. Saves remain serialized; an in-flight save
drains the latest pending snapshot. The window bounds scheduling, not storage
completion. Ten isolated edits per setting with native Memory storage measured
median editor-change-to-save completion of 509.7 ms with a 500 ms window and
27.2 ms with the new default. Separate tests cover continuous typing.

Partial sync batches up to 32 selected missing metadata records through the
existing endpoint and groups local residency checks. A local two-replica profile
reduced first-update metadata requests from 16 to 4. First 96 KiB file updates in
each direction changed from 990/1,038 ms to 640/624 ms on loopback, and from
1,695/1,731 ms to 1,000/980 ms with 25 ms added before each request.

Those timings start before SQL UPDATE and end when a peer SELECT observes the
exact new bytes. They exclude editor scheduling and full UI rendering, use a
native Memory authority, and include 10 ms SELECT polling. The added request
delay is a sensitivity experiment, not a full network emulator. Thirty baseline
and thirty candidate edits passed; an additional 40-edit ABBA confirmation found
warm medians of 223.3 ms before and 231.7 ms after, with unchanged warm metadata
and range request counts. No warm speedup or sub-200 ms networked convergence is
claimed for that first batching change.

The transport combines small-file publication and complete working-set
updates. Files up to 256 KiB can use one push within a 1 MiB combined request
budget. The waiting peer receives a leased descriptor and up to 1 MiB of native
inputs for its retained SQL read interests. It validates and installs missing
inputs, then uses the existing local candidate publication. Larger working sets
retain on-demand hydration. Opening remains bounded metadata only.

Acknowledged local commits retain their valid resident physical representation.
Unchanged updates re-arm the authority long poll immediately, using the last
processed cursor to avoid sending the same working set again. An explicit
upload-size rejection falls back to the existing chunk transfer; ambiguous
publication failures retain the original durable attempt. Authoritative row and
plugin merging use the same machinery as before.

A follow-up profile against Lix main `94db8faef` measured 30 alternating SQL
updates across two independent Chromium OPFS replicas. All updates converged.
Warm medians exclude only the first edit from each replica:

| Workload | Before combined delivery | Combined delivery |
| --- | ---: | ---: |
| 1 KiB loopback | 220.8 ms | 151.0 ms |
| 96 KiB loopback | 237.0 ms | 168.6 ms |
| 96 KiB +25 ms/request | 487.9 ms | 187.8 ms |

Each update used one push and all warm updates needed zero additional native
hydration requests. Warm local SQL writes took 18.8–23.1 ms median. The previous
one-second reconciliation stalls disappeared after clearing stale backoff on
successful upload progress. Outliers up to 393.7 ms remain included; eight warm
samples per workload do not establish a tail-latency guarantee. These SDK
measurements exclude editor scheduling and rendering and use the same disposable
Memory-authority setup and request-delay limitations described above.

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
