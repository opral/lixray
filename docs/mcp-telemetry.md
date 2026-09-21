# MCP telemetry

Native OpenTelemetry is the performance trace for hosted MCP. LixRay and the
Lix reference server share W3C `traceparent` and `tracestate`; custom PostHog
trace/parent/session headers and MCP `$ai_trace` / `$ai_span` timers are removed.
There is no dual emission or legacy ID conversion.

## Lifetimes

The Node host starts an HTTP SERVER span at `/mcp` admission, before
authentication. `response_ready` records when the Web Response is available.
The span ends once when Node finishes writing the response, or on premature
close/error. This is server completion, not proof of delivery to the client.
For SSE the root measures connection lifetime, not individual tool latency.

Each SDK `tools/call` dispatch owns one `mcp.tool` span. Its lifetime includes
tool argument validation, target resolution, service work, preview/change lookup,
resource links, response construction and SDK output validation. The bounded
`mcp.tool.name` and `mcp.tool.outcome` distinguish successful calls from tool
errors inside HTTP 200 responses. A completed-call summary is published once
after dispatch, keyed by its native span identity; there is no request-wide
last-tool cache. HTTP status, tool outcome, and engine transaction status are
different facts. `lix.commit.outcome=committed` confirms completion of the
mutating operation; it can include a no-op write and does not assert that a
new repository commit was created. Preview fallback does not undo a persisted write. Malformed
protocol envelopes can fail before tools/call dispatch; these attach a bounded
protocol error to the HTTP span without manufacturing a tool span.

Authentication, repository authorization, remote runtime operations, response
preparation and blocking cleanup provide phase spans. Outbound Lix protocol
attempts inject the active W3C context, including handshake provisioning,
transactions, retries and close. The reference server extracts that parent
before its protocol span, connecting existing `lix.sql.*` and checkpoint work.
Source revision and service instance resources identify the emitting deployment.

Stream readers and cleanup explicitly retain their originating context.
Official analytics shutdown happens after response EOF, error or cancellation,
never immediately after constructing an SSE Response. Export delivery is
background work and cannot fail a tool or block response completion.

## Product analytics and privacy

Official `@posthog/mcp` `$mcp_*` events remain for discovery, usage and friction
analytics. `trace_id` and `span_id` link an event to the native trace. The SDK's
`$mcp_duration_ms` is an analytics field, not a second diagnostic waterfall.
The SDK v2 adapter and `server/discover` handshake mapping remain necessary
for supported protocol clients.

Tool parameters, response bodies and raw error messages are removed from
PostHog events. SQL summaries retain only their existing sanitized shape and
aggregate result metadata. Raw SQL and bindings are used only in process for
product import detection. Native tracing does not capture document contents,
credentials, context tokens or exception messages. Unknown tool names are
recorded as `unknown` rather than copying arbitrary input into traces.

The existing engine-owned `lix.repository.opened` product projection and
reference-server error projections remain separate from MCP performance
instrumentation. See [SQL telemetry](./sql-telemetry.md).

## Investigating a slow call

Find the canonical trace using the official event's `trace_id`, then compare
intervals: admission/authentication, tool work, remote protocol attempts and
their Rust descendants, response preparation, and cleanup. Do not subtract
unrelated event clocks or add nested span durations. A small `response_ready`
interval with a long tool span is valid for streaming; a completed HTTP span
must include all work that blocks its response.

PostHog trace access requires `tracing:read`. Event access alone cannot identify
the engine bottleneck. A missing connector permission is not evidence that
native traces were never emitted.

## Node exporter lifecycle

The Railway entry point initializes one OTel provider before importing the
application and drains it during process shutdown. Native export is enabled
with `POSTHOG_ENVIRONMENT=production` and `POSTHOG_PROJECT_TOKEN`, excluding demo/PR environments; `POSTHOG_HOST`
selects the destination. Export goes directly to `/i/v1/traces` using OTLP
protobuf. The bounded batch processor queues at most 2,048 spans, sends up to
256 per batch, and schedules delivery every second. Delivery has a four-second
HTTP timeout and a five-second processor timeout. Requests never await export.
The exporter is not wrapped in application HTTP instrumentation.

Resources include `service.name=lixray`, `service.version`,
`service.instance.id`, `vcs.ref.head.revision`, and
`deployment.environment.name`. The reference server uses `service.name=lix-server`
and its corresponding revision/instance resources. Repository and request IDs
are span attributes, not metric dimensions.

## Cross-service contract test

With workspace dependencies installed and the vendored JS SDK prepared, run the
opt-in Rust harness from the LixRay checkout:

```sh
LIX_TRACE_NODE_FIXTURE="$PWD/web-app/scripts/trace-integration.mjs" \
  cargo test --manifest-path vendor/lix/Cargo.toml -p lix-server --lib \
  node_client_trace_integration -- --ignored --nocapture
```

It starts the real reference-server router with in-memory storage on a local TCP
port, invokes `WorkerLixRuntimeClient`, and compares exported JS and Rust span
IDs. It covers handshake/account provisioning, a write transaction, checkpoint,
and session close, without production credentials or data. This cross-repository
harness is opt-in; the default suites separately cover propagation, streaming
lifetimes, concurrent call isolation, shared-open links, and exporter failure.
