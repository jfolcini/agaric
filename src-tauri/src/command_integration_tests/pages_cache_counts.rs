//! #417/#432 — pages_cache counts must be maintained via the LOCAL command
//! path (create/edit/move/delete of content under a page), not only via the
//! sync `ApplyOp` path or a full rebuild.

use super::common::*;

async fn read_counts(pool: &sqlx::SqlitePool, page_id: &str) -> (i64, i64) {
    let row = sqlx::query!(
        "SELECT inbound_link_count, child_block_count FROM pages_cache WHERE page_id = ?",
        page_id
    )
    .fetch_optional(pool)
    .await
    .unwrap();
    match row {
        Some(r) => (r.inbound_link_count, r.child_block_count),
        None => (-1, -1),
    }
}

/// Creating content blocks under a page must keep the page's
/// `child_block_count` correct, and an inline link must bump the target
/// page's `inbound_link_count` — all via the local command path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_content_create_maintains_pages_cache_counts() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let t = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let p = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let c1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child one".into(),
        Some(p.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child two".into(),
        Some(p.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child three".into(),
        Some(p.id.clone()),
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(&pool, DEV, &mat, c1.id.clone(), format!("see [[{}]]", t.id))
        .await
        .unwrap();
    settle(&mat).await;

    let (_p_inbound, p_children) = read_counts(&pool, p.id.as_str()).await;
    let (t_inbound, _t_children) = read_counts(&pool, t.id.as_str()).await;
    assert_eq!(
        p_children, 3,
        "P child_block_count should be 3 after 3 local content creates"
    );
    assert_eq!(t_inbound, 1, "T inbound_link_count should be 1");

    // Deleting a child must decrement child_block_count.
    delete_block_inner(&pool, DEV, &mat, c1.id.clone())
        .await
        .unwrap();
    settle(&mat).await;
    let (_p_in2, p_children2) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        p_children2, 2,
        "P child_block_count should be 2 after deleting one child"
    );
    let (t_in2, _t_ch2) = read_counts(&pool, t.id.as_str()).await;
    assert_eq!(
        t_in2, 0,
        "T inbound_link_count should drop to 0 after the linking child is deleted"
    );
}

/// #432/#417 — the dedicated `rebuild_pages_cache_counts` pass (the RESET-path
/// count recompute, #417) must persist the recomputed counts even when the
/// `pages_cache` rows already exist and the title/orphan rebuild is a no-op.
/// It previously rolled back when `changed == 0`, discarding the count UPDATE;
/// #417 split the count recompute into its own `changed == 0 → rollback` guard
/// that keys on count drift, not title drift.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_pages_cache_counts_persists_when_titles_unchanged() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
        .await
        .unwrap();
    settle(&mat).await;
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(p.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Simulate the RESET repair shape: wipe the count columns to DEFAULT 0,
    // then run RebuildPagesCache (title/orphan only — no-op here) followed by
    // RebuildPagesCacheCounts. The counts pass must restore child_block_count
    // to 1 despite the title rebuild having an empty diff.
    sqlx::query("UPDATE pages_cache SET child_block_count = 0, inbound_link_count = 0")
        .execute(&pool)
        .await
        .unwrap();
    crate::cache::rebuild_page_ids(&pool).await.unwrap();
    crate::cache::rebuild_pages_cache(&pool).await.unwrap();
    crate::cache::rebuild_pages_cache_counts(&pool)
        .await
        .unwrap();
    let (_in, children) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        children, 1,
        "child_block_count must be restored by the dedicated counts pass (#417/#432)"
    );
}

