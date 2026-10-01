# Native working-scope verification — engine 98397ecf


Exact pair: app `b4c671c4d4d4647516dd2b46caed90a0340824fd`, engine `98397ecf730587829fa3c115f2d62300724424cb`, and matching SDK/server from successful full engine CI run `36858697176`. The measured app worktree was clean. `productionScope: true` identifies the harness mode; all services used loopback fixtures, and this result does not claim deployment or remote production measurements. The full app browser CI run `36859173032` still had a history-interaction failure caused by the device-storage protection overlay; that separate UI issue is being corrected.

24/24 cold-browser capability cases passed. Each workload has 6 fresh Chromium contexts and separately seeded repositories. Measured bootstrap and scope responses include an asserted 80 ms added delay. The active document is always 1 KiB. Authority runtimes are warm after seeding.

| Unrelated files | Unrelated history writes | Bootstrap median | Scope preparation median | Ready median | Bootstrap body bytes | Scope body median |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1160.6 ms | 909.8 ms | 2069.3 ms | 2606–2617 | 23083 |
| 500 | 0 | 996.9 ms | 964.5 ms | 1984.3 ms | 2610–2622 | 98963 |
| 5000 | 0 | 1091.4 ms | 1279.3 ms | 2447.8 ms | 2603–2618 | 155861 |
| 0 | 500 | 989.5 ms | 1422.6 ms | 2411.0 ms | 2604–2627 | 30594 |

Bootstrap completes up to three finite responses in every case and has 2603–2627 measured body bytes across this grid. Browser assets, request bodies and headers are separate from these protocol body counts. These observations support bounded repository opening on the measured workloads; they are descriptive results, not a universal constant wall-clock guarantee or a production latency forecast.

Selected-file preparation is separate and includes authenticated index dependencies and the branch write frontier. Its bytes may grow with native index depth and its time may grow with history-frontier preparation. No repository-wide offline capability is claimed.

| Unrelated files / history writes | Hot read median | Offline edit median | Offline edited reopen median | Reconnect-to-authority median |
| --- | ---: | ---: | ---: | ---: |
| 0 / 0 | 3.9 ms | 17.4 ms | 516.8 ms | 521.7 ms |
| 500 / 0 | 3.9 ms | 20.0 ms | 522.3 ms | 521.8 ms |
| 5000 / 0 | 3.8 ms | 21.4 ms | 518.8 ms | 519.8 ms |
| 0 / 500 | 3.8 ms | 17.8 ms | 523.4 ms | 519.1 ms |

Every case verifies twenty prepared local reads, three offline native edits, read-after-write, durable close/reopen while offline, and authority convergence after reconnect. Successful offline protocol responses are forbidden; only native background publication attempts are allowed. Reconnect verification is outside the read/edit hot path. These are ordinary OPFS close/reopen checks, not power-loss or browser storage-eviction tests.

One zero-unrelated-file sample retained a bootstrap outlier of 4.14 s and a ready time of 5.05 s; its other five samples passed. One 5000-file sample reached 1.99 s bootstrap and 3.28 s ready. These maxima remain in the raw sample set and are not trimmed.
