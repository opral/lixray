# lixray

Cloudflare Worker + TanStack Start frontend + Durable Object Container exposing
Lix over HTTP, backed by SlateDB on R2.

Production is deployed at `https://lixray.com`.

## Architecture

- Supabase Auth provides Google-only sign-in.
- Application-owned Supabase tables model organizations, memberships,
  invitations, and workspaces.
- One organization can contain many workspaces. Every organization member can
  use and create workspaces; owners additionally administer the organization.
- Every workspace UUID selects one Durable Object Container and one SlateDB R2
  prefix.

The Worker serves the TanStack Start application and handles `/healthz`, the
authenticated `/mcp` endpoint, OAuth protected-resource discovery, and
workspace-scoped `/v1/*` requests before delegating all other routes to Start.

## ChatGPT MCP app

Lixray exposes a stateless Streamable HTTP MCP server at:

```text
https://lixray.com/mcp
```

`GET /.well-known/oauth-protected-resource` advertises the Lixray resource and
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

Every operation names an existing workspace and branch. File-tool calls require
canonical absolute paths and valid UTF-8 content of at most 1 MiB. Replacements,
edits, moves, and deletes compare the supplied opaque revision with
`lixcol_change_id`; stale operations fail without changing the file. Creates and
moves never overwrite existing destinations, and directory deletion requires
`recursive=true`. The `execute` tool accepts raw Lix SQL and wire-format
parameters, is marked destructive, and bypasses these file-tool safeguards.

The `/oauth/consent` page preserves the Google sign-in return path and shows
the requesting client, scopes, and file permissions before allowing approval
or denial.

## HTTP API

- `GET /healthz` returns Worker health without authentication or container
  startup.
- `GET /v1/workspaces/:workspaceId/container-health` checks the workspace
  container.
- `GET /v1/workspaces/:workspaceId/branches` lists Lix branches.
- `POST /v1/workspaces/:workspaceId/createBranch` creates a branch.
- `POST /v1/workspaces/:workspaceId/execute` executes one Lix SQL statement.
- `POST /v1/workspaces/:workspaceId/observe` streams Lix observe events as POST
  SSE.

All workspace routes require a Supabase access token:

```text
Authorization: Bearer <Supabase access token>
```

The Worker verifies the ES256 JWT against Supabase JWKS, then looks up the URL's
workspace UUID through the Supabase Data API with the same user token. Row Level
Security proves membership. The Worker strips the workspace prefix and
`Authorization` header before forwarding the request to the Rust container, so
the container continues to expose its internal `/v1/branches`, `/v1/execute`,
and related routes without receiving user credentials.

Invalid authentication returns `401`, malformed workspace UUIDs return `400`,
and missing/inaccessible workspaces return `403` without revealing whether the
workspace exists.

## Workspace storage

Each workspace routes to isolated runtime and storage state:

```text
container name = <workspace UUID>
SLATEDB_PATH = <workspace UUID>
R2 object prefix = lixray/<workspace UUID>/
```

There is no fallback to `lixray/default`. The Supabase cutover is a fresh start;
old Clerk organization prefixes are not mapped into new workspaces. Leave them
in place for rollback until a separate, confirmed deletion step.

## Supabase setup

Install dependencies and start the local Supabase stack:

```sh
pnpm install --frozen-lockfile
pnpm exec supabase start
pnpm exec supabase test db
```

Link and apply migrations to the configured development project from an
authenticated Supabase CLI session:

```sh
pnpm exec supabase login
pnpm exec supabase link --project-ref xpkokrinmkjqcnjzbmpe
pnpm exec supabase db push
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

In ChatGPT, enable developer mode, create a developer-mode app named
**Lixray**, describe it as a safe workspace file editor, and use
`https://lixray.com/mcp` as its MCP URL.

## Local development

Copy `.dev.vars.example` to `.dev.vars` for local R2 secrets when needed.
`.dev.vars` is ignored and must not be committed. The public development
Supabase configuration lives in `.env.development` and `wrangler.jsonc`.

Start with in-memory SlateDB:

```sh
pnpm dev
```

For local workspace development without Google sign-in, use the fixed
localhost-only development identity:

```sh
pnpm dev:authless
```

This mode provides one fixed organization and workspace. Organization and
workspace mutations are unavailable in authless mode.

The app is served at `http://localhost:8787`. Run against R2 explicitly with:

```sh
pnpm dev:r2
```

Restart the dev server after changing storage mode so existing containers do
not retain old startup environment.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test:worker
pnpm exec supabase start
pnpm exec supabase test db
pnpm test:e2e
pnpm build
cargo test
docker build .
pnpm run deploy:worker --dry-run
```

Install Playwright Chromium once with:

```sh
pnpm exec playwright install chromium
```

Playwright starts a deterministic in-memory development server on port `8790`
and uses a localhost-only E2E workspace identity. Use `E2E_PORT` to override the
port or run `pnpm test:e2e:r2` for the R2-backed variant.

## Deployment

```sh
pnpm run deploy:worker
```

Workers Builds should use:

- Project root: `/`
- Production branch: `main`
- Build command: `pnpm run check:cloudflare`
- Deploy command: `pnpm run deploy:worker`
- Worker name: `lixray`

Enable Workers Builds build caching. The Dockerfile uses BuildKit cache mounts
for the Cargo registry, git checkouts, and target directory. Do not run
`cargo test` in the Workers Builds build command: `wrangler deploy` already
builds the container image and Rust release binary, and duplicating the Rust
compile can exceed the build timeout.

Public Worker variables are checked into `wrangler.jsonc`:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_KEY
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_JWKS_URL
R2_ENDPOINT
R2_BUCKET
R2_REGION
SLATEDB_STORAGE
SLATEDB_CACHE_DIR
SLATEDB_CACHE_MAX_BYTES
SLATEDB_BLOCK_CACHE_BYTES
SLATEDB_METADATA_CACHE_BYTES
```

Only the R2 credentials are Worker secrets:

```sh
pnpm wrangler secret put R2_ACCESS_KEY_ID --config ./wrangler.jsonc
pnpm wrangler secret put R2_SECRET_ACCESS_KEY --config ./wrangler.jsonc
```

No Supabase `wrangler secret put` command is needed. After a Clerk-free
deployment has been verified, remove the obsolete secret:

```sh
pnpm wrangler secret delete CLERK_SECRET_KEY --config ./wrangler.jsonc
```

Before production cutover, replace the public development Supabase values with
the production project's values, apply the same migrations, and configure its
Google provider and redirect URLs.
