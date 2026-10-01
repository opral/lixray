# Native working-scope verification

24/24 cold-browser capability cases passed. Each workload has 6 fresh Chromium contexts and separately seeded repositories. Measured bootstrap and scope responses include an asserted 80 ms added delay. The active document is always 1 KiB. Authority processes restart after seeding; remote storage is reopened on the first measured repository request.

| Unrelated files | Unrelated history writes | Bootstrap median | Scope preparation median | Ready median | Bootstrap body bytes | Scope body median |
| --------------: | -----------------------: | ---------------: | -----------------------: | -----------: | -------------------: | ----------------: |
|               0 |                        0 |        1056.3 ms |                 240.3 ms |    1297.2 ms |            2599–2616 |             17743 |
|             500 |                        0 |        1157.4 ms |                 253.3 ms |    1411.3 ms |            2600–2620 |             91710 |
|            5000 |                        0 |        1259.3 ms |                 276.5 ms |    1535.2 ms |            2605–2620 |            123138 |
|               0 |                      500 |        1081.8 ms |                 242.4 ms |    1325.5 ms |            2612–2621 |             22475 |

Bootstrap completes up to three finite responses in every case and has 2599–2621 measured body bytes across this grid. Browser assets, request bodies and headers are separate from these protocol body counts. These observations support bounded repository opening on the measured workloads; they are descriptive results, not a universal constant wall-clock guarantee or a production latency forecast.

Selected-file preparation is separate and includes authenticated index dependencies and the branch write frontier. Its bytes may grow with native index depth and its time may grow with history-frontier preparation. No repository-wide offline capability is claimed.

| Unrelated files / history writes | Hot read median | Offline edit median | Offline edited reopen median | Reconnect-to-authority median |
| -------------------------------- | --------------: | ------------------: | ---------------------------: | ----------------------------: |
| 0 / 0                            |          3.7 ms |             17.6 ms |                     489.3 ms |                      558.7 ms |
| 500 / 0                          |          3.6 ms |             21.8 ms |                     491.5 ms |                      560.1 ms |
| 5000 / 0                         |          3.8 ms |             20.5 ms |                     496.1 ms |                      560.4 ms |
| 0 / 500                          |          3.7 ms |             17.1 ms |                     490.3 ms |                      556.5 ms |

Every case verifies twenty prepared local reads, three offline native edits, read-after-write, durable close/reopen while offline, and authority convergence after reconnect. Successful offline protocol responses are forbidden; only native background publication attempts are allowed. Reconnect verification is outside the read/edit hot path. These are ordinary OPFS close/reopen checks, not power-loss or browser storage-eviction tests.
