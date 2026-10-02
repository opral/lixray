# Repository opening profile

The browser records one `lixray.repository.open` trace per route attempt, ending when the initial view has committed and passed two animation frames. Initial document opens start at `performance.timeOrigin`; client navigations and retries start at their own start time. Background synchronization is not part of the readiness boundary. The gateway projects the bounded profile into PostHog's `repository_open_performance` event and preserves trace/span correlation. This extends [the telemetry catalog](./telemetry-catalog.md); [issue #554](https://github.com/opral/lixray/issues/554) records the original measurement gap.

Profiling observes work the application already performs. It makes no additional requests, storage probes or repository-size queries. There is no storage prompt or new user flow.

## Lifecycle facts

`profile_version=1` identifies the new measurement contract. Older events lacking these fields must be kept separate rather than inferred from latency.

| Property | Meaning |
| --- | --- |
| `replica_state=fresh` | The SDK reports `initialized=true`: this open initialized local engine/partial-replica state. |
| `replica_state=cached` | The SDK reports existing state, `initialized=false`. This can include attachment to an existing shared engine; it does not prove a physical disk read. |
| `replica_state=joined_open` | The application joined an already-pending session creation. |
| `replica_state=reused_session` | The application reused an already-open managed session. |
| `replica_state=remote` | The repository uses the remote-only path. |
| `replica_state=unknown` | No completed native report or session acquisition established the state, including an early failed open. |
| `session_acquisition` | `created`, `joined`, or `reused`, measured by the session manager. The creator takes precedence if the same route acquires additional handles. |
| `initialized_this_open` | The actual SDK initialization boolean for a completed partial-replica open. |
| `replica_mode` | `partial_replica` or `remote`. |
| `storage_format`, `local_migration_count`, `authority_migration_count` | Actual completed native open-report facts. |

An existing localStorage replica identifier is not evidence that a physical replica exists. Lifecycle classification uses the native open report and actual session-manager state instead. Existing shared attachments omit historical SDK startup profiles; they never charge another handle's initial WASM/provider work to this opening.

## Bottleneck measurements

The serial phases remain `bootstrap`, `auth`, `access`, `replica`, `engine`, `branch`, `session`, `atelier`, `initial_view`, and `paint`, exposed as `<phase>_ms`. `longest_phase`/`longest_phase_ms` identify the largest of these serial phases. `terminal_phase` and `outcome` locate failures, cancellations, superseded attempts and timeouts as well as successful opens.

Native progress emits local/authority inspecting, migrating, validating and opening child spans, plus `native_<scope>_<phase>_ms` totals. Repeated notifications in one phase do not restart its timer. A retry or replacement closes the current native step before its wait. `engine_attempts`, `retry_count`, `retry_backoff_scheduled_ms` and `replacement_count` distinguish active work from recovery overhead. Scheduled backoff is the configured delay, not a claim about precise elapsed timer wakeup time.

`rpc_count`, `rpc_failed` and `rpc_response_headers_pending` count actual opening requests, including credential-refresh retries. `rpc_response_headers_total_ms` and `rpc_response_headers_max_ms` measure fetch start to response headers or rejection. The total can overlap across concurrent requests; it is not the critical path or body-transfer duration. Existing `lix.client.rpc` spans cover body consumption and correlate with server work. Completion after the route has ended cannot mutate that route's finished profile.

Successful native browser reports add `host_version=1` and:

