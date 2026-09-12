# Production SQL telemetry

Production SQL timing is emitted as OpenTelemetry spans and exported by
`lix-server` over OTLP to LixRay's authenticated telemetry gateway. The engine's
`sql_telemetry` module owns the statement schema and redaction logic; callers
must not emit a second SQL telemetry event.

Telemetry is opt-in per opened Lix instance. Without a telemetry sink the
engine does not create spans, sanitize or fingerprint SQL for telemetry, read
timestamps, or send cross-runtime messages. `lix-server` explicitly supplies
the Rust tracing adapter when it opens Lix through `lix_sdk`.

## SDK exposure

The Rust SDK accepts an `Arc<dyn TelemetrySink>` through
`open_lix().with_telemetry(...)`. The engine calls `enabled` before building
attributes, then uses the returned start/finish handle to preserve async span
parentage. `OpenTelemetryTracingSink` captures an explicit `tracing::Dispatch`
configured by the host; Lix never installs a global subscriber or exporter.

The JS SDK accepts `openLix({ telemetry: { onSpan(span) {} } })`. Local browser
and Node execution forwards the completed engine span through the native or
WASM binding and the SDK worker. The callback is isolated from query results;
an exception in `onSpan` does not fail the Lix operation. Remote SQL spans stay
on the server and are not duplicated in the remote client. The same rule
applies to `lix.repository.opened`.

## Open-repo north star

The engine emits a vendor-neutral `lix.repository.opened` span when a client
session binds to a Lix (handshake session create, in-process client
`open_lix()`, or an explicit `Lix::bind_session` / `lix::bind_session`). That
span is the north star. LixRay does not emit a parallel product event named
`repository_opened`, `lixray_repository_opened`, or `webapp_repository_opened`.

Lix spans stay `lix.*` on the TelemetrySink / OTLP path. LixRay's gateway
projects each completed identified
`lix.repository.opened` span to a PostHog `$ai_span` whose `$ai_span_name`
equals the Lix name and forwards the native OTLP payload to PostHog tracing.
Web remote/sync and MCP clients share this server export;
they must not attach a second mapper. Local Rust and JavaScript hosts can
consume the same canonical span through their telemetry sink or `onSpan`;
PostHog delivery is host-configured, not automatic in the SDK.

The event means a client session was bound, not a unique logical UI open.
Sync and reconnects can create multiple sessions. North-star DAU/WAU count
unique people, not raw span volume.

MCP `open_lix` does not invent an `mcp.open_lix` `$ai_span`. Official
`$mcp_tool_call` keeps `$mcp_duration_ms` as harness wall clock. Cache admission
uses `open_lix().with_telemetry(...).serve()` and owns only the repository
engine, so it is not a client bind.

Identity is the OAuth / session account so the same person on web and MCP is
one WAU. Anonymous and demo accounts are not captured. Optional `source`
(`web` / `mcp` / `server`) is diagnostic only and must not split the north
star. Missing or invalid PostHog config never prevents the server from
starting.

Product events describe behavior, not the client that emitted them. Every
product event uses the central semantic `object_action` name and carries
`surface=web|mcp|server`. Both web and MCP-originated account creation emit the
server-owned `user_signed_up` event. It carries `surface`, `signup_source`,
`auth_provider`, `email`, and `name`; its UUID is the auth user ID so a retried
callback is deduplicated by PostHog. See the complete
[telemetry catalog](./telemetry-catalog.md).

## Product event rename

Hard-cut emit (no dual-emit). Product and surface prefixes are removed. Client
origin is the `surface` property.

| Old name                                                         | Canonical name                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `lixray_user_signed_up`, `webapp_user_signed_up`                 | `user_signed_up`                                               |
| `lixray_first_file_added`, `webapp_first_file_added`             | `first_file_added`                                             |
| `lixray_oauth_consent_resolved`, `webapp_oauth_consent_resolved` | `oauth_consent_resolved`                                       |
| `lixray_file_written`, `webapp_file_written`                     | `file_written`                                                 |
| `lixray_import_completed`, `webapp_import_completed`             | `import_completed`                                             |
| `webapp_*` product events                                        | strip `webapp_` and add `surface=web`                          |
| `workspace_created`                                              | `repository_created`                                           |
| `workspace_deleted`                                              | `repository_deleted`                                           |
| `workspace_opened`                                               | deleted — use `$ai_span` `$ai_span_name=lix.repository.opened` |
| `repository_opened`                                              | deleted — use `$ai_span` `$ai_span_name=lix.repository.opened` |

Failures are not product events. Authentication validation, repository-list
failures, and actionable repository request failures are captured as PostHog
`$exception` events with stable operation, endpoint, status, and error-code
properties. Repository opening owns its terminal exception after retry and
migration handling. Established repository sessions report each consecutive
transport failure once; successful requests reset that suppression. Expected
migration, recovery, cancellation, and missing-chunk probes are not errors.

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

| Attribute                   | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `db.system.name`            | Always `lix`                                                           |
| `db.operation.name`         | SQL operation such as `SELECT` or `INSERT`                             |
| `db.query.text`             | Whitespace-normalized SQL with comments and literal values removed     |
| `lix.sql.fingerprint`       | BLAKE3 of the sanitized query text                                     |
| `lix.execution.kind`        | `execute`, `transaction`, `observe`, `batch`, or `coherent_read_batch` |
| `lix.batch.index`           | Zero-based position when the statement belongs to a batch              |
| `db.response.returned_rows` | Rows returned on success                                               |
| `lix.rows_affected`         | Rows changed on success                                                |
| `error.type`                | Stable Lix error code on failure                                       |

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

The reference server supports one export path: standard OTLP HTTP/protobuf.
Configure the production server with:

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://lixray.com/api/telemetry/otlp/v1/traces`
- `OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer <internal-token>`
- `RUST_LOG=info,lix_sql=info` (the reference server's Rust target is `lix_server`)

Use the shared `LIXRAY_INTERNAL_TOKEN` as the internal token. Preview deployments
must use their own gateway URL and token. Never route preview traces through
the production gateway. No `POSTHOG_*` variables belong on the reference server.

The existing LixRay web gateway owns the destination credentials:

- `POSTHOG_PROJECT_TOKEN`
- `POSTHOG_HOST`
- `POSTHOG_ENVIRONMENT=production`

The gateway receives `/api/telemetry/otlp/v1/traces`, authenticates before
decoding, forwards native traces to `<POSTHOG_HOST>/i/v1/traces`, and projects
identified repository-open spans into the existing PostHog event schema.
Server ERROR log events and standard OTel exception events are also projected
as PostHog `$exception` events. Each exception includes `server_log_message`,
`server_error_detail`, repository ID, migration versions when present, and
`$otel_trace_id`/`$otel_span_id` for the native diagnostic trace. Projection
uses stable event UUIDs so exporter retries do not create new occurrences.
An ERROR span status alone is not captured: retryable migration 503s are not
terminal server errors. Only diagnostic fields are projected, with bounded
messages and credential redaction; request bodies and arbitrary log fields
are not copied. Diagnostic detail stays in the authenticated telemetry path,
not in public repository error responses. These are server exceptions, separate
from the browser's generic repository-open exception.
There is no second event detector or vendor-specific exporter in Lix.
Verify both native trace receipt and person-linked event receipt when changing
deployment configuration. A successful repository request alone does not
verify analytics delivery.
Missing or invalid telemetry configuration never prevents the server from
starting. `RUST_LOG` controls formatted server logs only; it does not enable or
disable OpenTelemetry spans.

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
