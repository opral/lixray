# Lixray CRUD performance findings

## Outcome

The dominant 1,000–5,000-commit write cost was not SlateDB acceptance, commit
enumeration, or SQL2. It was repeated filesystem namespace validation after the
filesystem planner had already checked the same invariant. The engine changes
remove that work from the serialized, bounded-statement happy path while
retaining commit-time validation for raw state writes, mixed descriptor
batches, and long-lived explicit transactions.

At an exact 1,000-total-commit starting state, five counterbalanced
end-to-end pairs measured:

| Operation | Instrumented baseline median | Candidate median | Median change | Median paired change |
| --- | ---: | ---: | ---: | ---: |
| Create 4 KiB in an existing directory | 181.252 ms | 118.463 ms | **34.6% faster** | **29.7% faster** |
| Delete an existing 1 KiB file | 75.034 ms | 51.860 ms | **30.9% faster** | **30.9% faster** |

The corrected server open-workspace cap also materially bounds retained
resources: in a same-binary 32-workspace comparison it reduced process RSS
29.3%, anonymous memory 35.6%, and the Docker working set 35.0%.

A follow-on changelog-append profile found a separate history-proportional
operation. It is not ordinary current-state CRUD enumeration: append-time
duplicate `derived_change_id` validation scanned every commit record. A small,
atomically maintained reverse index removes that scan for new repositories.
At 5,000 commits it produces qualifying end-to-end update and delete wins on
the SlateDB-backed server; the native benchmark records the same causal cut on
both SlateDB and RocksDB.

## Workload and timing

The checked-in runner builds 1,000 deterministic files: 100 each of JSON, CSV,
Markdown, text, XML, YAML, PDF, PNG, binary, and log. Sizes range from 1 KiB to
32 KiB and total 11,161,600 logical bytes. The current corpus digest is
`337079755ce996d2566b26cac6897f64283d8b1bf13ae98727d3880be8c7f580`.

`--commits` includes genesis. Every depth gets one atomic 1,000-file insertion
commit followed by deterministic single-file update commits. A mutation run
times exactly one request on a fresh workspace. A read run reports a
distribution. The timer starts before JSON serialization and ends after the
complete response body has been read and decoded. Payload construction,
including blob-to-base64 conversion, plus assertions and accounting are
outside it.

For the controlled active-runtime validation comparison:

- baseline: rebased phase instrumentation commit `16ec6d47`
- candidate: rebased validation stack through `1f5f49a5`
- start state: 1,000 files and exactly 1,000 total commits
- five physical clones per operation and revision from one closed template
- one mutation per clone and a fresh server process immediately before it
- five asserted, unrelated point reads warmed ordinary read infrastructure
- a fixed one-second wait kept runtime-open background work outside timing
- no pre-timing file, namespace, or history scan
- baseline/candidate order alternated by repetition

Raw create samples in milliseconds were:

```text
baseline:  [187.689, 158.974, 181.252, 181.690, 168.446]
candidate: [132.439, 110.987, 143.026,  84.792, 118.463]
paired %:  [ 29.437,  30.185,  21.090,  53.332,  29.673]
```

Raw delete samples in milliseconds were:

```text
baseline:  [82.938, 75.034, 82.313, 55.827, 45.568]
candidate: [45.825, 51.860, 52.722, 45.779, 77.469]
paired %:  [44.748, 30.885, 35.950, 17.998, -70.007]
```

These five pairs show a large median improvement but are not enough to
characterize tail latency or claim statistical confidence. Delete improved in
four pairs and regressed 70.0% in one retained outlier. The runner therefore
records each mutation as a single observation and does not mislabel it p50 or
p95.

The same rebased clones were also run as cold first operations, with neither
read preconditioning nor a settling window. Object-store/background variance
dominated that profile: create improved 17.2% by median and 17.4% by median
paired change; delete improved 18.4% by median and 24.2% by median paired
change. Those cold results are retained as a caveat, not promoted into the
active-path claim.

## Commit-depth discovery profile

The first broad sweep was deliberately used for hypothesis discovery. Its
mutating warmups, changing insertion shape, and shared post-ingest cache state
make values across depths confounded; they are not release claims.

