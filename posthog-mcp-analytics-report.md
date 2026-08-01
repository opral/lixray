# PostHog MCP Analytics Setup Report

## What was done

The LixRay MCP server (`web-app/src/mcp/server.ts`) has been instrumented with [`@posthog/mcp`](https://posthog.com/docs/mcp-analytics) using **Path A** (official SDK low-level `Server` object). Every MCP tool call, tools/list request, and initialize handshake is now captured as a `$mcp_*` event in PostHog.

**SDK installed:** `@posthog/mcp@0.10.2` (beta — pinned; pre-1.0, may have breaking changes in minor releases)

## Files modified

| File | Change |
|------|--------|
| `web-app/package.json` | Added `@posthog/mcp@0.10.2` to dependencies |
| `pnpm-lock.yaml` | Updated lockfile |
| `web-app/src/mcp/server.ts` | Added privacy-redacted `instrument()` integration, authenticated identity, and post-request shutdown |
| `web-app/src/worker/handler.ts` | Gates SDK telemetry to production and wires identity/flush through `executionContext.waitUntil` |
| `web-app/src/mcp/server.test.ts` | Verifies private MCP payload and error properties are removed |
| `web-app/src/worker/handler.test.ts` | Verifies identity forwarding and non-production gating |

## How it works

- `handleMcpTransport` creates a per-request `PostHog` client (`flushAt: 1, flushInterval: 0`) and instruments the MCP `Server` before it handles the request.
- `context: false` disables intent-argument injection to preserve the server's strict Zod input validation (tools use `.strict()` schemas that would otherwise reject the injected `context` field).
- A `beforeSend` hook removes `$mcp_parameters`, `$mcp_response`, `$mcp_error_message`, and `$exception_list`, so SQL, result rows, document data, and error details cannot be sent to PostHog. Exception fan-out is disabled for the same reason.
- Authenticated requests use the Supabase user ID as their PostHog distinct ID and record the OAuth client ID as low-cardinality event metadata.
- Shutdown is scheduled only after the MCP request has completed. It allows the SDK's async redaction pipeline to enqueue its event, then drains the PostHog client through `executionContext.waitUntil`.
- Official MCP SDK instrumentation follows the existing telemetry policy: it runs only in production, never in preview/dev/demo mode.

## Events you'll see in PostHog

Once the server handles its next request:

- `$mcp_initialize` — per MCP client handshake
- `$mcp_tools_list` — per `tools/list` call
- `$mcp_tool_call` — per `tools/call` invocation (includes tool name, duration, error flag)

Automatic `$exception` fan-out is intentionally disabled because exception messages and stacks can contain private SQL or document data. Failures remain visible on `$mcp_tool_call` through the error flag and safe error type.

All events share a `$session_id` derived from the MCP protocol session. See https://posthog.com/docs/mcp-analytics for the full event reference and dashboard templates.

## Verification

On 2026-07-31, a synthetic `list_lixes` request was sent with credentials injected from Infisical and verified through the PostHog MCP against the **LixRay** project:

- `$identify` and `$mcp_tool_call` were ingested for the synthetic distinct ID.
- Tool name, success state, production environment, server name, and OAuth client metadata were present.
- `$mcp_parameters`, `$mcp_response`, `$mcp_error_message`, and the unique private response marker were absent.

The PostHog MCP initially targeted the separate **flashtype** project; it was switched to **LixRay** before verification.

## Next steps

1. **Deployment sync** — ensure the Cloudflare Worker deployment consumes the Infisical production environment. `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` now exist there as shared aliases of the public SDK values.
2. **Optional: enable intent capture** — set `context: true` in the `instrument()` options and update tool schemas to accept the `context` string argument. This lets agents report what they're trying to accomplish.
3. **SDK pinning** — `@posthog/mcp` is pre-1.0; review the [changelog](https://github.com/PostHog/posthog-js/releases) before upgrading past `0.10.2`.
