# LixRay

LixRay is a collaborative workspace app built from a TanStack Start control
plane and a multi-workspace Rust Lix service. Supabase provides identity and
application data; SlateDB stores workspace data in S3-compatible object
storage.

Production: [lixray.com](https://lixray.com)

## Repository layout

- `web-app/` — TanStack Start app, MCP server, and Atelier integration
- `lix-server/` — Rust Lix HTTP service and container image
- `database/` — Supabase schema, migrations, seeds, and database tests
- `vendor/` — pinned Lix and Atelier submodules

## Architecture

```text
browser / MCP client -> lixray-web -> lix-server -> R2
                            |
                         Supabase
```

Every workspace maps to an isolated SlateDB object prefix. One bounded
`lix-server` process hosts multiple workspaces, opens them lazily, and evicts
idle runtimes. Local development uses the same topology with MinIO in place of
R2.

The web service owns authentication, organization and workspace resolution,
`/healthz`, `/mcp`, and the workspace-scoped Lix protocol. Supabase row-level
security proves workspace access before a request reaches `lix-server`.

## Setup

Requirements: Node.js 22, pnpm 10.13.1, Rust, Docker, and the Supabase CLI.

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:8787` and choose **Continue as local developer**.
`pnpm dev` starts Supabase, applies migrations, creates the local account, and
starts the Compose services. Ctrl-C stops the services without deleting their
volumes. Set `LIXRAY_DEV_PORT` to use another port.

For a hosted Supabase project, link the CLI and apply migrations:

```sh
pnpm --dir database exec supabase login
pnpm --dir database exec supabase link --project-ref <project-ref>
pnpm --dir database exec supabase db push
```

Enable Google authentication, disable email authentication, and configure the
site URL plus `/auth/callback` redirect in both Supabase and Google. Browser and
server access use the user's JWT with RLS; no Supabase secret key is required.

## Verification

The same acceptance path used by CI is available locally:

```sh
pnpm --dir web-app format:check
pnpm --dir web-app lint
pnpm --dir web-app check:cloudflare
pnpm --dir web-app build
cargo fmt --manifest-path lix-server/Cargo.toml --check
cargo clippy --manifest-path lix-server/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo test --manifest-path lix-server/Cargo.toml --locked
pnpm --dir database start
pnpm --dir database test
pnpm --dir web-app exec playwright install chromium
pnpm test:e2e
```

The browser test starts local Supabase and the Compose topology, signs in,
creates a workspace, completes a Lix handshake, and runs a query. Set
`E2E_PORT` to override its default port (`8790`).

## MCP and HTTP API

The Streamable HTTP MCP endpoint is:

```text
https://lixray.com/mcp
```

It exposes workspace and branch discovery, file operations, and atomic raw Lix
SQL execution. OAuth protected-resource metadata is served from
`/.well-known/oauth-protected-resource`; MCP access tokens are Supabase ES256
tokens bound to `https://lixray.com`.

Register LixRay with Codex using:

```sh
codex mcp add LixRay \
  --url https://lixray.com/mcp \
  --oauth-resource https://lixray.com
codex mcp login LixRay
```

Useful HTTP endpoints:

- `GET /healthz` — unauthenticated service health
- `/@namespace/workspace/lix/v1/*` — authenticated canonical Lix protocol
- `/mcp` — authenticated MCP transport

Apply `database/supabase/migrations/20260710180000_lixray_mcp_oauth.sql`
before enabling Supabase's OAuth server, dynamic client registration, and the
`private.custom_access_token_hook`. The consent path is `/oauth/consent`.

Probe a configured environment with a temporary token:

```sh
LIXRAY_MCP_ACCESS_TOKEN='<token>' pnpm --dir web-app check:mcp
```

## CI and deployment

GitHub Actions runs one `CI` job for pull requests and pushes to `main`. It
checks the database, frontend, Railway build, Rust service, generated files,
submodule pins, and the Compose browser flow. In-progress runs for the same ref
are cancelled.

Railway handles deployment outside GitHub Actions:

- pull requests create an isolated preview environment;
- Supabase creates a data-less branch for every pull request;
- `.github/workflows/supabase-preview.yml` injects that branch's URL and
  publishable key into the matching Railway environment before redeploying it;
- merging to `main` deploys both services to production;
- `railway.json` and `web-app/railway.json` define the two services;
- Infisical syncs runtime configuration to Railway;
- GitHub Actions authenticates to Infisical with OIDC and receives only
  narrowly scoped preview-provisioning secrets, never production runtime
  credentials or stored GitHub Actions secrets.

Both services share `LIXRAY_INTERNAL_TOKEN`. The web service reaches the Rust
service through Railway's private network. Production and preview environments
use separate S3 storage configuration; when `S3_PREFIX` is unset, the server
namespaces data by Railway environment ID. Preview environments never inherit
production Supabase credentials: they fail closed until the per-PR Supabase
branch is ready. The workflow seeds a branch-local preview account and builds
the web app with that account instead of Google OAuth, because every Supabase
branch has a unique provider callback URL. Its random password exists only for
the lifetime of that workflow run and the matching Railway preview.

Infisical is the source of truth for preview provisioning. Its production
environment contains these secrets under `/preview-automation`:

- `SUPABASE_ACCESS_TOKEN` — access to read preview-branch credentials;
- `RAILWAY_API_TOKEN` — workspace-scoped access to update ephemeral PR
  environments (Railway project tokens cannot access derived environments).

The `lixray-github-preview` machine identity can read the project via GitHub
OIDC for `opral/lixray`'s `main` workflow context. Dynamic per-PR Supabase
credentials are derived from Supabase Branching and written only to the
matching Railway preview environment.

## Performance loop

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

Set `LIXRAY_PERF_URL` and `LIXRAY_INTERNAL_TOKEN` to exercise a hosted service.
Use `--fixture` and `--workload` to select other performance inputs.