| Requested mutation commits, plus genesis | Read 4 KiB | Read 32 KiB | List 100 | Create 4 KiB | Update 4 KiB | Update 2 MiB | Delete 1 KiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.05 | 7.98 | 3.48 | 44.95 | 6.67 | 24.36 | 15.50 |
| 10 | 3.46 | 7.00 | 2.09 | 40.26 | 6.97 | 34.99 | 14.26 |
| 100 | 2.91 | 6.23 | 3.56 | 42.87 | 6.04 | 39.66 | 25.46 |
| 1,000 | 2.73 | 7.78 | 3.37 | 44.21 | 9.28 | 41.24 | 26.32 |
| 5,000 | 3.71 | 7.30 | 3.21 | 144.32 | 26.33 | 49.16 | 61.53 |

All values are milliseconds. Reads remained essentially flat while small
writes became three to four times slower at 5,000 commits. This directed phase
instrumentation at validation rather than history enumeration or point reads.

## Phase accounting

At roughly 5,000 commits, close events from the added tracing spans showed:

- create: descriptor uniqueness about 36 ms median plus namespace validation
  about 34 ms median, roughly 70 ms total validation
- delete: namespace validation about 24–30 ms; file restrictions about 1.5 ms
  hot
- storage writer wait, mutation lowering, and visible acceptance: tens of
  microseconds, not tens of milliseconds

Code-path inspection and targeted traces also falsified the hypothesis that
ordinary current-state CRUD enumerates every commit: those paths return before
commit enumeration. Caching `all_commits` would have optimized an appealing
story, not the measured bottleneck.

## Changelog append follow-on

The preceding conclusion applies to the filesystem validator and ordinary
current-state CRUD. A separate path runs once a filesystem mutation has already
produced a changelog commit: the old duplicate `derived_change_id` check
paginated through `COMMIT_SPACE` and decoded every existing commit. Its work was
therefore linear in history even though the required answer is a point lookup.

The hard cut adds `changelog.commit_change_id`: raw 16-byte `ChangeId` UUID keys
map to raw 16-byte `CommitId` UUID values. The entry and a `format-v1` marker are
staged in the same native write set as the commit, so uniqueness stays atomic
across writers. An existing nonempty repository without the marker cannot append
commits; it must be recreated. This intentionally avoids a compatibility shim
or a migration scan on the 90% new-repository path.

The native append harness uses production RocksDB and SlateDB adapters only (no
SQLite workload), five warmups, and 31 samples per case. `Unique` measures a
new change ID; `duplicate` measures rejection of an existing one. Values are
median microseconds for the validation-plus-append operation:

| History | Backend | Case | Scan baseline | Indexed | Change |
| ---: | --- | --- | ---: | ---: | ---: |
| 1,000 | RocksDB | Unique | 536 | 13 | **97.6% faster** |
| 1,000 | RocksDB | Duplicate | 262 | 6 | **97.7% faster** |
| 1,000 | SlateDB | Unique | 2,589 | 402 | **84.5% faster** |
| 1,000 | SlateDB | Duplicate | 2,285 | 264 | **88.4% faster** |
| 5,000 | RocksDB | Unique | 4,536 | 14 | **99.7% faster** |
| 5,000 | RocksDB | Duplicate | 3,484 | 9 | **99.7% faster** |
| 5,000 | SlateDB | Unique | 4,066 | 376 | **90.8% faster** |
| 5,000 | SlateDB | Duplicate | 6,953 | 283 | **95.9% faster** |

At 1,000 commits the old path read one 1,024-row page and about 43 KiB of
values per append. At 5,000 it read five pages and about 215 KiB. The index
performs no commit scans; the 5,000-commit benchmark uses four batched gets for
five keys. This follows the same point-lookup/read-batch and atomic-write-batch
pattern documented by RocksDB rather than attempting a cache of the full
history.

The end-to-end server comparison used fresh, isolated 1,000-mixed-file clones
at each depth, five precondition reads, and a fresh process per mutation. The
timer covers the HTTP request through decoded response. At 1,000 commits the
4 KiB update moved only 7.4%, while the history-dependent benefit becomes clear
at 5,000 commits:

| 5,000-commit SlateDB start state | Baseline median | Indexed median | Median paired change |
| --- | ---: | ---: | ---: |
| Create 4 KiB | 144.374 ms | 126.060 ms | 14.9% faster |
| Update 4 KiB | 58.535 ms | 35.425 ms | **36.5% faster** |
| Delete 1 KiB | 66.293 ms | 47.696 ms | **28.2% faster** |

The create result is retained as a non-qualifying control rather than rounded
up into a claim. A 30-sample point-read control was effectively neutral
(baseline p50 6.189 ms; indexed p50 5.700 ms). One reopened-clone RSS pair was
also effectively neutral (39.95 MiB versus 40.24 MiB); that is not enough data
to characterize memory tails, but the index adds no process-wide history cache.

