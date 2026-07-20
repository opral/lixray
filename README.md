# LixRay

TanStack Start control plane plus a multi-workspace Rust Lix service, backed by
Supabase identity and SlateDB object storage.

Production is deployed at `https://lixray.com`.

The repository is split into three product modules:

- `web-app/` contains the TanStack Start application, Cloudflare Worker, and
  Atelier integration.
- `lix-server/` contains the Rust Lix HTTP service and its container image.
- `database/` contains the Supabase schema, migrations, seeds, and tests.

## Architecture

- Supabase Auth provides Google-only sign-in.
- Application-owned Supabase tables model organizations, memberships,
  invitations, and workspaces.
- One organization can contain many workspaces. Every organization member can
  use and create workspaces; owners additionally administer the organization.
- Every workspace UUID selects an isolated SlateDB object prefix. The target
  architecture routes all workspace IDs through one bounded, multi-workspace
  `lix-server` process.

The LixRay web service serves the TanStack Start application and handles
`/healthz`, the authenticated `/mcp` endpoint, OAuth protected-resource
discovery, and workspace-scoped `/@namespace/workspace/lix/v1/*` requests
before delegating all other routes to Start. The temporary Cloudflare Worker
production deployment invokes this same application handler during the Railway
cutover.

Pull requests use Railway environments containing the real web and
`lix-server` images. Preview workspace data uses the same S3-compatible SlateDB
path as production, isolated by Railway environment ID. Local development uses
MinIO; previews and production can use R2. Production continues to use its
Durable Object Container and R2 architecture until the Railway production
cutover.

## ChatGPT MCP app

LixRay exposes a stateless Streamable HTTP MCP server at:

```text
https://lixray.com/mcp
```

`GET /.well-known/oauth-protected-resource` advertises the LixRay resource and
the Supabase Auth OAuth 2.1 server. ChatGPT dynamically registers a client,
uses PKCE, and sends a Supabase ES256 access token bound to
`resource=https://lixray.com`. The Worker validates the token's issuer,
audience, expiry, authenticated role, OAuth client ID, scope, and resource on
every MCP request.

The MCP server provides eleven data-only tools:

- discovery: `list_workspaces`, `list_branches`
- reads: `list_directory`, `find_files`, `read_file`
- writes: `write_file`, `edit_file`, `create_directory`, `move_entry`,
  `delete_entry`
- raw SQL: `execute`

Every branch-scoped operation names an existing workspace. Its `branch_id` is
optional: omitting it resolves the workspace's current branch, analogous to
Git's `origin/HEAD`, at the start of the tool call. `list_branches` returns that
pointer as `current_branch_id` and omits hidden branches and legacy non-UUID
IDs, including the internal `global` branch. File-tool calls require canonical
absolute paths and valid UTF-8 content of at most 1 MiB. File tools return the
entry's public Lix `changeId`. Replacements, edits, moves, and deletes accept it
as `expected_change_id`; stale operations fail without changing the entry. The
input is optional, in which case LixRay reads the current change ID immediately
before applying the mutation. Creates and moves never overwrite existing
destinations, and directory deletion requires `recursive=true`. The `execute`
tool accepts an
ordered array of raw Lix SQL statements and per-statement wire-format
parameters, is marked destructive, and bypasses these file-tool safeguards.
The normal remote Lix client sends the array through `executeBatch`, so every
statement commits atomically and returns one ordered result; a failure rolls
back the complete batch. Numbered `$n` and anonymous `?` parameters refer to
their statement's parameter array.

The `/oauth/consent` page preserves the Google sign-in return path and shows
the requesting client, scopes, and file permissions before allowing approval
or denial.

## HTTP API

- `GET /healthz` returns Worker health without authentication or container
  startup.
- `/@namespace/workspace/lix/v1/*` exposes the canonical Lix server protocol,
  including branch operations, `execute`, atomic `execute-batch`, and
  multiplexed `observe`.

The workspace runtime exposes no LixRay-specific sidecar routes. Browser and
MCP consumers perform every Lix operation through the normal remote Lix client.

All production workspace routes require a Supabase access token:

```text
Authorization: Bearer <Supabase access token>
```

The Worker verifies the ES256 JWT against Supabase JWKS, then resolves the
namespace and workspace slug through the Supabase Data API with the same user
token. Row Level Security proves membership. The Worker strips the public
workspace prefix and `Authorization` header, then forwards the request to the
Rust workspace service at `/workspaces/<workspace-id>/lix/v1/*`.

Invalid authentication returns `401`; missing or inaccessible workspaces return
`404` without revealing whether the workspace exists.

## Workspace storage

Each workspace routes to isolated runtime and storage state:

```text
workspace runtime key = <workspace UUID>
R2 object prefix = <workspace UUID>/
```

One `lix-server` process can host multiple workspaces. It opens runtimes lazily,
coalesces concurrent opens, and evicts idle runtimes from a bounded warm cache.
`LIXRAY_MAX_OPEN_WORKSPACES` controls that bound and defaults to `32`.

