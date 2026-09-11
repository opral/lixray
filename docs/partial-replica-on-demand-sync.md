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

The SDK and reference server use Lix main revision
`48aec47b74b151dfb44c9b66259d280971014bce`, merged through
[Lix PR #1755](https://github.com/opral/lix/pull/1755). Upgrade both together.
Server protocol is 8 and sync protocol is 11. Browser conversion is separate from
any authoritative repository migration; never reset server storage for an upgrade.

Controlled profiling of this SDK revision in the earlier Lixray opener measured
median SDK opening of 293 ms for a small repository and 301 ms with 320 MiB of
content, using two requests and about 2.3 KB. Session readiness including navigation
SQL was 487/500 ms. All 18 runs supported offline edits and reopen without fetching
query inputs. These are historical local measurements of that opener, not a
measurement of this PR’s current-main UI or its Railway preview. Broad queries,
new write dependencies, server startup and production network latency remain
separate costs.

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
