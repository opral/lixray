# Lixray end-to-end CRUD benchmark

This worker measures one request at a time through the full
`lix-server -> Lix server protocol -> Lix engine -> configured storage` path.
It is intentionally opinionated: every invocation uses a fresh repository,
seeds one of the fixed 1,000-, 5,000-, or 10,000-file corpora, creates an
exact history depth, and measures one operation family. There is no resume
mode because reusing setup state makes write comparisons ambiguous.

The measured bottlenecks, controlled A/B results, memory/storage accounting,
tradeoffs, and external design references are in [FINDINGS.md](FINDINGS.md).

## Corpus and history

`--files` is deliberately restricted to `1000`, `5000`, or `10000`. Each
corpus has an even mix of JSON, CSV, Markdown, text, XML, YAML, PDF, PNG,
binary, and log files (100, 500, or 1,000 files of each type respectively).
Structured formats and containers are valid, sizes are fixed from 1 KiB
through 32 KiB, binary payloads are deterministic, and the report records the
corpus SHA-256.

`--commits` is the total history depth at the start of the operation family
and **includes the genesis commit**. The seed commit count is
`ceil(--files / 1000)`, so `--commits` must be at least one genesis commit plus
that many seed commits. Every seed commit is one atomic `execute-batch` of
exactly 1,000 files; the 1,000-file request is 14.276 MiB on the wire, safely
below the 64 MiB protocol ceiling. For the standard operation families, the
runner then creates exactly `--commits - 1 - seedCommitCount` deterministic
single-file history mutations. This makes the requested start depth exact
without sending an oversized 5,000- or 10,000-file request.

`read-point-2m` is an explicit targeted-fixture workload. It inserts one
deterministic, high-entropy 2 MiB binary file at a root-level fixture path in
one additional seed commit, then creates one fewer history mutation so the
requested total depth remains exact. The fixture is outside `/corpus`, so
`--files`, the normal corpus SHA-256, and all other operation families remain
unchanged. Its ID, path, digest, byte count, and extra seed commit are recorded
in the report. A `read-point-2m` target therefore needs one more minimum commit
than the table below; create preseeded templates with `read-point-2m` as well.

| `--files` | seed commits | minimum `--commits` (genesis included) |
| --------: | -----------: | -------------------------------------: |
|     1,000 |            1 |                                      2 |
|     5,000 |            5 |                                      6 |
|    10,000 |           10 |                                     11 |

The report and runner summary record `seedFilesPerCommit`, `seedCommitCount`,
and `historyMutationCommits`, so preseeded templates can be checked against
the same setup plan.

The runner performs no pre-timing current-state or history accounting scan:
such a scan would prime the same blocks used by CRUD validation. It derives
the start counts from acknowledged seed mutations and verifies actual file and
commit counts after timing. A reused repository fails this final invariant
instead of silently producing a misleading result.

## Run

Start the local stack and provide its local internal token:

The performance commands resolve the server image from the vendored Lix revision so its SQL and wire protocols match the SDK. Set `LIXRAY_SERVER_IMAGE` to select an explicit local image.

