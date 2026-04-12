use super::common::*;
use crate::op_log;
use crate::soft_delete;

// ======================================================================
// restore_all_deleted — happy paths (B-46)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_all_deleted_restores_all_soft_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 3 blocks, soft-delete 2
    insert_block(&pool, "RA_DEL1", "content", "deleted one", None, Some(1)).await;
    insert_block(&pool, "RA_DEL2", "content", "deleted two", None, Some(2)).await;
    insert_block(&pool, "RA_ALIVE", "content", "alive", None, Some(3)).await;

    soft_delete::cascade_soft_delete(&pool, "RA_DEL1")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, "RA_DEL2")
        .await
        .unwrap();

    let resp = restore_all_deleted_inner(&pool, DEV, &mat).await.unwrap();

    assert_eq!(resp.affected_count, 2, "two blocks should be restored");

    // Both should be alive now
    let row1 = get_block_inner(&pool, "RA_DEL1".into()).await.unwrap();
    assert!(
        row1.deleted_at.is_none(),
        "RA_DEL1 must have deleted_at cleared after restore"
    );
    let row2 = get_block_inner(&pool, "RA_DEL2".into()).await.unwrap();
    assert!(
        row2.deleted_at.is_none(),
        "RA_DEL2 must have deleted_at cleared after restore"
    );

    // Third block still alive and unaffected
    let row3 = get_block_inner(&pool, "RA_ALIVE".into()).await.unwrap();
    assert!(row3.deleted_at.is_none(), "RA_ALIVE must remain alive");

    // Op log should have 2 restore_block entries
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "2 restore_block ops must be logged");
    for op in &ops {
        assert_eq!(op.op_type, "restore_block", "op_type must be restore_block");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_all_deleted_empty_trash_returns_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a block but don't delete it
    insert_block(&pool, "RA_NODEL", "content", "not deleted", None, Some(1)).await;

    let resp = restore_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(
        resp.affected_count, 0,
        "with no deleted blocks, affected_count must be 0"
    );

    // No ops logged
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(ops.is_empty(), "no ops should be logged for empty trash");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_all_deleted_handles_cascade_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create parent + child, cascade-delete parent (both get same deleted_at)
    insert_block(&pool, "RA_PAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "RA_CHD", "content", "child", Some("RA_PAR"), Some(1)).await;

    let (ts, count) = soft_delete::cascade_soft_delete(&pool, "RA_PAR")
        .await
        .unwrap();
    assert_eq!(count, 2, "cascade must delete parent + child");

    // Verify both have same deleted_at
    let par_row = get_block_inner(&pool, "RA_PAR".into()).await.unwrap();
    let chd_row = get_block_inner(&pool, "RA_CHD".into()).await.unwrap();
    assert_eq!(par_row.deleted_at.as_deref(), Some(ts.as_str()));
    assert_eq!(chd_row.deleted_at.as_deref(), Some(ts.as_str()));

    let resp = restore_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(resp.affected_count, 2, "both blocks should be restored");

    // Only 1 root op in op_log (child has same deleted_at as parent)
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(
        ops.len(),
        1,
        "only 1 root op should be logged for cascade-deleted pair"
    );
    assert!(
        ops[0].payload.contains("RA_PAR"),
        "the root op should reference the parent block"
    );

    // Both blocks are alive
    let par = get_block_inner(&pool, "RA_PAR".into()).await.unwrap();
    let chd = get_block_inner(&pool, "RA_CHD".into()).await.unwrap();
    assert!(par.deleted_at.is_none(), "parent must be restored");
    assert!(chd.deleted_at.is_none(), "child must be restored");
}

// ======================================================================
// purge_all_deleted — happy paths (B-46)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_removes_all_soft_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 3 blocks, soft-delete 2
    insert_block(&pool, "PA_DEL1", "content", "doomed one", None, Some(1)).await;
    insert_block(&pool, "PA_DEL2", "content", "doomed two", None, Some(2)).await;
    insert_block(&pool, "PA_ALIVE", "content", "alive", None, Some(3)).await;

    soft_delete::cascade_soft_delete(&pool, "PA_DEL1")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, "PA_DEL2")
        .await
        .unwrap();

    let resp = purge_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(resp.affected_count, 2, "two blocks should be purged");

    // Purged blocks are physically gone
    let exists1 = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", "PA_DEL1")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(exists1.is_none(), "PA_DEL1 must be physically removed");

    let exists2 = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", "PA_DEL2")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(exists2.is_none(), "PA_DEL2 must be physically removed");

    // Third block still exists
    let alive = get_block_inner(&pool, "PA_ALIVE".into()).await.unwrap();
    assert!(alive.deleted_at.is_none(), "PA_ALIVE must remain alive");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_empty_trash_returns_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a block but don't delete it
    insert_block(&pool, "PA_NODEL", "content", "not deleted", None, Some(1)).await;

    let resp = purge_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(
        resp.affected_count, 0,
        "with no deleted blocks, affected_count must be 0"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_cleans_dependent_tables() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block with tags, properties, links
    insert_block(&pool, "PA_REL", "content", "has relations", None, Some(1)).await;
    insert_block(&pool, "PA_TAG", "tag", "my-tag", None, None).await;
    insert_block(&pool, "PA_TGT", "content", "link target", None, Some(2)).await;

    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("PA_REL")
        .bind("PA_TAG")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind("PA_REL")
        .bind("priority")
        .bind("high")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("PA_REL")
        .bind("PA_TGT")
        .execute(&pool)
        .await
        .unwrap();

    // Soft-delete both the block with relations and the tag
    soft_delete::cascade_soft_delete(&pool, "PA_REL")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, "PA_TAG")
        .await
        .unwrap();

    purge_all_deleted_inner(&pool, DEV, &mat).await.unwrap();

    // Verify all dependent rows are gone
    let tags: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = ?",
        "PA_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tags, 0, "block_tags must be purged");

    let props: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
        "PA_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(props, 0, "block_properties must be purged");

    let links: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_links WHERE source_id = ?",
        "PA_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(links, 0, "block_links must be purged");

    // PA_TGT (link target, not deleted) should still exist
    let tgt = get_block_inner(&pool, "PA_TGT".into()).await.unwrap();
    assert!(tgt.deleted_at.is_none(), "PA_TGT must remain alive");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_preserves_non_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 5 blocks, soft-delete 3, leave 2 alive
    insert_block(&pool, "PA5_DEL1", "content", "doomed 1", None, Some(1)).await;
    insert_block(&pool, "PA5_DEL2", "content", "doomed 2", None, Some(2)).await;
    insert_block(&pool, "PA5_DEL3", "content", "doomed 3", None, Some(3)).await;
    insert_block(&pool, "PA5_LIVE1", "content", "alive 1", None, Some(4)).await;
    insert_block(&pool, "PA5_LIVE2", "content", "alive 2", None, Some(5)).await;

    // Add a property on one of the alive blocks
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind("PA5_LIVE1")
        .bind("status")
        .bind("active")
        .execute(&pool)
        .await
        .unwrap();

    soft_delete::cascade_soft_delete(&pool, "PA5_DEL1")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, "PA5_DEL2")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, "PA5_DEL3")
        .await
        .unwrap();

    let resp = purge_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(resp.affected_count, 3, "3 deleted blocks should be purged");

    // 2 alive blocks still exist
    let live1 = get_block_inner(&pool, "PA5_LIVE1".into()).await.unwrap();
    assert!(live1.deleted_at.is_none(), "PA5_LIVE1 must remain alive");
    let live2 = get_block_inner(&pool, "PA5_LIVE2".into()).await.unwrap();
    assert!(live2.deleted_at.is_none(), "PA5_LIVE2 must remain alive");

    // Properties on alive blocks are intact
    let props: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
        "PA5_LIVE1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        props, 1,
        "properties on alive blocks must be preserved after purge"
    );

    // Total block count should be exactly 2
    let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 2, "only the 2 alive blocks should remain");
}
