# Browser working-set prototype

This experiment compares two ways to open and edit one UTF-8 text file against
the same Lix server:

- `partial`: browser Lix engine, OPFS storage, native partial synchronization.
- `working-set`: server SQL, an IndexedDB snapshot, and a durable edit outbox.

The prototype is isolated from the production repository route. It does not
implement the directory tree, Atelier plugins, arbitrary local SQL, production
authentication, or a production subscription protocol. Its opening result is
**text present and editable**, not the production application's full usability
metric. Browser HTML navigation while disconnected is outside this experiment.
Native offline editing has a separate readiness step: **Prepare offline editing**
fetches the bounded immutable write frontier while connected. Reading the file
alone does not establish this readiness. The profile records preparation time
separately from opening time; it does not issue a fake mutation to warm writes.

## Working-set contract

The server owns accepted history. The browser owns its pending edits until the
server acknowledges them. Loaded text opens and changes locally; publication is
an explicit asynchronous operation. In the prototype UI, use **Save locally** and
**Synchronize** to inspect these boundaries separately.

State is partitioned by account, public repository route, branch, and file. The
authority adapter opens a separate branch-pinned session and checks its actual
account identity. The caller must bind the Lix handle to the corresponding public
repository route; the embedded Lix ID can differ from that route's repository ID.

Each pending operation stores its own base text, base content digest, new text,
and stable operation ID. Clearing the snapshot does not clear pending work.
IndexedDB edits resolve after a transaction with strict durability completes.
Once an operation has been attempted, retries retain its exact ID and payload.
The server's idempotency receipt prevents a lost acknowledgment from creating a
second commit. A stale second-tab draft is rejected rather than overwriting a
newer local draft.

Publication uses a content compare-and-set. Concurrent different text produces
an explicit conflict and preserves the local edit until resolution. This narrow
contract allows content ABA and excludes rename, metadata, multi-file atomicity,
and rich-document merge semantics. It is not a general revision-token protocol.

Replacing a working-set snapshot requires no historical database migration.
The outbox is durable application data and must never be swept along with cache
replacement. Browser storage eviction, clearing site data, and crash/power-loss
guarantees are not established by ordinary reload tests. A production rollout
still needs an outbox version/recovery contract, refresh subscriptions,
authentication lifecycle handling, and integration with each editing surface.

## Reproduction

The experiment uses a disposable Lix authority on loopback port `18309`, backed
by an independent storage prefix. Its local internal token is
`lixray-local-internal-token`; the fixture account is
`00000000-0000-4000-8000-000000000031`. These are development fixture values.
The preview's loopback proxy supplies them to the server. The browser sends a
public fixture identity marker so native offline admission can scope its local
proof; it does not receive the server's internal token.
For an unoptimized native authority, set `RUST_MIN_STACK=16777216`, matching
the engine's test environment; its debug async SQL poll chains overflow the
default worker stack. The comparison must identify the debug/release profile.

From `web-app`, with the vendored SDK already built and the authority running:

```sh
pnpm exec vite build --config experiments/vite.config.ts
pnpm exec vite preview --config experiments/vite.config.ts
```

In another terminal:

```sh
node experiments/seed-architecture.mjs
node experiments/validate-architecture.mjs
PROTOTYPE_AUTHORITY_BUILD='sdk-source-head=<sha>;sdk-diff-sha256=<sha>;authority-binary-sha256=<sha>' \
	PROTOTYPE_SAMPLES=6 node experiments/profile-architecture.mjs
```

The full paired profile refuses to run without `PROTOTYPE_AUTHORITY_BUILD` so
the artifact identifies the SDK source revision and dirty diff plus the native
authority binary. A one-workload smoke run may omit it and is labeled
`smoke-unpinned`; do not use that artifact as revision-pinned evidence.

The seed command prints a prototype URL. The page exposes both architectures.
Each profile arm receives a fresh synthetic repository. The harness alternates
AB/BA order and varies file size, unrelated file count, and an 80 ms delay before
each protocol fetch. That delay is not a full network emulator.

Raw outputs go into ignored `web-app/.architecture/validation.json` and
`profile.json`. Cold-open measurements are retained even when the subsequent
offline scenario fails. Capability outcomes remain separate from latency
results. Response-byte counts cover Lix protocol responses, not HTML, JavaScript,
or WASM transfer. Navigation timing includes browser application startup.
During the offline window, the harness records native partial-replica
`POST /sync/push` attempts separately because the background publisher may wake and
fail against the disconnected transport. Any remote SQL `execute` or
`execute-batch` attempt during offline local work fails the capability check.

The browser validation suite covers the working-set path: clean reload, pending
edit plus snapshot reset/reload, lost acknowledgment, conflicting server edits,
and stale edits from a second tab. The profile separately tests loaded offline
reads, durable edits, reopen, and reconnect against both architectures.

## Evidence

`experiments/architecture-baseline24-smoke.json` preserves the initial one-sample
smoke run against protocol 24 with the WASM cache-loader fix. It establishes a
baseline offline-edit failure, not a statistically reliable speed comparison.
Full paired measurements and hardened-baseline results must be reported with
their actual SDK/server revisions and capability failures.

Production open-to-usable telemetry is a separate route trace: authentication,
access resolution, replica/engine opening, branch/session setup, Atelier, and
initial view rendering. The prototype records local spans and protocol attempts
for controlled comparison; it does not establish deployed PostHog coverage.
