# Operating LixRay

These are contributor runbooks for the hosted service. They are not a supported
control-plane self-hosting guide; see [self-hosting](self-host.md).

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
