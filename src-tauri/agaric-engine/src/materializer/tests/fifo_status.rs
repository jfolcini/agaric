use super::*;
use crate::loro::shared::LoroState;

/// H-5 / H-6 (2026-04) regression guard: two `ApplyOp` tasks targeting
/// *different* block_ids are now processed strictly FIFO (no JoinSet
/// bucketing). This test pins that both blocks see their edits in the
/// order the ops were enqueued and that `fg_processed` advances twice.
///
/// Historically this test was named `parallel_groups` and relied on the
/// JoinSet parallel-group dispatch to run the two ops concurrently.
/// That dispatch path was deleted for H-5 / H-6 because SQLite
/// serialises writes at the engine level (single writer in WAL mode),
/// so parallel buckets bought no throughput while creating FK-ordering
/// and bucketing-key hazards.
#[tokio::test]
async fn foreground_distinct_block_edits_land_in_fifo_order() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAR_A", "content", "original-A").await;
    insert_block_direct(&pool, "PAR_B", "content", "original-B").await;
    let ra = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_A"),
            to_text: "updated-A".into(),
            prev_edit: None,
        }),
    )
    .await;
    let rb = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_B"),
            to_text: "updated-B".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(ra)))
        .await
        .unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(rb)))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    let ca: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_A'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ca.as_deref(),
        Some("updated-A"),
        "block PAR_A content should be updated"
    );
    let cb: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_B'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cb.as_deref(),
        Some("updated-B"),
        "block PAR_B content should be updated"
    );
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        3,
        "should process exactly 2 distinct-block edits plus the flush barrier"
    );
}

#[test]
fn high_water_zero() {
    let m = QueueMetrics::default();
    assert_eq!(
        m.fg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "fg high water should start at zero"
    );
    assert_eq!(
        m.bg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "bg high water should start at zero"
    );
}
#[tokio::test]
async fn high_water_fg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-hw"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "hw".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.metrics().fg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "fg high water should increase after dispatch_op"
    );
}
#[tokio::test]
async fn high_water_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    assert!(
        mat.metrics().bg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "bg high water should increase after enqueue_background"
    );
}
#[tokio::test]
async fn status_info() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let s = mat.status().await;
    assert_eq!(
        s.fg_high_water, 0,
        "initial fg high water in status should be zero"
    );
    assert_eq!(
        s.bg_high_water, 0,
        "initial bg high water in status should be zero"
    );
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-si"),
            block_type: "page".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "status".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.status().await.fg_high_water >= 1,
        "fg high water should rise after dispatching an op"
    );
}

/// #1326: the SQL-only fallback observability counter must be reachable
/// through the production `StatusInfo` surface. `record()` increments a
/// *process-global* monotonic `AtomicU64`, so other tests running in the
/// same process may have bumped it; we assert a **delta** (count-before vs
/// count-after) rather than an absolute value to stay robust under nextest
/// parallelism.
#[tokio::test]
async fn status_surfaces_sql_only_fallback_count() {
    use crate::materializer::handlers::sql_only_fallback;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    let before = mat.status().await.sql_only_fallback_count;
    assert_eq!(
        before,
        sql_only_fallback::count(),
        "StatusInfo must report the live process-global fallback count"
    );

    sql_only_fallback::record(
        "test_op",
        sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
    );

    let after = mat.status().await.sql_only_fallback_count;
    assert_eq!(
        after,
        before + 1,
        "StatusInfo::sql_only_fallback_count must reflect the +1 from record()"
    );
}

