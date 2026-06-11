use super::*;

#[tokio::test]
async fn enqueue_foreground_any() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue foreground task successfully"
    );
}
#[tokio::test]
async fn enqueue_background_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue RebuildTagsCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok(),
        "should enqueue RebuildPagesCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: "blk-x".into()
        })
        .await
        .is_ok(),
        "should enqueue ReindexBlockLinks in background"
    );
}
#[tokio::test]
async fn try_enqueue_background_drops_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        assert!(
            mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
                .is_ok(),
            "try_enqueue should accept tasks when not full"
        );
    }
}

/// M-7 / M-8: the `try_enqueue_background` Full-arm must increment
/// `metrics.bg_dropped` so sustained backpressure is visible in
/// `StatusInfo`.  Without the increment, dropped cache-rebuild
/// fan-outs are an invisible degradation.
///
/// Single-threaded `#[tokio::test]` runtime guarantees the bg
/// consumer cannot drain during the sync `try_send` loop, so the
/// bounded channel fills at `BACKGROUND_CAPACITY` and every
/// subsequent send lands in the Full arm.
#[tokio::test]
async fn try_enqueue_background_full_arm_increments_bg_dropped() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    // Channel capacity is 1024 — push more than that without yielding
    // so the consumer never runs and the Full arm is exercised
    // deterministically.  We push 2x capacity to give the increment
    // ~1024 chances to fire.
    for _ in 0..2048 {
        // Each call returns `Ok(())` regardless of whether it landed
        // or was shed — the helper preserves the `Ok` return for
        // back-compat.  We assert via the metric instead.
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }

    let dropped = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        dropped > 0,
        "bg_dropped must increment when try_enqueue_background sheds tasks under backpressure, got {dropped}"
    );

    // Stop the consumer cleanly so the test runtime can drain.
    mat.shutdown();
}

/// M-7 / M-8: the cache-rebuild fan-out path
/// (`enqueue_full_cache_rebuild`, used by `delete_block` /
/// `restore_block` / `purge_block`) is the specific code path called
/// out in the recommendation.  When the bg queue is saturated, every
/// fan-out task shed by the helper must tick `bg_dropped` so the
/// "agenda missing entries until something else is edited" symptom is
/// observable.
#[tokio::test]
async fn enqueue_full_cache_rebuild_under_backpressure_increments_bg_dropped() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    // Fill the bg queue to capacity first so the cache-rebuild fan-out
    // arrives at a queue that is already full.
    for _ in 0..2048 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }
    let baseline = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        baseline > 0,
        "precondition: backpressure must already have ticked bg_dropped, got {baseline}"
    );

    // Drive a synthetic delete_block fan-out via the same dispatch entry
    // point a real op uses.  The fan-out covers all 7 tasks in
    // `FULL_CACHE_REBUILD_TASKS` plus a `RemoveFtsBlock` for the
    // non-empty block_id — every one should be shed and counted because
    // the queue is saturated.
    let record = fake_op_record("delete_block", r#"{"block_id":"BLK-DEL"}"#);
    let _ = mat.dispatch_background(&record);

    let after = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        after >= baseline + 7,
        "the delete_block cache-rebuild fan-out must add at least 7 drops under saturation (baseline={baseline}, after={after})"
    );

    mat.shutdown();
}

/// PEND-03: when the bg queue is full and a global cache rebuild
/// (`RebuildTagsCache`) is dispatched, three things must happen:
///   1. The task is shed (queue stays full, no panic).
///   2. `bg_dropped_global` ticks (separate from `bg_dropped` so
///      operators can distinguish a per-block reindex backlog from a
///      global-cache freshness gap).
///   3. The task is persisted to `materializer_retry_queue` under the
///      `'__GLOBAL__'` sentinel so the sweeper picks it up later.
#[tokio::test]
async fn test_global_task_dropped_on_queue_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Saturate the bg queue first. Push 2x capacity so the Full arm
    // has plenty of opportunities to fire.
    for _ in 0..2048 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildPagesCache);
    }

    let global_drops = mat
        .metrics()
        .bg_dropped_global
        .load(AtomicOrdering::Relaxed);
    assert!(
        global_drops > 0,
        "bg_dropped_global must increment when global tasks are shed under saturation, got {global_drops}"
    );

    // The persistence side-effect happens via spawn_task. Drain the
    // pending task set so we observe the row before asserting.
    // 250ms is enough for the tokio executor to drive the awaiter
    // through `record_failure` (single SQLite UPSERT in WAL mode).
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let row = sqlx::query!(
            "SELECT block_id, task_kind FROM materializer_retry_queue \
             WHERE block_id = '__GLOBAL__' AND task_kind = 'RebuildPagesCache'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        if row.is_some() {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!(
                "PEND-03: dropped global RebuildPagesCache must be persisted to \
                 materializer_retry_queue under '__GLOBAL__'; row never appeared"
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    mat.shutdown();
}

