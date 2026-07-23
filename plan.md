# LixRay performance architecture plan

## Goal

Create a fast, trustworthy loop for reproducing a slow workspace, measuring its
queries, improving Lix or `lix-server`, and proving the improvement before
merge.

Local development and CI use the same Compose `lixray-web -> lix-server ->
MinIO` path. Railway previews use the portable web and server images with R2.
The current Cloudflare production deployment is a temporary cutover exception,
not a local, CI, or preview runtime. We should not maintain an alternate Lix
runtime for tests or previews.

## Target architecture

LixRay will use a small control-plane/data-plane split:

```text
Browser / MCP
      |
      v
LixRay web service
- UI and public routes
- authentication
- namespace/workspace resolution
      |
      | stable workspace ID over private HTTP
      v
lix-server workspace service
- one long-running Rust service
- hosts multiple workspaces
- opens workspace runtimes lazily
      |
      v
SlateDB object storage
- MinIO through S3 for local development and performance tests
- R2 through the same S3 interface for previews and production
```

The public Lix protocol remains stable. Browser and MCP traffic share one
internal abstraction:

```ts
type WorkspaceFetch = (
  workspaceId: string,
  request: Request,
) => Promise<Response>;
```

Its normal implementation forwards HTTP to the workspace service, for example:

```text
/lixes/{lixId}/lix/v1/...
```

For each request, `lix-server` validates the workspace ID, finds or lazily opens
the corresponding Lix/SlateDB runtime, executes the canonical Lix protocol
request, and keeps frequently used runtimes warm. It isolates workspace storage
through object-store prefixes and can evict an idle runtime without deleting
durable data.

The workspace service does not authenticate users, resolve
`@namespace/workspace` slugs, serve the UI, or create a separate process for
each workspace. Those public control-plane responsibilities remain in the
LixRay web service.

## MVP boundaries

The first version has:

- one region;
- one `lix-server` workspace service instance;
- one writer owner for all workspaces;
- workspace isolation through object-store prefixes;
- lazy workspace opening and a bounded warm-workspace cache;
- the existing Lix workspace/session and branch behavior.

The first version does not need distributed placement, leases, replicas,
multi-region routing, Kubernetes, or a new branch/client-state model. Those can
be added behind the same workspace routing boundary later.

## One Lix source tree

Both JavaScript and Rust builds must use the checked-in `vendor/lix` submodule.
`lix-server` should use local Cargo path dependencies instead of a separately
pinned remote Git revision.

The Docker build context must include both `lix-server` and `vendor/lix`. This
makes the optimization loop direct:

```text
edit vendor/lix or lix-server
-> rebuild lix-server
-> rerun workload
-> compare with baseline
```

A PR therefore tests one atomic combination of the Lix engine, server protocol,
remote SDK, Atelier, and LixRay.

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
test signs in through local Supabase, creates a workspace, verifies the Lix
handshake, and executes a query through the web service and `lix-server`.

The fast performance loop talks directly to the real `lix-server` workspace
service:

```text
perf:up
-> build and start lix-server

perf:seed
-> load a deterministic slow-workspace fixture

perf:run
-> warm up
-> replay named queries
-> report per-query latency
-> write a machine-readable result

perf:run --compare <baseline>
-> show the before/after result
```

Fixtures, workloads, and representative baselines live in the repository.
Initially, wall-clock latency with warmup and repeated runs is sufficient. More
detailed profiling and regression thresholds can be added after the loop is
reliable.

Every PR runs `pnpm test:e2e` in CI. One outer browser test proves the full
path:

```text
browser -> web service -> WorkspaceFetch -> lix-server
```

Performance measurements should run on controlled CI workers, not public PR
preview instances.

## Production deployment

Production consists of two portable Docker services:

- a public LixRay web service;
- a private `lix-server` workspace service.

Durable workspace data remains in R2/S3. Avoid provider-specific persistent
volumes so the services remain portable.

Railway is the current preferred deployment target because mostly idle PR
environments can use usage-based billing and Serverless/App Sleeping. Production
services remain awake initially.

Cloudflare remains the temporary production control plane until this topology
has been smoke-tested in a Railway production environment. That exception must
not reintroduce a Workerd/Wasm path for local development, CI, or previews.

Before committing to Railway, run a small deployment spike that verifies:

- `vendor/lix` submodules are checked out at the PR-pinned SHA;
- both Dockerfiles can build from the repository-root context;
- PR environments contain both services and private networking works;
- both preview services can sleep when inactive;
- the web service can reliably wake and retry the private workspace service;
- closing a PR removes its environment;
- usage limits prevent unexpected preview costs.

If these assumptions fail, keep the Docker architecture and reconsider the
hosting provider rather than changing the application model.

## PR previews

A PR preview is a disposable deployment of the production topology, not an
alternate Workerd/Wasm Lix implementation:

```text
PR environment
|- LixRay web service (public, sleeping)
`- lix-server workspace service (private, sleeping, S3 storage)
```

Previews use their configured Supabase control plane and dedicated preview R2
credentials supplied through Infisical. Railway environment IDs prefix every
workspace, and bucket lifecycle rules expire abandoned preview data. Previews
must not receive production bucket credentials.

There is no Workerd/Wasm snapshot preview path. The current Cloudflare
production deployment remains only until the Railway production cutover.

## Next milestones

1. Keep the Compose browser E2E green as the one local/CI acceptance path.
2. Establish a slow-workspace baseline and begin comparing performance changes.
3. Create the Railway production web and `lix-server` services, sync production
   R2 configuration through Infisical, and smoke-test them.
4. Attach `lixray.com`, cut traffic to Railway, and then remove the temporary
   Cloudflare Worker, Durable Object Container, and remaining Worker-only code.

## MVP success criteria

The MVP is complete when:

- one command starts the production-shaped stack locally;
- one command seeds a known slow workspace;
- one command produces repeatable per-query results and compares them with a
  baseline;
- edits to `vendor/lix` are included in the tested Rust server image;
- browser and MCP requests reach that same server path;
- CI exercises the same images;
- a PR can receive an isolated, disposable full-stack preview;
- production deploys from the same Dockerfiles without Durable Objects or
  per-workspace containers.
