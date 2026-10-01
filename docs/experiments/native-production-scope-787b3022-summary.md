**Prepared-document baseline provenance:** 24/24 capability cases passed against app 5844e3d413a9fb9dba65044858f7628cfd064c21 and engine 787b30226c1c621b752334a1dbffe8993b752038; exact CI run 36841323230 completed successfully. The browser SDK WASM SHA-256 is 9584c602738184dbbc8bb098f9e4de19438db49cfda42db00c0af01662e2eb15. The authority is the matching CI release binary with SHA-256 569443a5d9bf0a01c530f5c67f7a90901d9addae43c5b22f11cdae331dc804ca. See the report scope below: this is not full Library release qualification.

# Native working-scope verification — 787b prepared-document baseline

This report qualifies the prepared single-document flow only. `productionScope: true` identifies the profile harness mode; it does not establish full Library release qualification. The measured flow uses a preselected document and does not exercise Library directory discovery or cold directory-registry recipes. Actual Library browser gates exposed a cold directory-registry recipe bug, so full Library release qualification remains pending the engine fix, its exact matching SDK/server CI artifacts, and a fresh run of those gates. No deployment occurred.

24/24 cold-browser prepared-document capability cases passed. Each workload has 6 fresh Chromium contexts and separately seeded repositories. Measured bootstrap and scope responses include an asserted 80 ms added delay. The active document is always 1 KiB. Authority runtimes are warm after seeding.

| Unrelated files | Unrelated history writes | Bootstrap median | Scope preparation median | Ready median | Bootstrap body bytes | Scope body median |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 986.5 ms | 918.1 ms | 1904.4 ms | 2598–2619 | 23071 |
| 500 | 0 | 984.8 ms | 979.9 ms | 2005.0 ms | 2604–2624 | 94898 |
| 5000 | 0 | 992.0 ms | 1279.8 ms | 2268.9 ms | 2599–2617 | 141553 |
| 0 | 500 | 989.1 ms | 1440.7 ms | 2431.3 ms | 2604–2615 | 30595 |

Bootstrap completes up to three finite responses in every case and has 2598–2624 measured body bytes across this grid. Browser assets, request bodies and headers are separate from these protocol body counts. These observations support bounded repository opening on the measured workloads; they are descriptive results, not a universal constant wall-clock guarantee or a production latency forecast.

Selected-file preparation is separate and includes authenticated index dependencies and the branch write frontier. Its bytes may grow with native index depth and its time may grow with history-frontier preparation. No repository-wide offline capability is claimed.

| Unrelated files / history writes | Hot read median | Offline edit median | Offline edited reopen median | Reconnect-to-authority median |
| --- | ---: | ---: | ---: | ---: |
| 0 / 0 | 3.7 ms | 17.1 ms | 516.8 ms | 522.7 ms |
| 500 / 0 | 3.7 ms | 19.5 ms | 517.5 ms | 525.1 ms |
| 5000 / 0 | 3.7 ms | 22.1 ms | 517.8 ms | 522.8 ms |
| 0 / 500 | 3.7 ms | 17.1 ms | 518.0 ms | 521.7 ms |

Every case verifies twenty prepared local reads, three offline native edits, read-after-write, durable close/reopen while offline, and authority convergence after reconnect. Successful offline protocol responses are forbidden; only native background publication attempts are allowed. Reconnect verification is outside the read/edit hot path. These are ordinary OPFS close/reopen checks, not power-loss or browser storage-eviction tests.


## Observed outlier

One of six 500-file samples had a 27,735.3 ms bootstrap and 28,685.6 ms ready time. Its three completed bootstrap responses each took 83–85 ms; the nine selected-file scope responses took 82–92 ms, and the native capability and convergence checks passed. The delay occurred within the browser-side open event rather than in a slow authority response, based on these request timings. The other five 500-file bootstrap samples were 976–1,002 ms; the full raw profile retains the outlier.

The held-publication validator passed 2/2 cases with publication requests blocked: 63.7 ms durable edit at zero unrelated files and 70.6 ms at 5000, local read-before-ACK, unchanged remote content before release, and convergence after release.

- [Raw 24-case profile](native-production-scope-787b3022-profile.json)
- [Derived profile summary JSON](native-production-scope-787b3022-summary.json)
- [Held-publication validation JSON](native-production-scope-787b3022-publication-validation.json)
- [Host load and isolated runtime context](native-production-scope-787b3022-runtime-context.json)
- [CI artifacts and exact build provenance](native-production-scope-787b3022-build-provenance.json)
