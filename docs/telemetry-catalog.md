# Telemetry catalog


## Taxonomy rules

1. Product events use lower-case `object_action` names such as
   `user_signed_up`.
2. Product and client names do not belong in event names. Every product event
   carries `surface=web|mcp|server` instead.
3. Event names are declared once in
   `web-app/src/lib/telemetry-events.ts`. Emitters do not invent strings.
4. Durable business facts are emitted by the backend after authoritative
   state changes. Browser callbacks may request capture, but are not the source
   of truth.
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
| `first_file_added`        | First verified file enters a repository       | `repository_id`, `organization_id`, `file_extension`; MCP also emits safe size/hash verification fields | web, mcp |
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
| `share_link_copied`       | Public link is copied                         | `share_mode`                                                                                            | web      |
| `auth_session_orphaned`   | Invalid local session is cleared              | stable validation and auth error fields                                                                 | web      |

`user_signed_up` is server-validated against the authoritative auth user,
identified before capture, and uses the auth user ID as its PostHog event UUID.
Accounts created after the telemetry cutover remain eligible on later auth
callbacks, so a temporary delivery failure can be retried without duplicating
the event. The event timestamp remains the auth account's `created_at` value.
That closes the observed browser navigation/identity/deduplication leak while
keeping web and MCP acquisition in one metric.

`first_file_added` is still locally deduplicated on the web. It is suitable for
directional activation analysis, but should move to an authoritative backend
transition before it is used for billing or exact-once automation.

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
| Lix native spans          | `lix.repository.opened`, `lix.protocol.request`, `lix.sql.query`, `lix.sql.batch`, `lix.sql.coherent_read_batch` | Vendor-neutral OTLP pipeline; do not duplicate as product events |
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
Up to eight sanitized JavaScript asset frames, including source-map chunk IDs,
are retained in the first-party exception. Raw error messages, URL queries, page
paths, local variables, tokens and repository contents are not accepted by this
endpoint. Direct browser exception reporting remains available for stack traces.
Failures to reach the gateway cannot be delivered through this path.
