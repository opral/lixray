# MCP friction telemetry

LixRay records each production MCP tool call as a PostHog AI Observability
`$ai_span`. These spans are for MCP contract and SQL usability friction. SQL
engine performance remains in the native `lix.sql.*` OpenTelemetry spans
described in [sql-telemetry.md](./sql-telemetry.md).

PostHog automatically presents each MCP span as a trace. LixRay does not set an
`$ai_session_id`: the stateless MCP server does not receive the agent's
conversation or task identifier, and grouping unrelated calls would be
misleading.

## Span model

Every tool call includes:

- `$ai_trace_id`, `$ai_span_id`, `$ai_span_name`, `$ai_latency`, and
  `$ai_is_error`
- `mcp_server`, `mcp_tool`, `oauth_client_id`, `lix_id`, and `outcome`
- `release_id` from `LIXRAY_RELEASE_ID`, Cloudflare Worker version metadata, or
  Railway's commit SHA
- `mcp_surface_version`, a content hash of the advertised MCP tool descriptors
- stable `error_code` and `$ai_error.code` on failure

`execute` spans add a privacy-safe `$ai_input_state` containing SQL operations,
sanitized statement shapes, shape IDs, parameter counts, and literal-redaction
counts. `$ai_output_state` contains only result counts, row counts, affected-row
counts, and notice codes.

SQL comments, literals, and bound values are never captured. Returned columns,
rows, file contents, notice messages, error details, and unsanitized SQL are
never captured. Sanitized SQL is capped at 4 KiB per statement.

## Analyze with an agent

Connect the analysis agent to PostHog's MCP server and point it at the LixRay
project. A useful starting prompt is:

> Analyze LixRay MCP `$ai_span` traces from the last seven days. Group recurring
> friction by `mcp_surface_version`, `error_code`, `notice_codes`,
> `sql_shape_ids`, and `sql_operations`. Inspect representative trace IDs and
> report unsupported SQL, unnecessary schema discovery, zero-row query shapes,
> excessive statement counts, and recurring notices. Treat `lix.sql.query`
> traces as SQL performance telemetry, not MCP usability evidence. Include the
> trace IDs supporting every finding.

The large `$ai_input_state` and `$ai_output_state` fields live in
`posthog.ai_events`. Metadata remains queryable as normal PostHog event
properties. There is intentionally no scheduler or automated remediation in
this implementation.
