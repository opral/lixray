# Telemetry catalog


## Taxonomy rules

1. Product events use lower-case `object_action` names such as
   `user_signed_up`.
2. Product and client names do not belong in event names. Every product event
   carries `surface=web|mcp|server` instead.
3. Event names are declared once in
   `web-app/src/lib/telemetry-events.ts`. Emitters do not invent strings.
4. Durable business facts are emitted by the backend after state changes.
   Browser callbacks may supply a commit-local observation when the server's
   partial replica cannot reconstruct that commit; the `verification` property
   records which source verified the transition.
5. PostHog-owned `$*` events keep their official names. OpenTelemetry spans
   keep their vendor-neutral `lix.*` names.
6. Failures are `$exception`, PostHog Logs, or spans. They are not product
   events ending in `_failed`.
7. One behavior has one event. Migrations hard-cut emitters and update actions,
   dashboards, destinations, and alerts in the same release; no dual emit.
8. Stable database user IDs are the PostHog `distinct_id`. Identify as soon as
   the account is known. Content, SQL values, tokens, file paths, and full URLs
   remain redacted.

These rules follow PostHog's guidance to instrument growth events explicitly,
use a consistent naming convention, prefer backend capture, and enrich events
with properties rather than creating client-specific variants.

## Canonical product events

`surface` and `environment` are required on every row. IDs are allowed where
needed for joins and group analytics, but names and content are not.

| Event                     | Owner / moment                                | Additional properties                                                                                   | Surface  |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `user_signed_up`          | Auth backend confirms a newly created account | `auth_provider`, `signup_source`, `email`, `name`                                                       | web, mcp |
| `first_file_added`        | A committed write changes a repository from zero files to one or more files | `repository_id`, `lix_id`, `file_extension`, `telemetry_schema_version=2` | web, mcp |
| `repository_inventory_snapshot` | A repository is opened or a committed file change is observed | `repository_id`, `snapshot_date`, total and user/`.lix` file counts and content bytes, total and user/`.lix` file-size buckets, total and user/`.lix` extension counts and bytes, `telemetry_schema_version=1` | web, mcp |
| `file_written`            | MCP write is verified                         | safe size/hash verification fields, `repository_id`, `organization_id`, `lix_id`                        | mcp      |
| `import_completed`        | MCP bulk import completes                     | counts, `duration_ms`, `repository_id`, `lix_id`                                                        | mcp      |
| `oauth_consent_resolved`  | OAuth decision succeeds                       | `decision`, `client_name`, `redirect_host`                                                              | web      |
| `organization_created`    | Organization RPC succeeds                     | none                                                                                                    | web      |
| `organization_renamed`    | Organization RPC succeeds                     | none                                                                                                    | web      |
| `repository_created`      | Repository insert succeeds                    | none                                                                                                    | web      |
| `repository_renamed`      | Repository update succeeds                    | none                                                                                                    | web      |
| `repository_deleted`      | Repository delete RPC succeeds                | none                                                                                                    | web      |
| `document_open_attempted` | Atelier chooses a renderer                    | `document_open_result`, `file_extension`, `unsupported_reason`, `document_origin`, `view_kind`          | web      |
| `document_viewed`         | Atelier renders a document                    | `document_origin`, `file_extension`, `view_kind`                                                        | web      |
| `document_modified`       | Throttled document edit                       | `file_extension`, `modified_by`                                                                         | web      |
| `extension_opened`        | Atelier extension opens                       | `extension_id`, `panel`                                                                                 | web      |
| `diff_opened`             | Diff opens                                    | `file_extension`                                                                                        | web      |
| `diff_resolved`           | Diff decision completes                       | `file_extension`, `outcome`                                                                             | web      |
| `resource_published`      | Public read access succeeds                   | `resource_kind`                                                                                         | web      |
| `resource_unpublished`    | Public read access removal succeeds           | `resource_kind`                                                                                         | web      |
| `share_link_copied`       | Share link is copied                          | `share_mode` (`public`, or `members` for a private conversation)                                        | web      |
| `auth_session_orphaned`   | Invalid local session is cleared              | stable validation and auth error fields                                                                 | web      |

