# LixRay

LixRay is a collaborative repository app built from a TanStack Start control
plane and the prebuilt Lix reference server. Supabase supports control-plane
identity and metadata; SlateDB stores Lix repositories in S3-compatible object
storage.

Production: [lixray.com](https://lixray.com)

The repository browser uses an OPFS-backed **partial replica with on-demand sync**,
with explicit `server.mode: "partial_replica"`. SQL fetches missing inputs and
retains them locally; applications prefetch by executing a SELECT on hover.
There is no `lix.prepare()` API. See [browser synchronization](docs/partial-replica-on-demand-sync.md).

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
resolves those artifacts from its exact Lix submodule pointer. Missing artifacts
must be built in Lix before retrying. Local development follows the same
resolution path with MinIO in place of R2.

Sync clients recover lost server sessions with a fresh handshake and bounded
request replay, preserving local edits. Failed recovery backs off from one to
thirty seconds. Stale session IDs cannot open a server runtime or extend its
idle lifetime, including when an old browser tab keeps retrying after a deploy.

The web service owns authentication, organization and project pages,
`/healthz`, `/mcp`, and the canonical Lix protocol. Supabase row-level security
proves Lix access before a request reaches `lix-server`.

## Setup

Requirements: Node.js 24, pnpm 10.13.1, Docker, and the Supabase CLI.
Rust is only needed for explicitly building native SDK development binaries.
The workspace excludes released optional native SDK packages so Node uses the
pinned Wasm artifact instead of mixing a released addon with vendored JavaScript.
Explicitly prepared local native binaries still take precedence.

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

For agent work, run the local PR acceptance in an isolated worktree after
committing the candidate. The artifact check runs first and rejects a pinned
Lix browser SDK whose producer workflow has not finished successfully. This
prevents a green local run from relying on an artifact that production will
later reject. Node 24, pnpm 10.13.1, Docker, and the local Supabase CLI are
required.

```sh
pnpm ci:local --check-only  # Fast cross-repository artifact gate
pnpm ci:local               # Source, tooling, database, browser, and image checks
```

The full command runs the four built-image sync scenarios in separate
disposable Compose projects. It builds a local web image with placeholder
Supabase build settings and resolves or builds the pinned Lix server image
locally. It does not publish images, migrate a linked production database, or
promote Railway services; those remain GitHub release gates.

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
    mode: "remote", // default; opt into "partial_replica" with local storage
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

PRs run fast formatting and focused tests immediately, without SDK preparation,
Docker, or Railway. Type checks and SDK-dependent tests resolve the pinned Lix
browser artifact independently. Relevant integration changes run ordinary
Supabase/Compose tests and isolated built-image browser scenarios in parallel.
The stable `CI` check requires every selected lane to pass for ready PRs. Drafts
defer validation unless they request a preview with the `preview` label.

Lix owns Rust compilation. LixRay resolves existing SDK/server artifacts once;
missing artifacts fail promptly with a producer link. There is no waiting job
or automatic Rust compilation fallback. To build artifacts for an experimental
Lix branch (including a draft PR), dispatch its exact head:

```sh
gh workflow run ci.yml --repo opral/lix --ref BRANCH \
  -f artifacts_only=true -f source_revision=FULL_COMMIT_SHA
```

The branch must still point to that SHA. Artifact-only builds test the browser
SDK and build the server, but do not replace Lix's full release validation.

Preview deployment is opt-in: add the `preview` label to the PR. While the label
is present, subsequent pushes refresh its preview after selected checks pass.
Image publishing and previews are limited to branches in this repository. Fork
PRs can run read-only checks, but changes that need image/browser integration
remain blocked by `CI` until a maintainer reviews the changes and runs full CI
on a repository branch. A `preview` label does not grant a fork credentials.
Unlabeled PRs never create Railway environments. Closing or merging the PR
removes its preview. Cleanup shares the deployment lock and rechecks GitHub state;
closing a PR does not cancel an in-flight Railway creation. A final deployment
check retires previews whose PR closed during deployment. Hourly reconciliation
(and manual dispatch of `railway-preview-cleanup.yml`) removes orphaned
`lixray-pr-N` environments after confirming their PR is still closed, covering
missed events and interrupted jobs. Open PRs, production, and the preview template
are retained. Keep the preview template stopped; it supplies configuration, not a
running service. Deployment smoke tests retain canonical protocol/no-store and
PWA checks.

The shared `web-image.yml` builds the exact checked-out commit with Docker layer
caching. PRs and production use that same implementation. On `main`, production
validates the built web/server digests locally before database migrations, then
promotes those exact digests and runs the production canary. A PR image is never
assumed to represent an interleaved merge's final tree. GitHub Actions remains
the sole deploy authority; Railway does not independently build source.

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
optional `LIX_ACTIONS_READ_TOKEN` supplies Actions read access when organization
policy prevents cross-repository access. Missing, expired, or inaccessible
artifacts fail without falling back to source compilation. Local development
uses the current `gh auth` session for artifact reads when available.

Create separate Infisical OIDC machine identities for pull requests and the
GitHub `production` environment. Give both read access only to `/ci`, bind
the preview identity with an empty Bound Subject and a `sub` Bound Claim
containing the exact comma-separated allowlist
`repo:opral/lixray:pull_request,repo:opral/lixray:ref:refs/heads/main`. The main
subject permits hourly/manual preview reconciliation; do not use a wildcard.
Bind the production identity subject to
`repo:opral/lixray:environment:production`, and use
`https://github.com/opral` as the audience and
`https://token.actions.githubusercontent.com` as the issuer. Configure their public identifiers
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

The reference server closes unused Lix runtimes after 60 seconds of observed
idle time, checked at most every five seconds, even below its open-runtime limit.
Set `LIX_SERVER_IDLE_TIMEOUT_SECS` to a positive integer to adjust this interval.
Closing releases SlateDB background metadata polling and allows preview services
to sleep. Active requests, observation streams, and unexpired protocol sessions
are protected; abandoned sessions retain the existing 30-minute session expiry
before the runtime idle timer starts. The next request reopens the database only
after the previous runtime has finished closing. This trades a cold open after
idle periods for lower R2 operation costs.

### Sync validation

`browser-integration.yml` runs navigation, editing, and checkpoint/history in
separate jobs. Each gets its own disposable Compose storage and the exact built
web/server images, with no Supabase or Railway dependency. Strict protocol,
convergence, runtime-error, offline durability, and checkpoint identity checks
remain required. Ordinary authenticated Compose E2E runs separately.

For a focused local run, supply built images (prefer immutable digests):

```sh
LIXRAY_WEB_IMAGE=ghcr.io/opral/lixray-web@sha256:... \
LIXRAY_SERVER_IMAGE=ghcr.io/opral/lix-server@sha256:... \
LIXRAY_LIX_SERVICE_URL=http://127.0.0.1:18080 \
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
PLAYWRIGHT_SYNC_LOCAL=1 \
pnpm --dir web-app exec playwright test tests/e2e/sync-preview.spec.ts --grep @history
```

The stack uses a fresh storage prefix on every launch. Its containers persist
until explicitly stopped; CI tears down its disposable stack after each job.
Use `COMPOSE_PROJECT_NAME`, `E2E_PORT` for the web port, and the
`LIXRAY_SERVER_PORT`/`LIXRAY_MINIO_PORT`/`LIXRAY_MINIO_CONSOLE_PORT` overrides to isolate a local
run from an existing development stack.

Repeated warm-reopen latency and query-budget measurements run in the separate
`Browser performance` workflow, daily and on explicit workflow dispatch, using
a dedicated runner class. They retain the existing limits and are not a PR gate.
The performance Playwright config is `web-app/playwright.performance.config.ts`.

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
operator command accepts IDs after the required mode, replacing the demo defaults.
Adoption allows up to nine minutes per repository for an epoch migration and does
not retry a provisioning write automatically:

```sh
railway ssh --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_TARGET_ENVIRONMENT" --service "$RAILWAY_WEB_SERVICE" -- node /app/web-app/scripts/provision-repositories.mjs adopt-existing REPOSITORY_UUID
```

Repeat for the exported inventory before enabling public reads or running the
production canary. A metadata row whose repository was never initialized will
fail adoption; classify it explicitly through the authenticated provisioning
workflow instead of creating storage in response to a missing public read. Production promotion now adopts the configured `LIXRAY_CANARY_LIX_URL` explicitly
after both image deployments succeed and before the public canary runs. It uses
`adopt-existing`, fails on missing or rejected storage, and never substitutes an
empty repository or preview demo IDs. This bounded release check does not replace
the full legacy inventory migration described above. The database migration alone
does not provision repositories.

The public production canary first requests repository admission using compatibility
metadata from the checked-out Lix SDK source. It validates the repository and
compatibility epochs, validates the SQL session's embedded repository ID, and
matches its principal to admission before running `SELECT 1` and closing the
session. Hosted URL identity and portable embedded identity may differ after a
clone or restore. Admission and
handshake migration polling share a two-minute budget; only typed migration
responses are retried. The SQL read itself is never replayed. Both canary workflows
check out the Lix submodule so this check uses the deployed source contract.

Repository opening failures display the migration error code and diagnostic text
instead of replacing them with a generic support message. Include that text when
reporting a failed migration; server diagnostics omit private storage connection
details. Do not reset or recreate the repository to work around a migration error.

Synced replicas keep their storage identity across upgrades. Lix retains the old
storage generation and bootstraps a fresh generation from the same server,
repository and account. It activates the replacement only after validation;
failed downloads leave the source intact. This is a Lix sync-mode policy shared
by all storage backends. Standalone and authoritative repositories still migrate
their stored data.

Local work no longer blocks opening the server-backed repository. The **Saved
device changes** panel offers restoration onto separate recovery branches and a
download of available logical recovery data. It reports unresolved content and
keeps the source; downloading or creating recovery branches never deletes it.
Intentionally local-only data remains local. Recovery can be retried without
creating duplicate branches or overwriting changes made in a recovery branch.
Old retained generations are not reused as caches on later upgrades.

Preview and production canary CI register a unique ephemeral SSH key for that operator command and
revokes it afterward, including failed provisioning attempts. The existing
workspace-scoped Railway API token must permit SSH key management; no permanent
SSH private key is stored in repository or CI configuration. Before connecting,
CI wakes the web deployment through its public health endpoint. The operator
waits for private server health before provisioning; transient wake-up failures
do not repeat repository writes.

## Repository lifecycle

The website, desktop clients, and other SDK consumers use the same canonical
Lix server protocol:

| Operation                         | Endpoint              | SDK         |
| --------------------------------- | --------------------- | ----------- |
| Create empty or import a snapshot | `POST /lix/v1`        | `createLix` |
| Open existing storage             | `GET /lix/v1/<id>`    | `openLix`   |
| Delete hosted storage             | `DELETE /lix/v1/<id>` | `deleteLix` |

```ts
const headers = { authorization: `Bearer ${apiToken}` };
const hosted = await createLix({
  server: { url: "https://lixray.com", headers },
  from: localLix, // Omit to create an empty repository.
  idempotencyKey: savedCreationKey,
});
const remote = await openLix({ server: { url: hosted.url, headers } });
await remote.close();
await deleteLix({ server: { url: hosted.url, headers } });
```

Lix owns snapshot import, storage lifecycle, and sync. Lixray's gateway
authenticates the caller and records ownership before creation returns. It
requires repository admin rights for deletion, deletes storage first, and then
marks the metadata deleted. Opening never creates or provisions a repository.
Account onboarding creates a personal namespace without initializing storage.
The former `/api/repositories/<id>/provision`, provisioning fetch wrappers,
metadata-only `delete_lix` RPC, and direct client repository inserts are removed.

Creation defaults to a private repository in the caller's personal namespace.
The website uses optional host metadata headers through the SDK's existing
`server.headers` to choose a namespace and name:

```ts
{
  ...headers,
  "x-lixray-namespace-id": selectedNamespaceId,
  "x-lixray-repository-name": encodeURIComponent(name),
}
```

These are Lixray metadata, not additional Lix API options. The gateway checks
namespace membership before upload and again when registering ownership.
The headers are not forwarded to storage. Names are percent-encoded UTF-8,
trimmed, and limited to 80 characters. First successful registration determines
name and namespace; retries never overwrite subsequent metadata changes.

Apply database migrations through `20260911000000_canonical_repository_lifecycle.sql`.
The web server requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `LIXRAY_LIX_SERVICE_URL`, and `LIXRAY_INTERNAL_TOKEN`.
Service credentials belong only in the server environment, never `VITE_`
variables. The service role registers IDs returned by a successful storage
creation; granting this operation to a user token would allow claiming arbitrary
existing repository IDs. Missing lifecycle configuration returns 503 before upload.
Browser sessions and account API tokens use the same lifecycle endpoints.
Generate account tokens at `/settings/@<your-handle>` (`/settings` redirects there).

A successful creation means storage and ownership registration both finished.
After an interrupted request, retry with the **same idempotency key and identical
snapshot**. The reference server resolves that retry to the same repository;
the ownership receipt makes registration repeatable without resetting metadata
or resurrecting a deleted repository. Failed registration can leave inaccessible
storage until the retry completes. Do not generate another key for an uncertain
creation. Repeat the same `DELETE` to complete an interrupted deletion; retained
admin membership authorizes retries after metadata deletion.

Creation copies a snapshot; it does not connect the source. Reopen locally with
`openLix({ storage, server: { url: hosted.url, headers } })` to sync. Publish
individual paths separately through `POST /api/repositories/<id>/share?path=/file.md`.
Other files remain private.
