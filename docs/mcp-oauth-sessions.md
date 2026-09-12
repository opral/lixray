# Persistent MCP authorization

Supabase owns OAuth registration, consent, code exchange, refresh rotation,
expiry, and grant revocation. LixRay binds each approved OAuth client to one
resource in `private.oauth_client_resources`. No new service or dependency is
required. The token hook reads that immutable mapping on issuance and refresh;
it never searches outstanding authorizations.

## Approval and resource binding

`private.bind_oauth_client_resource` runs as a database trigger when Supabase
records an approved authorization. Registration and pending consent do not
create a mapping. Approval accepts only the exact LixRay resource/endpoint
aliases listed in the migration. A unique client key serializes concurrent
first approvals. Later approvals must match the same canonical resource.
Different resources require different client registrations.

The check also runs for Supabase's remembered-consent auto-approval and direct
consent API calls. It cannot be bypassed by skipping LixRay's consent UI.
Unsupported resources fail approval without issuing a code or changing an
existing mapping. This is a LixRay integration with Supabase's internal
`auth.oauth_authorizations` table, so the real HTTP regression is required when
upgrading Auth. Local setup and CI pin Supabase CLI v2.112.0, which bundles
Auth v2.195.0 and supports the advertised `offline_access` scope.

The production canonical resource remains `https://lixray.com`. The private,
operator-owned `oauth_resource_policy` allowlist enables only that resource in
production. Local seed/setup explicitly adds loopback resources; the hook also
requires a local Supabase issuer when issuing tokens for them. `pnpm --dir
database start` configures an existing local stack after applying migrations. Ordinary browser sessions and unapproved OAuth clients
cannot gain MCP permissions. Mappings are inaccessible to application roles;
Auth writes them only through the approval trigger.

The JWT retains Supabase's `aud: authenticated` for the Data API. Its signed
`resource` and `lixray_mcp` claims establish the MCP resource restriction, which
the MCP validator and control-plane permissions enforce. This is a fixed
client-resource policy, not general RFC 8707 multi-resource support. Hosted Auth
may ignore a different `resource` parameter at refresh; the resulting token
still targets the client's original resource and cannot authorize the requested
foreign resource. We do not claim the token endpoint returns `invalid_target`.

## Refresh and revocation

The hook verifies the session's user, client, and scopes against the trusted
issuance event before reading the client mapping. Concurrent authorizations,
expired abandoned approvals, and consumed codes cannot disturb refresh.
New sessions need no `oauth_session_resources` record.

A session created before the client mapping cannot inherit its permissions.
Only a matching, previously proven `private.oauth_session_resources` record can
bridge that cutoff. That old table remains solely for migration compatibility;
it receives no new records. Existing session deletion still cascades to it.

Normal Supabase grant revocation removes the user's sessions for the client and
prevents refresh. The client-resource mapping remains: it describes the client's
fixed target, not a user's consent. Deleting the OAuth client removes its mapping.
Already-issued access tokens remain valid until expiry; the migration adds no
per-request revocation lookup.

An approval the client never exchanged (a lost code, a failed browser handoff)
keeps its `auth.oauth_authorizations` row past expiry, and every retry adds
one. Nothing reads those rows for token issuance any more, so a fresh approval
for the client sweeps its expired pending and approved rows in the same
transaction (`private.bind_oauth_client_resource`,
`20260911030000_oauth_authorization_hygiene.sql`).

Settings → Connected apps lists the OAuth clients the account has granted
(`auth.oauth.listGrants`) next to what LixRay recorded of their use
(`public.list_mcp_client_connections`: repositories touched, last tool, last
use). Revoking calls `auth.oauth.revokeGrant` and then
`public.forget_mcp_client`, so the app disappears from the list; its access
tokens still expire on their own within the hour.

## Related authentication boundaries

Ordinary website logout targets only its browser session, preserving independently
authorized MCP connections. Browser refresh follows Supabase auth events:
retryable failures preserve existing state, while authoritative sign-out clears
it. An indeterminate cold start retries with capped backoff instead of presenting
a false signed-out state, and displays a retry status while authentication is
unavailable.

The control plane accepts interactive identities or resource-bound MCP identities
when resolving the current account and checking membership. This protects both
RLS reads and security-definer RPCs from OAuth tokens for other resources. Public
publications and API-token capabilities retain their independent authorization.
Published directory names are matched as literal path prefixes with a slash
boundary, including names containing `%`, `_`, or backslashes.

JWKS cache persistence is optional: disk failures cannot reject an otherwise
verified token. Writes are serialized and atomic to preserve the restart cache.
An unknown signing key can trigger a coalesced refresh at most once per five
seconds. A key missing from an authoritative fresh response remains invalid;
an unseen key during the refresh throttle produces a retryable 503. This avoids
prompting for login during key rotation without allowing unrestricted refetches.

## Rollout

Apply migrations through `20260911000100_oauth_client_resource.sql` and retain
`private.custom_access_token_hook` as the configured Auth hook. The new migration
installs the mapping, approval trigger, and token hook atomically.

It imports only clients with one compatible resource among their proven legacy
bindings. Legacy sessions with that exact binding continue refreshing. Ambiguous
clients and older sessions without a proven binding need a reconnect; using a
different resource requires a new client registration.

**Rollout interrupts unfinished authorizations:** pending and approved codes are
marked denied because they predate the new approval policy. Users mid-login must
start a fresh authorization. Established sessions and user consent records are
preserved. This prevents an older foreign-resource code from borrowing a newly
created client mapping. Tests apply changes only to the local Supabase stack;
production deployment is separate.

For persistent connections, retain short-lived access tokens and refresh-token
rotation. MCP clients must save each replacement refresh token securely and
retain it across restarts. Avoid time-boxed sessions, inactivity timeouts, or
single-session settings if persistent connections are the intended policy.
The migration does not change project-wide Supabase session settings or
third-party client behavior.

## Validation

With the local Supabase stack running and migrations applied:

```sh
pnpm --dir database test
pnpm --dir database test:oauth
```

The HTTP test first replays the actual migration over representative legacy
records inside a rolled-back transaction, including conflicting client resources
and old pending/approved codes. It then exercises real dynamic registration, parallel consent approval,
code exchange, refresh rotation, process restart, browser logout, grant
revocation, and PostgREST/RPC permissions. It also seeds expired approvals and
checks that they do not block concurrent exchanges, that used/expired codes are
rejected, and that different-resource approval cannot rebind the client.
The database tests cover protected mapping writes, forged claims, unknown
clients, legacy session isolation, and local issuer restrictions. These checks
do not exercise a specific MCP client's UI. Fixtures are removed in `finally`;
credentials are never printed.

The database CI lane runs both pgTAP and the real Auth lifecycle test using the
pinned Supabase CLI. Local container names can be overridden with
`LIXRAY_TEST_DB_CONTAINER`, `LIXRAY_TEST_AUTH_CONTAINER`, and
`LIXRAY_TEST_REST_CONTAINER`.