`user_signed_up` is server-validated against the authoritative auth user,
identified before capture, and uses the auth user ID as its PostHog event UUID.
Accounts created after the telemetry cutover remain eligible on later auth
callbacks, so a temporary delivery failure can be retried without duplicating
the event. The event timestamp remains the auth account's `created_at` value.
That closes the observed browser navigation/identity/deduplication leak while
keeping web and MCP acquisition in one metric.

`first_file_added` version 2 checks the committed before and after file inventory
on the server, including writes through both Atelier and MCP. The PostHog event
UUID is the repository ID, so repeated delivery across clients resolves to the
same milestone. Earlier captures used a browser-local marker or an MCP
request-local marker and overcounted; filter to `telemetry_schema_version=2`
for activation analysis. This remains product analytics, not a billing ledger.
When the server reports `LIX_SYNC_HISTORY_REQUIRED` for a browser write, the
browser's local Lix supplies its before/after user-file counts. The backend
accepts that candidate only for an authorized repository whose server replica
still has zero user files, and emits `verification=browser_commit`; normal
server checks emit `verification=server_commit`. If the server already has user
files but still lacks the historical payload, the browser retains the candidate
and retries while open and on a later repository open. The PostHog UUID keeps
these retries idempotent.

`repository_inventory_snapshot` measures the live files at a specific commit,
using `OCTET_LENGTH(content)` for logical content bytes. It does not measure
database storage, compression, or history. Paths under `/.lix/` are
classified separately; overall totals include them, and `user_*` properties
exclude them. The event UUID is derived from the
repository, commit, and UTC date: a repeated open of the same commit on the
same day deduplicates, while a return on a later day is another observation.
For daily growth curves, select the last snapshot per repository per day before
aggregating; do not sum snapshots or treat event count as repository count.
Each extension breakdown includes only counts and bytes for up to 20 common
extensions in that path class, with the remaining extensions grouped as
`(other)`. File paths and contents are never sent to PostHog. Empty
repositories may have a zero-file baseline; filter to activated repositories
when measuring value.
If a partial replica cannot reconstruct an older commit because sync history
payloads are deferred, the server uses the live file view only when its head is
the requested commit. Otherwise it skips that observation until a later open;
it never attributes a different commit's inventory to the requested commit.

## PostHog and OpenTelemetry signal families

| Family                    | Emitted names                                                                                                    | Treatment                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Browser product analytics | `$pageview`, `$pageleave`, `$autocapture`, `$web_vitals`, `$rageclick`                                           | SDK-owned; keep privacy scrubber and masked recordings           |
| Identity and groups       | `$identify`, `$set`, `$groupidentify`                                                                            | SDK-owned; stable auth user ID and Lix group ID                  |
| Error tracking            | `$exception`                                                                                                     | Canonical actionable failure signal                              |
| Logs                      | Structured PostHog Logs, currently repository request and orphaned-session errors                                | Operational detail; never growth metrics                         |
| MCP analytics             | `$mcp_initialize`, `$mcp_tools_list`, `$mcp_tool_call`                                                           | Official `@posthog/mcp` events; do not recreate                  |
| MCP native spans          | HTTP server root, `mcp.tool`, authorization, response and cleanup phases                                          | Native OTLP performance trace; no custom MCP AI event clocks     |
| Repository-open span      | `$ai_span` with `$ai_span_name=lix.repository.opened`                                                            | Only repository-open north-star clock                            |
| Lix native spans          | Repository and protocol lifecycle spans; SQL spans named from `db.query.summary` (for example, `SELECT` or `BATCH SELECT`) | Vendor-neutral OTLP pipeline; identify SQL statements by database attributes, not span name |
| PostHog-derived/system    | `$ai_trace_summary`, `$recording_observed` and other configured `$*` events                                      | Platform-owned; not application emitters                         |

## Legacy event migration

