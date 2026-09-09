# LixRay

LixRay is a collaborative repository app built from a TanStack Start control
plane and the prebuilt Lix reference server. Supabase supports control-plane
identity and metadata; SlateDB stores Lix repositories in S3-compatible object
storage.

Production: [lixray.com](https://lixray.com)

<!-- Content-addressed web image republish trigger; this file is outside hashed inputs. -->

## Repository layout

- `web-app/` — TanStack Start app, MCP server, and Atelier integration
- `database/` — Supabase schema, migrations, seeds, and database tests
- `vendor/` — pinned Lix and Atelier submodules

## Architecture

```text
browser / MCP client -> lixray-web -> lix-server -> R2
                            |
                         Supabase
```

### Architectural boundaries

A Lix repository is a self-contained unit of durable repository state. Content,
repository configuration, and repository-scoped application state belong in the
Lix itself so that cloning, transferring, or hosting the repository elsewhere
does not silently lose behavior or data.

User preferences illustrate this boundary. A preference associated with a
particular repository should be stored as account-scoped state in that Lix,
typically on its global branch when it must apply across working branches. It
should not use a LixRay database table as its source of truth. Transient browser
state may remain in browser storage when it is intentionally local to a tab or
device.

LixRay is the hosting and control plane around those self-contained
repositories. It authenticates users, manages organizations and access,
provisions and resolves repositories, routes requests, and operates the hosted
service. Control-plane databases may index or coordinate repositories, but they
must not become the authority for durable state that needs to travel with a
Lix.

Every repository maps to an isolated SlateDB object prefix. One bounded Lix
reference-server process hosts multiple lixes, opens them lazily, and evicts
idle runtimes. Lix CI retains tested browser SDK and server artifacts for each
reviewed revision, and Lix main publishes content-addressed server images. LixRay
resolves those artifacts from its exact Lix submodule pointer and only compiles
from source when no successful artifact exists. Local development follows the
same resolution path with MinIO in place of R2.

The web service owns authentication, organization and project pages,
`/healthz`, `/mcp`, and the canonical Lix protocol. Supabase row-level security
proves Lix access before a request reaches `lix-server`.

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
Use `pnpm dev:telemetry` to load the Infisical `dev` environment and enable
development telemetry; this requires an Infisical CLI session authenticated to
the LixRay project.
Edits in `web-app` and `vendor/atelier` update through HMR. Ctrl-C stops Vite;
the backend services remain available for the next run. Use `pnpm dev --down`
to stop the services. The local web and MCP endpoint always use port `8787`.

### Production developer sign-in

For production smoke testing without Google, create and confirm the dedicated
Supabase email/password user `dev@lixray.com`. Production automatically shows
the developer sign-in form on `/sign-up-dev`; standard `/sign-in` continues to
show Google sign-in. Preview and local environments do not expose the developer
form. The browser calls `POST /auth/email` for the server-side Supabase password
exchange; `/auth/email` is not a page route.

Keep Supabase sign-ups disabled and store the account password in the team's
password manager. The password is not baked into the image, frontend bundle,
or repository.

For a hosted Supabase project, link the CLI and apply migrations:

```sh
pnpm --dir database exec supabase login
pnpm --dir database exec supabase link --project-ref <project-ref>
pnpm --dir database exec supabase db push
```

Enable Google authentication, keep public email sign-ups disabled, and configure
the site URL plus `/auth/callback` redirect in both Supabase and Google. Enable
Supabase email password sign-in while keeping new-user registration disabled.
Browser and server access use the user's JWT with RLS; no Supabase secret key is
required.

## Verification

When changing the vendored Lix or Atelier revisions, run `pnpm vendor:sync`.
It regenerates the pnpm lockfile. `pnpm vendor:check` verifies that the derived
lockfile is committed and in sync.

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
pnpm --dir database start
pnpm --dir database test
pnpm --dir web-app exec playwright install chromium
pnpm test:e2e
```

The browser test starts local Supabase and the Compose topology, signs in,
creates a repository, completes a Lix handshake, and runs a query. Set
`E2E_PORT` to override its default port (`8790`).

## MCP and HTTP API

### Repository API tokens for SDKs and scripts

Open a repository → **Settings → API tokens**. Generate as many tokens as you
need, each with an automatic human-readable name such as `happy-elephant`.
Copy the secret when generated: it is only shown once. The list shows each
name, creation date and one-year expiry. **Delete** immediately revokes that
specific token; other tokens continue working. Tokens are personal to their
creator and scoped to this repository.

```ts
const lix = await openLix({
  server: {
    mode: "remote", // also supported with mode: "sync" and local storage
    url: `https://lixray.com/lix/${repositoryId}`,
    headers: async () => ({
      Authorization: `Bearer ${process.env.LIXRAY_API_TOKEN}`,
    }),
  },
});
```

Each API token works only for the repository where it was generated, even if
its owner belongs to other repositories. The gateway checks repository scope,
expiry, account status and current membership on every protocol request. Tokens authenticate `/lix/v1/{uuid}/*`; interactive account management
still requires browser sign-in, and MCP continues to use OAuth. Keep tokens in
scripts or server environments, not in a shipped browser bundle.

The control plane stores only SHA-256 token digests in a private table. Apply
`20260908000000_personal_api_tokens.sql` and
`20260908000100_repository_api_tokens.sql`, followed by
`20260908000200_named_api_tokens.sql`, before deploying this feature. The final
migration preserves existing repository tokens and assigns them names. The
second migration revokes unscoped preview tokens; generate replacements in
repository settings. The narrow
`authorize_api_token` RPC accepts the raw token and uses the same permission
helper as repository RLS; it requires no Supabase service-role key.

### MCP

The Streamable HTTP MCP endpoint is:

```text
https://lixray.com/mcp
```

It exposes repository and branch discovery, file operations, and atomic raw Lix
SQL execution. OAuth protected-resource metadata is served from
`/.well-known/oauth-protected-resource`; MCP access tokens are Supabase ES256
tokens bound to `https://lixray.com`.

For local MCP testing, configure exactly one MCP connection. Remove the
production connection from the local Codex configuration, then register and
authenticate the local endpoint:

```sh
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
- `/lix/v1/{uuid}/*` — authenticated canonical Lix REST protocol
- `/lix/{uuid}` — stable SDK connection URL
- `/mcp` — authenticated MCP transport

An authorized operator can stream a complete Lix snapshot through that same
protocol—there is no LixRay-only snapshot route or token:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header "Accept: application/vnd.lix.snapshot" \
  --output "$LIX_ID.lixsnap.part" \
  "https://lixray.com/lix/v1/$LIX_ID/snapshot"
mv "$LIX_ID.lixsnap.part" "$LIX_ID.lixsnap"
```

The response is the canonical deterministic Lix snapshot stream. Export is
read-only; LixRay does not expose snapshot upload or resource creation through
this route. A downloaded artifact becomes a backup only after an operator
stores it independently with retention, access control, and restore drills.

Apply the database migrations before enabling Supabase's OAuth server, dynamic
client registration, and `private.custom_access_token_hook`. The consent path is
`/oauth/consent`. [Persistent MCP authorization](docs/mcp-oauth-sessions.md)
describes session resource bindings, the one-time reconnect for existing
connections, and the local refresh/revocation regression tests.

Probe a configured environment with a temporary token:

```sh
LIXRAY_MCP_ACCESS_TOKEN='<token>' pnpm --dir web-app check:mcp
```

## CI and deployment

GitHub Actions builds immutable web images on pull requests, resolves the Lix
SDK and server from the exact vendored revision, and runs the Compose browser
flow against the server digest. Successful Lix CI artifacts are reused; an
unreviewed revision with no artifact is compiled once as an explicit fallback.
Trees with unchanged inputs reuse existing images.
Draft pull requests build both immutable images and refresh their deployed
preview, while skipping the frontend, database, Rust, and local E2E validation
lanes. Marking a pull request ready for review runs the complete validation set.
In-progress runs for the same pull request are cancelled, and the stable `CI`
job remains the merge gate.

The separate `Production` workflow normally promotes existing tested images.
Pushes to `main` resolve the web image and the server matching the Lix submodule
before applying database migrations. A missing Lix artifact takes the same
visible source-build fallback as local and PR workflows. The workflow then
points both Railway services at immutable GHCR digests, starts them together,
and waits up to ten minutes for both health checks. Production never waits for
an independent Railway build.

GitHub Actions is the only build and deployment authority:

- pull request CI creates an isolated Railway environment without initial
  source deployments, points both services at tested image digests, and deletes
  the environment when the pull request closes;
- each healthy preview is published as a GitHub deployment with a **View
  deployment** link in the pull request;
- merging to `main` applies database migrations and promotes the tested web
  image with LixRay's pinned Lix server digest;
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
- `RAILWAY_PREVIEW_BASE_ENVIRONMENT`: a persistent image-managed environment
  containing demo configuration and isolated preview storage, but no production
  Supabase credentials;
- `GHCR_READ_USERNAME`: the GitHub user owning a classic PAT;
- `GHCR_READ_TOKEN`: that PAT with `read:packages`;
- `GITHUB_ENVIRONMENT_ADMIN_TOKEN` (optional): a fine-grained token scoped only
  to this repository with Administration write access. Closed-PR cleanup uses
  `GITHUB_TOKEN` with `environments: write` and `deployments: write`. Set this
  only if that workflow token is denied; it is not required in Infisical;
- `VITE_SUPABASE_URL`: the public production Supabase project URL;
- `VITE_SUPABASE_KEY`: the public production Supabase publishable key.

Public Lix artifacts are downloaded with the workflow's `GITHUB_TOKEN`. An
optional `LIX_ACTIONS_READ_TOKEN` GitHub Actions secret can supply Actions read
access when repository visibility or organization policy prevents that token
from reading `opral/lix`. If authorization fails or an artifact has expired,
the terminal reports the miss and LixRay falls back to compiling the selected
submodule. CI waits for an already-running exact-revision Lix build before
falling back, avoiding a duplicate compile when both pull requests start
together. Local development uses the current `gh auth` session for the same
read when available.

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

Disable Railway's native GitHub autodeploy on both services and disable
Railway-managed PR environments. The repository workflows own preview creation,
cleanup, image deployment, health checks, and production promotion; leaving the
native triggers enabled starts an untested duplicate source build without Git
submodules and produces misleading commit statuses.

Migrate in this order: create the persistent image-managed preview-base
environment, add its name or ID as `RAILWAY_PREVIEW_BASE_ENVIRONMENT`, merge the
workflow change, and only then disable Railway's native GitHub autodeploy and
PR environments. This keeps preview deployment available throughout the
transition.

Both services share `LIXRAY_INTERNAL_TOKEN`. The Railway server start command
maps it to the reference server's `LIX_SERVER_INTERNAL_TOKEN` and maps the
existing timeout/cache variables to their generic `LIX_SERVER_*` names. The web
service reaches the server through Railway's private network. Production and
preview environments use separate S3 storage configuration; when `S3_PREFIX`
is unset, the deployment adapter preserves the existing
`railway/$RAILWAY_ENVIRONMENT_ID` object layout. Preview environments never
inherit production Supabase credentials.

### Fast pull request previews

CI-managed Railway environments named `lixray-pr-*` run in demo mode. The
sign-in screen offers **Continue as preview user** and the server
accepts the matching fixed demo token for the built-in `acme/launch-q3`
repository. No Supabase URL, key, branch, password, seed job, or provisioning
workflow is involved.

Both production services remain image-managed, and their GitHub autodeploy is
disabled. CI clones the isolated preview-base configuration without starting a
deployment, applies the preview policy, and deploys the tested web and server
images together. The same coordinator promotes both images in production.
Preview data is disposable and isolated by the Railway environment. Closing or
merging the pull request deletes both the Railway environment and its matching
GitHub deployment environment.
Database-sensitive changes continue to use local Compose or an explicitly
requested integration environment.

## Performance loop

```sh
LIXRAY_PERF_REPOSITORY=11111111-1111-4111-8111-111111111111 pnpm perf:reset
RUST_LOG=lix_server=info pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository 11111111-1111-4111-8111-111111111111 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/baseline.json
# To test a local Lix change, build the server image in the Lix repository and
# export LIXRAY_SERVER_IMAGE=<your-local-image> before starting this stack.
LIXRAY_PERF_REPOSITORY=22222222-2222-4222-8222-222222222222 pnpm perf:reset
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository 22222222-2222-4222-8222-222222222222 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/candidate.json
pnpm perf:down
```

Set `LIXRAY_PERF_URL` and `LIXRAY_INTERNAL_TOKEN` to exercise a hosted service.
Every invocation seeds a fresh deterministic 1,000-file repository and measures
one CRUD operation family. See [`perf/README.md`](perf/README.md) for the
operation matrix, exact commit semantics, repetition method, and result schema.

The Lix server requires `LIX_SERVER_PUBLIC_URL` to advertise repository URLs through
the web gateway. Local development sets it to the dev server origin (including
custom ports). Railway promotion resolves or creates the web service domain in
the target environment and passes that HTTPS origin to the server. Set
`LIXRAY_PUBLIC_URL` in the promotion environment to use a custom HTTPS origin.
Direct Railway launches must set `LIXRAY_PUBLIC_URL` to the web gateway origin.

Demo repositories are provisioned explicitly after preview deployment. CI runs
`node /app/web-app/scripts/provision-repositories.mjs create-new` through
`railway ssh` on the preview web service, using that service's private connection
configuration. Existing deployment storage must instead use `adopt-existing`;
failed adoption never falls back to creating an empty repository. The command
covers the two fixed demo IDs and any configured `LIXRAY_DEMO_LIX_IDS` (or legacy
`LIXRAY_DEMO_REPOSITORY_IDS`). Deleted repositories remain deleted.

Before switching existing production storage to the lifecycle-aware server,
export the repository UUID inventory with `SELECT id FROM public.lixes ORDER BY id`
and explicitly register every previously backed repository. The same private
operator command accepts IDs after the required mode, replacing the demo defaults:

```sh
railway ssh --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_TARGET_ENVIRONMENT" --service "$RAILWAY_WEB_SERVICE" -- node /app/web-app/scripts/provision-repositories.mjs adopt-existing REPOSITORY_UUID
```

Repeat for the exported inventory before enabling public reads or running the
production canary. A metadata row whose repository was never initialized will
fail adoption; classify it explicitly through the authenticated provisioning
workflow instead of creating storage in response to a missing public read. No
production adoption or creation is performed automatically by this migration.

Preview CI registers a unique ephemeral SSH key for that operator command and
revokes it afterward, including failed provisioning attempts. The existing
workspace-scoped Railway API token must permit SSH key management; no permanent
SSH private key is stored in repository or CI configuration.
