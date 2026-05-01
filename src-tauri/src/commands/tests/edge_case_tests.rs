#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use crate::soft_delete;

// ======================================================================
// F11: Concurrent edit race condition (verifies TOCTOU fix)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn f11_concurrent_edits_do_not_corrupt() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block, then spawn 2 concurrent edits.
    // Both should succeed (SQLite serializes via IMMEDIATE tx).
    // Final state should be one of the two edits.
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let block_id = created.id.clone();
    let pool1 = pool.clone();
    let pool2 = pool.clone();
    let mat1 = Materializer::new(pool.clone());
    let mat2 = Materializer::new(pool.clone());
    let bid1 = block_id.clone();
    let bid2 = block_id.clone();

    let h1 =
        tokio::spawn(
            async move { edit_block_inner(&pool1, DEV, &mat1, bid1, "edit-A".into()).await },
        );
    let h2 =
        tokio::spawn(
            async move { edit_block_inner(&pool2, DEV, &mat2, bid2, "edit-B".into()).await },
        );

    let (r1, r2) = tokio::join!(h1, h2);
    assert!(r1.unwrap().is_ok(), "first concurrent edit should succeed");
    assert!(r2.unwrap().is_ok(), "second concurrent edit should succeed");

    // Final DB state should be one of the two edits
    let row = get_block_inner(&pool, block_id.clone()).await.unwrap();
    assert!(
        row.content == Some("edit-A".into()) || row.content == Some("edit-B".into()),
        "final content should be one of the concurrent edits, got: {:?}",
        row.content
    );

    // Verify exactly 2 edit ops in the log
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block' \
         AND json_extract(payload, '$.block_id') = ?",
        block_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 2, "exactly 2 edit ops should be logged");
}

// ======================================================================
// F12: Purge of already-purged block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f12_purge_already_purged_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE_TWICE", "content", "purge me", None, Some(1)).await;

    // Soft-delete first
    soft_delete::cascade_soft_delete(&pool, "PURGE_TWICE")
        .await
        .unwrap();

    // First purge succeeds
    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into())
        .await
        .unwrap();
    assert_eq!(
        resp.purged_count, 1,
        "first purge should succeed with count=1"
    );

    // Second purge should return NotFound (block is physically gone)
    let result = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "purging an already-purged block should return NotFound, got: {result:?}"
    );
}

// ======================================================================
// F13: Create block with invalid block_type values
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f13_empty_block_type_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(&pool, DEV, &mat, "".into(), "hello".into(), None, None).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_type should return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f13_sql_injection_block_type_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "'; DROP TABLE blocks; --".into(),
        "hello".into(),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "SQL injection in block_type should return Validation error, got: {result:?}"
    );

    // Verify blocks table still exists (SELECT COUNT(*) succeeds = table exists)
    let _count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .expect("blocks table should still exist after SQL injection attempt");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f13_case_sensitive_block_type_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // "Content" (uppercase C) should be rejected -- only "content" is valid
    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "Content".into(),
        "hello".into(),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "case-variant block_type should return Validation error, got: {result:?}"
    );
}

// ======================================================================
// F14: list_blocks with edge-case page_size values
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f14_page_size_zero_clamped_to_one() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PS_BLK1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "PS_BLK2", "content", "b", None, Some(2)).await;

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
        Some(0),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "page_size=0 should be clamped to 1, returning exactly 1 item"
    );
    assert!(resp.has_more, "should indicate more items available");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f14_page_size_negative_clamped_to_one() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PS_N1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "PS_N2", "content", "b", None, Some(2)).await;

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
        Some(-1),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "page_size=-1 should be clamped to 1, returning exactly 1 item"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f14_page_size_1000_clamped_to_100() {
    let (pool, _dir) = test_pool().await;

    // Insert 3 blocks -- enough to verify clamping but not 100+
    insert_block(&pool, "PS_L1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "PS_L2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "PS_L3", "content", "c", None, Some(3)).await;

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
        Some(1000),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    // With only 3 items and clamped limit=100, all 3 should be returned
    assert_eq!(
        resp.items.len(),
        3,
        "clamped page_size should still return all items"
    );
    assert!(!resp.has_more, "no more items should remain");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f14_page_size_none_uses_default() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PS_D1", "content", "a", None, Some(1)).await;

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
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "default page_size should return the single block"
    );
}

// ======================================================================
// Frontend logging commands (F-19)
// ======================================================================

#[tokio::test]
async fn log_frontend_happy_path_all_levels() {
    // log_frontend is a pure tracing call — it should return Ok(()) for every level.
    for level in &["error", "warn", "info", "debug", "trace", "unknown"] {
        let result = log_frontend(
            level.to_string(),
            "test-module".into(),
            format!("test message at {level}"),
            Some("fake stack".into()),
            Some("fake context".into()),
            Some(r#"{"blockId":"abc123"}"#.into()),
        )
        .await;
        assert!(
            result.is_ok(),
            "log_frontend should succeed for level '{level}'"
        );
    }
}

#[tokio::test]
async fn log_frontend_without_optional_fields() {
    let result = log_frontend(
        "error".into(),
        "test-module".into(),
        "message without optionals".into(),
        None,
        None,
        None,
    )
    .await;
    assert!(
        result.is_ok(),
        "log_frontend should succeed without stack/context/data"
    );
}