```sh
LIXRAY_PERF_REPOSITORY=11111111-1111-4111-8111-111111111111 pnpm perf:reset
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository 11111111-1111-4111-8111-111111111111 \
  --operation read-point-4k \
  --files 1000 \
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
- `read-point-2m`: exact-path read of the explicitly seeded deterministic 2 MiB binary fixture
- `read-range-256k-2m`: one 256 KiB byte range from the 2 MiB binary fixture, recording selected transfer bytes through the bounded CAS range reader
- `list-paths-100`: ordered listing of 100 corpus paths
- `diff-file-history`: history-backed diff projection of one changed 4 KiB file's current and prior logical revisions
- `branch-create`: create one named branch from the active head through `POST /lix/v1/{uuid}/branch/create`
- `branch-switch`: switch the live session between two sibling branches; their creation is setup outside the timed switch primitive
- `create-4k`: create a unique valid 4 KiB JSON file in the existing `/corpus` directory
- `update-4k`: replace an existing JSON file with 4 KiB
- `update-2m`: replace an existing binary file with 2 MiB of high-entropy data
- `update-mixed`: hot-session-only deterministic mix of 4x 4 KiB JSON, 3x 4 KiB CSV, 2x 64 KiB PDF, and 1x 256 KiB binary per 10 writes
- `update-mixed-native-single`: the fixed mixed payload through 10 sequential native raw upserts and 10 commits
- `update-mixed-native-batch`: the same paths and bytes through one native raw batch frame and one commit
- `delete-1k`: delete a unique existing 1 KiB text file

The three exact point-read operations accept `--file-read-transport json|binary`
and default to `json`. The JSON control sends the exact `SELECT path, content`
query and times JSON parsing plus Base64-to-`Buffer` decoding. The binary arm
sends `GET /lix/v1/{uuid}/file?path=…` and times raw response-body materialization.
Both arms return and assert the same usable bytes; semantic envelope and row
checks are outside the timer. Binary is deliberately rejected for non-point
operations. Preconditioning uses the selected arm, so raw reads do not warm
the SQL route (and vice versa).

`read-range-256k-2m` requires `--file-read-transport binary`. It sends one
forward `Range` request and verifies both the selected bytes and
`Content-Range`. The ordinary chunked CAS path reads only intersecting chunks;
use a pre-range revision as the whole-materialization control when making a
causal comparison.

`update-mixed` requires `--hot-session --preseeded` and a `--samples` count
that is a multiple of 10, preserving its stated deterministic weights.
`update-mixed-native-single` and `update-mixed-native-batch` require
`--file-write-transport binary`. For a fair one-logical-operation comparison,
repeat each command on independently cloned repositories, counterbalance the two
operation families, and compare the report's explicit
`mutationCommitsPerOperation` (10 versus 1). A native batch frame is limited
to 1,024 files; the client rejects larger calls rather than silently creating
multiple commits, preserving the one-call atomicity contract. These operations
also reject `--hot-session`: their arms advance history by different amounts,
so a multi-sample live session would confound the comparison.

`diff-file-history` is deliberately a history-backed diff projection, not a
generic textual diff. Before its timer starts, the runner resolves each chosen
file's stable `lix_file.id` by exact path and records that identity resolution
as pre-timing operation setup. The timed operation reads the latest change from
`lix_history('lix_file') WHERE id = $1 ORDER BY lixcol_position LIMIT 1`, then
loads the exact before/after states with two `lix_as_of('lix_file', $1)`
queries. The three request timings and wire sizes are summed. It verifies the
current and prior payloads against the corpus and that they differ. History
metadata selects immutable endpoint IDs; bytes are loaded only afterward. This leaves the seeded corpus and its physical layout
unchanged. It requires at least one post-seed history mutation, so choose
`--commits` above the seed minimum.

Mutation operations, including `branch-create`, require `--warmups 0 --samples
1` (their defaults), so the single timed mutation operation starts at exactly
the requested commit depth. `branch-create` uses the protocol endpoint instead of
writing internal branch tables, verifies its `lix_branch` row after timing, and
adds its tracked branch-descriptor commit to the verified final count.
`branch-switch` is a distribution: it first creates two sibling branches outside
the timer and then alternates the live session between them. The report records
those two setup commits separately, so its expected final count remains
auditable. Repeat a mutation with fresh repository IDs to obtain independent
samples. For a hot-session mutation distribution, pass `--hot-session` with
`--preseeded` and `--samples` of at least two: it keeps one fresh clone and one
live protocol session, records each sequential write, and verifies the expected final commit
count. Read operations default to three warmups and 30 timed requests. The
report states both the requested start count and the expected/verified final
count.

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
contain local checkout revisions and dirty flags. Before opening a protocol
session, the runner retries `/healthz` and records the server-attested
`storageBackend` and `storageLayout`; these fields are authoritative, not
caller labels. Pass `--storage-backend slatedb` or `--storage-backend rocksdb`
as an optional assertion and the run fails if it disagrees with the server.
`--storage-cohort <label>` records a human-defined comparison cohort but cannot
override either attested field. When the server is built from another revision,
pass `--target-revision`; the runner never guesses a storage backend or
deployed revision.

## Scaling and comparison method

Use fresh repository IDs for every point and run at least five independent
repetitions per candidate. The canonical scaling matrix crosses
`--files 1000|5000|10000` with `--commits 1000|5000` total commits. (The
smaller 2/10/100 depths remain useful diagnosis points when they satisfy the
seed minimum shown above.) Counterbalance baseline and candidate runs (for
example A/B/B/A) instead of running every baseline first. For mutations,
aggregate the one-request reports across repositories; for reads, compare each
report's median and p95.

By default, setup and timing share a session, so the result is explicitly
reported as a post-ingest operational profile: cache heat and compaction
backlog vary with history depth. To isolate the timed operation, first create a
template using a non-mutating read run and gracefully stop lix-server. For each
repetition, copy that closed template through the object-store API to one
repository, start a fresh server process, run only that clone with `--preseeded`,
then gracefully stop the server before preparing the next clone. A single
restart followed by several clones is not isolated: open-repository retention,
threads, and cache pressure change across the series. `--preseeded` performs no
setup or pre-timing accounting scan; the final accounting check fails if the
clone was not at the requested exact depth.

Create a separate closed template for every revision, storage backend, and
storage configuration. Clone only within that cohort. Keep the logical corpus
hash, history depth, and (when present) targeted-fixture identity identical
across cohorts; copying a baseline's physical store into a storage-layout
candidate would test compatibility with the old layout instead of the
candidate's native layout.

For the local Compose MinIO stack, a stopped template can be copied with `mc`
(replace both IDs for every repetition):

```sh
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository 11111111-1111-4111-8111-111111111111 \
  --operation read-point-4k \
  --files 1000 \
  --commits 1000 \
  --warmups 0 \
  --samples 1
