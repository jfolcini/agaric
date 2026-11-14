# Session 4130 — the persist-retry budget test no longer races a second task against the backoff

`materializer::tests::retry_metrics::persist_recovers_within_bounded_budget_851` failed once in CI, on a Markdown-only PR (#6734, `cargo-tests (2)`): `record_failure_with_retry` returned `false`. The session set out to say whether that was a test race or a retry budget too short for a slow device, and to fix whichever it was.

## Cause

A test race. The test dropped `materializer_retry_queue` and spawned a task that polled `retry_queue_persist_errors` and recreated the table once two attempts had failed. A missing table fails at prepare, at once, so the loop's remaining budget was its two last backoffs of wall-clock time. In that window the watcher had to wake from its poll, hand a `CREATE TABLE` to a SQLite worker thread and have it commit. When those hops were scheduled late, attempts three and four found no table.

It is not a product weakness. The failure the budget exists for is write-lock contention, and there each attempt already waits out the pool's `busy_timeout` before it fails, so the backoff between attempts is the smaller part of the budget. Only a failure that returns at once, like the missing table, leaves the backoff as the whole budget, and nothing in production drops that table.

## Reproduction

Each run is its own process, as under nextest, on a 4-core box.

- Ordinary load did not reproduce it: 0 of 2700 runs failed across CPU oversubscription (up to 128 parallel runs beside 128 busy loops) and an fsync-heavy disk load.
- Starvation did: the test pinned to one core at `nice 19`, six at a time, beside three busy loops on that core at `nice 0`, failed 17 of 600 runs, each with the CI panic at the same line.
- The rewritten test under the same starvation: 0 of 400.

## Fix

`record_failure_with_retry`'s loop moved into `persist_with_retry`, which takes the persist attempt as a closure; `record_failure_with_retry` passes `record_failure`. The test passes a closure that recreates the table at the start of its third call and then calls the real `record_failure`, so the recreate happens before the attempt by construction and there is no second task. It asserts exactly three attempts and exactly two persist errors, where it asserted "at least two".

Paused tokio time was not usable: sqlx runs SQLite on its own threads, so the runtime looks idle while a statement runs and the clock auto-advances past the backoff, which is the same race.

Falsified by cutting `PERSIST_RETRY_ATTEMPTS` to 2: the test went red on its `persisted` assertion.

## Siblings

No other test in `retry_metrics.rs` shares the cause. `record_failure_persist_error_is_metered_pend24_m1` never brings the table back, and the poll in `foreground_applyop_exhausted_persists_and_re_enqueues_on_boot` waits for an outcome with a deadline, not against a product budget.

## Scope

Touched `agaric-engine/src/materializer/consumer.rs` (the persist-retry helper only) and `agaric-engine/src/materializer/tests/retry_metrics.rs`. Another session is changing the background queue; nothing there was touched.

## What ran

The `retry_metrics` tests, the loops above, and `cargo clippy --workspace --all-targets -- -D warnings`. `cargo-nextest` was not installed in this container, so the loops ran the test binary directly with `--exact`; the full suite is CI's.
