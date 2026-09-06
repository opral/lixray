# LixRay performance architecture plan

## Goal

Create a fast, trustworthy loop for reproducing a slow repository, measuring its
queries, improving Lix or `lix-server`, and proving the improvement before
merge.

Local development, CI, previews, and production use the same portable Compose
and Railway `lixray-web -> lix-server -> MinIO/R2` architecture. There is one
Lix runtime path; tests do not maintain a provider-specific runtime.

## Target architecture

LixRay will use a small control-plane/data-plane split:

```text
Browser / MCP
      |
      v
LixRay web service
- UI and public routes
- authentication
- namespace/repository resolution
      |
      | stable repository ID over private HTTP
      v
lix-server repository service
- one long-running Rust service
- hosts multiple repositories
- opens repository runtimes lazily
      |
      v
SlateDB object storage
- MinIO through S3 for local development and performance tests
- R2 through the same S3 interface for previews and production
```

The public Lix protocol remains stable. Browser and MCP traffic share one
internal abstraction:

```ts
type RepositoryFetch = (
  repositoryId: string,
  request: Request,
) => Promise<Response>;
```

Its normal implementation forwards HTTP to the repository service, for example:

```text
/lix/v1/{lixId}/...
```

For each request, `lix-server` validates the repository ID, finds or lazily opens
the corresponding Lix/SlateDB runtime, executes the canonical Lix protocol
request, and keeps frequently used runtimes warm. It isolates repository storage
through object-store prefixes and can evict an idle runtime without deleting
durable data.

The repository service does not authenticate users, resolve
`@namespace/repository` slugs, serve the UI, or create a separate process for
each repository. Those public control-plane responsibilities remain in the
LixRay web service.

## MVP boundaries

The first version has:

- one region;
- one `lix-server` repository service instance;
- one writer owner for all repositories;
- repository isolation through object-store prefixes;
- lazy repository opening and a bounded warm-repository cache;
- the existing Lix repository/session and branch behavior.

The first version does not need distributed placement, leases, replicas,
multi-region routing, Kubernetes, or a new branch/client-state model. Those can
be added behind the same repository routing boundary later.

## Prebuilt Lix server artifact

The reference server belongs to the Lix repository. Lix builds and publishes
one immutable GHCR image for each selected Lix revision; LixRay pins that digest
for local development, CI, previews, and production. LixRay does not carry a
Rust server workspace or rebuild the server for product changes.

To test a local Lix fix with LixRay, build and tag the image once in the Lix
repository, set `LIXRAY_SERVER_IMAGE` to that tag, and rerun the workload. The
normal LixRay loop pulls the pinned image and performs no Rust compilation.

## Local and CI loop

Docker Compose is the canonical local topology. `pnpm dev` starts local
Supabase, waits for Auth, provisions the deterministic local developer, then
starts the real web service, `lix-server`, and MinIO:

```text
browser -> lixray-web (Compose) -> lix-server (private Compose network) -> MinIO
                  |
                  `-> local Supabase
```

`pnpm test:e2e` starts that same topology on an isolated port. Its one browser
test signs in through local Supabase, creates a repository, verifies the Lix
handshake, and executes a query through the web service and `lix-server`.

The fast performance loop talks directly to the real `lix-server` repository
service:

```text
perf:reset
-> delete one explicitly named perf-* repository prefix

perf:up
-> pull and start the pinned lix-server image

perf:run
-> create 1,000 deterministic mixed-format files
-> extend history to an exact requested total commit count
-> warm or settle only when explicitly requested
-> measure one asserted CRUD operation family
-> verify final file and commit accounting after timing
-> write a machine-readable result with revision and methodology metadata
```

Controlled mutation comparisons clone a gracefully closed, revision-native
template into fresh repositories and start a fresh server process for each
single timed request. Read comparisons use repeated distributions. The corpus,
operation matrix, isolation rules, and result schema live in
`perf/README.md`; measured findings and raw sample summaries live in
`perf/FINDINGS.md`.

Every PR runs `pnpm test:e2e` in CI. One outer browser test proves the full
path:

```text
browser -> web service -> RepositoryFetch -> lix-server
```

Performance measurements should run on controlled CI workers, not public PR
preview instances.

## Production deployment

Production consists of two portable Docker services:

- a public LixRay web service;
- a private `lix-server` repository service using the digest-pinned image
  published by Lix.

Durable repository data remains in R2/S3. Avoid provider-specific persistent
volumes so the services remain portable.

Railway is the deployment target because mostly idle PR environments can use
usage-based billing and Serverless/App Sleeping. Production services remain
awake initially.

Before committing to Railway, run a small deployment spike that verifies:

- the public Lix server digest is anonymously pullable;
- the LixRay web Dockerfile builds from the repository-root context;
- PR environments contain both services and private networking works;
- both preview services can sleep when inactive;
- the web service can reliably wake and retry the private repository service;
- closing a PR removes its environment;
- usage limits prevent unexpected preview costs.

If these assumptions fail, keep the Docker architecture and reconsider the
hosting provider rather than changing the application model.

## PR previews

A PR preview is a disposable deployment of the production topology:

```text
PR environment
|- LixRay web service (public, sleeping)
`- lix-server repository service (private, sleeping, S3 storage)
```

Previews use their configured Supabase control plane and dedicated preview R2
credentials supplied through Infisical. Railway environment IDs prefix every
repository, and bucket lifecycle rules expire abandoned preview data. Previews
must not receive production bucket credentials.

## Next milestones

1. Keep the Compose browser E2E green as the one local/CI acceptance path.
2. Establish a slow-repository baseline and begin comparing performance changes.
3. Keep the Railway production web and `lix-server` services healthy, with
   production R2 configuration supplied through Infisical.

## MVP success criteria

The MVP is complete when:

- one command starts the production-shaped stack locally;
- one command seeds a known slow repository;
- one command produces repeatable per-query results and compares them with a
  baseline;
- the same pinned Lix server digest is used locally, in CI, and in Railway;
- browser and MCP requests reach that same server path;
- CI exercises the same images;
- a PR can receive an isolated, disposable full-stack preview;
- production deploys the LixRay web image and prebuilt Lix server image without
  Durable Objects or per-repository containers.
