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

The SDK and reference server use Lix main revision
`1060e19baa0ef478c8c1ac7e57c9e37823dbcc0c`, merged through
[Lix PR #1757](https://github.com/opral/lix/pull/1757). Upgrade both together.
Server protocol is 8 and sync protocol is 11. Browser conversion is separate from
any authoritative repository migration; never reset server storage for an upgrade.

Controlled local profiling of this integration used three fresh small replicas
and three with 320 MiB of unrelated content (335,547,662 physical blob bytes).
The native authority, release WASM, SDK and app source were held fixed throughout.

| Median measurement                      |       Small |     320 MiB |
| --------------------------------------- | ----------: | ----------: |
| SDK opening                             |      283 ms |      287 ms |
| Session ready, including navigation SQL |      467 ms |      469 ms |
| Opening requests / response body bytes  | 2 / 2,327 B | 2 / 2,321 B |
| Warm offline read                       |      4.9 ms |      5.3 ms |
| Warm offline write                      |      8.6 ms |     9.75 ms |
| Offline reopen session ready            |      241 ms |      252 ms |

All 180 offline writes and 360 reads passed, with no native-input requests and no
successful offline network responses. Background upload attempts and reopen
authentication attempts were blocked; they were not absent. First offline writes
took 42/47 ms. The first measured SELECT took 64/116 ms, and one 693 ms small-opening
outlier remains in the results. These are local measurements after module import:
they exclude application/SDK/WASM downloads, HTTP headers, full UI rendering,
production network latency and server startup. They demonstrate bounded opening
for an unchanged working set while unrelated repository content grows; broader
queries and new write dependencies can require more hydration.

Pending edits and checkpoint dependencies upload in bounded waves. A single
native commit or minimal checkpoint publication closure over the 1 MiB JSON
request budget remains pending until multipart preparation is supported. Binary
file content uses a separate blob uploader and does not count toward that limit.

## Optional history totals

The Home sidebar keeps its working-change summary on the local partial replica,
including pending edits. Repository-wide `lix_commit` checkpoint totals and
`lix_change` daily totals require an authoritative inventory that the partial
replica does not provide. Those two optional queries treat the SDK's exact
`LIX_PARTIAL_REPLICA_SCOPE_UNSUPPORTED` result as unavailable: counts remain
unknown, inventory graphs are omitted, and the sidebar says complete history
totals are unavailable. Available working changes and their review action remain
visible. Other query failures continue to be reported. The app does not replace
these totals with server-only counts that would omit pending local commits.
