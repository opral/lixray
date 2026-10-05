# Browser startup qualification

Measured locally on 2026-10-05 against deployable server and web images using
Lix `9421ddfcfae22858f0205ed72536ad51b39eb88c` (source tree
`548debeb5102bf95a72f86cb126430d38fb0c053`) and Atelier
`c7489d144811463ba869989b2b1f9bdcb13b03cf`. This is local qualification,
not deployed-preview latency. Raw measurements are in `startup-profile.json`.

The warm baseline checks only the scalar active-branch commit ID against the
authority and completion of existing reads. It does not request file content,
history, or tree payloads. This precondition matters: the editing fixture's
last write can reach its two writer tabs before the independent replica closes.
A stale close measures reconciliation as well as reuse.

All five warm reopen samples passed the original zero-cold-read budget:
2079, 2068, 2039, 2053, and 2061 ms to usable. Median was 2061 ms and p90 was
2079 ms, against the unchanged 10000 ms hosted regression ceiling. Every sample
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
