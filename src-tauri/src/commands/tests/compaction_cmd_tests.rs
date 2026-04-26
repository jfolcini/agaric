#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// Op log compaction commands (F-20)
// ======================================================================

#[tokio::test]
async fn get_compaction_status_returns_correct_counts() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Empty op log — expect zeros
    let status = get_compaction_status_inner(&pool).await.unwrap();
    assert_eq!(status.total_ops, 0, "empty log should have 0 total ops");
    assert!(
        status.oldest_op_date.is_none(),
        "empty log should have no oldest date"
    );
    assert_eq!(
        status.eligible_ops, 0,
        "empty log should have 0 eligible ops"
    );
    assert_eq!(
        status.retention_days,
        crate::snapshot::DEFAULT_RETENTION_DAYS,
        "retention_days should match default"
    );

    // Create a few blocks (each produces one op)
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block one".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block three".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();

    let status = get_compaction_status_inner(&pool).await.unwrap();
    assert_eq!(
        status.total_ops, 3,
        "should have 3 ops after creating 3 blocks"
    );
    assert!(
        status.oldest_op_date.is_some(),
        "should have an oldest date"
    );
    // All ops are recent (just created), so none should be eligible
    assert_eq!(
        status.eligible_ops, 0,
        "recently created ops should not be eligible"
    );

    mat.shutdown();
}

#[tokio::test]
async fn compact_op_log_cmd_deletes_old_ops() {
    let (pool, _dir) = test_pool().await;

    // Insert ops with old timestamps (> 90 days ago) directly into op_log
    let old_ts = "2024-01-01T00:00:00.000Z";
    for i in 1..=5 {
        let block_id = format!("01HZ00000000000000000BLOCK{i:02}");
        // Insert a block so the op references a valid block
        insert_block(
            &pool,
            &block_id,
            "content",
            &format!("old block {i}"),
            None,
            Some(i),
        )
        .await;
        // Insert op_log entry with old timestamp
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, op_type, payload, hash, created_at) \
             VALUES (?, ?, 'create_block', ?, 'fakehash' || ?, ?)",
        )
        .bind(DEV)
        .bind(i)
        .bind(format!(
            r#"{{"block_id":"{}","block_type":"content","content":"old block {}","parent_id":null,"position":{}}}"#,
            block_id, i, i
        ))
        .bind(i)
        .bind(old_ts)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Also insert a recent op
    let recent_block_id = "01HZ00000000000000000BLOCKRE";
    insert_block(
        &pool,
        recent_block_id,
        "content",
        "recent block",
        None,
        Some(6),
    )
    .await;
    let recent_ts = crate::now_rfc3339();
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, op_type, payload, hash, created_at) \
         VALUES (?, ?, 'create_block', ?, 'fakehash_recent', ?)",
    )
    .bind(DEV)
    .bind(6)
    .bind(format!(
        r#"{{"block_id":"{}","block_type":"content","content":"recent block","parent_id":null,"position":6}}"#,
        recent_block_id
    ))
    .bind(&recent_ts)
    .execute(&pool)
    .await
    .unwrap();

    // Verify initial state
    let total_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total_before, 6, "should have 6 ops before compaction");

    // Run compaction with 90-day retention
    let result = compact_op_log_cmd_inner(&pool, DEV, 90).await.unwrap();
    assert!(
        result.snapshot_id.is_some(),
        "compaction should create a snapshot"
    );
    assert_eq!(result.ops_deleted, 5, "should report 5 old ops as deleted");

    // Verify remaining ops
    let total_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        total_after, 1,
        "only the recent op should remain after compaction"
    );
}

#[tokio::test]
async fn compact_op_log_cmd_noop_when_no_old_ops() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create recent ops only
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "recent one".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "recent two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    let result = compact_op_log_cmd_inner(&pool, DEV, 90).await.unwrap();
    assert!(
        result.snapshot_id.is_none(),
        "no snapshot should be created when no old ops exist"
    );
    assert_eq!(
        result.ops_deleted, 0,
        "no ops should be deleted when none are eligible"
    );

    // Verify all ops remain
    let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 2, "both recent ops should remain");

    mat.shutdown();
}

#[tokio::test]
async fn compact_op_log_cmd_rejects_retention_days_zero() {
    // M-38 regression: retention_days = 0 must be rejected up-front with
    // AppError::Validation("retention_days.too_small") before any DB work
    // (otherwise cutoff = now() and the entire op log is purged).
    let (pool, _dir) = test_pool().await;

    let result = compact_op_log_cmd_inner(&pool, DEV, 0).await;

    let err = result.expect_err("retention_days = 0 should be rejected");
    assert!(
        matches!(&err, AppError::Validation(msg) if msg == "retention_days.too_small"),
        "expected AppError::Validation(\"retention_days.too_small\"), got {err:?}"
    );

    // Belt-and-braces: also reject any value below the floor.
    let result = compact_op_log_cmd_inner(
        &pool,
        DEV,
        crate::commands::compaction::MIN_RETENTION_DAYS - 1,
    )
    .await;
    let err = result.expect_err("retention_days below floor should be rejected");
    assert!(
        matches!(&err, AppError::Validation(msg) if msg == "retention_days.too_small"),
        "expected AppError::Validation(\"retention_days.too_small\"), got {err:?}"
    );
}
