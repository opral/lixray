# LixRay

LixRay is a collaborative repository app built from a TanStack Start control
plane and a multi-repository Rust Lix service. Supabase supports control-plane
identity and metadata; SlateDB stores Lix repositories in S3-compatible object
storage.

Production: [lixray.com](https://lixray.com)

<!-- Content-addressed web image republish trigger; this file is outside hashed inputs. -->

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

Every repository maps to an isolated SlateDB object prefix. One bounded
`lix-server` process hosts multiple lixes, opens them lazily, and evicts
idle runtimes. Local development uses the same topology with MinIO in place of
R2.

The web service owns authentication, organization and repository resolution,
`/healthz`, `/mcp`, and the repository-scoped Lix protocol. Supabase row-level
security proves repository access before a request reaches `lix-server`.

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
creates a repository, completes a Lix handshake, and runs a query. Set
`E2E_PORT` to override its default port (`8790`).

## MCP and HTTP API

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
- `/@namespace/workspace/lix/v1/*` — authenticated canonical Lix protocol
- `/mcp` — authenticated MCP transport

### Snapshot operations

The Rust service exposes snapshot operations only when
`LIXRAY_SNAPSHOT_TOKEN` is set. This is a separate operator credential; the
normal internal web-service token cannot use these routes.

Export a complete Lix as a streamed `.lixsnap` artifact:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $LIXRAY_SNAPSHOT_TOKEN" \
  "https://<lix-server>/_ops/lixes/<lix-id>/snapshot" \
  --output '<lix-id>.lixsnap.part'
mv '<lix-id>.lixsnap.part' '<lix-id>.lixsnap'
```

The export is one coherent view of committed state and includes writes visible
when the snapshot read begins. It does not buffer the artifact in server
memory. This is a visible-state boundary, not proof that the source R2 writes
have crossed a durable-read boundary. Store the completed artifact in durable,
independent backup storage. A cancelled or failed download is intentionally
incomplete and must be discarded; publish the file only after `curl` exits
successfully.

Restore into a fresh Lix ID:

```sh
curl --fail-with-body --request PUT \
  -H "Authorization: Bearer $LIXRAY_SNAPSHOT_TOKEN" \
  -H 'If-None-Match: *' \
  -H 'Content-Type: application/vnd.lix.snapshot' \
  --upload-file '<lix-id>.lixsnap' \
  "https://<lix-server>/_ops/lixes/<new-lix-id>/snapshot"
```

Restore is create-only: it never merges into or replaces an existing Lix. The
server verifies the complete snapshot, publishes it atomically, and returns
`201 Created` only after the restored storage has closed successfully. A
missing source export returns `404`; a destination that already exists returns
`412 Precondition Failed`. Concurrent restores are serialized by an R2-backed
conditional locator. Restore bytes remain in an attempt-owned staging prefix
until one small conditional update publishes them, so a rejected attempt cannot
delete or expose another attempt's data. An interrupted service process fails
closed with the locator still marked as restoring and requires operator
reconciliation before that Lix ID can be reused.

The upload may pause for at most 60 seconds between body chunks. Longer idle
uploads are cancelled and their unpublished attempt is cleaned up.

This storage-layout change requires a hard-cut deployment. Before enabling
snapshot PUT, quiesce every older `lix-server` process; older binaries do not
claim or read locators. Once any `snapshot` locator has been published, do not
roll back to a pre-locator binary because it would look only at the obsolete
direct prefix. Back up and protect the complete `.lixray-storage-v1` namespace
alongside Lix data: its locators are authoritative.

Before production enablement, stop `lix-server` and qualify conditional Create
and Update against Compose MinIO:

```sh
docker compose run --rm lix-server \
  /usr/local/bin/lixray snapshot-locator-smoke
```

Run the same binary command with the production R2 environment loaded and make
its success a deployment gate. The command creates, conditionally updates,
verifies, and deletes a unique object under `.lixray-storage-v1/smoke`; it never
touches Lix data. The Rust unit test exercises the same command with the
in-memory object store.

To reconcile a process crash during restore, first quiesce all writers and copy
the `attempt` UUID from the `restoring` locator. Dry-run the exact attempt, then
apply it:

```sh
lixray snapshot-reconcile <lix-id> <attempt-uuid>
lixray snapshot-reconcile <lix-id> <attempt-uuid> --apply
```

The command requires the locator's exact state and attempt, lists the derived
staging prefix, deletes only that attempt's staging objects, and conditionally
updates the observed locator version to `vacant`. It fails closed on a mismatch
or lost CAS. Never delete a whole Lix prefix or alter a `snapshot` locator.

Snapshots are the full-copy payload for backup and recovery, not the backup
schedule. Production operations still need independent storage, retention,
access controls, monitoring, and regular restore drills.

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
Draft pull requests build both immutable images and refresh their deployed
preview, while skipping the frontend, database, Rust, and local E2E validation
lanes. Marking a pull request ready for review runs the complete validation set.
In-progress runs for the same pull request are cancelled, and the stable `CI`
job remains the merge gate.

The separate `Production` workflow is promotion-only. Pushes to `main` must
resolve both tested `tree-*` images before applying database migrations. The
workflow then points both Railway services at those GHCR digests, starts them
together, and waits up to ten minutes for both health checks. Production never
waits for an independent Railway build and never rebuilds merged source.

GitHub Actions is the only build and deployment authority:

- pull request CI creates an isolated Railway environment without initial
  source deployments, points both services at tested image digests, and deletes
  the environment when the pull request closes;
- each healthy preview is published as a GitHub deployment with a **View
  deployment** link in the pull request;
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

Both services share `LIXRAY_INTERNAL_TOKEN`. The web service reaches the Rust
service through Railway's private network. Production and preview environments
use separate S3 storage configuration; when `S3_PREFIX` is unset, the server
namespaces data by Railway environment ID. Preview environments never inherit
production Supabase credentials.

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
LIXRAY_PERF_REPOSITORY=perf-baseline-c1000-read4k-r1 pnpm perf:reset
LIXRAY_PERF_SPANS=true \
  RUST_LOG=lixray=info,lix_perf=debug \
  pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository perf-baseline-c1000-read4k-r1 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/baseline.json
# edit vendor/lix or lix-server
LIXRAY_PERF_REPOSITORY=perf-candidate-c1000-read4k-r1 pnpm perf:reset
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository perf-candidate-c1000-read4k-r1 \
  --operation read-point-4k \
  --commits 1000 \
  --output perf/results/candidate.json
pnpm perf:down
```

Set `LIXRAY_PERF_URL` and `LIXRAY_INTERNAL_TOKEN` to exercise a hosted service.
Every invocation seeds a fresh deterministic 1,000-file repository and measures
one CRUD operation family. See [`perf/README.md`](perf/README.md) for the
operation matrix, exact commit semantics, repetition method, and result schema.
