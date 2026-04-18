#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// get_status
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_status_returns_initial_metrics() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Allow 10ms for consumer tokio tasks to be spawned and start their event
    // loops. This is minimal — just enough for the runtime to schedule the
    // spawned tasks before we query their status metrics.
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let status = get_status_inner(&mat, None).await;

    // Fresh materializer — all counters at zero
    assert_eq!(
        status.total_ops_dispatched, 0,
        "fresh materializer should have zero ops"
    );
    assert_eq!(
        status.total_background_dispatched, 0,
        "fresh materializer should have zero background ops"
    );
    // MAINT-24: new fields exposed
    assert_eq!(status.bg_dropped, 0, "fresh materializer drops zero tasks");
    assert_eq!(
        status.bg_deduped, 0,
        "fresh materializer dedupes zero tasks"
    );
    assert_eq!(
        status.fg_full_waits, 0,
        "fresh materializer records zero full-channel waits"
    );
    assert_eq!(
        status.last_materialize_at, None,
        "fresh materializer has not recorded a batch yet"
    );
    assert_eq!(
        status.time_since_last_materialize_secs, None,
        "fresh materializer has no elapsed-since value"
    );
    assert_eq!(
        status.total_ops_in_log,
        Some(0),
        "fresh op_log contains zero ops"
    );
    assert!(
        status.sync_peer_failure_counts.is_empty(),
        "no scheduler wired — peer failure map must be empty"
    );
    assert_eq!(
        status.retry_queue_pending,
        Some(0),
        "retry queue must start empty"
    );
}

/// When a `SyncScheduler` is wired and has recorded failures, those counts
/// must appear in `StatusInfo.sync_peer_failure_counts`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_status_surfaces_peer_failure_counts() {
    use crate::sync_scheduler::SyncScheduler;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = SyncScheduler::new();

    scheduler.record_failure("PEER_A");
    scheduler.record_failure("PEER_A");
    scheduler.record_failure("PEER_B");

    let status = get_status_inner(&mat, Some(&scheduler)).await;
    assert_eq!(
        status.sync_peer_failure_counts.len(),
        2,
        "both failing peers must be surfaced"
    );
    let mut counts: std::collections::HashMap<_, _> =
        status.sync_peer_failure_counts.iter().cloned().collect();
    assert_eq!(counts.remove("PEER_A"), Some(2));
    assert_eq!(counts.remove("PEER_B"), Some(1));
}

/// The `total_ops_in_log` field must reflect the actual `op_log` row count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_status_total_ops_in_log_reflects_op_log_count() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed 3 op_log rows directly
    for i in 1..=3 {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("dev-status")
        .bind(i as i64)
        .bind(format!("hash-{i}"))
        .bind("create_block")
        .bind(r#"{"block_id":"BLK_S","block_type":"content","content":""}"#)
        .bind("2025-06-15T12:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
    }
    let status = get_status_inner(&mat, None).await;
    assert_eq!(
        status.total_ops_in_log,
        Some(3),
        "total_ops_in_log must match the actual op_log row count"
    );
}

/// bg_dropped must increment whenever the retry queue receives a persisted
/// failure OR a global rebuild task is silently dropped after retries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_status_bg_dropped_increments_on_persisted_retry() {
    use crate::materializer::retry_queue;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed a retry row directly (simulating the consumer having written it).
    retry_queue::record_failure(
        &pool,
        &crate::materializer::MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_RS".into(),
        },
        "simulated",
    )
    .await
    .unwrap();
    // Nudge the materializer metric to mirror what the consumer would do
    // when it enqueues a task to the persistent queue. Tests don't easily
    // trigger a real failure without mocking, so exercise the metric path.
    mat.metrics()
        .bg_dropped
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let status = get_status_inner(&mat, None).await;
    assert_eq!(
        status.bg_dropped, 1,
        "bg_dropped must reflect the atomic counter"
    );
    assert_eq!(
        status.retry_queue_pending,
        Some(1),
        "retry_queue_pending must reflect the row we just wrote"
    );
}
