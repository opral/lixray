# Public profile activity qualification

The production activity route returns exact scalar file/category counts from
Lix instead of materializing every file path in the gateway. Category ordering
and extension semantics share the production category declaration. The former
path implementation is frozen at LixRay `1c0da0159478946cc3c210131cdee82ce559feb2`
in a test-only fixture, with no production compatibility path.

The cache retains at most 256 result entries, removes expired results on access,
and prevents invalidated in-flight scans from repopulating the cache. This limit
bounds retained results, not concurrent HTTP requests or in-flight scans. The
existing route deadline still applies to each scan.

## Measured comparison

Measured on 2026-10-05, Ubuntu 24.04.4, Node 22.23.2, against the pinned
Lix `4a08507006f02d2663400d752e79c6dbaadef534` browser SDK
(source tree `fbefd22e359f7a47bb304cb59d32aca5ac12bd76`). These are local
warm SDK queries and cache stress measurements, not deployed route latency.

The aggregation benchmark seeds deterministic paths, warms both strategies,
alternates their order for six paired samples per size, and asserts exact
profile JSON equality. The repository includes Lix's default file, so returned
baseline row counts are one greater than the number inserted.

| Inserted files | Path scan median | SQL aggregate median | Path result bytes | Aggregate result bytes |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 3.44 ms | 6.13 ms | 38,028 | 107 |
| 10,000 | 24.48 ms | 11.80 ms | 380,027 | 113 |

At 10,000 files, aggregation reduces median time about 52% and serialized
query result bytes about 99.97%, returning one row instead of 10,001. At 1,000
files, it costs about 2.70 ms. Serialized result bytes are a reproducible
transport/materialization proxy; the SDK exposes no per-query WASM heap metric,
so this does not claim measured engine peak memory.

The cache benchmark uses five paired samples of 10,000 unique concurrent loads
sharing one small profile payload. The final candidate repeat had
median retained heap 1,657,224 bytes / 10,000 entries for the baseline versus
126,128 bytes / 256 entries for the candidate (about 92.4% less). Median insertion
time was 6.76 ms versus 11.30 ms. This measures the entry structure with a shared
payload; independent large profiles would have a different retained heap.

Run from the repository root:

```sh
node --expose-gc --experimental-strip-types perf/profile-activity-aggregate-benchmark.mjs
node --expose-gc --experimental-strip-types perf/profile-activity-cache-benchmark.mjs
```

Both emit raw samples. The aggregation script also records SDK provenance. The
cache script resolves its immutable baseline commit and records candidate Git
state. Timing varies with host load; result shape, exact parity, invalidation,
and retained-entry bounds are correctness gates independent of these timings.

Raw samples for this revision are retained in `profile-activity-samples.json`.