There is no fallback to `lixray/default`. The Supabase cutover is a fresh start;
old Clerk organization prefixes are not mapped into new workspaces. Leave them
in place for rollback until a separate, confirmed deletion step.

## Supabase setup

Install dependencies and start the local Supabase stack:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir database start
pnpm --dir database test
```

Link and apply migrations to the intended Supabase project from an
authenticated Supabase CLI session:

```sh
pnpm --dir database exec supabase login
pnpm --dir database exec supabase link --project-ref <project-ref>
pnpm --dir database exec supabase db push
```

In the Supabase Dashboard for the development project:

1. Enable the Google provider and provide its Google OAuth client ID and secret.
2. Disable email authentication.
3. Set the site URL to `http://localhost:8787`.
4. Add `http://localhost:8787/auth/callback` to the redirect allow list.

In Google Auth Platform, add `http://localhost:8787` as an authorized JavaScript
origin and use the Supabase project's `/auth/v1/callback` URL as the authorized
redirect URI. Production needs equivalent entries for `https://lixray.com` and
its production Supabase project.

The checked-in Supabase URL, publishable key, and JWKS URL are public
configuration. `SUPABASE_SECRET_KEY` is deliberately unused: browser queries and
Worker authorization use the user's JWT plus RLS.

### Enable MCP OAuth in Supabase

Apply `20260710180000_lixray_mcp_oauth.sql` before enabling the OAuth server.
The migration installs the custom access-token hook and RLS restrictions. MCP
tokens can select only their accessible organization/workspace names and IDs;
they cannot read profiles, rosters, or invitations, or mutate account and
workspace metadata. Normal browser sessions retain their existing policies.

Then configure the production project in Supabase Dashboard:

1. Under **Authentication → OAuth Server**, enable the OAuth 2.1 server.
2. Set the authorization/consent path to `/oauth/consent`.
3. Enable dynamic client registration for personal ChatGPT developer-mode use.
4. Under **Authentication → Hooks**, enable the custom access-token hook and
   select `private.custom_access_token_hook`.
5. Confirm the production site URL is `https://lixray.com`, the Google provider
   is enabled, and `https://lixray.com/auth/callback` is allowed.

After deployment, verify these endpoints before connecting ChatGPT:

```sh
curl https://lixray.com/.well-known/oauth-protected-resource
curl -i https://lixray.com/mcp
```

The second command should return `401` with a `WWW-Authenticate` challenge that
points back to the protected-resource metadata. Use MCP Inspector to verify
discovery, consent, token refresh/revocation, `initialize`, `tools/list`, and a
read/write/conflict cycle.

The website login and MCP authorization are separate sessions. A working
browser preview does not prove that an MCP client received and persisted its
OAuth credentials. Supabase's authorization-code exchange returns a refresh
token without an `offline_access` resource scope; do not add `offline_access`
to the protected-resource metadata.

For a non-interactive post-authorization check, run the probe with a temporary
OAuth access token (never commit or paste the token into logs):

```sh
cd web-app
LIXRAY_MCP_ACCESS_TOKEN='<token>' pnpm check:mcp
```

The probe starts a new MCP client, performs `initialize`, requests
`tools/list`, calls `list_workspaces`, and fails if the discovery metadata does
not advertise the authorization-code and refresh-token grants. Set
`LIXRAY_MCP_URL` to test an environment other than `https://lixray.com/mcp`.

Use one production registration with an explicit OAuth resource:

```sh
codex mcp add LixRay \
  --url https://lixray.com/mcp \
  --oauth-resource https://lixray.com
codex mcp login LixRay
```

Only register the local server while actively developing it, under the distinct
name `LixRay-Localhost`:

```sh
codex mcp add LixRay-Localhost \
  --url http://localhost:8787/mcp \
  --oauth-resource https://lixray.com
```

Do not leave production and inactive localhost or preview registrations enabled
together. Check `codex mcp list` and remove stale entries before reconnecting.
If Codex reports `No refresh token available`, run `codex mcp logout <name>`
followed by `codex mcp login <name>`. If it recurs, record the Codex version,
exact MCP URL, and attempt time without recording either token. A successful CLI
login should still be followed by a fresh-task `list_workspaces` call.

In ChatGPT, enable developer mode, create a developer-mode app named
**LixRay**, describe it as a safe workspace file editor, and use
`https://lixray.com/mcp` as its MCP URL.

## Local development

There is one production-shaped local loop:

```sh
pnpm dev
```

It starts local Supabase and its migrations, waits for Auth, creates the
deterministic local developer account, then starts Docker Compose:

```text
browser -> lixray-web -> lix-server -> MinIO
             |              |
             `---- Supabase-'
```

`lixray-web` reaches `lix-server` only on the Compose network; `lix-server`
uses MinIO through the same S3 API that targets R2 outside local development.
Open `http://127.0.0.1:8787`, choose **Continue as local developer**, and use
the normal organization and workspace flows. Ctrl-C stops the web service,
workspace service, MinIO, and local Supabase without deleting their volumes.