Use this mapping when updating existing event definitions, destinations, and
saved queries to the canonical taxonomy. Production usage counts and internal
analytics identifiers are omitted.

| Observed event                   | Hard-cut treatment                                             |
| -------------------------------- | -------------------------------------------------------------- |
| `lix_request_failed`             | Stop; use `$exception`, Logs, and `lix.*` spans                |
| `document_open_attempted`        | Canonical                                                      |
| `document_viewed`                | Canonical                                                      |
| `repository_opened`              | Stop; use repository-open `$ai_span`                           |
| `workspace_opened`               | Stop; use repository-open `$ai_span`                           |
| `extension_opened`               | Canonical                                                      |
| `document_modified`              | Canonical                                                      |
| `mcp_tool_called`                | Stop; use `$mcp_tool_call`                                     |
| `diff_opened`                    | Canonical                                                      |
| `webapp_request_failed`          | Stop; use `$exception` and Logs                                |
| `lixray_user_signed_up`          | Rename to `user_signed_up`                                     |
| `webapp_document_open_attempted` | Rename to `document_open_attempted`                            |
| `webapp_document_viewed`         | Rename to `document_viewed`                                    |
| `workspace_created`              | Rename to `repository_created`                                 |
| `webapp_extension_opened`        | Rename to `extension_opened`                                   |
| `lixray_oauth_consent_resolved`  | Rename to `oauth_consent_resolved`                             |
| `diff_resolved`                  | Canonical                                                      |
| `webapp_user_signed_up`          | Rename to `user_signed_up`                                     |
| `lixray_first_file_added`        | Rename to `first_file_added`                                   |
| `lixray_file_written`            | Rename to `file_written`                                       |
| `workspace_deleted`              | Rename to `repository_deleted`                                 |
| `share_link_created`             | Stop; use `resource_published` for the successful state change |
| `lixray_import_completed`        | Rename to `import_completed`                                   |
| `webapp_oauth_consent_resolved`  | Rename to `oauth_consent_resolved`                             |
| `repository_created`             | Canonical                                                      |
| `organization_created`           | Canonical                                                      |
| `share_link_copied`              | Canonical                                                      |
| `lixray_telemetry_probe`         | Delete test event                                              |
| `repository_deleted`             | Canonical                                                      |
| `repository_list_failed`         | Stop; use `$exception` and Logs                                |
| `webapp_organization_created`    | Rename to `organization_created`                               |
| `telemetry_smoke_test`           | Delete test event                                              |
| `webapp_repository_created`      | Rename to `repository_created`                                 |
| `auth_session_validation_failed` | Stop; use `$exception` and Logs                                |

Other legacy names follow the same strip-prefix rule: `webapp_first_file_added`, `webapp_file_written`,
`webapp_import_completed`, `webapp_document_modified`, `webapp_diff_opened`,
`webapp_diff_resolved`, `webapp_organization_renamed`,
`webapp_repository_renamed`, `webapp_repository_deleted`,
`webapp_resource_published`, `webapp_resource_unpublished`,
`webapp_share_link_copied`, and `webapp_auth_session_orphaned`.

## Release cutover

1. Deploy the canonical emitters.
2. In the same cutover, change the Slack destination from
   `lixray_user_signed_up` to `user_signed_up` and render `email`, `name`,
   `surface`, `auth_provider`, and `signup_source`.
3. Change the signup action and insights to only
   `user_signed_up`. Do not leave an OR action as the long-term definition.
4. Update the remaining actions/dashboards using the mapping above.
5. Verify one new web-origin and one new MCP-origin account, then hide legacy
   definitions from event selection. Historical events remain queryable.
6. Alert when `$identify`/new-account evidence exists without
   `user_signed_up` inside ten minutes.

References:

