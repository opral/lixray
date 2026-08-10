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

Requirements: Node.js 22, pnpm 10.13.1, Rust, Docker, the Supabase CLI, and
the Infisical CLI authenticated to the LixRay project.

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:8787` and choose **Continue as local developer**.
`pnpm dev` loads the Infisical `dev` environment, starts Supabase, applies
migrations, creates the local account, runs the stateful backend services with
Compose, and serves the web app with Vite.
Edits in `web-app` and `vendor/atelier` update through HMR. Ctrl-C stops Vite;
the backend services remain available for the next run. Use `pnpm dev --down`
to stop the services. The local web and MCP endpoint always use port `8787`.

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

When changing the vendored Lix or Atelier revisions, run `pnpm vendor:sync`.
It updates the Railway revision manifest and regenerates both Rust and pnpm
lockfiles. `pnpm vendor:check` verifies that those derived files are committed
and in sync.

Run the frontend source checks locally with `pnpm run ci`. Pull-request CI builds
the production Railway bundle once through `web-app/Dockerfile`, so the
frontend lane does not repeat that production build.

The same acceptance path used by CI is available locally:

```sh
pnpm --dir web-app format:check
pnpm --dir web-app lint
pnpm --dir web-app check
VITE_SUPABASE_URL=https://example.invalid \
VITE_SUPABASE_KEY=ci-public-placeholder \
pnpm --dir web-app ci:build:node
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

For local MCP testing, configure exactly one MCP connection. Remove the
installed production plugin and connection from the local Codex configuration,
then register and authenticate the local endpoint:

```sh
codex plugin remove lixray@personal
codex mcp remove LixRay
codex mcp add LixRay_Dev \
  --url http://127.0.0.1:8787/mcp \
  --oauth-resource http://127.0.0.1:8787
codex mcp login LixRay_Dev
```

Do not keep `LixRay` and `LixRay_Dev` enabled in the same local Codex task.

For production-only Codex configuration, register LixRay using:

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

GitHub Actions builds immutable web and server images on pull requests, tags
them by reusable inputs and the Git tree hash, and runs the Compose browser flow
against the server digest. Trees with unchanged inputs reuse existing images.
In-progress runs for the same pull request are cancelled, and the stable `CI`
job remains the merge gate.

The separate `Production` workflow is promotion-only. Pushes to `main` must
resolve both tested `tree-*` images before applying database migrations. The
workflow then points both Railway services at those GHCR digests, starts them
together, and waits up to ten minutes for both health checks. Production never
waits for an independent Railway build and never rebuilds merged source.

Railway still creates preview environments and builds their demo web service:

- pull requests create an isolated Railway demo environment with a built-in
  preview user, then CI points its server service at the tested image;
- merging to `main` applies database migrations and promotes the tested web and
  server image digests together;
- `railway.json` and `web-app/railway.json` define the two services;
- Infisical syncs runtime configuration to Railway;
- deployment and registry credentials come from Infisical via short-lived
  GitHub OIDC authentication.

Put these secrets in the Infisical `prod` environment under `/ci`:

- `RAILWAY_API_TOKEN`: a Railway workspace token, which can discover and
  update both production and ephemeral environments;
- `RAILWAY_PROJECT_ID`: the Railway project ID;
- `RAILWAY_SERVER_SERVICE`: the `lix-server` service name or ID;
- `RAILWAY_WEB_SERVICE`: the `lixray-web` service name or ID;
- `RAILWAY_PRODUCTION_ENVIRONMENT`: the production environment name or ID;
- `GHCR_READ_USERNAME`: the GitHub user owning a classic PAT;
- `GHCR_READ_TOKEN`: that PAT with `read:packages`.
- `VITE_SUPABASE_URL`: the public production Supabase project URL;
- `VITE_SUPABASE_KEY`: the public production Supabase publishable key.

Create separate Infisical OIDC machine identities for pull requests and the
GitHub `production` environment. Give both read access only to `/ci`, bind
their subjects to `repo:opral/lixray:pull_request` and
`repo:opral/lixray:environment:production`, and use
`https://github.com/opral` as the audience. Configure their public identifiers
as GitHub Actions variables:

- `INFISICAL_PROJECT_SLUG`;
- `INFISICAL_PREVIEW_IDENTITY_ID`;
- `INFISICAL_PRODUCTION_IDENTITY_ID`.

The production web image reads the public Supabase and PostHog configuration
from the build environment at build time. Supabase values come from Infisical
`/ci`; PostHog values come from GitHub Actions variables:

- `VITE_PUBLIC_POSTHOG_TOKEN`;
- `VITE_PUBLIC_POSTHOG_HOST`.

No deployment secret is stored in GitHub. Preview promotion is skipped when its
Infisical identity is absent; production configuration is required and fails
fast when incomplete.

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

Railway GitHub autodeploy stays enabled for preview web services and **Wait for
CI stays disabled**. Both production services are image-managed; the Production
workflow is their only deployment initiator. The preview base keeps the server
image-managed while Railway builds the demo web service from the pull request.
CI verifies that the preview server remains image-managed and retries one failed
or timed-out promotion before failing the check.
Preview data is disposable and isolated by the Railway environment.
Database-sensitive changes continue to use local Compose or an explicitly
requested integration environment.

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
