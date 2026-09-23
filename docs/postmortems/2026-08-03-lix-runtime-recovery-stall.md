# Lix runtime recovery stall

- **Date:** 2026-08-03 PDT / 2026-08-04 UTC
- **Affected workspace:** One production workspace (identifier omitted)
- **Severity:** User-visible outage for one workspace
- **Status:** Resolved by restarting the production `lix-server` replica
- **Incident tracking:** Internal telemetry reference omitted from the public report

## Summary

A protocol request for the affected lix stopped making progress and exceeded the
server's 60-second request deadline. The server correctly moved the runtime out
of active service and marked it as recovering. Recovery then stalled while
closing the lix service. Because that close is not bounded, the runtime remained
in `Recovering` indefinitely and every later open returned
`LIX_ERROR_LIX_RECOVERING`.

Railway continued to report the deployment as successful because the process
and HTTP server were alive. The service had one replica and a restart-on-failure
policy, but the process never failed. Restarting the replica released the stuck
runtime and restored the workspace.

The initiating operation is not known from current telemetry. Completed request
and SQL spans are exported, but the hung request never completed and therefore
did not export the span data needed to identify its statement. The sustained
outage mechanism—the unbounded recovery close—is confirmed by the state
transition and the absence of any recovery-completion log.

## Impact

- The public workspace could not open and displayed “The lix is recovering.”
- PostHog recorded four handled `LixError` occurrences across two users and two
  sessions during the confirmed incident window.
- Other process-level endpoints remained healthy. There is no evidence in the
  inspected logs that unrelated lix runtimes were unavailable.
- Confirmed user-visible impact lasted approximately 25 minutes, from the first
  PostHog exception at 03:42:24 UTC until successful verification at 04:07:12
  UTC. The exact start may have been earlier than the first captured exception.

## Timeline

All timestamps are UTC on 2026-08-04.

| Time            | Event                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ~03:41:13       | The request that later timed out likely began. Its span never completed or exported.                                             |
| 03:42:13        | `lix-server` logged `protocol request exceeded its deadline; recovering runtime` with a 60-second timeout.                       |
| 03:42:13        | The runtime entered recovery. No subsequent `closed recovered lix runtime` or `removed recovered lix runtime` event was emitted. |
| 03:42:16 onward | Later handshakes completed immediately with an error because the runtime was already marked recovering.                          |
| 03:42:24        | PostHog recorded the first confirmed browser `LixError` for `workspace_open`.                                                    |
| 03:56:49        | The failure was reproduced again and captured by PostHog.                                                                        |
| ~04:06          | The production `lix-server` replica was manually restarted.                                                                      |
| 04:06:40        | The restarted service logged that it was ready.                                                                                  |
| 04:07:11        | The affected lix runtime reopened successfully in 2.2 seconds.                                                                   |
| 04:07:12        | The public URL was verified: Atelier, navigator, and file tree loaded with no browser errors.                                    |

## Root cause

The incident had two stages:

1. **Initiating failure:** a protocol execution stopped making progress long
   enough to exceed `LIXRAY_PROTOCOL_TIMEOUT_SECS` (60 seconds). Existing
   evidence does not establish whether the hang was in SlateDB, object storage,
   query execution, or shutdown-sensitive coordination.
2. **Recovery failure:** `LixManager::recover` changed the runtime state to
   recovering, spawned a cleanup task, and awaited `close_lix_service` without a
   deadline. That close did not return. Cleanup never removed the runtime from
   the manager, so it permanently rejected later opens as recovering.

The second stage converted a bounded request failure into a persistent
workspace outage. The process remained alive, so Railway's restart policy did
not activate.

## Detection and observability

### What worked

- The browser failure boundary called `captureException`, attaching
  `operation=workspace_open` and `environment=production`.
- PostHog grouped the events into one active issue and resolved source maps down
  to `workspace-lix-session.ts` and the remote Lix protocol client.
- URL sanitization protected workspace identifiers in PostHog.
- Railway logs identified the affected lix, timeout, and transition into
  recovery.
