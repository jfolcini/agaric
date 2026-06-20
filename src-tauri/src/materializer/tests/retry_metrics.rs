use super::*;

// These tests exercise only the metric side; the warn-line wiring is
// covered by inspection (tracing-test fixtures are intentionally not
// pulled in to keep this drop-observability change strictly additive).
// ──────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_bumps_when_apply_op_retry_exhausts() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a: A `create_block` with an empty payload deterministically fails
    // `serde_json::from_str::<CreateBlockPayload>` inside `apply_op_tx`,
    // so both the first attempt and the 100ms retry land on Ok(Err(_)).
    // That is exactly the retry-exhaust path we want to observe.
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "create_block",
        "{}",
    ))))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    let m = mat.metrics();
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        1,
        "ApplyOp retry exhaust should bump fg_apply_dropped exactly once",
    );
    assert_eq!(
        m.fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "ApplyOp retry exhaust should bump fg_errors exactly once",
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_bumps_once_per_failed_batch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a: A 2-element batch where the first op deterministically fails
    // payload deserialization. The whole batch is dropped together
    // (apply_op_tx returns Err inside the outer transaction, which is
    // rolled back). Per the spec, fg_apply_dropped must increment
    // exactly once for the failed batch, regardless of batch size — the
    // remaining ops are implicitly dropped.
    let bad1 = fake_op_record("create_block", "{}");
    let bad2 = fake_op_record("create_block", "{}");
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![
        bad1, bad2,
    ])))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    let m = mat.metrics();
    // #649: the spec above says "exactly once for the failed batch,
    // regardless of batch size". The old `>= 1` left a weakening mutant
    // (an off-by-N bump) undetected; assert the exact count the comment
    // promises so the test actually constrains the implementation.
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        1,
        "BatchApplyOps retry exhaust should bump fg_apply_dropped exactly once for the failed batch",
    );
    assert!(
        m.fg_errors.load(AtomicOrdering::Relaxed) >= 1,
        "BatchApplyOps retry exhaust should also still bump fg_errors",
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_stays_zero_for_non_apply_task() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a (negative case): a non-Apply task — `UpdateFtsBlock` for a
    // block that doesn't exist — must never bump `fg_apply_dropped`.
    // This task is routed to the background queue, where the existing
    // Retry/persist semantics apply unchanged. The point of
    // the assertion is that the new fg-only counter does not pollute
    // the bg path. (`UpdateFtsBlock` against a missing block actually
    // succeeds — the handler treats "no row" as "remove from FTS" — so
    // this also exercises the bg-success path's effect on the new
    // counter.)
    mat.enqueue_background(MaterializeTask::UpdateFtsBlock {
        block_id: "BLK_DOES_NOT_EXIST".into(),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let m = mat.metrics();
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "non-Apply background task must not bump fg_apply_dropped",
    );
    // Sanity: the bg path itself ran (bg_processed advanced). We don't
    // assert on bg_errors / bg_dropped here — the point is just that
    // the new counter is fg-only.
    assert!(
        m.bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "background task should still be processed",
    );
    mat.shutdown();
}

// ──────────────────────────────────────────────────────────────────────
// `record_failure` persistence-failure path is metered.
//
// When the consumer's drop path calls `record_failure` and the SQLite
// write itself returns Err (e.g. table missing during a hot
// migration, WAL contention exceeding our retry budget), the task
// must NOT be silently leaked. The fix wraps every persistence call
// in `record_failure_with_retry` which:
//   1. Retries once after a 100 ms delay.
//   2. Bumps `retry_queue_persist_errors` on every failed attempt
//      (so 2 increments if both fail).
//   3. Returns `false` on total failure so the caller can preserve
//      the surrounding metric semantics — `bg_dropped` /
//      `fg_apply_dropped` continue to bump regardless of persist
//      outcome (M1's "tasks gone total" must stay accurate).
//
// To simulate a deterministic persistence failure we drop the
// `materializer_retry_queue` table from under the running
// consumer, then submit a foreground ApplyOp that deterministically
// fails its retry budget (`{}` payload → deserialize Err). The
// consumer's drop path then exercises `record_failure_with_retry`
// against a missing table — both attempts fail, both increment.
// ──────────────────────────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_failure_persist_error_is_metered_pend24_m1() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Drop the retry queue table so every record_failure() call
    // returns Err. (`PRAGMA foreign_keys = ON` is per-connection but
    // does not protect a DROP TABLE without dependent FKs.)
    sqlx::query("DROP TABLE materializer_retry_queue")
        .execute(&pool)
        .await
        .unwrap();

    // Submit an ApplyOp that deterministically exhausts the
    // foreground retry budget (`{}` fails CreateBlockPayload deserialize
    // inside apply_op_tx — see the existing
    // `fg_apply_dropped_bumps_when_apply_op_retry_exhausts` test).
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "create_block",
        "{}",
    ))))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();

    let m = mat.metrics();
    // Both record_failure attempts (first + 100 ms retry) failed
    // because the table is gone → +2 on retry_queue_persist_errors.
    assert!(
        m.retry_queue_persist_errors.load(AtomicOrdering::Relaxed) >= 2,
        "both record_failure attempts must bump retry_queue_persist_errors \
         (got {})",
        m.retry_queue_persist_errors.load(AtomicOrdering::Relaxed),
    );
    // fg_apply_dropped MUST still bump (semantic: drop event happened),
    // and fg_apply_dropped_persisted MUST NOT bump (persist failed).
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        1,
        "fg_apply_dropped must bump exactly once on persist-failure path",
    );
    assert_eq!(
        m.fg_apply_dropped_persisted.load(AtomicOrdering::Relaxed),
        0,
        "+M1: persist-failure path must NOT bump fg_apply_dropped_persisted",
    );

    mat.shutdown();
}

