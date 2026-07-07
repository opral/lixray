# lixray

Cloudflare Worker + TanStack Start frontend + Durable Object Container exposing
Lix over HTTP, backed by SlateDB on R2.

Production is deployed at:

```text
https://lixray.com
```

Cloudflare state:

- Account: `Opral` (`11a1a6f76d167248cc6987e978efb7e5`)
- Zone: `lixray.com`
- Worker: `lixray`
- Custom Domain: `lixray.com`
- R2 bucket: `lixray`
- SlateDB path: `<Clerk org id>/`

## Frontend

The Worker serves the TanStack Start app and handles `/healthz` plus `/v1/*`
before delegating all other routes to Start.

- `/sign-in` and `/sign-up` use Clerk hosted components.
- `/` is the signed-in workspace dashboard.
- `/workspace` exposes Clerk organization selection, member management, and
  invitations.

A workspace is exactly a Clerk Organization. Personal workspaces are disabled.

## API

- `GET /healthz` returns Worker health without auth or container startup.
- `GET /v1/container-health` checks the Rust container after Clerk auth.
- `GET /v1/branches` lists Lix branches so clients can discover the generated
  `main` branch id.
- `POST /v1/createBranch` creates a branch from a supplied `branchId`.
- `POST /v1/execute` executes one Lix SQL statement on a supplied `branchId`.
- `POST /v1/observe` streams Lix observe events as POST SSE.

All `/v1/*` routes require a Clerk session token from a signed-in user with an
active organization:

```text
Authorization: Bearer <Clerk session token>
```

Requests without a valid Clerk session return `401`. Requests with a valid
session but no active organization return `403 Active workspace required`.
Workspace routing only uses the `orgId` from Clerk auth; the Worker does not
accept workspace ids from headers, query params, or request bodies.

Values use Lix wire values:

```json
{ "kind": "text", "value": "hello" }
{ "kind": "blob", "base64": "aGVsbG8=" }
```

## Workspace storage

Each active Clerk organization routes to one Durable Object Container:

```text
container name = <Clerk org id>
SLATEDB_PATH = <Clerk org id>
R2 object prefix = lixray/<Clerk org id>/
```

The Rust service requires `SLATEDB_PATH`. There is no fallback to
`lixray/default`.

After production cutover, delete every object under the old `lixray/default`
prefix from the `lixray` R2 bucket. Do this as an explicit operator step after
confirming no deployed Worker version still points at the default prefix.

## Local development

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets. `.dev.vars` is
ignored and must not be committed. The dev Clerk publishable key is committed in
`.env.development` so Vite serves the local app against the Clerk development
instance.

Use Clerk development keys locally, then run:

```sh
pnpm dev
```

The app is served at `http://localhost:8787`. `pnpm dev` forces
`SLATEDB_STORAGE=memory`, so local development does not depend on R2 credentials.
Restart the dev server after changing storage mode so existing containers do not
keep old startup env.

Run against R2 explicitly when needed:

```sh
pnpm dev:r2
```

## Iteration workflow

Before deploying:

```sh
pnpm typecheck
pnpm test:worker
pnpm test:e2e
pnpm build
cargo test
docker build .
pnpm run deploy:worker --dry-run
```

Install the Playwright browser once before running e2e tests:

```sh
pnpm exec playwright install chromium
```

The e2e suite fails on browser runtime errors, console errors, and Vite's error
overlay. It also runs the workspace dashboard under a localhost-only e2e auth
mode and asserts that `/v1/branches` returns at least one branch and
`SELECT 1 AS one` succeeds:

```sh
pnpm test:e2e
```

Playwright starts its own dev server on `http://localhost:8790` by default so it
does not reuse a stale `pnpm dev` process on port `8787`. Override that with
`E2E_PORT` when needed. The default e2e server uses in-memory SlateDB storage so
it is deterministic and does not depend on local R2 secrets.

Run the R2-backed e2e check explicitly when validating the same storage path used
by R2 local development:

```sh
pnpm test:e2e:r2
```

Deploy:

```sh
pnpm run deploy:worker
```

The `deploy:worker` script is used instead of `pnpm deploy` because `pnpm
deploy` is pnpm's own workspace command.

Workers Builds should use:

- Project root: `/` when connected to the `lixray` repository, or
  `submodule/lixray` when connected through the parent `flashtype` repository
- Production branch: `main`
- Build command: `pnpm run check:cloudflare`
- Deploy command: `pnpm run deploy:worker`
- Worker name: `lixray`

Enable Workers Builds build caching. The Dockerfile uses BuildKit cache mounts
for the Cargo registry, git checkouts, and target directory; without
Cloudflare's build cache enabled, every deployment recompiles the
Lix/DataFusion dependency graph from scratch.

Do not run `cargo test` in the Workers Builds build command. `wrangler deploy`
builds the container image and compiles the Rust release binary, so running the
full `pnpm check` first causes two Rust compiles in the same Cloudflare build
and can exceed the 20 minute Workers Builds timeout.

## Runtime config

Non-secret production values are checked into `wrangler.jsonc`:

```text
CLERK_APP_ID=app_3GBViGp1pL2PtKZ2jU5vMWQcSik
VITE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsubGl4cmF5LmNvbSQ
R2_ENDPOINT=https://11a1a6f76d167248cc6987e978efb7e5.r2.cloudflarestorage.com
R2_BUCKET=lixray
R2_REGION=auto
SLATEDB_STORAGE=r2
```

Production secrets live in Cloudflare Worker secrets:

```text
CLERK_SECRET_KEY
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

To rotate a secret:

```sh
pnpm wrangler secret put CLERK_SECRET_KEY --config ./wrangler.jsonc
pnpm wrangler secret put R2_ACCESS_KEY_ID --config ./wrangler.jsonc
pnpm wrangler secret put R2_SECRET_ACCESS_KEY --config ./wrangler.jsonc
```

R2 S3 credentials are created in the Cloudflare dashboard under R2 API tokens.
Use an account token with Object Read & Write access scoped to the `lixray`
bucket.