- `host_wasm_wait_ms`, `host_wasm_realm_reused`, `host_wasm_source`, `host_wasm_cache_status`: the actual current initialization wait and cache branch. Sources are `bundled`, `cache`, `network`, or `realm`; statuses are `hit`, `miss`, `corrupt`, `unavailable`, or `not_consulted`. Reusing an initialized/in-progress realm records only the current wait and never copies old fetch/compile durations.
- Optional `host_wasm_fetch_ms`, `host_wasm_compile_ms`, `host_wasm_initialize_ms`: work performed by this initialization. Fetch ends at response headers; compilation can include consuming the remaining response body.
- `host_component_compiler_import_ms`, `host_component_compiler_initialize_ms`: the existing parallel component-compiler import and initialization.
- Optional `host_provider_module_import_ms`, `host_provider_create_ms`, `host_provider_open_ms`: provider startup.
- Optional `host_provider_opfs_lock_wait_ms`, `host_provider_opfs_sqlite_init_ms`, `host_provider_opfs_pool_open_ms`, `host_provider_opfs_schema_init_ms`: actual OPFS startup boundaries.
- `host_native_binding_open_ms`: the native binding open call, including work it awaits.

Host timing is wall time, not worker CPU time. Imports run concurrently; physical provider opening can be inside provider creation, and native binding opening can include remote work. These measurements must not be summed as exclusive costs. Failed opens before the SDK returns a report may have native child/request spans and `terminal_phase` but no host report.

## Passive browser context

`profile_` event properties are a fixed allowlist; the OTLP attribute prefix is `lixray.repository.open.profile.`. They include:

- Navigation DNS, connection, TLS, TTFB and document transfer/encoded/decoded bytes, only for an initial document open. Client navigations and retries do not inherit document startup costs.
- Opening-interval resource counts, overlapping duration totals and transfer bytes for `wasm`, `first_party_js`, `api`, `lix`, and `other`. Resource URLs and query strings are discarded during observation.
- Main-thread long-task count, clipped total duration and maximum overlap with the opening interval. Worker/WASM CPU time is not represented by these entries.
- Bounded browser family/major version, plus coarse hardware-concurrency, device-memory and effective-network-type buckets when the browser exposes them. Raw user-agent strings are not emitted.
- Explicit navigation/resource/long-task capability flags, interval validity and resource/long-task truncation flags.

Resource entries are observed in the document realm when they complete; worker-owned loader requests, unfinished requests and unavailable/cross-origin entries may not be represented. SDK host timings supply the worker startup waits. Telemetry uploads are excluded to avoid measuring the profiler itself. Transfer bytes are browser-reported (zero can mean cache or restricted visibility); they are not remote repository size. The observer retains at most 1,000 entries per type, disconnects when the attempt ends, and cannot block opening on unsupported APIs or malformed entries. Missing measurements mean unavailable, not zero. Main-thread long-task support differs by browser.

## Queries for optimization

Use completed `profile_version=1` events, group by release, lifecycle state and entry, and keep foreground latency separate from background opens. Sample counts and failure rates matter alongside successful p50/p95.

```sql
SELECT
    properties.client_release AS release,
    properties.replica_state AS replica_state,
    properties.entry AS entry,
    count() AS samples,
    quantile(0.5)(toFloat(properties.duration_ms)) AS p50_ms,
    quantile(0.95)(toFloat(properties.duration_ms)) AS p95_ms
FROM events
WHERE event = 'repository_open_performance'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND properties.profile_version = 1
  AND properties.outcome = 'usable'
  AND properties.visibility = 'foreground'
GROUP BY release, replica_state, entry
ORDER BY samples DESC
```

```sql
SELECT
    properties.client_release AS release,
    properties.replica_state AS replica_state,
    properties.outcome AS outcome,
    properties.terminal_phase AS terminal_phase,
    properties.longest_phase AS longest_phase,
    count() AS samples
FROM events
WHERE event = 'repository_open_performance'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND properties.profile_version = 1
GROUP BY release, replica_state, outcome, terminal_phase, longest_phase
ORDER BY samples DESC
```

Then inspect the dominant phase, its SDK host/resource measurements and the linked `$otel_trace_id` to separate startup, storage contention, network/authority work and initial rendering. Public anonymous opens use the same bounded profile projection; private/authenticated raw traces remain access-controlled. Failures before repository access is established cannot pass this authorized gateway and retain their separate opening exception diagnostics.

No remote repository-size measurement or proof of size-independent loading is included. That experiment remains a separate follow-up; browser resource bytes cannot substitute for repository size.