/// Audit #423: a PER-BLOCK reindex task (`UpdateFtsBlock`) shed when the
/// background queue is saturated must ALSO be persisted to
/// `materializer_retry_queue` — keyed by its real `block_id`, not the
/// `'__GLOBAL__'` sentinel. Before the fix, only global rebuilds were
/// persisted on the saturation path, so a shed per-block task left that
/// block's FTS / link / tag-ref index stale until its next edit, with no
/// self-healing (the consumer failure path never runs for tasks shed at
/// enqueue). `bg_dropped_global` must NOT tick for a per-block task.
#[tokio::test]
async fn test_per_block_task_dropped_on_queue_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let global_before = mat
        .metrics()
        .bg_dropped_global
        .load(AtomicOrdering::Relaxed);

    // Saturate the bg queue with a per-block reindex task. Push 2x
    // capacity so the Full arm fires deterministically (consumer never
    // gets scheduled between sync pushes).
    let block_id: std::sync::Arc<str> = std::sync::Arc::from("BLK-FTS-SAT");
    for _ in 0..2048 {
        let _ = mat.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
            block_id: block_id.clone(),
        });
    }

    let dropped = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        dropped > 0,
        "bg_dropped must increment when per-block tasks are shed under saturation, got {dropped}"
    );

    // The persistence happens via spawn_task; poll for the row.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let row = sqlx::query!(
            "SELECT block_id, task_kind FROM materializer_retry_queue \
             WHERE block_id = 'BLK-FTS-SAT' AND task_kind = 'UpdateFtsBlock'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        if row.is_some() {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!(
                "audit #423: dropped per-block UpdateFtsBlock must be persisted to \
                 materializer_retry_queue keyed by its block_id; row never appeared"
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A per-block drop must not be miscounted as a global-cache drop.
    let global_after = mat
        .metrics()
        .bg_dropped_global
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        global_before, global_after,
        "bg_dropped_global must not tick for a per-block task drop"
    );

    mat.shutdown();
}

/// PEND-03: a persisted global `RebuildAgendaCache` row whose
/// `next_attempt_at` is already in the past must be re-enqueued by
/// `sweep_once` and the row deleted from `materializer_retry_queue`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_global_task_re_enqueued_after_backoff() {
    use crate::materializer::retry_queue;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Plant a global retry row with an already-past next_attempt_at,
    // simulating "the backoff window expired".
    let past = crate::db::now_ms() - 2 * 60_000;
    sqlx::query!(
        "INSERT INTO materializer_retry_queue \
             (block_id, task_kind, attempts, next_attempt_at) \
         VALUES (?, ?, ?, ?)",
        "__GLOBAL__",
        "RebuildAgendaCache",
        1_i64,
        past,
    )
    .execute(&pool)
    .await
    .unwrap();

    let n = retry_queue::sweep_once(&pool, &pool, &mat).await.unwrap();
    assert_eq!(
        n, 1,
        "the due global rebuild row must be re-enqueued by the sweeper"
    );

    // Issue #378: the sweeper now LEASES the row instead of deleting it
    // on enqueue — the row is cleared only once the re-enqueued task
    // completes durably and the consumer calls `clear_on_success`. The
    // live background consumer (spawned by `Materializer::new`) drains
    // the re-enqueued `RebuildAgendaCache`, which succeeds on the empty
    // test DB, so the row is cleared asynchronously. Poll for the
    // confirmed-success clear instead of asserting an immediate delete.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let remaining: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) AS \"n!: i64\" FROM materializer_retry_queue \
             WHERE block_id = '__GLOBAL__' AND task_kind = 'RebuildAgendaCache'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        if remaining == 0 {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!(
                "issue #378: swept row must be cleared after the re-enqueued \
                 task completes durably; row never cleared"
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    mat.shutdown();
}

#[tokio::test]
async fn try_enqueue_after_shutdown_err() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_stops_consumers() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue before shutdown"
    );
    mat.flush_background().await.unwrap();
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown when full"
    );
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "foreground enqueue should fail after shutdown when full"
    );
}

/// M-12 regression test: a long-running future spawned via the
/// materializer's tracked spawn helper must be aborted when
/// `shutdown()` is called, not allowed to outlive the shutdown
/// signal.
///
/// Pre-fix, fire-and-forget `tokio::spawn` calls produced no abort
/// handle — an in-progress FTS rebuild (or any other multi-second
/// future) kept running while the surrounding tear-down sequence
/// closed the writer pool, producing writer-pool errors and a slow /
/// hung exit.
///
/// We assert via a `Drop` guard inside the task body: when the task
/// is aborted, its frame is dropped, which sets the flag. We poll
/// the flag with a 1s budget, well under the 60s sleep it would
/// otherwise have to wait out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_aborts_in_flight_tasks_m12() {
    use std::sync::atomic::AtomicBool;

    struct DropFlag(StdArc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, AtomicOrdering::Release);
        }
    }

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    let dropped = StdArc::new(AtomicBool::new(false));
    let flag = dropped.clone();
    Materializer::spawn_task(&mat.tasks, async move {
        let _guard = DropFlag(flag);
        // Far longer than the test's bounded wait — if the future
        // were not aborted, the test would hang and fail.
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    // Yield once so the spawned task gets onto a worker and reaches
    // its first `.await`. Without this the abort below would race
    // with task scheduling and the Drop assertion below could observe
    // the guard before the task ever runs (still a pass, but for the
    // wrong reason).
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !dropped.load(AtomicOrdering::Acquire),
        "task should still be running before shutdown",
    );

    let start = std::time::Instant::now();
    mat.shutdown();

    // Poll the drop flag until the abort propagates. 1s budget is
    // generous on a multi-thread runtime; in practice this resolves
    // in <10 ms.
    while !dropped.load(AtomicOrdering::Acquire) {
        if start.elapsed() > Duration::from_secs(1) {
            panic!("M-12: shutdown() must abort in-flight tasks within 1s");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