// ──────────────────────────────────────────────────────────────────────
// #851 — bounded persist-failure mitigation. The previous
// budget retried `record_failure` exactly ONCE; if both the first attempt
// and that single retry hit transient WAL-lock contention, the op was
// permanently un-materialized (it already failed its foreground apply, so
// it never advances the cursor and the boot replay walk does NOT cover
// it). #851 widens the budget to a few bounded attempts so a transient
// failure that outlasts one retry still lands in the retry queue.
//
// This test makes the persist write fail for longer than a single retry
// would tolerate: it DROPs the table, then recreates it only after a delay
// that lets the FIRST attempt + the FIRST backoff elapse. The old
// single-retry budget would have already given up and returned `false`;
// the widened budget retries again, sees the table back, and persists.
// ──────────────────────────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persist_recovers_within_bounded_budget_851() {
    use crate::materializer::consumer::record_failure_with_retry;

    let (pool, _dir) = test_pool().await;
    let metrics = StdArc::new(crate::materializer::QueueMetrics::default());

    // Drop the table so the first attempt(s) fail deterministically.
    sqlx::query("DROP TABLE materializer_retry_queue")
        .execute(&pool)
        .await
        .unwrap();

    // Recreate the table after a delay long enough to outlast a single
    // retry (one 100ms backoff) but well inside the full bounded budget.
    // 250ms lands the recreate after attempt 2's failure, so attempt 3
    // succeeds — a scenario the old one-retry budget could not survive.
    let recreate_pool = pool.clone();
    let recreate = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        sqlx::query(
            "CREATE TABLE materializer_retry_queue (
                 block_id   TEXT NOT NULL,
                 task_kind  TEXT NOT NULL,
                 attempts   INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 PRIMARY KEY (block_id, task_kind)
             ) STRICT",
        )
        .execute(&recreate_pool)
        .await
        .unwrap();
    });

    let task = MaterializeTask::ApplyOp(StdArc::new(fake_op_record("create_block", "{}")));
    let persisted = record_failure_with_retry(&pool, &task, "boom", &metrics).await;
    recreate.await.unwrap();

    assert!(
        persisted,
        "#851: the bounded retry budget must recover a transient persist failure \
         that outlasts a single retry (returned false — budget too small / not widened)"
    );
    // At least the first two attempts failed before the table came back.
    assert!(
        metrics
            .retry_queue_persist_errors
            .load(AtomicOrdering::Relaxed)
            >= 2,
        "each pre-recreate attempt must bump retry_queue_persist_errors (got {})",
        metrics
            .retry_queue_persist_errors
            .load(AtomicOrdering::Relaxed),
    );
    // The row must actually be present after recovery.
    let row_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM materializer_retry_queue WHERE block_id = ?")
            .bind("__APPLY_OP__")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row_count, 1,
        "#851: the recovered attempt must leave exactly one persisted retry row"
    );
}

