# Checkpoint history qualification

The candidate Lix engine at `f0dcfee8cc60c1c6930b537f5b4fb85264a7b07a`
loads bounded checkpoint windows in batches. An isolated reference at the same
commit restores only the previous behavior: an explicit LIMIT uses a window of
one. Both ran the same regression/profile with the full simulation and server
protocol feature set on 2026-10-05.

The workload creates real file checkpoints through public APIs, retires one to
prove retirement state exists, then queries 30 visible checkpoints with LIMIT
40 in a fresh partial replica. Six samples cover zero and 50 ms injected HTTP
latency. Warm pages assert exact result equality and zero additional HTTP calls.

For LIMIT 40, the candidate performs one retirement batch containing 30 IDs;
the reference performs 30 batches containing the same number of IDs. Candidate
warm page-40 queries took 1.92–1.96 ms; the reference took 15.28–15.43 ms. Warm
page-10 medians were 2.57 versus 4.75 ms, and page-20 medians were 2.89 versus
10.60 ms. These measurements support batching the local query work.

Both versions made ten cold-query requests: eight physical fallback calls and
two metadata walks. Independently seeded UUID/tree shapes vary, so observed
cold-query elapsed times and response bytes cannot establish a causal network
improvement. The current-epoch retirement interest itself is a correctness fix:
a separate regression publishes an authority retirement and verifies that a
plain subsequent local query excludes the retired checkpoint.

Raw samples and command provenance are in
[checkpoint-history-window-profile.json](checkpoint-history-window-profile.json).
The benchmark lives in the engine's checkpoint log profile regression; no
benchmark switch or old-window compatibility path is added to production.
