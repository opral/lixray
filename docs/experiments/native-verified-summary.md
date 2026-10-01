# Native working-scope verification

24/24 cold-browser capability cases passed. Each workload has 6 fresh Chromium contexts and separately seeded repositories. Measured bootstrap and scope responses include an asserted 80 ms added delay. The active document is always 1 KiB. Authority runtimes are warm after seeding.

| Unrelated files | Unrelated history writes | Bootstrap median | Scope preparation median | Ready median | Bootstrap body bytes | Scope body median |
| --------------: | -----------------------: | ---------------: | -----------------------: | -----------: | -------------------: | ----------------: |
|               0 |                        0 |         989.4 ms |                 231.5 ms |    1221.7 ms |            2598–2619 |             17743 |
|             500 |                        0 |         996.7 ms |                 242.5 ms |    1241.0 ms |            2603–2619 |             99304 |
|            5000 |                        0 |        1002.0 ms |                 250.7 ms |    1252.1 ms |            2603–2617 |            140523 |
|               0 |                      500 |        1003.8 ms |                 235.9 ms |    1239.2 ms |            2601–2616 |             22480 |

Bootstrap completes up to three finite responses in every case and has 2598–2619 measured body bytes across this grid. Browser assets, request bodies and headers are separate from these protocol body counts. These observations support bounded repository opening on the measured workloads; they are descriptive results, not a universal constant wall-clock guarantee or a production latency forecast.

Selected-file preparation is separate and includes authenticated index dependencies and the branch write frontier. Its bytes may grow with native index depth and its time may grow with history-frontier preparation. No repository-wide offline capability is claimed.

| Unrelated files / history writes | Hot read median | Offline edit median | Offline edited reopen median | Reconnect-to-authority median |
| -------------------------------- | --------------: | ------------------: | ---------------------------: | ----------------------------: |
| 0 / 0                            |          3.8 ms |             16.6 ms |                     490.3 ms |                      555.8 ms |
| 500 / 0                          |          3.7 ms |             18.5 ms |                     500.7 ms |                      555.9 ms |
| 5000 / 0                         |          3.8 ms |             21.2 ms |                     502.1 ms |                      555.2 ms |
| 0 / 500                          |          3.8 ms |             17.2 ms |                     494.9 ms |                      555.2 ms |

Every case verifies twenty prepared local reads, three offline native edits, read-after-write, durable close/reopen while offline, and authority convergence after reconnect. Successful offline protocol responses are forbidden; only native background publication attempts are allowed. Reconnect verification is outside the read/edit hot path. These are ordinary OPFS close/reopen checks, not power-loss or browser storage-eviction tests.
