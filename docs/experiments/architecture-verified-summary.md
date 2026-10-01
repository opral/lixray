# Architecture profile summary

Source: `architecture-verified-profile.json` · 6 samples per workload · browser 149.0.7827.55
Authority: `sdk-source-head=38dd17445501e3293f1e626eec53dd94ee709460;sdk-diff-sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;authority-source-head=38dd17445501e3293f1e626eec53dd94ee709460;authority-diff-sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;authority-binary-sha256=8b610d5ab855ffe0726b547b0d907a22203faea12a23788ca5e76846658acdc2;authority-profile=debug;harness-source-sha256=62fa4cc91f69d64e4effbf7a2b061e801ffe3015313f123684b19bf916925b3e;browser-entry-source-sha256=1258fec83d23aa0acaa9b62a9950e103a1b4832c8ebac06af33d650aae99dba6;report-source-sha256=07813a9f88260493301bc894ff1add8126157ac55d89b5842d4c2f92e7e4a068` · WASM: `884eb3cfe0ff0088cad0828302eb72816a2d2f9a4154bbcaacb04a12cb685e3a`

Negative partial-minus-working-set differences and ratios below 1 favor partial. Per-arm medians include every observed value; paired effects use only matched sample ordinals with both values.

## 1024 bytes · 0 unrelated files · 0 ms/request delay

partial: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures; working-set: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures

| Metric                                          | Partial median (n) | Working-set median (n) |  Median Δ P−W (n) | Median P/W (n) |
| ----------------------------------------------- | -----------------: | ---------------------: | ----------------: | -------------: |
| Cold open to usable (ms)                        |       904.4 ms (6) |           504.8 ms (6) |      398.6 ms (6) |      2.13× (6) |
| Navigation to usable (ms)                       |       937.2 ms (6) |           537.5 ms (6) |      397.9 ms (6) |      2.02× (6) |
| Prepare offline editing (ms)                    |         1.5 ms (6) |             0.2 ms (6) |        1.2 ms (6) |            N/A |
| Offline reopen before edit (ms)                 |       480.3 ms (6) |             0.3 ms (6) |      480.1 ms (6) |   1598.33× (6) |
| Offline reopen after edit (ms)                  |       482.1 ms (6) |             0.1 ms (6) |      481.9 ms (6) |   4827.03× (5) |
| Warm read median, 20 reads (ms)                 |         6.6 ms (6) |             0.0 ms (6) |        6.6 ms (6) |          — (0) |
| Durable local edit (ms)                         |        70.5 ms (6) |             0.4 ms (6) |       70.1 ms (6) |    180.00× (6) |
| Reconnect sync attempt (ms)                     |       173.1 ms (6) |            49.6 ms (6) |      124.9 ms (6) |      3.56× (6) |
| Reconnect sync acknowledgment (ms; synced only) |       173.1 ms (6) |            49.6 ms (6) |      124.9 ms (6) |      3.56× (6) |
| Cold protocol responses (count)                 |        4 count (6) |            3 count (6) |       1 count (6) |            N/A |
| Cold completed response bodies (bytes)          |  20339.5 bytes (6) |         2124 bytes (6) | 18215.5 bytes (6) |      9.58× (6) |
| Cold incomplete/streaming responses (count)     |        0 count (6) |            0 count (6) |       0 count (6) |            N/A |

Cold byte bodies incomplete/streaming: 0 arm/sample(s).

## 1024 bytes · 0 unrelated files · 80 ms/request delay

partial: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures; working-set: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures

| Metric                                          | Partial median (n) | Working-set median (n) |  Median Δ P−W (n) | Median P/W (n) |
| ----------------------------------------------- | -----------------: | ---------------------: | ----------------: | -------------: |
| Cold open to usable (ms)                        |      1231.6 ms (6) |           541.8 ms (6) |      682.7 ms (6) |      2.26× (6) |
| Navigation to usable (ms)                       |      1265.3 ms (6) |           578.3 ms (6) |      678.2 ms (6) |      2.17× (6) |
| Prepare offline editing (ms)                    |         1.4 ms (6) |             0.2 ms (6) |        1.2 ms (6) |            N/A |
| Offline reopen before edit (ms)                 |       486.3 ms (6) |             0.3 ms (6) |      486.0 ms (6) |   1621.17× (6) |
| Offline reopen after edit (ms)                  |       484.3 ms (6) |             0.2 ms (6) |      484.2 ms (6) |   2435.50× (5) |
| Warm read median, 20 reads (ms)                 |         6.6 ms (6) |             0.0 ms (6) |        6.6 ms (6) |          — (0) |
| Durable local edit (ms)                         |        71.2 ms (6) |             0.4 ms (6) |       70.8 ms (6) |    178.12× (6) |
| Reconnect sync attempt (ms)                     |       496.9 ms (6) |           375.1 ms (6) |      122.4 ms (6) |      1.33× (6) |
| Reconnect sync acknowledgment (ms; synced only) |       496.9 ms (6) |           375.1 ms (6) |      122.4 ms (6) |      1.33× (6) |
| Cold protocol responses (count)                 |        4 count (6) |            3 count (6) |       1 count (6) |            N/A |
| Cold completed response bodies (bytes)          |  20362.5 bytes (6) |         2124 bytes (6) | 18238.5 bytes (6) |      9.59× (6) |
| Cold incomplete/streaming responses (count)     |        0 count (6) |            0 count (6) |       0 count (6) |            N/A |