/// #417 (b) — moving a child block from page A to page B must update BOTH
/// pages' `child_block_count` via the LOCAL move path, with NO full-table
/// `RebuildPagesCache` count pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_move_updates_both_pages_child_counts() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let a = create_block_inner(&pool, DEV, &mat, "page".into(), "A".into(), None, Some(1))
        .await
        .unwrap();
    settle(&mat).await;
    let b = create_block_inner(&pool, DEV, &mat, "page".into(), "B".into(), None, Some(2))
        .await
        .unwrap();
    settle(&mat).await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let (_a_in0, a_children0) = read_counts(&pool, a.id.as_str()).await;
    let (_b_in0, b_children0) = read_counts(&pool, b.id.as_str()).await;
    assert_eq!(a_children0, 1, "A owns the child before the move");
    assert_eq!(b_children0, 0, "B owns nothing before the move");

    // Move the child from A to B (slot 0 under B).
    move_block_inner(&pool, DEV, &mat, child.id.clone(), Some(b.id.clone()), 0)
        .await
        .unwrap();
    settle(&mat).await;

    let (_a_in1, a_children1) = read_counts(&pool, a.id.as_str()).await;
    let (_b_in1, b_children1) = read_counts(&pool, b.id.as_str()).await;
    assert_eq!(
        a_children1, 0,
        "A.child_block_count must drop to 0 after moving its only child out"
    );
    assert_eq!(
        b_children1, 1,
        "B.child_block_count must rise to 1 after receiving the moved child"
    );
}

/// #417 (c) — deleting a block that carries an inline `[[ULID]]` link must
/// decrement the target page's `inbound_link_count` via the LOCAL delete
/// path, with NO full-table `RebuildPagesCache` count pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_delete_of_linking_block_decrements_target_inbound() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let source = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // A content child on Source links into Target. The inbound edge is
    // registered via the EDIT path (link extraction runs on edit, not on the
    // initial create — see `local_content_create_maintains_pages_cache_counts`),
    // so create plain content first, then edit in the `[[ULID]]` link.
    let linker = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "see me".into(),
        Some(source.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        linker.id.clone(),
        format!("see [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let (t_in0, _t_ch0) = read_counts(&pool, target.id.as_str()).await;
    assert_eq!(
        t_in0, 1,
        "Target inbound_link_count is 1 while the link exists"
    );

    // Delete the linking block — Target must lose the inbound edge.
    delete_block_inner(&pool, DEV, &mat, linker.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let (t_in1, _t_ch1) = read_counts(&pool, target.id.as_str()).await;
    assert_eq!(
        t_in1, 0,
        "Target inbound_link_count must drop to 0 after the linking block is deleted (#417)"
    );
}

/// #446 (review of #417) — purging a soft-deleted subtree that still owns an
/// ACTIVE descendant must recompute the SURVIVING owning page's
/// `child_block_count`. The purge affected-page set previously captured only
/// outbound link targets, omitting the ownership branch that delete/restore/
/// move include; once the full-table recompute was gated out (#417), the owner
/// page's count was left permanently stale. This reproduces the reachable
/// inconsistent state (active grandchild under a soft-deleted child) that the
/// purge cascade removes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_purge_recomputes_surviving_owner_child_count() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
        .await
        .unwrap();
    settle(&mat).await;
    let c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(p.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let gc = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "gc".into(),
        Some(c.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Both descendants are active and owned by P.
    let (_in0, ch0) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(ch0, 2, "P owns the active child + grandchild");

    // Construct the reachable inconsistent state: soft-delete ONLY C (no
    // cascade to GC), as a sync merge / partial restore can leave it — GC
    // stays active under a tombstoned C. Stamp the cache to the correct
    // post-state (P now has 1 active descendant: GC) so the baseline is clean
    // and the purge is the only thing under test.
    sqlx::query("UPDATE blocks SET deleted_at = 1767225600000 WHERE id = ?")
        .bind(c.id.as_str())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pages_cache SET child_block_count = 1 WHERE page_id = ?")
        .bind(p.id.as_str())
        .execute(&pool)
        .await
        .unwrap();
    let (_in1, ch1) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(ch1, 1, "baseline: P owns only the active grandchild GC");

    // Purge the soft-deleted C — the cascade also removes the still-active GC,
    // so P must drop to 0. Without the #446 ownership branch P stays stale at 1.
    let _ = gc;
    purge_block_inner(&pool, DEV, &mat, c.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let (_in2, ch2) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        ch2, 0,
        "P.child_block_count must be recomputed to 0 after purging its last \
         (active) descendant (#446)"
    );
}