- PostHog server traces showed successful traffic immediately before the hang
  and immediate error responses after the runtime entered recovery.

### What did not work

- PostHog's `$exception_values` field was empty even though the UI had the
  actionable message “The lix is recovering.” The issue is discoverable, but
  its default presentation omits the most useful error detail.
- No alert fired for a runtime remaining in recovery or for repeated
  `LIX_ERROR_LIX_RECOVERING` responses.
- Recovery lifecycle logging has an entry event but no deadline/watchdog, so an
  absent completion event requires manual interpretation.
- Completed-span telemetry cannot describe an operation that never completes.
- Railway's deployment health is process-level and did not cover the ability to
  open an existing lix.

## Resolution

The production `lix-server` replica was restarted without rebuilding or
changing configuration. Process termination released the stuck runtime and its
storage resources. The existing deployment came back successfully and the
affected lix opened on the first verification attempt.

## Corrective actions

### P0 — prevent indefinite recovery

- Add a recovery watchdog around service close.
- If close cannot finish within a short, explicit deadline, terminate the
  process so Railway can safely restart it and release all storage owners. Do
  not retire or reopen the lix's cache path while a leaked close task can still
  own the old storage runtime.
- Add a regression test whose close future never resolves and assert that the
  watchdog reaches the fail-fast path.

### P0 — detect workspace-level unavailability

- Add a production canary that periodically opens and executes a harmless read
  against a dedicated lix.
- Alert on repeated `LIX_ERROR_LIX_RECOVERING`, protocol timeout counters, and a
  runtime remaining in recovery beyond the expected close budget.

### P1 — repair PostHog exception details

- Preserve `Error.name`, `message`, `stack`, and safe Lix fields such as `code`
  and `status` through the `before_send` privacy scrubber.
- Add a test using the real remote `LixError` shape and assert that PostHog's
  normalized exception value contains the sanitized message.

### P1 — make incomplete work observable

- Emit counters and duration metrics for protocol requests, timeouts, recovery
  starts, recovery completions, and recovery watchdog failures.
- Record a safe request/query fingerprint before execution so a timeout can be
  attributed even when its normal completion span is never exported.
- Include lix ID, protocol path, recovery age, and deployment identifier on
  structured recovery logs and metrics.

The follow-up implementation keeps an independent registry of SQL spans from
creation until close. On timeout, the still-running operation, execution kind,
sanitized-query fingerprint, and request correlation ID are copied onto the
completed parent span and structured Railway log. This makes the evidence
available even though the child SQL span never finishes; raw SQL and parameters
are not retained by the registry.

### P2 — operational hardening

- Add a runbook for confirming this signature and restarting only
  `production/lix-server`.
- Revisit the service health check and promoted-image deployment manifest so
  production retains an explicit `/healthz` check. A deeper canary should remain
  separate from the cheap process health check.

## Runbook

This signature is present when Railway logs show both:

1. `protocol request exceeded its deadline; recovering runtime`
2. `lix runtime entering recovery`

and do not show `closed recovered lix runtime` or `removed recovered lix
runtime` within the recovery budget.

Confirm the affected lix continues returning `LIX_ERROR_LIX_RECOVERING`. If so,
restart the current production `lix-server` deployment, wait for `lix lix
service ready`, then open the exact affected workspace and verify its file tree
loads. A restart is mitigation, not closure: preserve the logs and PostHog issue
for follow-up on the initiating hang.

## Evidence and confidence

- **High confidence:** the runtime remained in recovery because service close
  did not complete; the expected completion logs never appeared and a process
  restart immediately restored the same lix.
- **High confidence:** Railway health did not detect the workspace outage; the
  deployment stayed `SUCCESS` with low CPU and memory utilization.
- **Medium confidence:** the initiating request began around 03:41:13 UTC,
  inferred from the 60-second timeout emitted at 03:42:13 UTC.
- **Unknown:** the exact query and subsystem that caused the initiating hang.
  Current telemetry exports completed work and cannot reconstruct the missing
  span.
