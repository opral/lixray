# MCP analytics note

LixRay keeps the official `@posthog/mcp@0.10.2` integration enabled alongside
the stateless MCP transport. The v2 `McpServer` is instrumented through its
low-level server because PostHog 0.10.x expects the v1 low-level shape; the
transport itself remains `@modelcontextprotocol/server` v2 with no MCP session
state.

The integration emits PostHog's canonical MCP events and removes private MCP
payload properties (`$mcp_parameters`, `$mcp_response`, `$mcp_error_message`,
and `$exception_list`) before delivery. `$mcp_duration_ms` is harness wall
clock. Engine SQL / open / checkpoint timing comes only from Lix spans
(`lix.sql.*` and related), never from synthesized `$ai_span` names such as
`mcp.execute_sql`.

The PostHog MCP SDK is pinned because its MCP Analytics event contract is still
beta. Future changes must preserve the redaction boundary and must not make
branch or Lix execution depend on PostHog or an MCP transport session.
