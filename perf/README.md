# Lixray end-to-end CRUD benchmark

This worker measures one request at a time through the full
`lix-server -> Lix server protocol -> Lix engine -> configured storage` path.
It is intentionally opinionated: every invocation uses a fresh workspace,
seeds the same 1,000-file corpus, creates an exact history depth, and measures
one operation family. There is no resume mode because reusing setup state
makes write comparisons ambiguous.

The measured bottlenecks, controlled A/B results, memory/storage accounting,
tradeoffs, and external design references are in [FINDINGS.md](FINDINGS.md).

## Corpus and history

The corpus has 100 files in each of ten formats: JSON, CSV, Markdown, text,
XML, YAML, PDF, PNG, binary, and log. Structured formats and containers are
valid, sizes are fixed from 1 KiB through 32 KiB, binary payloads are
deterministic, and the report records the corpus SHA-256.

`--commits` is the total history depth at the start of the operation family
and **includes the genesis commit**. Seeding therefore creates
`--commits - 1` mutation commits. Every history depth uses the same shape:
one atomic `execute-batch` inserts all 1,000 files, then deterministic
single-file updates extend history. This keeps file count and insertion
batching constant when commit depth changes.

The runner performs no pre-timing current-state or history accounting scan:
such a scan would prime the same blocks used by CRUD validation. It derives
the start counts from acknowledged seed mutations and verifies actual file and
commit counts after timing. A reused workspace fails this final invariant
instead of silently producing a misleading result.

## Run

Start the local stack and provide its local internal token:

```sh
LIXRAY_PERF_WORKSPACE=perf-main-c1000-read4k-r1 pnpm perf:reset
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --workspace perf-main-c1000-read4k-r1 \
  --operation read-point-4k \
  --commits 1000 \
  --warmups 3 \
  --samples 30 \
  --target-revision "$(git rev-parse HEAD)"
```

To emit the opt-in engine phase close events used during diagnosis, enable both
the formatter and the debug-level `lix_perf` target when starting the server:

```sh
LIXRAY_PERF_SPANS=true \
RUST_LOG=lixray=info,lix_perf=debug \
pnpm perf:up
```

Supported operation families are:

- `read-point-4k`: exact-path read of a valid 4 KiB JSON file
- `read-point-32k`: exact-path read of a valid 32 KiB PDF
- `list-paths-100`: ordered listing of 100 corpus paths
- `create-4k`: create a unique valid 4 KiB JSON file in the existing `/corpus` directory
- `update-4k`: replace an existing JSON file with 4 KiB
- `update-2m`: replace an existing binary file with 2 MiB of high-entropy data
- `delete-1k`: delete a unique existing 1 KiB text file

Mutation operations require `--warmups 0 --samples 1` (their defaults), so the
single timed request starts at exactly the requested commit depth. Repeat a
mutation with fresh workspace IDs to obtain independent samples. Read
operations default to three warmups and 30 timed requests. The report states
both the requested start count and the expected/verified final count.

Use `--precondition-reads 5` when the target is the common already-active
runtime path. It performs five asserted exact-path reads of rows unrelated to
the timed mutation before the timer, without changing history or scanning the
namespace. Leave it at zero to measure a cold first operation. The report
records the count and aggregate preconditioning time; never compare a
preconditioned candidate with an unconditioned baseline.

Freshly opening SlateDB also starts background work. Use `--settle-ms 1000`
after preconditioning for the common already-active runtime profile, and leave
it at zero for a first-operation profile. The wait is outside the timer and is
recorded in the report. Use the same value for both sides of a comparison.

Generated reports go to `perf/results/` by default and are gitignored. They
contain local checkout revisions and dirty flags. When the server is built
from another revision, pass `--target-revision`; the runner never guesses a
storage backend or deployed revision.

## Scaling and comparison method

Use fresh workspace IDs for every point and run at least five independent
repetitions per candidate. A useful history matrix is 2, 10, 100, 1,000, and
5,000 total commits. Counterbalance baseline and candidate runs (for example
A/B/B/A) instead of running every baseline first. For mutations, aggregate the
one-request reports across workspaces; for reads, compare each report's median
and p95.

By default, setup and timing share a session, so the result is explicitly
reported as a post-ingest operational profile: cache heat and compaction
backlog vary with history depth. To isolate the timed operation, first create a
template using a non-mutating read run and gracefully stop lix-server. For each
repetition, copy that closed template through the object-store API to one
workspace, start a fresh server process, run only that clone with `--preseeded`,
then gracefully stop the server before preparing the next clone. A single
restart followed by several clones is not isolated: open-workspace retention,
threads, and cache pressure change across the series. `--preseeded` performs no
setup or pre-timing accounting scan; the final accounting check fails if the
clone was not at the requested exact depth.

Create a separate closed template for every revision, storage backend, and
storage configuration. Clone only within that cohort. Keep the logical corpus
hash and history depth identical across cohorts; copying a baseline's physical
store into a storage-layout candidate would test compatibility with the old
layout instead of the candidate's native layout.

For the local Compose MinIO stack, a stopped template can be copied with `mc`
(replace both IDs for every repetition):

```sh
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --workspace perf-template-c1000 \
  --operation read-point-4k \
  --commits 1000 \
  --warmups 0 \
  --samples 1
docker compose stop -t 30 lix-server
docker compose run --rm --no-deps --entrypoint /bin/sh minio-init -c \
  'mc alias set local http://minio:9000 lixray lixray-local-secret &&
   mc mirror \
     local/lixray/local/perf-template-c1000/ \
     local/lixray/local/perf-candidate-c1000-r1/'
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --workspace perf-candidate-c1000-r1 \
  --operation create-4k \
  --commits 1000 \
  --precondition-reads 5 \
  --settle-ms 1000 \
  --preseeded
```

The sample timer starts before JSON serialization and ends after the complete
response body has been read and decoded. Preconditioning and semantic
assertions are outside that timer. Read distributions and the single mutation
sample are stored compactly as `[elapsedMs, requestBytes, responseBytes]`;
mutation reports deliberately do not label one observation as p50/p95. Request
bytes are JSON payload bytes and do not include HTTP framing.

Storage size, server RSS, object-store requests, and cache size are properties
outside the protocol response. For memory, sample the lix-server container
after the runner closes its child protocol session but before stopping the
server; this measures the retained open-workspace runtime. For physical
storage, gracefully stop lix-server with its 30-second Compose grace period
before measuring the workspace prefix, so SlateDB has closed and background
work is no longer changing the result. Key both snapshots by workspace ID,
target revision, Compose project, cache configuration, and open-workspace cap.

Run the fast harness tests with:

```sh
pnpm perf:test
```