/// #4638: an `edit_block` record without a `block_id` sidecar is rejected in
/// every build instead of silently skipping the per-block reindexes.
#[tokio::test]
async fn dispatch_bg_empty_block_id_returns_validation_err() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let result = mat.dispatch_background(&fake_op_record(
        "edit_block",
        r#"{"to_text":"hello","prev_edit":null}"#,
    ));
    match result {
        Err(AppError::Validation { message, .. }) => {
            assert!(
                message.contains("edit_block payload has empty block_id"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
    mat.shutdown();
}
#[tokio::test]
async fn error_counters_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let m = mat.metrics();
    assert_eq!(
        m.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "fg errors should start at zero"
    );
    assert_eq!(
        m.bg_errors.load(AtomicOrdering::Relaxed),
        0,
        "bg errors should start at zero"
    );
}
#[tokio::test]
async fn status_error_counters() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let s = mat.status().await;
    assert_eq!(s.fg_errors, 0, "status fg_errors should start at zero");
    assert_eq!(s.bg_errors, 0, "status bg_errors should start at zero");
}

#[tokio::test]
async fn handle_fg_apply_op() {
    let (pool, _dir) = test_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('NOOP_BLK', 'content', 'original')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let task = MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "edit_block",
        r#"{"block_id":"NOOP_BLK","to_text":"modified","prev_edit":null}"#,
    )));
    assert!(
        handle_foreground_task(&pool, &task, &LoroState::new())
            .await
            .is_ok(),
        "handle_foreground_task should succeed for valid ApplyOp"
    );
    let c: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'NOOP_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        c.as_deref(),
        Some("modified"),
        "content should be updated by foreground ApplyOp"
    );
}
#[tokio::test]
async fn handle_fg_barrier() {
    let (pool, _dir) = test_pool().await;
    let n = Arc::new(tokio::sync::Notify::new());
    assert!(
        handle_foreground_task(
            &pool,
            &MaterializeTask::Barrier(Arc::clone(&n)),
            &LoroState::new()
        )
        .await
        .is_ok(),
        "barrier task should succeed"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), n.notified())
            .await
            .is_ok(),
        "barrier notify should fire within timeout"
    );
}
#[tokio::test]
async fn handle_fg_unexpected() {
    // An unexpected (background-only) variant in the foreground
    // queue must surface as `Err(Validation)` so the consumer bumps
    // `fg_errors` and reviewers see a real signal instead of a silent
    // drop.
    let (pool, _dir) = test_pool().await;
    let result =
        handle_foreground_task(&pool, &MaterializeTask::RebuildTagsCache, &LoroState::new()).await;
    match result {
        Err(AppError::Validation { message: msg, .. }) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}
#[tokio::test]
async fn handle_fg_unexpected_reindex() {
    // See `handle_fg_unexpected` — same contract for any
    // background-only variant.
    let (pool, _dir) = test_pool().await;
    let result = handle_foreground_task(
        &pool,
        &MaterializeTask::ReindexBlockLinks {
            block_id: "01FAKE00000000000000000000".into(),
        },
        &LoroState::new(),
    )
    .await;
    match result {
        Err(AppError::Validation { message: msg, .. }) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}
#[tokio::test]
async fn handle_bg_unexpected_apply() {
    // (bg mirror): an `ApplyOp` in the background queue is a
    // dispatch bug. The handler must return `Err(Validation)` so the
    // bg consumer bumps `bg_errors`. Block must NOT be created.
    let (pool, _dir) = test_pool().await;
    let result = handle_background_task(
        &pool,
        &MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
            "create_block",
            r#"{"block_id":"X","block_type":"content","content":"t","parent_id":null,"position":null}"#,
        ))),
        None,
        None,
    )
    .await;
    match result {
        Err(AppError::Validation { message: msg, .. }) => {
            assert!(
                msg.contains("unexpected ApplyOp in background queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'X'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.0, 0,
        "ApplyOp in bg queue must not mutate state even though it now errors"
    );
}

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------
//
// `enqueue_foreground` previously inspected `tx.capacity()` BEFORE
// the awaiting `send` to bump `fg_full_waits`. That snapshot was racy
// (the consumer can drain between the read and the send) so the metric
// under-counted real wait events. The fix uses `try_send` first and
// only bumps the counter on the `Full` arm — guaranteeing 1:1
// correlation between counter increments and "we actually awaited on a
// full channel".
//
// Misrouted variants in either queue used to log at warn and
// return Ok(()), silently absorbing dispatch bugs. They now return
// `Err(AppError::Validation { .. })` so consumers bump `fg_errors` /
// `bg_errors` and reviewers see a real signal.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_foreground_does_not_bump_fg_full_waits_when_capacity_available() {
    // The happy path — channel has capacity, `try_send` succeeds
    // immediately, `fg_full_waits` must remain at zero. The old snapshot
    // check could in principle race (capacity read 0 milliseconds before
    // send), but more importantly was inverted in spirit: capacity == 0
    // does not actually mean we waited. The new contract is "the metric
    // counts real wait events only".
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let before = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(before, 0, "fg_full_waits starts at zero");

    // A `Barrier` task is the cheapest valid foreground variant — it
    // completes synchronously inside the consumer with no I/O, so the
    // channel will not fill regardless of how fast we enqueue.
    let n = StdArc::new(tokio::sync::Notify::new());
    mat.enqueue_foreground(MaterializeTask::Barrier(StdArc::clone(&n)))
        .await
        .expect("foreground enqueue should succeed when capacity is available");

    let after = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(
        after, 0,
        "fg_full_waits must not bump when the channel had capacity"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_background_does_not_bump_bg_full_waits_when_capacity_available() {
    // Background mirror of the foreground happy-path contract: when the
    // bounded background channel has capacity, `enqueue_background`'s
    // `try_send` succeeds immediately and `bg_full_waits` must stay at
    // zero. The counter only counts real wait events on the blocking
    // enqueue path (a full channel forcing an awaited `send`), not mere
    // occupancy — so a single, promptly-drained enqueue never bumps it.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let before = mat.metrics().bg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(before, 0, "bg_full_waits starts at zero");

    // A `Barrier` task is a cheap valid variant that the background
    // consumer completes synchronously, so the channel will not fill.
    let n = StdArc::new(tokio::sync::Notify::new());
    mat.enqueue_background(MaterializeTask::Barrier(StdArc::clone(&n)))
        .await
        .expect("background enqueue should succeed when capacity is available");

    let after = mat.metrics().bg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(
        after, 0,
        "bg_full_waits must not bump when the channel had capacity"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_fg_rebuild_fts_index_returns_validation_err() {
    // An explicit second test using a different background-only
    // variant (`RebuildFtsIndex`) so a future refactor that special-cases
    // any single variant cannot accidentally re-introduce the silent-Ok
    // behavior.
    let (pool, _dir) = test_pool().await;
    let result =
        handle_foreground_task(&pool, &MaterializeTask::RebuildFtsIndex, &LoroState::new()).await;
    match result {
        Err(AppError::Validation { message: msg, .. }) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_bg_unexpected_batch_apply_returns_validation_err() {
    // (bg mirror): a `BatchApplyOps` in the background queue is a
    // dispatch bug — must surface as `Err(Validation)`.
    let (pool, _dir) = test_pool().await;
    let batch = StdArc::new(vec![fake_op_record(
        "create_block",
        r#"{"block_id":"BAD_BATCH_BLK","block_type":"content","content":"x","parent_id":null,"position":null}"#,
    )]);
    let result =
        handle_background_task(&pool, &MaterializeTask::BatchApplyOps(batch), None, None).await;
    match result {
        Err(AppError::Validation { message: msg, .. }) => {
            assert!(
                msg.contains("unexpected BatchApplyOps in background queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
    // The bg arm must not have applied any of the ops.
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'BAD_BATCH_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.0, 0,
        "BatchApplyOps in bg queue must not mutate state even though it now errors"
    );
}

// ---------------------------------------------------------------------------
// #3382: firing proofs for the three counters that only had "must not bump"
// tests.
//
// A counter whose every assertion pins it to zero passes forever after its
// emit site is deleted — the same false-green shape as a CI check that cannot
// fail, relocated into the observability layer. The three tests below drive
// the production path and assert the counter ROSE, so deleting the
// `fetch_add` / `store` turns each of them red.
// ---------------------------------------------------------------------------

/// Saturate a bounded queue by holding every free slot as a reserved
/// `Permit`, and return the permits (dropping them releases the queue).
///
/// A permit occupies channel capacity without being a message, which is what
/// makes this deterministic: the consumer has nothing to drain, so it cannot
/// race the test back to "capacity available". `try_reserve` never awaits, so
/// the loop has no timing component either — and each `expect` doubles as an
/// assertion that the channel's bound really is `capacity`.
fn saturate<'a>(
    tx: &'a tokio::sync::mpsc::Sender<MaterializeTask>,
    capacity: usize,
    label: &str,
) -> Vec<tokio::sync::mpsc::Permit<'a, MaterializeTask>> {
    let permits: Vec<_> = (0..capacity)
        .map(|i| {
            tx.try_reserve().unwrap_or_else(|e| {
                panic!("{label} slot {i} of {capacity} should have been free: {e}")
            })
        })
        .collect();
    assert!(
        tx.try_reserve().is_err(),
        "{label} must be saturated before the enqueue under test"
    );
    permits
}

/// Poll `fut` exactly once and require it to be Pending.
///
/// This is what makes the two backpressure tests deterministic rather than a
/// wall-clock bet: the `Full` arm bumps its counter synchronously, *before*
/// the awaited `send` yields, so a single poll is enough to observe the
/// increment — and `Pending` proves the enqueue really did block on the full
/// channel instead of slipping through.
fn poll_once_expecting_pending<F: Future>(fut: F, what: &str) {
    let mut fut = std::pin::pin!(fut);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(
        fut.as_mut().poll(&mut cx).is_pending(),
        "{what} must still be awaiting the full channel"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_foreground_bumps_fg_full_waits_when_the_channel_is_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    // Drain anything in flight so the only thing holding capacity below is
    // this test's own permits.
    mat.flush_foreground().await.unwrap();

    let tx = mat
        .fg_tx
        .get()
        .expect("Materializer::build sets the foreground sender")
        .clone();
    let permits = saturate(&tx, FOREGROUND_CAPACITY, "the foreground queue");

    let before = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    let n = StdArc::new(tokio::sync::Notify::new());
    poll_once_expecting_pending(
        mat.enqueue_foreground(MaterializeTask::Barrier(StdArc::clone(&n))),
        "enqueue_foreground",
    );
    let after = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    assert!(
        after > before,
        "fg_full_waits must count the wait enqueue_foreground just performed \
         on a full channel — the repo's only foreground-backpressure signal \
         (was {before}, still {after})"
    );

    drop(permits);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_background_bumps_bg_full_waits_when_the_channel_is_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    // `Materializer::new` may leave startup work on the background queue;
    // drain it so `saturate` sees an empty channel and the `expect` inside it
    // stays an honest capacity check.
    mat.flush_background().await.unwrap();

    let tx = mat
        .bg_tx
        .get()
        .expect("Materializer::build sets the background sender")
        .clone();
    let permits = saturate(&tx, BACKGROUND_CAPACITY, "the background queue");

    let before = mat.metrics().bg_full_waits.load(AtomicOrdering::Relaxed);
    let n = StdArc::new(tokio::sync::Notify::new());
    poll_once_expecting_pending(
        mat.enqueue_background(MaterializeTask::Barrier(StdArc::clone(&n))),
        "enqueue_background",
    );
    let after = mat.metrics().bg_full_waits.load(AtomicOrdering::Relaxed);
    assert!(
        after > before,
        "bg_full_waits must count the wait the blocking enqueue_background \
         just performed on a full channel (was {before}, still {after})"
    );

    drop(permits);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_errors_bumps_when_a_background_task_exhausts_its_retries() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.flush_background().await.unwrap();

    // Deterministic background failure. `RebuildPagesCacheCounts` opens an
    // IMMEDIATE transaction and immediately UPDATEs `pages_cache`, with no
    // early return in front of it, so dropping the table makes the first
    // attempt and both exponential retries fail identically — the
    // retry-exhaustion arm `bg_errors` lives on. Its foreground twin
    // `fg_errors` is proven by `retry_metrics.rs`; this is the background
    // half, which had only `assert_eq!(bg_errors, 0)` before #3382.
    sqlx::query("DROP TABLE pages_cache")
        .execute(&pool)
        .await
        .unwrap();

    let before = mat.metrics().bg_errors.load(AtomicOrdering::Relaxed);
    mat.enqueue_background(MaterializeTask::RebuildPagesCacheCounts)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    let after = mat.metrics().bg_errors.load(AtomicOrdering::Relaxed);
    assert!(
        after > before,
        "bg_errors must count a background task that exhausted its retry \
         budget (was {before}, still {after})"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_materialize_ms_is_stamped_after_a_foreground_batch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    // The stalled-consumer detector's input. Zero means "never materialized";
    // the only assertions that existed before #3382 were on that never case,
    // so nothing proved the stamp is ever written at all.
    assert_eq!(
        mat.metrics()
            .last_materialize_ms
            .load(AtomicOrdering::Relaxed),
        0,
        "nothing has been materialized yet"
    );
    let status_before = mat.status().await;
    assert_eq!(
        status_before.last_materialize_at, None,
        "the projection must report the never-materialized case as None"
    );

    // `flush_foreground` pushes a real `Barrier` through `run_foreground`'s
    // batch loop, which is the sole production caller of
    // `record_last_materialize`.
    //
    // TWO flushes, and the second one is not belt-and-braces. `run_foreground`
    // stamps *after* the whole drained batch, while the Barrier arm's
    // `notify_one()` fires from inside it — so the first `flush_foreground`
    // returns while its own batch is still being processed and the stamp has
    // provably not landed yet (asserting after one flush fails ~100% of the
    // time). The loop is sequential — `recv` → process batch → stamp — and the
    // second barrier cannot join the first batch, whose task list was frozen
    // before processing began. So the second flush returning is a completion
    // edge for the first batch's stamp, with no wall-clock deadline anywhere.
    mat.flush_foreground().await.unwrap();
    mat.flush_foreground().await.unwrap();

    let stamped = mat
        .metrics()
        .last_materialize_ms
        .load(AtomicOrdering::Relaxed);
    assert!(
        stamped > 0,
        "run_foreground must stamp last_materialize_ms after a batch, or the \
         stalled-consumer detector reports None forever"
    );
    let status_after = mat.status().await;
    assert!(
        status_after.last_materialize_at.is_some(),
        "StatusInfo::last_materialize_at must project the stamp"
    );
    assert!(
        status_after.time_since_last_materialize_secs.is_some(),
        "StatusInfo::time_since_last_materialize_secs must project the stamp"
    );

    mat.shutdown();
}
