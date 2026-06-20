use super::*;

// ======================================================================
// B-62: BatchApplyOps atomicity — if last op fails, none persist
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_atomic_rollback_on_failure() {
    let (pool, _dir) = test_pool().await;

    // First op: a valid create_block
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_ATOM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "should be rolled back".into(),
        }),
    )
    .await;

    // Second op: bad payload that will fail deserialization
    let bad = fake_op_record("create_block", "{}");

    let task = MaterializeTask::BatchApplyOps(StdArc::new(vec![good, bad]));
    let result = handle_foreground_task(&pool, &task).await;
    assert!(
        result.is_err(),
        "batch should fail because the last op has bad payload"
    );

    // The first op's block should NOT be visible (rolled back)
    let row = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_ATOM_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_none(),
        "block from first op should be rolled back when batch fails"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_all_succeed_commits() {
    let (pool, _dir) = test_pool().await;

    let op1 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "first".into(),
        }),
    )
    .await;

    let op2 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            index: None,
            content: "second".into(),
        }),
    )
    .await;

    let task = MaterializeTask::BatchApplyOps(StdArc::new(vec![op1, op2]));
    let result = handle_foreground_task(&pool, &task).await;
    result.unwrap();

    // Both blocks should be visible
    let r1 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r1.is_some(), "first block should be committed");

    let r2 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_2'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r2.is_some(), "second block should be committed");
}

// ======================================================================
// B-63: purge cleans page_aliases and projected_agenda_cache
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_page_aliases() {
    let (pool, _dir) = test_pool().await;

    // Create a page block, soft-delete it, add a page alias
    insert_block_direct(&pool, "PURGE_PA_1", "page", "my page").await;
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_PA_1")
        .bind("alias-one")
        .execute(&pool)
        .await
        .unwrap();

    // Verify alias exists
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "alias should exist before purge");

    soft_delete_block_direct(&pool, "PURGE_PA_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PA_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(StdArc::new(r));
    handle_foreground_task(&pool, &task).await.unwrap();

    // Verify block and alias are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PA_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let alias_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(alias_count, 0, "page_aliases should be cleaned after purge");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;

    // Create a block, soft-delete it, add a projected_agenda_cache row
    insert_block_direct(&pool, "PURGE_PAC_1", "content", "task").await;
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_PAC_1")
    .bind("2025-06-01")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    // Verify cache row exists
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "projected_agenda_cache row should exist before purge"
    );

    soft_delete_block_direct(&pool, "PURGE_PAC_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PAC_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(StdArc::new(r));
    handle_foreground_task(&pool, &task).await.unwrap();

    // Verify block and cache row are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PAC_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let cache_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cache_count, 0,
        "projected_agenda_cache should be cleaned after purge"
    );
}

// ======================================================================
// C: cascade-purge materialises descendants once into a TEMP
// table and DROPs it at the end of the handler. The 15 DELETE / UPDATE
// statements then read from the temp table instead of re-evaluating the
// recursive `descendants_cte_purge!()` CTE 15× per cascade.
//
// Regression contract:
//   1. Final DB state matches the pre-refactor handler (every row in
//      the subtree is gone).
//   2. The temp namespace is clean afterwards (no leaked
//      `_purge_descendants` row in `sqlite_temp_master`).
// ======================================================================

/// Build a tree of 100+ blocks rooted at `root_id`.
async fn seed_purge_tree(pool: &SqlitePool, root_id: &str) -> usize {
    insert_block_direct(pool, root_id, "page", "purge-root").await;
    // Build a deliberately-bushy tree: 10 first-level children, each
    // with 10 grandchildren -> 1 root + 10 + 100 = 111 blocks total.
    for i in 0..10 {
        let child_id = format!("{root_id}_C{i:02}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&child_id)
        .bind(format!("child-{i}"))
        .bind(root_id)
        .bind(i)
        .execute(pool)
        .await
        .unwrap();
        for j in 0..10 {
            let leaf_id = format!("{root_id}_C{i:02}_L{j:02}");
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', ?, ?, ?)",
            )
            .bind(&leaf_id)
            .bind(format!("leaf-{i}-{j}"))
            .bind(&child_id)
            .bind(j)
            .execute(pool)
            .await
            .unwrap();
        }
    }
    1 + 10 + 100 // = 111
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cascades_through_100_block_tree_and_cleans_temp_table() {
    let (pool, _dir) = test_pool().await;

    let root_id = "PURGE_BIG";
    let total = seed_purge_tree(&pool, root_id).await;
    assert!(
        total >= 100,
        "test seed must place 100+ blocks under the purge root (got {total})"
    );
    soft_delete_block_direct(&pool, root_id).await;

    // Pre-purge sanity — the tree is fully populated.
    let pre_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id LIKE 'PURGE_BIG%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        usize::try_from(pre_count).unwrap(),
        total,
        "tree should be fully populated before the purge"
    );

    // Drive a purge through the materializer foreground handler — this
    // exercises the `OpType::PurgeBlock` arm that was refactored under
    // C to use the `_purge_descendants` TEMP table.
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id(root_id),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(StdArc::new(r));
    handle_foreground_task(&pool, &task).await.unwrap();

    // 1. Every block in the subtree is physically gone.
    let post_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id LIKE 'PURGE_BIG%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        post_count, 0,
        "every block in the purged subtree must be gone"
    );

    // 2. The TEMP table must NOT leak across handler invocations. The
    //    explicit `DROP TABLE _purge_descendants` at the bottom of the
    //    handler keeps the connection's temp namespace empty.
    //
    //    `sqlite_temp_master` is per-connection; we query through the
    //    pool so this matches what the next caller would observe. Note
    //    that pool connection identity is not deterministic, so we
    //    aggregate across whichever connection responds — any leaked
    //    temp table on any pooled connection would be a defect.
    let leaked: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_temp_master WHERE name = '_purge_descendants'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(
        leaked.is_none(),
        " C: the _purge_descendants temp table must be dropped at the end of the handler"
    );
}

/// Repeated invocations of the purge handler share connections from the
/// pool. The defensive `DROP TABLE IF EXISTS` at the top of the handler
/// guards against a prior crash leaking the table; verify by running
/// the cascade twice on independently-seeded subtrees.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_runs_cleanly_when_invoked_consecutively() {
    let (pool, _dir) = test_pool().await;

    for n in 0..2 {
        let root_id = format!("PURGE_REP_{n}");
        seed_purge_tree(&pool, &root_id).await;
        soft_delete_block_direct(&pool, &root_id).await;
        let r = make_op_record(
            &pool,
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::test_id(&root_id),
            }),
        )
        .await;
        let task = MaterializeTask::ApplyOp(StdArc::new(r));
        handle_foreground_task(&pool, &task).await.unwrap();
        let after: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM blocks WHERE id LIKE '{root_id}%'"
        )))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "purge {n} must clear its subtree");
    }
}