Cold byte bodies incomplete/streaming: 0 arm/sample(s).

## 98304 bytes · 0 unrelated files · 80 ms/request delay

partial: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures; working-set: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures

| Metric                                          | Partial median (n) | Working-set median (n) | Median Δ P−W (n) | Median P/W (n) |
| ----------------------------------------------- | -----------------: | ---------------------: | ---------------: | -------------: |
| Cold open to usable (ms)                        |      1244.4 ms (6) |           541.7 ms (6) |     697.1 ms (6) |      2.29× (6) |
| Navigation to usable (ms)                       |      1283.1 ms (6) |           578.6 ms (6) |     702.3 ms (6) |      2.22× (6) |
| Prepare offline editing (ms)                    |         1.7 ms (6) |             0.3 ms (6) |       1.5 ms (6) |            N/A |
| Offline reopen before edit (ms)                 |       487.5 ms (6) |             0.5 ms (6) |     487.1 ms (6) |    977.30× (6) |
| Offline reopen after edit (ms)                  |       491.8 ms (6) |             0.8 ms (6) |     490.3 ms (6) |    609.44× (6) |
| Warm read median, 20 reads (ms)                 |         7.9 ms (6) |             0.1 ms (6) |       7.8 ms (6) |     79.00× (6) |
| Durable local edit (ms)                         |        72.6 ms (6) |             0.9 ms (6) |      71.6 ms (6) |     78.28× (6) |
| Reconnect sync attempt (ms)                     |       580.3 ms (6) |           387.3 ms (6) |     192.6 ms (6) |      1.50× (6) |
| Reconnect sync acknowledgment (ms; synced only) |       580.3 ms (6) |           387.3 ms (6) |     192.6 ms (6) |      1.50× (6) |
| Cold protocol responses (count)                 |        4 count (6) |            3 count (6) |      1 count (6) |            N/A |
| Cold completed response bodies (bytes)          |   150048 bytes (6) |        99404 bytes (6) |  50644 bytes (6) |      1.51× (6) |
| Cold incomplete/streaming responses (count)     |        0 count (6) |            0 count (6) |      0 count (6) |            N/A |

Cold byte bodies incomplete/streaming: 0 arm/sample(s).

## 1024 bytes · 500 unrelated files · 80 ms/request delay

partial: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures; working-set: 6/6 passed, 0 post-cold scenario failures, 0 pre-cold failures

| Metric                                          | Partial median (n) | Working-set median (n) | Median Δ P−W (n) | Median P/W (n) |
| ----------------------------------------------- | -----------------: | ---------------------: | ---------------: | -------------: |
| Cold open to usable (ms)                        |      1311.3 ms (6) |           637.3 ms (6) |     610.8 ms (6) |      2.00× (6) |
| Navigation to usable (ms)                       |      1340.8 ms (6) |           666.6 ms (6) |     614.1 ms (6) |      1.96× (6) |
| Prepare offline editing (ms)                    |         1.6 ms (6) |             0.2 ms (6) |       1.4 ms (6) |            N/A |
| Offline reopen before edit (ms)                 |       495.2 ms (6) |             0.3 ms (6) |     494.9 ms (6) |   1648.17× (6) |
| Offline reopen after edit (ms)                  |       493.5 ms (6) |             0.2 ms (6) |     493.3 ms (6) |   2467.25× (6) |
| Warm read median, 20 reads (ms)                 |         6.5 ms (6) |             0.0 ms (6) |       6.5 ms (6) |          — (0) |
| Durable local edit (ms)                         |        74.8 ms (6) |             0.4 ms (6) |      74.4 ms (6) |    187.50× (6) |
| Reconnect sync attempt (ms)                     |       497.0 ms (6) |           393.0 ms (6) |     103.2 ms (6) |      1.26× (6) |
| Reconnect sync acknowledgment (ms; synced only) |       497.0 ms (6) |           393.0 ms (6) |     103.2 ms (6) |      1.26× (6) |
| Cold protocol responses (count)                 |        4 count (6) |            3 count (6) |      1 count (6) |            N/A |
| Cold completed response bodies (bytes)          |    79525 bytes (6) |         2124 bytes (6) |  77401 bytes (6) |     37.44× (6) |
| Cold incomplete/streaming responses (count)     |        0 count (6) |            0 count (6) |      0 count (6) |            N/A |

Cold byte bodies incomplete/streaming: 0 arm/sample(s).

Cold response bytes sum completed Lix protocol response bodies only; they exclude browser assets, requests, headers, and incomplete/streaming responses. The 80 ms delay is injected before each protocol fetch, not a full network emulator. These one-file synthetic results are not production repository E2E latency. Preparation cost is separate; working-set preparation is a no-op, so its ratio is N/A.
