use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG01", "tag", "test-tag").await;
    let mat = Materializer::with_read_pool(pool.clone(), pool.clone());
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry after rebuild with read pool"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG02", "tag", "split-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, Some(&pool), None)
            .await
            .is_ok(),
        "background task should succeed with explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "tags_cache should have one entry using read pool");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_without_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG03", "tag", "orig-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, None, None)
            .await
            .is_ok(),
        "background task should succeed without explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry without read pool"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserved_key_todo_state() {
    use crate::op::is_reserved_property_key;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES ('BLK-RES', 'content', 'test', 1)").execute(&pool).await.unwrap();
    assert!(
        is_reserved_property_key("todo_state"),
        "todo_state should be a reserved property key"
    );
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK-RES"),
            key: "todo_state".into(),
            value_text: Some("DONE".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let ts: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-RES'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ts,
        Some("DONE".into()),
        "todo_state column should be set to DONE"
    );
    let pc: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-RES' AND key = 'todo_state'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pc, 0,
        "reserved key should not be stored in block_properties"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_reserved_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position, todo_state) VALUES ('BLK-DEL', 'content', 'test', 1, 'TODO')").execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK-DEL"),
            key: "todo_state".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let after: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-DEL'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        after.is_none(),
        "todo_state should be cleared after deleting reserved property"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_fg_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_01")
        .bind("content")
        .bind("stress")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..20 {
        let mat_fg = mat.clone();
        let ps = format!(r#"{{"block_id":"STRESS_01","to_text":"v{i}","prev_edit":null}}"#);
        let record = fake_op_record("edit_block", &ps);
        handles.push(tokio::spawn(async move {
            let _ = mat_fg
                .enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(record)))
                .await;
        }));
        let mat_bg = mat.clone();
        handles.push(tokio::spawn(async move {
            let _ = mat_bg
                .enqueue_background(MaterializeTask::ReindexBlockLinks {
                    block_id: "STRESS_01".into(),
                })
                .await;
            let _ = mat_bg
                .enqueue_background(MaterializeTask::UpdateFtsBlock {
                    block_id: "STRESS_01".into(),
                })
                .await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Stress-test integrity: STRESS_01 must hold one of the 20 values submitted.
    let content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'STRESS_01'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let valid_values: Vec<String> = (0..20).map(|i| format!("v{i}")).collect();
    assert!(
        content
            .as_deref()
            .is_some_and(|c| valid_values.iter().any(|v| v == c)),
        "STRESS_01 content must be one of v0..v19, got {content:?}",
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "concurrent_fg_bg must produce zero fg_errors"
    );
    assert_eq!(
        mat.metrics().fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "concurrent_fg_bg must produce zero fg_apply_dropped"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_dispatch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_SERIAL_01")
        .bind("content")
        .bind("initial")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..10 {
        let mat_c = mat.clone();
        let pool_c = pool.clone();
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("STRESS_SERIAL_01"),
            to_text: format!("concurrent-v{i}"),
            prev_edit: None,
        });
        handles.push(tokio::spawn(async move {
            let record = make_op_record(&pool_c, payload).await;
            mat_c.dispatch_op(&record).await.unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    // Every `dispatch_op` enqueues an internal `flush_foreground`
    // Barrier between ApplyOp and the bg fan-out, so 10 dispatch_ops
    // emit 10 ApplyOps + 10 dispatch barriers, then `flush()` adds one
    // final barrier — 21 fg tasks total.
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        21,
        "should process 10 concurrent dispatch ops + 10 dispatch-internal barriers + 1 flush barrier"
    );
}
