use super::*;

#[tokio::test]
async fn apply_op_create() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_CREATE_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "hello from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row =
        sqlx::query("SELECT block_type, content, position FROM blocks WHERE id = 'APPLY_CREATE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(row.is_some(), "block should exist after apply_op create");
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("block_type"),
        "content",
        "block_type should match created block"
    );
    assert_eq!(
        row.get::<Option<String>, _>("content").as_deref(),
        Some("hello from remote"),
        "content should match created block text"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(1),
        "position should match created block position"
    );
}
// #1057: prove the SQL-only fallback instrumentation actually fires. This
// test does NOT call `install_for_test`, so the create flows through
// `apply_create_block_sql_only` (the EngineUninit fallback arm), which now
// calls `sql_only_fallback::record`. The counter is process-global and
// monotonic, so a `>` assertion is robust under nextest parallelism.
#[tokio::test]
async fn apply_op_create_records_sql_only_fallback() {
    use crate::materializer::handlers::sql_only_fallback;
    let before = sql_only_fallback::count();
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_FALLBACK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "fallback instrumentation".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    // The block still materializes via the SQL-only path...
    assert!(
        sqlx::query("SELECT id FROM blocks WHERE id = 'APPLY_FALLBACK_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_some(),
        "block should exist after the SQL-only fallback apply"
    );
    // ...and the fallback was observed by the #1057 instrumentation.
    assert!(
        sql_only_fallback::count() > before,
        "apply_op create without install_for_test must record a SQL-only fallback"
    );
}
#[tokio::test]
async fn apply_op_create_idempotent() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_IDEM_1", "content", "original").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_IDEM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_IDEM_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("original"),
        "idempotent create should not overwrite existing block content"
    );
}
#[tokio::test]
async fn apply_op_edit() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_EDIT_1", "content", "before edit").await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("APPLY_EDIT_1"),
            to_text: "after edit".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_EDIT_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("after edit"),
        "content should reflect the edit operation"
    );
}
#[tokio::test]
async fn apply_op_delete() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_DEL_1", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("APPLY_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_DEL_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<i64>, _>("deleted_at")
            .is_some(),
        "deleted_at should be set after apply_op delete"
    );
}
#[tokio::test]
async fn apply_op_restore() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_RESTORE_1", "content", "to restore").await;
    soft_delete_block_direct(&pool, "APPLY_RESTORE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("APPLY_RESTORE_1"),
            deleted_at_ref: FIXED_TS,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_RESTORE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<i64>, _>("deleted_at")
            .is_none(),
        "deleted_at should be cleared after apply_op restore"
    );
}
#[tokio::test]
async fn apply_op_purge() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_PURGE_1", "content", "to purge").await;
    soft_delete_block_direct(&pool, "APPLY_PURGE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("APPLY_PURGE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT id FROM blocks WHERE id = 'APPLY_PURGE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "block should be physically removed after apply_op purge"
    );
}
#[tokio::test]
async fn apply_op_move() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_MOVE_PARENT", "page", "parent").await;
    insert_block_direct(&pool, "APPLY_MOVE_1", "content", "movable").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("APPLY_MOVE_1"),
            new_parent_id: Some(BlockId::test_id("APPLY_MOVE_PARENT")),
            new_position: 5,
            new_index: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT parent_id, position FROM blocks WHERE id = 'APPLY_MOVE_1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("parent_id").as_deref(),
        Some("APPLY_MOVE_PARENT"),
        "parent_id should be set after apply_op move"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(5),
        "position should be updated after apply_op move"
    );
}
#[tokio::test]
async fn apply_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_ADDTAG_BLK", "content", "note").await;
    insert_block_direct(&pool, "APPLY_ADDTAG_TAG", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("APPLY_ADDTAG_BLK"),
            tag_id: BlockId::test_id("APPLY_ADDTAG_TAG"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "APPLY_ADDTAG_BLK",
        "APPLY_ADDTAG_TAG"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "block_tags row should exist after apply_op add_tag"
    );
}
#[tokio::test]
async fn apply_op_invalid_payload() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "create_block",
        r#"{"not_valid": true}"#,
    ))))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "malformed create_block payload should increment fg_errors exactly once after retry exhaustion"
    );
}
#[tokio::test]
async fn apply_op_unknown_op() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "unknown_op",
        r#"{}"#,
    ))))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "unknown op_type should increment fg_errors exactly once after retry exhaustion"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_success() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-retry-ok"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "retry test".into(),
        }),
    )
    .await;
    process_single_foreground_task(&pool, MaterializeTask::ApplyOp(StdArc::new(r)), &metrics).await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "should count one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment errors"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment panics"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_barrier() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::Barrier(Arc::new(tokio::sync::Notify::new())),
        &metrics,
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "barrier should count as one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "barrier should not increment errors"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_bad_payload() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::ApplyOp(StdArc::new(fake_op_record("bogus_op_type", "{}"))),
        &metrics,
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should still count as processed"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should increment error counter"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "bad payload should not cause a panic"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_lifecycle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-lifecycle"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "lifecycle".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "lifecycle should process at least one foreground task"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "lifecycle should have no errors"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_failure_propagated() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(fake_op_record(
        "create_block",
        "{}",
    ))))
    .await
    .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "invalid payload should propagate as an error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_partial_failure() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-batch-good"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "batch good".into(),
        }),
    )
    .await;
    let bad = fake_op_record("create_block", "{}");
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![good, bad])))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "batch with a bad op should count one error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-success"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "success".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(r)))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful apply_op should have zero errors"
    );
    mat.shutdown();
}