docker compose stop -t 30 lix-server
docker compose run --rm --no-deps --entrypoint /bin/sh minio-init -c \
  'mc alias set local http://minio:9000 lixray lixray-local-secret &&
   mc mirror \
     local/lixray/local/perf/11111111-1111-4111-8111-111111111111/ \
     local/lixray/local/perf/22222222-2222-4222-8222-222222222222/'
pnpm perf:up
LIXRAY_INTERNAL_TOKEN=lixray-local-internal-token \
  pnpm perf:run -- \
  --repository 22222222-2222-4222-8222-222222222222 \
  --operation create-4k \
  --files 1000 \
  --commits 1000 \
  --precondition-reads 5 \
  --settle-ms 1000 \
  --preseeded
```

The sample timer starts before client base64/JSON encoding or raw body transfer and ends after
the complete response body has been read and decoded into usable bytes. For
point-read JSON controls that includes response JSON parsing and Base64-to-`Buffer`
materialization; for binary point reads it includes raw body materialization.
Protocol-envelope and semantic result assertions occur after the timer.
`create-4k`, `update-4k`, and
`update-2m` default to the JSON transport so an unchanged baseline remains
directly runnable. Pass `--file-write-transport binary` to send the file body
as `application/octet-stream` through the native file-upsert endpoint; its
timer starts before body transfer and ends after response decoding. The native
batch operation additionally starts before client entry validation and u32
frame encoding. The report records the chosen transport and write shape. JSON updates use SQL `UPDATE` by
default; use `--file-write-shape upsert` for the matched
`INSERT ... ON CONFLICT(path) DO UPDATE` control when comparing the native
endpoint's explicit upsert semantics. Preconditioning and semantic
assertions are outside that timer. Read distributions and the single mutation
sample are stored compactly as `[elapsedMs, requestBytes, responseBytes]`;
mutation reports deliberately do not label one observation as p50/p95. Request
bytes are encoded request-body bytes: JSON payload bytes for the JSON path and
raw octet-stream bytes for the binary path; neither includes HTTP framing.

Storage size, server RSS, object-store requests, and cache size are properties
outside the protocol response. For memory, sample the lix-server container
after the runner closes its child protocol session but before stopping the
server; this measures the retained open-repository runtime. For physical
storage, gracefully stop lix-server with its 30-second Compose grace period
before measuring the repository prefix, so SlateDB has closed and background
work is no longer changing the result. Key both snapshots by repository ID,
target revision, Compose project, cache configuration, and open-repository cap.

Run the fast harness tests with:

```sh
pnpm perf:test
```