## Engine cuts

1. Add opt-in close-event spans around the session gate, transaction open and
   planning, validation subphases, materialization, storage writer wait,
   lowering, and acceptance.
2. For tombstone-only filesystem descriptor batches, skip the full namespace
   scan. Deleting an existing file cannot create a path, parent, or cross-kind
   collision.
3. Defer generic descriptor uniqueness scanning to the stronger namespace
   validator instead of scanning the same descriptor batch twice.
4. Trust filesystem planner validation only for serialized implicit writes
   whose origin, schema, operation, and primary key exactly identify a planner
   insertion into the file or directory surfaces.
5. Serialize explicit transaction commit-time revalidation with the same
   collaboration gate. Long-lived transactions do not receive the trust flag.
   Raw `lix_state` writes, mixed batches, unmatched origins, and implicit parent
   creation retain the conservative validator.

SQL2 was not changed.

## Storage layout

The existing SlateDB and RocksDB adapters already use one native write batch;
RocksDB also uses `multi_get`, and SlateDB deliberately requests visible rather
than durable acceptance. Adapter batching was therefore not a measured
opportunity.

The remaining small-file cost is the binary CAS layout. A nonempty small blob
currently stores a manifest, a presence row, and a chunk row. A read fetches
the manifest and payload in two sequential phases, and a write first probes
chunk presence. The candidate appends an inline manifest representation for
payloads through 32 KiB. The existing 64 KiB single-chunk fast path remains
unchanged above that evidenced inline cutoff:

| Unique small blob | Existing | Inline candidate |
| --- | ---: | ---: |
| Logical rows | 3 | 1 |
| Key bytes | 108 | 36 |
| Pre-write presence-read phases | 1 | 0 |
| Blob-read point-read phases | 2 | 1 |

The implementation keeps compression and hash verification. The genuinely
chunked path remains unchanged.

The production CAS API was measured directly against both backends with seven
counterbalanced baseline/candidate process pairs per exact case. Every process
used a fresh database, 300 warmups, and 3,000 timed samples. The latency columns
below are the median per-run p50; the change is the median of the seven paired
percentage changes:

| Backend | Size | Operation | Existing p50 | Inline p50 | Paired change |
| --- | ---: | --- | ---: | ---: | ---: |
| RocksDB | 4 KiB | New-content write | 20,570 ns | 17,030 ns | 17.2% faster |
| RocksDB | 4 KiB | Repeat-identical write | 6,690 ns | 16,740 ns | **150.4% slower** |
| RocksDB | 4 KiB | Hot read | 5,820 ns | 3,880 ns | **33.0% faster** |
| RocksDB | 32 KiB | New-content write | 79,341 ns | 75,670 ns | 4.9% faster |
| RocksDB | 32 KiB | Repeat-identical write | 9,260 ns | 75,000 ns | **713.8% slower** |
| RocksDB | 32 KiB | Hot read | 9,930 ns | 4,070 ns | **58.5% faster** |
| SlateDB | 4 KiB | New-content write | 155,429 ns | 78,749 ns | **36.3% faster** |
| SlateDB | 4 KiB | Repeat-identical write | 154,759 ns | 114,730 ns | **29.7% faster** |
| SlateDB | 4 KiB | Hot read | 138,420 ns | 81,760 ns | **33.9% faster** |
| SlateDB | 32 KiB | New-content write | 170,299 ns | 120,779 ns | **32.6% faster** |
| SlateDB | 32 KiB | Repeat-identical write | 177,149 ns | 168,110 ns | 7.4% faster |
| SlateDB | 32 KiB | Hot read | 141,179 ns | 89,940 ns | **27.8% faster** |

This is a SlateDB changed-content/read-path optimization, not a universal
backend win. RocksDB repeat-identical writes regress because the old layout
could prove the payload present and rewrite only a small manifest, whereas the
inline layout rewrites the value. That path is outside the selected 90% happy
path. Logical value bytes remain nearly flat, and physical SST/WAL reduction
has not been inferred from the row-count change. The corrected raw 168-line
matrix has SHA-256
`d76a7a73b0690e81443d064ea2ef25fac033cc3f04f710b812fd56f6c11e4f3b`.

## Memory accounting