// #412 / #667 — single-op apply mirror of the `BatchApplyOps`
// single-device-cursor `debug_assert!`. `apply_op` advances a single
// global apply cursor for `record.seq`, which is only sound when the
// op_log belongs to ONE device (op_log seq is a per-device counter).
// These two tests pin the new `debug_assert!`: it fires when the op_log
// already contains an op from a DIFFERENT device, and does NOT fire on a
// single-device op_log.
//
// We drive `handle_foreground_task` directly (the same pattern used by
// `dispatch_bg_empty_block_id` / `handle_*_returns_validation_err`) so
// the assert panics on the test's own task rather than on a detached
// consumer worker, letting `#[should_panic]` catch it. Gated on
// `debug_assertions` because the guard compiles out in release builds
// (the release-build counterpart lives in `recovery::replay` #412).
#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[should_panic(expected = "per-device cursor partitioning is required (backend audit #412)")]
async fn apply_op_different_device_trips_single_device_cursor_assert() {
    let (pool, _dir) = test_pool().await;
    // Seed the op_log with an op from a DIFFERENT device so the op_log
    // now spans two devices.
    let _other = append_local_op(
        &pool,
        "OTHER-DEVICE",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-other-dev"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "from other device".into(),
        }),
    )
    .await
    .unwrap();
    // Build a single-op apply for the LOCAL device. `make_op_record`
    // appends as `DEV`, so the op_log now holds {DEV, OTHER-DEVICE}.
    let mine = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-mine-dev"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "from this device".into(),
        }),
    )
    .await;
    // Should panic on the `debug_assert!` before the cursor advances.
    let _ = handle_foreground_task(&pool, &MaterializeTask::ApplyOp(StdArc::new(mine))).await;
}

#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_same_device_does_not_trip_single_device_cursor_assert() {
    let (pool, _dir) = test_pool().await;
    // Single-device op_log: only `DEV` ops present.
    let mine = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-single-dev"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "single device".into(),
        }),
    )
    .await;
    // Must NOT panic; the apply succeeds on a single-device op_log.
    handle_foreground_task(&pool, &MaterializeTask::ApplyOp(StdArc::new(mine)))
        .await
        .expect("same-device single-op apply must succeed without tripping the #412 assert");
    let count = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BlockId::test_id("blk-single-dev").as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count.0, 1,
        "same-device single-op apply should materialize the block"
    );
}
