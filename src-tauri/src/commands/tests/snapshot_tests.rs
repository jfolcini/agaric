use super::super::*;
use super::common::*;

// ======================================================================
// insta snapshot tests — command responses
// ======================================================================

/// Snapshot a BlockRow from create_block_inner.
/// Redacts `id` (ULID is non-deterministic).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_create_block_response() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // #400: index 0 (first child) ⇒ provisional dense 1-based rank 1.
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "snapshot test content".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".id" => "[ULID]",
    });
}

/// Snapshot a DeleteResponse from delete_block_inner.
/// Redacts `deleted_at` (wall-clock timestamp).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_delete_block_response() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Use direct insert to avoid materializer contention
    insert_block(&pool, "SNAP_DEL", "content", "doomed", None, Some(1)).await;

    let resp = delete_block_inner(&pool, DEV, &mat, "SNAP_DEL".into())
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".deleted_at" => "[TIMESTAMP]",
    });
}

/// Snapshot a PageResponse from list_blocks_inner.
/// Redacts `id` fields since they are ULIDs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_blocks_response() {
    let (pool, _dir) = test_pool().await;

    // Insert deterministic blocks
    insert_block(&pool, "SNAP_BLK1", "content", "first", None, Some(1)).await;
    insert_block(&pool, "SNAP_BLK2", "page", "second", None, Some(2)).await;

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(10),
        TEST_SPACE_ID.into(), //  Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    // Exhaustive redactions covering every non-deterministic field
    // surfaced by `PageResponse<BlockRow>` — block ids and ancestor refs are
    // ULIDs, `deleted_at` is an RFC 3339 timestamp, `next_cursor` is an
    // opaque base64 cursor. Each path is redacted unconditionally so the
    // snapshot stays stable across runs even when these fields populate.
    insta::assert_yaml_snapshot!(resp, {
        ".items[].id"         => "[ULID]",
        ".items[].parent_id"  => "[ULID]",
        ".items[].page_id"    => "[ULID]",
        ".items[].deleted_at" => "[TIMESTAMP]",
        ".next_cursor"        => "[CURSOR]",
    });
}

// ======================================================================
// insta snapshot tests — new response types
// ======================================================================

/// Snapshot a StatusInfo from get_status_inner.
///
/// #2582: this test runs on a `multi_thread` runtime (2 workers), so
/// `flush_background()`'s `notify.notified().await` can resume on a
/// *different* OS thread than the background consumer that calls
/// `notify_one()`. Under `cargo llvm-cov nextest`'s much heavier per-line
/// instrumentation this test flipped deterministically-in-nextest but
/// flaky-under-coverage on `total_background_dispatched` (the
/// `bg_processed` counter): `process_single_foreground_task`'s Barrier arm
/// (consumer.rs) previously called `notify.notify_one()` *before*
/// `metrics.fg_processed.fetch_add(..)`, the same "wake before the count
/// lands" ordering bug fixed for `bg_high_water` in #2570 (sample
/// occupancy before `send`, not after). Fixed by reordering the fg Barrier
/// arm to increment before notifying; the bg Barrier arm (`run_background`)
/// was audited and already deferred its `notify_one()` until after every
/// `bg_processed` bump in the drained batch (see the comment there), so it
/// needed no change. The `assert_eq!`s below pin both barrier-count fields
/// explicitly — nextest captures assert messages even when insta's diff
/// output gets lost in CI logs, so a regression under llvm-cov names the
/// exact field instead of just failing the snapshot.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_status_info_response() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Wait deterministically for the materializer background tasks to reach a
    // stable state before sampling the status fields.
    mat.flush_background().await.unwrap();

    let status = get_status_inner(&mat, None).await;

    // #2582 belt-and-suspenders: pin the two barrier-driven processed
    // counters by name before the broader snapshot assertion runs.
    assert_eq!(
        status.total_background_dispatched, 1,
        "total_background_dispatched (bg_processed) must count exactly the \
         flush_background() barrier task itself by the time notify_one() \
         wakes the waiter — see consumer.rs::run_background's deferred \
         pending_barriers notify, which fires only after every bg_processed \
         fetch_add in the drained batch has landed"
    );
    assert_eq!(
        status.total_ops_dispatched, 0,
        "total_ops_dispatched (fg_processed) must stay 0 in this bg-only \
         flush test — no foreground task is ever enqueued here, so a \
         non-zero value would indicate cross-queue contamination, not the \
         #2582 notify/increment-ordering race (that race lives in \
         consumer.rs::process_single_foreground_task's Barrier arm, fixed by \
         incrementing fg_processed before notify_one())"
    );

    insta::assert_yaml_snapshot!(status, {
        ".last_materialize_at" => "[TIMESTAMP]",
        ".time_since_last_materialize_secs" => "[SECS]",
        // #1326: `sql_only_fallback_count` is a *process-global* monotonic
        // counter — other tests in this binary may have recorded fallbacks
        // before this snapshot samples it, so the value is non-deterministic
        // across runs. Redact it to keep the snapshot stable; its live wiring
        // is asserted by the delta test in `materializer::tests::fifo_status`.
        ".sql_only_fallback_count" => "[FALLBACK_COUNT]",
        // #2031: `descendant_fanout_dropped` is the same process-global
        // monotonic shape as `sql_only_fallback_count` — other tests in
        // this binary may bump it before this snapshot samples it. Redact
        // it; the live wiring is asserted by the delta test in
        // `materializer::handlers::descendant_fanout_dropped` and the
        // fan-out skip test in the apply handler module.
        ".descendant_fanout_dropped" => "[DESCENDANT_FANOUT_DROPPED]",
        // #1319: same process-global, cross-session non-determinism as
        // `sql_only_fallback_count` — other tests in this binary may have
        // recorded a snapshot-fallback before this snapshot samples it.
        // Redact both the count and the last-occurrence struct; the live
        // wiring is asserted by the delta test in
        // `sync_protocol::snapshot_fallback_metrics`.
        ".snapshot_fallback_count" => "[SNAPSHOT_FALLBACK_COUNT]",
        ".snapshot_fallback_last" => "[SNAPSHOT_FALLBACK_LAST]",
    });
}

/// Snapshot a PageResponse<HistoryEntry> from get_block_history_inner.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_block_history_response() {
    let (pool, _dir) = test_pool().await;

    // Insert deterministic op_log entries directly. B.2 — the
    // `block_id` column must be populated explicitly because
    // `list_block_history` now queries that column instead of
    // `json_extract(payload, '$.block_id')`.
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("snap-device")
    .bind(1_i64)
    .bind("snap-hash")
    .bind("create_block")
    .bind(r#"{"block_id":"SNAP_HIST","block_type":"content","content":"hi"}"#)
    .bind(1_749_988_800_000_i64)
    .bind("SNAP_HIST")
    .execute(&pool)
    .await
    .unwrap();

    let resp = get_block_history_inner(&pool, "SNAP_HIST".into(), None, None, None)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp);
}