// ──────────────────────────────────────────────────────────────────────
// Foreground `ApplyOp` retry exhaustion now persists the
// failure to `materializer_retry_queue` (replacing the previous
// silent drop). The boot-time / periodic sweeper re-loads the
// `OpRecord` from `op_log` and re-enqueues onto the foreground
// queue.
//
// Persistence shape (mirrors `__GLOBAL__` sentinel):
//   block_id = '__APPLY_OP__'
//   task_kind = "ApplyOp:<seq>:<device_id>"
//
// The composite primary key `(block_id, task_kind)` dedups failures
// of the same op across multiple retries naturally — the SQL-side
// `attempts + 1` increment in `record_failure` accumulates.
//
// This regression test exercises the full round trip in one
// scenario:
//   1. Submit an ApplyOp that deterministically fails (`{}` payload
//      → `serde_json::from_str::<CreateBlockPayload>` returns Err
//      inside `apply_op_tx`). Both the first attempt and the 100ms
//      retry fail, the consumer's drop path persists the failure.
//   2. Assert `fg_apply_dropped` and `fg_apply_dropped_persisted`
//      both bumped, and the retry-queue row exists with the
//      expected sentinel + composite-key shape.
//   3. Plant a *valid* op in op_log + matching retry-queue row, then
//      call `sweep_once` — the row must be deleted and the
//      foreground consumer applies the op successfully.
// ──────────────────────────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreground_applyop_exhausted_persists_and_re_enqueues_on_boot() {
    use crate::materializer::retry_queue;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // ── Phase 1: deterministic foreground retry exhaust → persistence.
    let bad_record = fake_op_record("create_block", "{}");
    let bad_seq = bad_record.seq;
    let bad_device = bad_record.device_id.clone();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(bad_record)))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    let m = mat.metrics();
    assert!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed) >= 1,
        "fg_apply_dropped must bump on foreground retry exhaustion",
    );
    assert!(
        m.fg_apply_dropped_persisted.load(AtomicOrdering::Relaxed) >= 1,
        "fg_apply_dropped_persisted must bump after retry-queue write succeeds",
    );

    let expected_kind = format!("ApplyOp:{bad_seq}:{bad_device}");
    let row = sqlx::query!(
        "SELECT block_id, task_kind FROM materializer_retry_queue \
         WHERE task_kind = ?",
        expected_kind,
    )
    .fetch_one(&pool)
    .await
    .expect("retry-queue row must exist for the persisted ApplyOp failure");
    assert_eq!(
        row.block_id, "__APPLY_OP__",
        "failed ApplyOp rows live under the __APPLY_OP__ sentinel"
    );
    assert_eq!(row.task_kind, expected_kind);

    // Cleanup: the bad_record was constructed via `fake_op_record` and never
    // appended to op_log. Sweeping it now would log a NotFound warn — drop
    // the row before phase 2 to keep the test log clean.
    sqlx::query!("DELETE FROM materializer_retry_queue")
        .execute(&pool)
        .await
        .unwrap();

    // ── Phase 2: sweep_once replays a persisted ApplyOp by re-loading
    //    from op_log. Append a valid op so the lookup succeeds.
    let valid_record = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK-H1-RECOVER"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "recovered content".into(),
        }),
    )
    .await;
    let task_kind = format!("ApplyOp:{}:{}", valid_record.seq, valid_record.device_id);
    let past = crate::db::now_ms() - 2 * 60_000;
    sqlx::query!(
        "INSERT INTO materializer_retry_queue \
             (block_id, task_kind, attempts, next_attempt_at) \
         VALUES (?, ?, ?, ?)",
        "__APPLY_OP__",
        task_kind,
        1_i64,
        past,
    )
    .execute(&pool)
    .await
    .unwrap();

    let n = retry_queue::sweep_once(&pool, &pool, &mat).await.unwrap();
    assert_eq!(
        n, 1,
        "the planted ApplyOp retry row must be re-enqueued onto the foreground queue"
    );
    // Issue #378: the sweeper now LEASES the row on enqueue instead of
    // deleting it — the row stays put until the re-enqueued task
    // completes durably, at which point the consumer's
    // `clear_on_success` deletes it. We do NOT assert the leased row is
    // present immediately after the sweep: the live foreground consumer
    // (spawned by `Materializer::new`) can drain and durably-succeed the
    // re-enqueued op before this thread observes the row, so an
    // immediate "row still present" check would race. The lease-keeps-
    // the-row invariant is pinned deterministically in
    // `retry_queue::tests` (no live consumer). Here we assert the
    // end-to-end contract: the row is eventually cleared via the
    // confirmed-success path (and was NOT pre-deleted on enqueue, which
    // would have lost the retry entry had the apply failed).

    // The re-enqueue routed the task to the foreground queue; flushing
    // drains it (the apply succeeds because the op is valid), and the
    // foreground consumer's durable-success path calls `clear_on_success`
    // to delete the leased row. We don't assert on the resulting
    // `blocks` row to keep this test focused on the persist + sweep
    // contract — the subsequent `dispatch_op_create_block_*` tests
    // already cover that path.
    mat.flush_foreground().await.unwrap();

    // Issue #378: after the durable foreground success the leased row is
    // cleared. `flush_foreground` returns once the consumer has drained
    // the batch, but the post-success `clear_on_success` DELETE may lag
    // slightly — poll briefly for the confirmed-success clear.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let remaining: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) AS \"n!: i64\" FROM materializer_retry_queue",)
                .fetch_one(&pool)
                .await
                .unwrap();
        if remaining == 0 {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!(
                "issue #378: leased ApplyOp row must be cleared after the \
                 re-enqueued task completes durably; row never cleared"
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    mat.shutdown();
}

// ──────────────────────────────────────────────────────────────────────
// Foreground retry: ordering of error log vs.
// retry attempt.
//
// The shared `retry_with_backoff` helper used to emit the first-attempt
// failure at `error` level via `log_consumer_result`, sleep, then retry.
// If the retry succeeded, the operator-facing logs were left with a
// stray `error processing materializer task` line for an op that
// actually completed — polluting `recent_errors_from_log_dir` and
// bug-report log captures.
//
// The fix: demote first-attempt (and intermediate retry-attempt)
// non-panic failures to `debug`. Panics keep their `error` level. On
// final retry exhaustion the helper emits a single `error` line. On
// retry success the helper emits an `info` "succeeded after retry"
// correlation line. `fg_errors` / `bg_errors` semantics are unchanged
// — they still bump on final failure via the caller.
//
// These tests pin the new log-level shape via in-process log capture
// (mirrors the `WarnBufWriter` pattern at
// `dispatch_background_or_warn_logs_seq_and_device_id_on_serde_error`).
// The `RetryOutcome` shape is also asserted directly so a test failure
// localises to either the log-level wiring or the outcome wiring.
// ──────────────────────────────────────────────────────────────────────

/// Thread-safe buffered writer for in-process log capture (mirrors the
/// helper used by `dispatch_background_or_warn_logs_seq_and_device_id_on_serde_error`).
/// Per-test `#[derive(Clone, Default)]` shadow definitions are used
/// because `tests.rs` deliberately keeps each helper local to the
/// test that owns it (see AGENTS.md § "Test helper duplication is
/// intentional"). We re-define instead of factoring to avoid coupling
/// unrelated tests.
#[derive(Clone, Default)]
struct LogBufWriter(StdArc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBufWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBufWriter {
    type Writer = LogBufWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_with_backoff_first_failure_does_not_emit_error_log_when_retry_succeeds() {
    use std::sync::atomic::AtomicU32;
    use tracing_subscriber::layer::SubscriberExt;

    let writer = LogBufWriter::default();
    // Capture every level so a stray ERROR shows up; the assertion
    // checks for the ERROR substring in the formatter output.
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_writer(writer.clone())
            .with_ansi(false)
            .with_level(true)
            .with_target(false),
    );
    let _guard = tracing::subscriber::set_default(subscriber);

    // Closure: first invocation returns Err, second returns Ok. The
    // shared `Arc<AtomicU32>` is the only state that survives across
    // closure invocations because the future returned must be
    // `'static + Send`.
    let attempts = StdArc::new(AtomicU32::new(0));
    let attempts_for_closure = StdArc::clone(&attempts);
    let outcome = super::super::consumer::retry_with_backoff(
        "fg",
        1,
        |_| Duration::from_millis(0),
        move || {
            let attempts = StdArc::clone(&attempts_for_closure);
            async move {
                let n = attempts.fetch_add(1, AtomicOrdering::Relaxed);
                if n == 0 {
                    Err(AppError::Validation("transient WAL contention".into()))
                } else {
                    Ok(())
                }
            }
        },
    )
    .await;

    // Behavioural assertions on RetryOutcome — independent of any log
    // capture, so the test still pins the contract even if the
    // formatter changes.
    assert!(
        outcome.succeeded,
        "retry-success path must set succeeded = true"
    );
    assert!(
        !outcome.panicked,
        "retry-success path must leave panicked = false"
    );
    assert!(
        outcome.last_error_msg.is_none(),
        "retry-success path must clear last_error_msg, got {:?}",
        outcome.last_error_msg
    );
    assert_eq!(
        attempts.load(AtomicOrdering::Relaxed),
        2,
        "closure must run exactly twice (one fail, one retry success)"
    );

    let contents = String::from_utf8_lossy(&writer.0.lock().unwrap()).into_owned();
    // The first-attempt failure must NOT escalate to ERROR. The
    // tracing-subscriber `fmt` layer renders levels in upper-case
    // ASCII, so a substring match is reliable.
    assert!(
        !contents.contains("ERROR"),
        "no ERROR-level log should be emitted when retry succeeds, captured: {contents:?}"
    );
    // The optional positive-correlation `info!` line must fire.
    assert!(
        contents.contains("materializer task succeeded after retry"),
        "info-level success-after-retry line must be emitted, captured: {contents:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_with_backoff_emits_error_log_when_all_retries_fail() {
    use std::sync::atomic::AtomicU32;
    use tracing_subscriber::layer::SubscriberExt;

    let writer = LogBufWriter::default();
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_writer(writer.clone())
            .with_ansi(false)
            .with_level(true)
            .with_target(false),
    );
    let _guard = tracing::subscriber::set_default(subscriber);

    let attempts = StdArc::new(AtomicU32::new(0));
    let attempts_for_closure = StdArc::clone(&attempts);
    let outcome = super::super::consumer::retry_with_backoff(
        "fg",
        1,
        |_| Duration::from_millis(0),
        move || {
            let attempts = StdArc::clone(&attempts_for_closure);
            async move {
                attempts.fetch_add(1, AtomicOrdering::Relaxed);
                Err(AppError::Validation("permanent failure".into()))
            }
        },
    )
    .await;

    assert!(
        !outcome.succeeded,
        "all-retries-fail path must leave succeeded = false"
    );
    assert!(
        !outcome.panicked,
        "non-panic failure must leave panicked = false"
    );
    assert!(
        outcome.last_error_msg.is_some(),
        "all-retries-fail path must capture last_error_msg"
    );
    let last_msg = outcome.last_error_msg.as_deref().unwrap_or_default();
    assert!(
        last_msg.contains("permanent failure"),
        "last_error_msg should embed the closure's error, got: {last_msg:?}"
    );
    assert_eq!(
        attempts.load(AtomicOrdering::Relaxed),
        2,
        "closure must run exactly twice (initial + 1 retry)"
    );

    let contents = String::from_utf8_lossy(&writer.0.lock().unwrap()).into_owned();
    // The retry-exhausted final escalation must surface at ERROR level.
    assert!(
        contents.contains("ERROR"),
        "retry-exhausted path must emit at least one ERROR-level log, captured: {contents:?}"
    );
    assert!(
        contents.contains("error processing materializer task"),
        "retry-exhausted path must emit the canonical error message, captured: {contents:?}"
    );
}