Use `LIXRAY_DEV_PORT` to choose another public web port. There is intentionally
no standalone `web-app` dev command: local development and E2E exercise the
Compose web service rather than Cloudflare's local container runtime.

## Verification

```sh
pnpm --dir web-app typecheck
pnpm --dir web-app lint
pnpm --dir web-app test:worker
pnpm --dir database start
pnpm --dir database test
pnpm test:e2e
pnpm --dir web-app build
cargo test --manifest-path lix-server/Cargo.toml
docker build -f lix-server/Dockerfile .
```

Install Playwright Chromium once with:

```sh
pnpm --dir web-app exec playwright install chromium
```

`pnpm test:e2e` starts the same local Supabase plus Compose topology on port
`8790` by default. The browser signs in as the local developer, creates a real
Supabase workspace, verifies the normal Lix handshake through `lixray-web` and
`lix-server`, then runs a query. Set `E2E_PORT` to override the port.

## Performance loop

The performance loop uses the production `lix-server` image and persistent
MinIO object storage through the same S3 API used for R2:

```sh
pnpm perf:reset
pnpm perf:up
pnpm perf:seed
pnpm perf:run -- --output perf/results/baseline.json
# edit vendor/lix or lix-server
pnpm perf:reset
pnpm perf:up
pnpm perf:seed
pnpm perf:run -- --compare perf/results/baseline.json
pnpm perf:down
```

The runner warms each named query, reports p50/p95/mean latency, and writes the
raw samples as JSON. Override the service with `LIXRAY_PERF_URL` or select other
fixture/workload files with `--fixture` and `--workload`. A hosted service that
sets `LIXRAY_INTERNAL_TOKEN` can be exercised by setting the same variable on
the runner.

## Deployment

### Railway

Railway is the deploy target for the portable two-service topology:

```text
browser -> lixray-web -> lix-server -> R2
```

The deployment rule is intentionally simple:

- merging to `main` deploys both services to Railway production;
- opening or updating a pull request creates an isolated Railway preview;
- pull-request environments sleep when idle; production stays awake.

[`railway.json`](./railway.json) defines `lix-server`;
[`web-app/railway.json`](./web-app/railway.json) defines `lixray-web`.
Each service builds from the repository root, includes the PR-pinned
`vendor/lix` checkout, exposes `/healthz`, and has no provider-specific
workspace runtime.

Infisical is the source of truth for runtime configuration. Its Railway syncs
are pinned to the target environment and service:

```text
Production  /railway/lix-server  -> Railway production / lix-server
Production  /railway/lixray-web  -> Railway production / lixray-web
Development /railway/lix-server  -> Railway preview-base / lix-server
Development /railway/lixray-web  -> Railway preview-base / lixray-web
```

The production `lix-server` service receives:

```text
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=<production-bucket>
S3_ACCESS_KEY_ID=<production-access-key>
S3_SECRET_ACCESS_KEY=<production-secret-key>
S3_REGION=auto
LIXRAY_MAX_OPEN_WORKSPACES=4
LIXRAY_INTERNAL_TOKEN=<random secret>
RUST_LOG=lixray=info
```

The production `lixray-web` service receives the same
`LIXRAY_INTERNAL_TOKEN`, a private
`LIXRAY_WORKSPACE_SERVICE_URL=http://lix-server.railway.internal:8080`, and
the production Supabase URL, JWKS URL, and publishable key. It also needs
`VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` at build time; these public browser
values are baked into the Vite bundle.

Use a dedicated preview R2 bucket in the Railway PR base environment. Leave
`S3_PREFIX` unset: `lix-server` then namespaces storage under the Railway
environment ID, so previews share credentials without sharing workspace data.
Preview web deployments use the same real Supabase configuration until we add
isolated Supabase preview projects; they do not have a demo-only runtime path.

GitHub Actions receives no runtime secrets: it only runs CI, while Railway
deploys from the connected GitHub branch. Supabase project settings, auth
provider credentials, and migrations remain provider-native; this app has no
Supabase Edge Functions to sync.

Before treating the deployment as healthy, smoke-test the generated Railway web
domain with sign-in, workspace creation, a Lix handshake, and a query. Attach
`lixray.com` only after that succeeds. The legacy Cloudflare Worker and its old
R2/Supabase data remain untouched until this traffic switch; then remove the
Worker/DO runtime and destroy the retired resources as one hard cut.

Exercise a hosted service directly with:

```sh
LIXRAY_PERF_URL=https://<pr-domain> \
LIXRAY_INTERNAL_TOKEN=<preview-token> \
pnpm perf:seed

LIXRAY_PERF_URL=https://<pr-domain> \
LIXRAY_INTERNAL_TOKEN=<preview-token> \
pnpm perf:run
```

Before treating the deployment as successful, verify that Railway checked out
the `vendor/lix` submodule, the first preview request wakes a sleeping service,
and closing the PR removes its environment. Set a workspace compute hard limit
as a final cost guardrail.