The Compose profile intended to cap cached workspace runtimes at four, but used
the nonexistent `LIXRAY_MAX_OPEN_WORKSPACES` variable. It therefore silently
ran the server default of 32. The profile now uses the actual
`LIXRAY_MAX_OPEN_LIXS` setting, defaults it to four, and permits an environment
override.

The controlled accounting opens, point-reads, and closes 32 cloned
1,000-commit workspaces on the same binary. Each run starts a fresh process;
the snapshot is taken 30 seconds after the final close. RSS/PSS, anonymous
memory, thread count, file descriptors, and cgroup memory are collected before
graceful shutdown.

| Retained resource | Cap 32 | Cap 4 | Change |
| --- | ---: | ---: | ---: |
| RSS | 334,232 KiB | 236,424 KiB | **29.3% lower** |
| PSS | 333,121 KiB | 235,274 KiB | **29.4% lower** |
| Anonymous memory | 274,004 KiB | 176,508 KiB | **35.6% lower** |
| Docker working set | 285.5 MiB | 185.5 MiB | **35.0% lower** |
| Threads | 113 | 29 | **74.3% lower** |
| File descriptors | 430 | 61 | **85.8% lower** |
| Raw cgroup memory | 607,997,952 B | 501,043,200 B | 17.6% lower |

The cap controls retained runtimes; it is not a concurrency limit on active
sessions. During rapid eviction, close work briefly leaves more threads alive,
so the fixed-delay snapshot is important.

## Storage accounting

The latest-main closed 1,000-commit SlateDB template occupied 39,862,752 bytes
(38.0 MiB) in MinIO. Storage is measured only after graceful server shutdown
so WAL flush and background work cannot move the target during accounting. A
storage-layout candidate must use a template created natively by that
candidate; copying the baseline's physical store would measure old-layout
compatibility instead.

The changelog reverse index has a fixed logical cost of 36 bytes per commit: a
20-byte key including the space prefix and a 16-byte value, plus a 14-byte
format marker per repository. It accounted for 36,014 bytes at 1,000 commits
and 180,014 bytes at 5,000. Closed native SlateDB prefix observations were:

| Template | Logical commits | Closed size | Objects |
| --- | ---: | ---: | ---: |
| Scan baseline | 1,000 | 38 MiB | 121 |
| Indexed layout | 1,000 | 38 MiB | 103 |
| Scan baseline | 5,000 | 130 MiB | 923 |
| Indexed layout | 5,000 | 135 MiB | 504 |

The physical figures are one closed-store observation each, not an amplification
claim: SlateDB compaction timing and object layout differ between independently
created stores. The logical row accounting above is the stable storage cost.

## External design checks

These systems were used as design checks, not as substitutes for local
measurements:

- [DuckDB's Appender](https://duckdb.org/docs/stable/data/appender) and
  [transaction guidance](https://duckdb.org/docs/stable/sql/statements/transactions)
  favor amortized, explicitly bounded ingestion. The runner inserts the corpus
  atomically instead of turning fixture shape into an accidental variable.
- [RocksDB `MultiGet`](https://github.com/facebook/rocksdb/wiki/MultiGet-Performance)
  and [basic write-batch operations](https://github.com/facebook/rocksdb/wiki/Basic-Operations)
  reinforced auditing batching before changing the key layout.
- [SlateDB tuning guidance](https://slatedb.io/docs/operations/tuning/) treats
  object-store requests, cache policy, and memory backpressure as first-class
  accounting dimensions. The profile separates protocol latency, retained
  memory, and closed-store size.
- [Turso's connection-state sharing](https://turso.tech/blog/how-turso-made-connections-faster)
  reinforced bounding retained per-database runtime state rather than treating
  every open as free.
- [Dolt's import benchmark](https://docs.dolthub.com/sql-reference/benchmarks/import)
  calls out the cost of chunking blobs individually. Lix keeps chunking for
  large values but tests an inline representation for the dominant small-file
  path.
- [Sapling's scale design](https://sapling-scm.com/docs/scale/axes/) separates
  compact graph structure from lazily fetched commit metadata. Current-state
  CRUD likewise should not become proportional to full history.
- [Jujutsu's operation-log design](https://jj-vcs.github.io/jj/latest/technical/concurrency/)
  relies on a stable view per operation. Lix's planner-validation trust is
  therefore tied to the write serialization boundary, not merely to a label
  carried by a transaction that could outlive its snapshot.

## Reproduction

See [README.md](README.md) for commands, result schema, clone isolation,
revision/backend cohorting, memory accounting, and safe reset rules. Run the
harness checks with:

```sh
pnpm perf:test
```
