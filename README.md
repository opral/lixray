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
`lix-server` process hosts multiple lixes, opens them lazily, and evicts
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
`pnpm dev` starts Supabase, applies migrations, creates the local account, runs
the stateful backend services with Compose, and serves the web app with Vite.
Edits in `web-app` and `vendor/atelier` update through HMR. Ctrl-C stops Vite;
the backend services remain available for the next run. Use `pnpm dev --down`
to stop the services, or set `LIXRAY_DEV_PORT` to use another port.

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

- pull requests immediately create an isolated Railway demo environment with a
  built-in preview user;
- merging to `main` deploys both services to production;
- `railway.json` and `web-app/railway.json` define the two services;
- Infisical syncs runtime configuration to Railway;
- GitHub Actions receives no runtime secrets.

Both services share `LIXRAY_INTERNAL_TOKEN`. The web service reaches the Rust
service through Railway's private network. Production and preview environments
use separate S3 storage configuration; when `S3_PREFIX` is unset, the server
namespaces data by Railway environment ID. Preview environments never inherit
production Supabase credentials.

### Fast pull request previews

Railway environments named `lixray-pr-*` automatically build and run in demo
mode. The sign-in screen offers **Continue as preview user** and the server
accepts the matching fixed demo token for the built-in `acme/launch-q3`
workspace. No Supabase URL, key, branch, password, seed job, or provisioning
workflow is involved.

Railway GitHub autodeploy stays enabled and **Wait for CI stays disabled**, so
each push produces one preview build immediately. Preview data is disposable
and isolated by the Railway environment. The `lix-server` service deploys in
parallel for every web preview so the built-in workspace is usable without
external infrastructure. Database-sensitive changes continue to use local
Compose or an explicitly requested integration environment.

## Performance loop

```sh
LIXRAY_PERF_WORKSPACE=perf-baseline-c1000-read4k-r1 pnpm perf:reset
LIXRAY_PERF_SPANS=true \
  RUST_LOG=lixray=info,lix_perf=debug \
  pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --workspace perf-baseline-c1000-read4k-r1 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/baseline.json
# edit vendor/lix or lix-server
LIXRAY_PERF_WORKSPACE=perf-candidate-c1000-read4k-r1 pnpm perf:reset
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --workspace perf-candidate-c1000-read4k-r1 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/candidate.json
pnpm perf:down
```

Set `LIXRAY_PERF_URL` and `LIXRAY_INTERNAL_TOKEN` to exercise a hosted service.
Every invocation seeds a fresh deterministic 1,000-file workspace and measures
one CRUD operation family. See [`perf/README.md`](perf/README.md) for the
operation matrix, exact commit semantics, repetition method, and result schema.
