# Persistent MCP authorization

LixRay stores each OAuth session's approved resource in
`private.oauth_session_resources`. The custom access-token hook copies that
binding into every access token. Supabase continues to own sessions, refresh
rotation, expiry, client authentication, and grant revocation. Resource
validation at the MCP endpoint is unchanged.

## Initial binding on hosted Supabase

The current Supabase hook event provides `session_id`, `client_id`, user, scopes,
and authentication method, but no authorization-code identifier. With Auth
v2.195.0, the code exchange locks its approved authorization row, creates the
session, invokes the hook, then deletes that row in the same transaction.

The hook initializes a binding only for `oauth_provider/authorization_code`.
It checks the session against the event and reads all approved authorizations
for the user/client in one database snapshot. Exactly one candidate establishes
which authorization is being exchanged: the actual locked row must still be in
that set. The hook validates its resource and scopes and saves its ID with the
session binding. It never chooses the newest row, filters candidates by expiry
or permissions, or trusts an incoming custom `resource` claim.

This is a compatibility solution for the current hosted API. Two outstanding
approved authorizations for the same user/client cause initial exchange to fail
closed, including an expired approved record still awaiting cleanup. Resolving
those outstanding transactions is necessary before retrying; repeatedly opening
new consent flows does not resolve ambiguity. Established sessions continue to
refresh even while other authorizations are pending or approved.

The long-term upstream improvement is for Supabase to persist the exact
`authorization.Resource` during code exchange and expose that session value on
every issuance. If that becomes available, replace the singleton bootstrap with
that supported input. Do not merely start trusting a `resource` field without
verifying its provenance. The HTTP regression is a required check when changing
Supabase Auth versions or the hook contract.

## Refresh and revocation

Refresh reads only the saved binding and verifies the session's user, client,
and scopes still match it. The hook never updates an existing binding. A
missing binding rejects issuance with a hook error rather than issuing a token
that MCP will reject later. Application roles cannot read or change the table
or execute the hook. Deleting a Supabase session cascades to its binding. The
normal OAuth grant revocation endpoint deletes that user's sessions for the
client and prevents further refreshes.

Already-issued access tokens remain valid until their normal expiry; this change
does not add per-request session revocation lookups.

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

Apply both `20260909000000_durable_oauth_resource.sql` and
`20260909000100_control_plane_resource_boundary.sql`, and retain the configured
`private.custom_access_token_hook`. No production changes are made by running
the local tests. Verify the production hook and Auth version before rollout.
The migration intentionally does not guess bindings for existing sessions:
pre-migration MCP connections need one reconnect at their next refresh.

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

The HTTP test uses synthetic local consent and actual GoTrue code exchange,
refresh, logout, and revocation endpoints, plus the PostgREST Data API. It verifies natural authorization deletion,
refresh-token rotation, restart in another process, resource/client isolation,
ambiguous initial exchange rejection, and rejection of legacy sessions without
bindings. It also verifies that local website logout preserves MCP access and
that foreign-resource tokens cannot read private metadata. It invokes the same pure claims validator as the MCP worker, without
installing the frontend or starting a browser. It does not exercise a specific
MCP client's UI. Fixture users and clients are removed in `finally`; credentials
are passed through private pipes and never printed.

The database CI lane runs both pgTAP and the real Auth lifecycle test using the
pinned Supabase CLI. Local container names can be overridden with
`LIXRAY_TEST_DB_CONTAINER`, `LIXRAY_TEST_AUTH_CONTAINER`, and
`LIXRAY_TEST_REST_CONTAINER`.
