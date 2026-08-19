# Production SQL telemetry

Production SQL timing is emitted as OpenTelemetry spans and exported by
`lix-server` to PostHog's native tracing endpoint. The engine's
`sql_telemetry` module owns the statement schema and redaction logic; callers
must not emit a second SQL telemetry event.

Telemetry is opt-in per opened Lix instance. Without a telemetry sink the
engine does not create spans, sanitize or fingerprint SQL for telemetry, read
timestamps, or send cross-runtime messages. `lix-server` explicitly supplies
the Rust tracing adapter when it opens Lix through `lix_sdk`.

## SDK exposure

The Rust SDK accepts an `Arc<dyn TelemetrySink>` through
`open_lix_with_telemetry`. The engine calls `enabled` before building
attributes, then uses the returned start/finish handle to preserve async span
parentage. `TracingTelemetrySink` is the explicit adapter for hosts that use
the Rust `tracing` ecosystem; Lix never installs a global subscriber or
exporter.

The JS SDK accepts `openLix({ telemetry: { onSpan(span) {} } })`. Local browser
and Node execution forwards the completed engine span through the native or
WASM binding and the SDK worker. The callback is isolated from query results;
an exception in `onSpan` does not fail the Lix operation. Remote SQL spans stay
on the server and are not duplicated in the remote client. The same rule
applies to `lix.opened`.

## Product open event

The engine emits a vendor-neutral `lix.opened` span when a client session binds
to a Lix (handshake session create, in-process `open_lix`, or an explicit
`Lix::bind_session` / `lix::bind_session` on a cache-hit runtime). Lix never
names or captures `repository_opened`.

LixRay's host sink is the only writer of the PostHog product event
`repository_opened`. On lix-server, `HostTelemetrySink` watches completed
`lix.opened` spans and `capture()`s that event with the session account as
`distinct_id`. In-process WASM uses the same mapping from `onSpan` when
`span.name` is `lix.opened`. MCP `open_lix` calls `bindSession` on every
successful signed-context mint, cache-hit or miss, with the OAuth / principal
account. Cache-admit's anonymous `open_lix` bind is not the product event.

Identity is the OAuth / session account so the same person on web and MCP is
one WAU. Anonymous and demo accounts are not captured. Optional `source`
(`web` / `mcp` / `server`) is diagnostic only and must not split the north
star. Missing or invalid PostHog config never prevents the server from
starting.

## Span model

- `lix.sql.query` is one completed SQL statement. It covers normal execution,
  explicit transactions, observer reevaluations, atomic batches, and coherent
  read batches.
- `lix.sql.batch` measures an atomic batch, including transaction and commit
  overhead. Its `lix.sql.query` children measure the individual statements.
- `lix.sql.coherent_read_batch` is the equivalent parent for internal coherent
  reads.
- `lix.protocol.request` stays active through the response body and connects
  protocol calls, including observer reevaluations, to a repository. SQL analysis
  should aggregate the statement spans, not request or batch spans.

Statement attributes:

| Attribute | Meaning |
| --- | --- |
| `db.system.name` | Always `lix` |
| `db.operation.name` | SQL operation such as `SELECT` or `INSERT` |
| `db.query.text` | Whitespace-normalized SQL with comments and literal values removed |
| `lix.sql.fingerprint` | BLAKE3 of the sanitized query text |
| `lix.execution.kind` | `execute`, `transaction`, `observe`, `batch`, or `coherent_read_batch` |
| `lix.batch.index` | Zero-based position when the statement belongs to a batch |
| `db.response.returned_rows` | Rows returned on success |
| `lix.rows_affected` | Rows changed on success |
| `error.type` | Stable Lix error code on failure |

Bound parameter values and SQL literal values are never captured. MCP
AI Observability spans remain the source for tool-level usability and
end-to-end latency. Their SQL input state contains independently sanitized
statement shapes, never bound values or returned rows; see
[mcp-telemetry.md](./mcp-telemetry.md).

## Failure logs

When a protocol request contains a failed SQL statement, `lix-server` emits a
structured warning with the HTTP status, `error.type`,
`lix.sql.fingerprint`, operation, execution kind, and request identity. The
same error code is recorded on the enclosing `lix.protocol.request` span.
These logs deliberately exclude SQL text, literal values, bound parameters,
and returned rows.

## Export configuration

Infisical supplies these production variables directly to the Railway
`/railway/lix-server` service:

- `POSTHOG_PROJECT_TOKEN`
- `POSTHOG_HOST`
- `POSTHOG_ENVIRONMENT=production`

The server exports OTLP HTTP/protobuf to `<POSTHOG_HOST>/i/v1/traces`. Missing
or invalid telemetry configuration never prevents the server from starting.

Set `RUST_LOG=lixray=info,lix_sql=info` too: Lix SQL spans use the separate
`lix_sql` tracing target and are otherwise filtered out.

## Daily sweeper query

This HogQL query is validated against the LixRay PostHog project. It groups
the last day by sanitized statement shape and ranks the slowest p95 first.

```sql
SELECT
    attributes['lix.sql.fingerprint'] AS fingerprint,
    any(attributes['db.query.text']) AS query_text,
    any(attributes['db.operation.name']) AS operation,
    count() AS executions,
    round(avg(duration_nano) / 1000000, 2) AS avg_ms,
    round(quantile(0.50)(duration_nano) / 1000000, 2) AS p50_ms,
    round(quantile(0.95)(duration_nano) / 1000000, 2) AS p95_ms,
    round(quantile(0.99)(duration_nano) / 1000000, 2) AS p99_ms,
    round(max(duration_nano) / 1000000, 2) AS max_ms,
    countIf(status_code = 2) AS errors
FROM posthog.trace_spans
WHERE service_name = 'lix-server'
  AND name = 'lix.sql.query'
  AND timestamp >= now() - INTERVAL 1 DAY
GROUP BY fingerprint
ORDER BY p95_ms DESC
LIMIT 100
```

A scheduled agent should ignore tiny samples, compare p95 and error rate with
the previous seven-day window, inspect representative full traces for the top
regressions, and report evidence before proposing an optimization. It should
not treat a slow `lix.sql.batch` parent as a slow statement without checking
the child spans; the difference is transaction or commit overhead.
