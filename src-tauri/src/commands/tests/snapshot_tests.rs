#![allow(unused_imports)]
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

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "snapshot test content".into(),
        None,
        Some(1),
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
        None,
        Some(10),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    insta::assert_yaml_snapshot!(resp);
}

// ======================================================================
// insta snapshot tests — new response types
// ======================================================================

/// Snapshot a StatusInfo from get_status_inner.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_status_info_response() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Allow 10ms for consumer tokio tasks to be spawned and start their event
    // loops before taking a snapshot of the status fields.
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let status = get_status_inner(&mat, None).await;

    insta::assert_yaml_snapshot!(status, {
        ".last_materialize_at" => "[TIMESTAMP]",
        ".time_since_last_materialize_secs" => "[SECS]",
    });
}

/// Snapshot a PageResponse<HistoryEntry> from get_block_history_inner.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_block_history_response() {
    let (pool, _dir) = test_pool().await;

    // Insert deterministic op_log entries directly
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind("snap-device")
    .bind(1_i64)
    .bind("snap-hash")
    .bind("create_block")
    .bind(r#"{"block_id":"SNAP_HIST","block_type":"content","content":"hi"}"#)
    .bind("2025-06-15T12:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let resp = get_block_history_inner(&pool, "SNAP_HIST".into(), None, None)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp);
}
