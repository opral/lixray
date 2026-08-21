# MCP harness telemetry

LixRay emits official PostHog MCP Analytics events (`$mcp_tool_call` and
handshake `$mcp_*`) for tool and protocol wall clock. `$mcp_duration_ms` is
how long the tool felt to the agent. It is never engine time.

Engine performance clocks come only from Lix (`lix.sql.*`, `lix.engine.open`,
`lix.session.open`, `lix.checkpoint.create`, `lix.transaction.*`). LixRay
forwards those `onSpan` records. Remote SQL / open / checkpoint spans stay on
lix-server's OpenTelemetry export; see [sql-telemetry.md](./sql-telemetry.md).
LixRay does not synthesize `$ai_span` names such as `mcp.open_lix`,
`mcp.execute_sql`, or `mcp.create_checkpoint`.

In-process WASM can attach `openLix({ telemetry: { onSpan } })`. The host maps
`lix.opened` to the product count `repository_opened` and may forward other
Lix-named spans as `$ai_span` using the Lix name and Lix ids. Missing Lix ids
are omitted; they are not invented.

PostHog automatically presents each official MCP tool call as analytics. LixRay
does not set an `$ai_session_id`: the stateless MCP server does not receive the
agent's conversation or task identifier, and grouping unrelated calls would be
misleading.

## Official `$mcp_tool_call`

Every tool call includes:

- `$mcp_tool_name` and `$mcp_duration_ms` (harness wall clock only)
- `mcp_server`, `oauth_client_id`, `lix_id`, `success`, and `request_id`
- stable `error_code` on failure
- `sql_op`, `is_bulk`, and `row_count` when the tool executed SQL

Do not add a second duration field. Do not put SQL text or commit ids on the
MCP event unless Lix put them on a span.

## Product open event

`repository_opened` is the north star. It maps from Lix `lix.repository.opened`
/ `lix.opened` on bind. It is a count. Do not rename it. Do not put duration on
it unless Lix provides one.

## Analyze with an agent

Connect the analysis agent to PostHog's MCP server and point it at the LixRay
project. A useful starting prompt is:

> Analyze LixRay MCP `$mcp_tool_call` events from the last seven days as
> harness wall clock (`$mcp_duration_ms`), not engine time. Group friction by
> `$mcp_tool_name`, `error_code`, `sql_op`, and `success`. Treat `lix.sql.query`
> OpenTelemetry spans as SQL engine performance. Never treat `mcp.execute_sql`
> / `mcp.open_lix` `$ai_span` names as a performance source — those names must
> not exist. Include the event and trace IDs supporting every finding.
