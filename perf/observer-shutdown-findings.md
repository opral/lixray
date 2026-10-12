# Observer watcher shutdown findings

## Revision context

The comparison baseline is `ee1d06d`. The implementation candidate is `9421ddfcfae22858f0205ed72536ad51b39eb88c` (tree `548debeb5102bf95a72f86cb126430d38fb0c053`).

## Observed failure

The cloud E2E run reported that `sync_mode::small_file_observer_receives_remote_edit_without_a_chunk_round_trip` passed its assertions, then the test process aborted during teardown with `pthread lock: Invalid argument`. One reported run had 260 of 261 tests pass, with this test as the sole abort. The test body completed in 4.54 seconds and the process aborted at about 4.78 seconds, close to the 250 ms external revision polling interval.

The diagnostic was matched to RocksDB's POSIX `PthreadCall("lock", pthread_mutex_lock)` path. That identifies a native RocksDB diagnostic, but it does not identify the particular mutex or prove that this observer task caused the abort. The timing and ownership paths below make the detached observer poller a concrete lifecycle issue; the intermittent cloud abort remains a correlation until a reproducer or stack trace proves the exact failure path.

## Ownership before and after

Before the change, both observer watcher variants used the detached `background_task::spawn` helper, which discarded its thread handle. The change-watch loop upgraded a `Weak<ObserveInvalidation>` before awaiting `changes.changed()`. That strong reference stayed live during an idle wait, retaining the invalidation owner and its storage-backed change source. It also had no last-subscriber shutdown branch while waiting on the source.

The native external-revision poller also ran as a detached thread. It slept for 250 ms before checking whether its weak invalidation owner could still be upgraded. Dropping the final owner therefore could leave the thread and its captured storage alive until the next tick. `session.close()` is not a join for this worker, and this note makes no claim that it joins checkpoint-maintenance work.

The candidate adds an owned background task handle while preserving existing detached `spawn` callers. The owned task races its worker future against cancellation. On native targets, the handle sends cancellation and joins the worker when its owner drops. It initializes a private Tokio current-thread runtime on the worker and reports runtime initialization failure to the starter before watcher startup succeeds. A join panic is returned during explicit reaping; Drop cannot return errors.

`ObserveInvalidation` now owns the watcher handle. Worker tasks retain only a weak reference to the signal state across awaits, plus a separate lifecycle object used to coordinate startup and restart. A change watcher races the adapter wait against `watch::Sender::closed()`. When the last observer closes, it rechecks the receiver count under the shared startup gate before stopping, so a concurrent new observer either keeps the worker or starts a replacement. The revision poller uses a Tokio timer raced against receiver closure, so final-owner cancellation does not wait for its next polling tick. The same startup gate continues to serialize baseline reads and supports retry after a cancelled start.

An adapter may also return an already-ready `changed()` future repeatedly. The watcher now yields after each successful notification so the outer cancellation race gets polled even under that source behavior. A regression uses an always-ready source, observes an invalidation, then drops the owner and checks that the source and its retained storage token are released after join. This guards cancellation fairness separately from the pending-source tests.

On browser Wasm there is no worker thread to join. The owned handle signals its cancellation receiver, which cancels the spawned local future. The synchronous Drop path is therefore a native thread join on desktop/server builds and a cancellation signal on browser builds.

## Regression evidence

The pending change-watch regression waits until the worker is actually blocked in `changed()`, drops the last observer, and checks that the source is dropped and the watcher can restart. The final-owner regression keeps an observer receiver alive, drops the owner, and checks immediately that the weak owner and a weak storage token can no longer be upgraded; it also confirms that the pending change source was dropped.

The poll regression instruments storage reads and waits for a read after the startup baseline before dropping the final owner. Immediately after Drop returns, it checks that the weak owner and storage references are gone. It records shutdown time and the configured polling interval as JSON for measurement. There is no wall-clock pass/fail threshold, so scheduling load cannot turn a slow run into a flaky test failure; release after the join is the correctness assertion.

The focused test binary was run as 20 independent processes after the full native gate passed (5,043/5,043 tests). All 20 processes exited successfully and exercised the post-baseline poll read, owner Drop, and weak-release assertions. Historical raw captures are omitted from the source repository.

Across these local Memory-backed test runs, measured synchronous owner-Drop cancellation and join ranged from 51 to 195 microseconds, with a median of 61.5 microseconds. The configured polling interval was 250,000 microseconds. Total process durations were about 255 to 257 milliseconds because the test waits for the first revision poll before dropping the owner; that wait is not part of `shutdown_us`. These are measurements of the test path on this machine, not a before/after comparison, not a speedup claim against the detached implementation, and not a direct RocksDB teardown benchmark. The cloud abort's exact mutex causality remains unproven.

The full native gate ran 5,043 tests across 12 binaries, with 89 skipped.
The profiled unit binary lists 5,109 tests, including 87 ignored: it contributes
5,022 executed tests; the other binaries contribute 21 executed and two ignored
tests. A focused run therefore reports 5,108 filtered tests. These counts refer
to different selections of the same qualification build, not different sources.
