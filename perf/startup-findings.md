# Browser startup qualification

Measured locally on 2026-10-05 against deployable server and web images using
Lix `1a7c6b3ca3fa496a9fd489735e7d81f2ce88072b` (source tree
`675fd87a2c43dbd7f493a6a723a4d1458dc92da8`) and Atelier
`9459394b0ed692295e0b41ec61a5cec18fcfec43`. This is local qualification,
not deployed-preview latency. Historical raw captures are omitted from the source repository.
Lix main `8bca5eb36be91040cca11c2a9af6706c9fbb2062` has the same measured
source tree. Atelier main `6a0c86b6fc933d4cce8ea034a00c398a56f61ddd` changes
only its nested Lix pin; its measured product code is unchanged.

The warm baseline checks only the scalar active-branch commit ID against the
authority and completion of existing reads. It does not request file content,
history, or tree payloads. This precondition matters: the editing fixture's
last write can reach its two writer tabs before the independent replica closes.
A stale close measures reconciliation as well as reuse.

All five warm reopen samples passed the original zero-cold-read budget:
1877, 1873, 1904, 1877, and 1892 ms to usable. Median was 1877 ms and p90 was
1904 ms, against the unchanged 10000 ms hosted regression ceiling. Every sample
emitted tree-ready and measured three Atelier observations, zero additional
executions, and two LixRay observations. All samples also preserved the cached
replica identity and the baseline head.

Atelier Library now consumes one authoritative observation for files and
directories instead of two observations followed by two executions. Existing
partitioning, sorting, hidden flags, extension selection, and historical views
remain covered. This establishes less query fan-out; it does not claim a paired
startup time speedup or zero downloads while the authority advances.

A separate editing scenario deliberately leaves the independent replica
offline, confirms a unique new edit on the authority, proves the replica still
has its old head, closes its owner, then reopens online. It verifies the new
content and authoritative head. Navigation, editing, history, conflicts, and
performance all passed against the same final-source local images.

The migration offline-reopen case closes the historical writer and current
online owner before the next document opens. Browser routing aborts real
repository fetches with internet-disconnected while assets remain available
and navigator.onLine stays true. The fixture uses the SDK's networkFetch at
that actual I/O boundary. Arbitrary custom-callback TypeErrors remain terminal
callback failures; they do not authorize offline fallback.