- [PostHog product analytics best practices](https://posthog.com/docs/product-analytics/best-practices)
- [PostHog identify documentation](https://posthog.com/docs/product-analytics/identify)
- [PostHog data management](https://posthog.com/docs/data)

### Repository opening failures

Every failure caught while opening a repository also sends a bounded report to
`/api/repository-open-diagnostics`, independently of browser PostHog initialization.
The gateway checks member or public repository access and records an allowlisted
server log before delivering a PostHog `$exception` with `operation=repository_open`
and `delivery=first_party`. Reports include client/server release, stable error
code or JavaScript error kind, and available admission epoch/root coordinates.
Payload resolution failures also include `payloadStandaloneStatus` and
`payloadPhysicalStatus` (`absent`, `matched`, `identity_mismatch`,
`missing_snapshot`, or `lifetime_mismatch`), `payloadPhysicalConflict`, and
`payloadSourceDeferred` when the deferred marker can be read. These same bounded
states are projected from native spans; payload values are excluded. An omitted
deferred flag means unknown, rather than false.
When selected canonical authority exists but has no live snapshot, diagnostics
also include `payloadFailureReason=selected_change_payload_unavailable` and the
validated `changeId`, alongside `payloadPhysicalStatus=missing_snapshot`. This
distinguishes a missing selected payload from a receipt parse or identity error;
no payload body or raw storage value is exported.
Partial-receipt parser and migration failures carry an allowlisted
`failureReason` and fixed-schema `failurePath` through native traces and browser
opening exceptions. The PostHog exception value includes that safe diagnosis;
raw parser messages, receipt values, and arbitrary JSON paths are never
exported. JSON parse failures may include one of four bounded parser categories,
positive `jsonLine` / `jsonColumn` values capped at 16 KiB, and a known
`missingField` name from the applicable frozen receipt DTO. A bounded
`migrationPhase=partial_receipt` property identifies the diagnostic stage;
receipt versions are not physical storage-format versions.
Up to eight sanitized JavaScript asset frames, including source-map chunk IDs,
are retained in the first-party exception. Raw error messages, URL queries, page
paths, local variables, tokens and repository contents are not accepted by this
endpoint. Direct browser exception reporting remains available for stack traces.
Failures to reach the gateway cannot be delivered through this path.

## Repository route to usable performance

`lixray.repository.open` measures entering a repository route until its initial
view is usable. A cold browser load begins at Navigation Timing's start (including
network and JS bootstrap); an in-app navigation starts at the repository route's
`beforeLoad`. Hover preloads do not count as opens. Repository home and folder
views finish after their initial directory data commits and two animation frames
allow it to paint. File views use the existing document-loaded and initial-read
readiness boundary before that paint fence. This measures initial usability,
not background sync completion or all restored tabs.

The root owns SDK/engine and request spans through explicit context propagation.
Sequential child spans describe `bootstrap`, `auth`, `access`, `replica`, `engine`,
`branch`, `session`, `atelier`, `initial_view`, and `paint`. Cached sessions may
skip phases. Phase spans are emitted when the attempt ends, preserving pre-auth
coordinates until repository access is known. React re-renders and branch
normalization do not create duplicate opens; explicit retries get fresh attempts.

The authorized browser OTLP gateway emits `repository_open_performance` alongside
the raw trace. Each sample contains `duration_ms`, individual `<phase>_ms`,
`outcome` (`usable`, `failed`, `cancelled`, `superseded`, `timeout`), `entry`
(`navigation`, `client_navigation`, `retry`), `visibility` (`foreground` or
`background`), the repository ID, release revision, and trace/span IDs. Identity
comes from the gateway's authenticated account. The event UUID derives from the
span identity, so delivery retries do not double-count an attempt. URL paths,
repository names, credentials and document contents are not included.

For loading latency, select `outcome=usable` and `visibility=foreground`, compare
p50/p95 of `duration_ms`, and split by `entry` and `client_release`. Use the stage
fields to identify the dominant delay, then open that sample's trace to inspect
engine, SQL and client/server request spans. Count other outcomes separately;
exclude background-tab delays from foreground latency. Successful samples cover
authenticated, authorized repositories and public repositories opened anonymously.
For anonymous opens, the gateway verifies the public repository and accepts only
the bounded root timing sample. Failures before repository access is established
are not performance samples through this gateway. Existing first-party opening
failure diagnostics remain independent.
