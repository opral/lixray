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

Measured on 2026-10-04, Ubuntu 24.04.4, Node 22.23.2, against the pinned
Lix `5e63acafeae3a6322083ea597b26f0c0a100860e` browser SDK. These are local
warm SDK queries and cache stress measurements, not deployed route latency.

The aggregation benchmark seeds deterministic paths, warms both strategies,
alternates their order for six paired samples per size, and asserts exact
profile JSON equality. The repository includes Lix's default file, so returned
baseline row counts are one greater than the number inserted.

| Inserted files | Path scan median | SQL aggregate median | Path result bytes | Aggregate result bytes |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 2.90 ms | 4.99 ms | 38,028 | 107 |
| 10,000 | 22.69 ms | 11.48 ms | 380,027 | 113 |

At 10,000 files, aggregation reduces median time about 49% and serialized
query result bytes about 99.97%, returning one row instead of 10,001. At 1,000
files, it costs about 2.10 ms. Serialized result bytes are a reproducible
transport/materialization proxy; the SDK exposes no per-query WASM heap metric,
so this does not claim measured engine peak memory.

The cache benchmark uses five paired samples of 10,000 unique concurrent loads
sharing one small profile payload. A repeat during concurrent compilation had
median retained heap 1,657,256 bytes / 10,000 entries for the baseline versus
126,128 bytes / 256 entries for the candidate (about 92.4% less). Median insertion
time was 6.85 ms versus 11.10 ms. This measures the entry structure with a shared
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
