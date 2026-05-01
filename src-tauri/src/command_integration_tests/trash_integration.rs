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
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
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
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
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
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
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
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PA_REL")
        .bind("old-name")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PA_REL")
    .bind("2024-12-26")
    .bind("due_date")
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

    // Use the non-macro `query_scalar` form for these two so we don't have
    // to add new variations to the sqlx offline cache.
    let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = ?")
        .bind("PA_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(aliases, 0, "page_aliases must be purged");

    let projected: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = ?")
            .bind("PA_REL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(projected, 0, "projected_agenda_cache must be purged");

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

// ======================================================================
// UX-243: roots-only trash listing + descendant counts round-trip
// ======================================================================

/// After cascade_soft_delete on a page with children, `list_blocks_inner`
/// with `show_deleted=true` returns only the root. Restoring that root
/// brings the descendants back too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_trash_with_cascade_deleted_page_returns_only_root_and_restores_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "UX243_PG", "page", "page with kids", None, Some(1)).await;
    insert_block(
        &pool,
        "UX243_C1",
        "content",
        "c1",
        Some("UX243_PG"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "UX243_C2",
        "content",
        "c2",
        Some("UX243_PG"),
        Some(2),
    )
    .await;

    let (_ts, count) = soft_delete::cascade_soft_delete(&pool, "UX243_PG")
        .await
        .unwrap();
    assert_eq!(count, 3, "cascade must delete page + 2 children");

    // Trash view returns only the root page.
    assign_all_to_test_space(&pool).await;
    let trash = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some(true),
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
    assert_eq!(
        trash.items.len(),
        1,
        "only the root page must appear in trash"
    );
    assert_eq!(trash.items[0].id, "UX243_PG");

    // Descendant counts helper reports +2 for the root.
    let counts = trash_descendant_counts_inner(&pool, vec!["UX243_PG".to_string()])
        .await
        .unwrap();
    assert_eq!(
        counts.get("UX243_PG").copied(),
        Some(2),
        "root must report 2 descendants, got {counts:?}"
    );

    // Restoring via the root brings descendants back.
    let root = get_block_inner(&pool, "UX243_PG".into()).await.unwrap();
    let deleted_at_ref = root
        .deleted_at
        .clone()
        .expect("root has deleted_at timestamp");
    let resp = restore_block_inner(&pool, DEV, &mat, "UX243_PG".into(), deleted_at_ref)
        .await
        .unwrap();
    assert_eq!(
        resp.restored_count, 3,
        "restore via root must cascade to descendants"
    );

    let pg = get_block_inner(&pool, "UX243_PG".into()).await.unwrap();
    let c1 = get_block_inner(&pool, "UX243_C1".into()).await.unwrap();
    let c2 = get_block_inner(&pool, "UX243_C2".into()).await.unwrap();
    assert!(pg.deleted_at.is_none(), "page must be alive");
    assert!(c1.deleted_at.is_none(), "child 1 must be alive");
    assert!(c2.deleted_at.is_none(), "child 2 must be alive");

    // Trash is now empty.
    let trash2 = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some(true),
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
    assert!(
        trash2.items.is_empty(),
        "trash must be empty after restore, got {:?}",
        trash2.items
    );
}

/// Purging the root via `purge_block` from the roots-only trash list
/// removes both the root and its descendants from the blocks table.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_root_from_trash_removes_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "UX243_PP", "page", "doomed", None, Some(1)).await;
    insert_block(
        &pool,
        "UX243_D1",
        "content",
        "d1",
        Some("UX243_PP"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "UX243_D2",
        "content",
        "d2",
        Some("UX243_PP"),
        Some(2),
    )
    .await;

    soft_delete::cascade_soft_delete(&pool, "UX243_PP")
        .await
        .unwrap();

    // Roots-only list returns just the root.
    assign_all_to_test_space(&pool).await;
    let trash = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some(true),
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
    assert_eq!(trash.items.len(), 1);
    assert_eq!(trash.items[0].id, "UX243_PP");

    let resp = purge_block_inner(&pool, DEV, &mat, "UX243_PP".into())
        .await
        .unwrap();
    assert_eq!(
        resp.purged_count, 3,
        "purge via root must remove all 3 (root + 2 descendants)"
    );

    // Neither the root nor the descendants physically remain.
    for id in ["UX243_PP", "UX243_D1", "UX243_D2"] {
        let exists = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            exists.is_none(),
            "{id} must be physically removed after purge"
        );
    }
}

// BUG-46 regression: the bulk purge path previously left orphan
// `block_tag_inherited` rows whose `tag_id` column pointed at a
// soft-deleted tag, causing an FK violation (SQLITE_CONSTRAINT_FOREIGNKEY
// / 787) when the tag was about to be physically removed. Seed a live
// page + live child + now-deleted tag with an inheritance row keyed on
// the deleted tag's id and confirm the purge succeeds cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_succeeds_when_tag_is_deleted_but_still_inherited_by_live_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Alive page P, alive tag T (child of P), alive child C (also under P).
    insert_block(&pool, "BUG46_P", "page", "parent page", None, Some(1)).await;
    insert_block(&pool, "BUG46_T", "tag", "my-tag", Some("BUG46_P"), None).await;
    insert_block(
        &pool,
        "BUG46_C",
        "content",
        "child block",
        Some("BUG46_P"),
        Some(2),
    )
    .await;

    // Materialized inheritance row: C inherits tag T from ancestor P.
    // (Schema requires non-null block_id, tag_id, inherited_from; each
    // points at a real row in `blocks`.)
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
    )
    .bind("BUG46_C")
    .bind("BUG46_T")
    .bind("BUG46_P")
    .execute(&pool)
    .await
    .unwrap();

    // Soft-delete ONLY the tag — P and C stay alive.
    let (_ts, cnt) = soft_delete::cascade_soft_delete(&pool, "BUG46_T")
        .await
        .unwrap();
    assert_eq!(cnt, 1, "only the tag should be soft-deleted");

    // Purge the trash. Before the fix this failed with FK violation 787
    // because `block_tag_inherited.tag_id` still referenced BUG46_T while
    // the DELETE FROM blocks tried to remove it.
    let resp = purge_all_deleted_inner(&pool, DEV, &mat).await.unwrap();
    assert_eq!(
        resp.affected_count, 1,
        "exactly one block (the tag) should be purged"
    );

    // P and C remain alive.
    let page = get_block_inner(&pool, "BUG46_P".into()).await.unwrap();
    assert!(page.deleted_at.is_none(), "BUG46_P must remain alive");
    let child = get_block_inner(&pool, "BUG46_C".into()).await.unwrap();
    assert!(child.deleted_at.is_none(), "BUG46_C must remain alive");

    // Zero `block_tag_inherited` rows reference BUG46_T in any column.
    let refs: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tag_inherited \
         WHERE block_id = ? OR tag_id = ? OR inherited_from = ?",
        "BUG46_T",
        "BUG46_T",
        "BUG46_T",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        refs, 0,
        "no block_tag_inherited row may reference the purged tag in any column"
    );

    // And the tag row is physically gone from `blocks`.
    let exists = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", "BUG46_T")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(exists.is_none(), "BUG46_T must be physically removed");
}
