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

/// #461 / #2042 — `delete_blocks_by_ids_inner` (batch soft-delete) must keep
/// `pages_cache.child_block_count` correct. #2042 moved the page-wide count
/// recompute off the foreground tx onto the background `RebuildPagesCacheCounts`
/// task, so the count is now correct after the background drain (`settle`),
/// not synchronously in-tx.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_delete_maintains_pages_cache_counts() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
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
    let c2 = create_block_inner(
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

    let (_in0, ch0) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(ch0, 2, "baseline: P owns 2 children");

    delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![c1.id.clone(), c2.id.clone()])
        .await
        .unwrap();
    // #2042: the page-wide count recompute is deferred to the background
    // RebuildPagesCacheCounts task — drain it before asserting.
    settle(&mat).await;

    let (_in1, ch1) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        ch1, 0,
        "child_block_count must drop to 0 after the deferred background recompute (#2042)"
    );
}

/// #461 / #2042 — `restore_blocks_by_ids_inner` (batch restore) must keep
/// `pages_cache.child_block_count` correct. #2042 defers the page-wide count
/// recompute to the background `RebuildPagesCacheCounts` task, so the count is
/// correct after the background drain (`settle`), not synchronously in-tx.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_restore_maintains_pages_cache_counts() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
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
    let c2 = create_block_inner(
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

    // Batch-delete both children so we have a clean baseline of 0.
    delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![c1.id.clone(), c2.id.clone()])
        .await
        .unwrap();
    // #2042: counts are deferred to the background recompute — drain it.
    settle(&mat).await;
    let (_in0, ch0) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(ch0, 0, "baseline after batch delete: P owns 0 children");

    // Batch-restore both children.
    restore_blocks_by_ids_inner(&pool, DEV, &mat, vec![c1.id.clone(), c2.id.clone()])
        .await
        .unwrap();
    // #2042: the page-wide count recompute is deferred to the background
    // RebuildPagesCacheCounts task — drain it before asserting.
    settle(&mat).await;

    let (_in1, ch1) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        ch1, 2,
        "child_block_count must rise back to 2 after the deferred background recompute (#2042)"
    );
}

/// #461 — `purge_blocks_by_ids_inner` (batch purge) must call the in-tx
/// `recompute_pages_cache_counts_for_pages` so non-purged pages that had
/// inbound links from the purged subtrees get their `inbound_link_count`
/// decremented immediately after the batch commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_purge_updates_inbound_link_count() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Page B is the link target; its `inbound_link_count` is under test.
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

    // Create a content block on Source, then edit in the `[[ULID]]` link so
    // the link-extraction path fires and registers the inbound edge on Target.
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

    // Soft-delete then batch-purge the linker block.
    delete_block_inner(&pool, DEV, &mat, linker.id.clone())
        .await
        .unwrap();
    settle(&mat).await;
    purge_blocks_by_ids_inner(&pool, DEV, &mat, vec![linker.id.clone()])
        .await
        .unwrap();
    // No settle — the recompute must happen synchronously in-tx (#461).

    let (t_in1, _t_ch1) = read_counts(&pool, target.id.as_str()).await;
    assert_eq!(
        t_in1, 0,
        "Target inbound_link_count must drop to 0 immediately after batch purge (#461)"
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

/// #2200 (Tier-2 reorder early-out) — a move that keeps a block under the SAME
/// parent is a pure sibling reorder. The affected pages and their descendant
/// COUNTS cannot change (the subtree stays under the same parent / owning
/// page), so `move_block_inner` must SKIP the in-tx
/// `recompute_pages_cache_counts_for_pages` on this hottest gesture — while a
/// cross-parent move still recomputes. We OBSERVE the skip by stamping a wrong
/// sentinel into `pages_cache.child_block_count` and asserting a same-parent
/// reorder leaves it UNTOUCHED (proving no recompute ran), whereas a subsequent
/// cross-parent move corrects it (proving the recompute still fires). Ranks are
/// asserted to reprojected correctly in BOTH cases.
///
/// The observe is sound because `move_block` does NOT enqueue the background
/// full-table `RebuildPagesCacheCounts` (see
/// `dispatch::rebuild_pages_cache_counts_enqueued_only_for_cohort_lifecycle_ops`):
/// the ONLY thing that maintains a page's counts on a move is that in-tx call,
/// so a tampered count survives `settle` iff the recompute was skipped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_parent_reorder_skips_count_recompute_cross_parent_still_recomputes() {
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

    // Two content children under A, in creation order c1 (slot 1) then c2
    // (slot 2). A owns 2; B owns 0.
    let c1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c1".into(),
        Some(a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let c2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c2".into(),
        Some(a.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let (_a_in0, a_ch0) = read_counts(&pool, a.id.as_str()).await;
    assert_eq!(a_ch0, 2, "baseline: A owns c1 + c2");

    // Helper: the (id, position) sibling order under a parent, canonical
    // `(position ASC, id ASC)`.
    async fn sibling_order(pool: &sqlx::SqlitePool, parent: &str) -> Vec<(String, i64)> {
        sqlx::query_as::<_, (String, i64)>(
            "SELECT id, position FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position ASC, id ASC",
        )
        .bind(parent)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    let order0 = sibling_order(&pool, a.id.as_str()).await;
    assert_eq!(
        order0.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        vec![c1.id.to_string(), c2.id.to_string()],
        "baseline sibling order under A is [c1, c2]"
    );

    // Stamp a WRONG sentinel so any recompute is observable: if the reorder
    // recomputes, this snaps back to 2; if it skips, it stays 999.
    sqlx::query("UPDATE pages_cache SET child_block_count = 999 WHERE page_id = ?")
        .bind(a.id.as_str())
        .execute(&pool)
        .await
        .unwrap();

    // SAME-PARENT REORDER: move c2 to slot 0 (front) under its EXISTING parent
    // A. Ranks must reproject to [c2, c1]; the tampered count must be UNTOUCHED.
    move_block_inner(&pool, DEV, &mat, c2.id.clone(), Some(a.id.clone()), 0)
        .await
        .unwrap();
    settle(&mat).await;

    let order1 = sibling_order(&pool, a.id.as_str()).await;
    assert_eq!(
        order1.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        vec![c2.id.to_string(), c1.id.to_string()],
        "a same-parent reorder must reproject ranks to [c2, c1]"
    );
    // c2 still owned by A (no reparent).
    let c2_parent: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(c2.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        c2_parent.as_deref(),
        Some(a.id.as_str()),
        "same-parent reorder must NOT reparent c2"
    );

    let (_a_in1, a_ch1) = read_counts(&pool, a.id.as_str()).await;
    assert_eq!(
        a_ch1, 999,
        "#2200: a same-parent reorder must SKIP recompute_pages_cache_counts_for_pages, \
         leaving the tampered child_block_count (999) untouched — counts cannot change \
         when only sibling ranks move"
    );

    // CROSS-PARENT MOVE: now move c2 out of A into B (slot 0). This DOES change
    // ownership, so the in-tx recompute must fire and correct BOTH pages'
    // counts (A -> 1, B -> 1), overwriting the tampered sentinel.
    move_block_inner(&pool, DEV, &mat, c2.id.clone(), Some(b.id.clone()), 0)
        .await
        .unwrap();
    settle(&mat).await;

    let (_a_in2, a_ch2) = read_counts(&pool, a.id.as_str()).await;
    let (_b_in2, b_ch2) = read_counts(&pool, b.id.as_str()).await;
    assert_eq!(
        a_ch2, 1,
        "#2200: a cross-parent move MUST recompute — A drops to 1 (only c1 left), \
         overwriting the tampered 999"
    );
    assert_eq!(
        b_ch2, 1,
        "#2200: a cross-parent move MUST recompute — B rises to 1 (received c2)"
    );
    // And c2 really reparented to B.
    let c2_parent2: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(c2.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        c2_parent2.as_deref(),
        Some(b.id.as_str()),
        "cross-parent move must reparent c2 under B"
    );
}

/// #2200 (Tier-2 batch-delete saturation collapse) — `delete_blocks_by_ids_inner`
/// replaced the former per-root `cascade_depth_saturated` loop with a SINGLE
/// `MAX(depth)` over ONE multi-root recursive CTE. This pins that the collapsed
/// form preserves identical delete SEMANTICS across roots at DIFFERENT depths:
/// every root's full subtree cascades (satellites soft-delete), the returned
/// count equals the whole cohort, and no root's descendants are missed — which
/// is exactly what the old loop guaranteed (its per-root walks covered every
/// subtree). Below saturation (max depth well under the >=99 cap) the delete
/// completes cleanly for the whole batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_delete_multi_root_varying_depth_cascades_all() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Root R1: a page owning a depth-3 content chain  R1 > a > b > c
    // (4 blocks incl. the root). Root R2: a page owning a depth-1 child
    // R2 > d (2 blocks). The two roots have DIFFERENT max depths, so the
    // collapsed multi-root MAX(depth) must span BOTH subtrees.
    let r1 = create_block_inner(&pool, DEV, &mat, "page".into(), "R1".into(), None, Some(1))
        .await
        .unwrap();
    settle(&mat).await;
    let r2 = create_block_inner(&pool, DEV, &mat, "page".into(), "R2".into(), None, Some(2))
        .await
        .unwrap();
    settle(&mat).await;

    // Build R1's deep chain: a (under R1) > b > c.
    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "a".into(),
        Some(r1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "b".into(),
        Some(a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(b.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Build R2's shallow child d.
    let d = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "d".into(),
        Some(r2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    async fn is_deleted(pool: &sqlx::SqlitePool, id: &str) -> bool {
        sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
            .is_some()
    }

    // Sanity: nothing deleted yet.
    for id in [&r1.id, &r2.id, &a.id, &b.id, &c.id, &d.id] {
        assert!(!is_deleted(&pool, id.as_str()).await, "baseline: {id} live");
    }

    // Batch-delete BOTH roots in one call. The collapsed multi-root CTE walks
    // both subtrees; the cascade soft-deletes every descendant of every root.
    let deleted = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![r1.id.clone(), r2.id.clone()])
        .await
        .unwrap();
    settle(&mat).await;

    // R1's subtree = 4 blocks (R1,a,b,c); R2's = 2 (R2,d). Total cohort = 6.
    assert_eq!(
        deleted, 6,
        "the multi-root cascade must soft-delete the FULL cohort across both \
         varying-depth roots (R1+a+b+c + R2+d = 6); the collapsed saturation \
         CTE must not change the cascade set"
    );

    // Every block in both subtrees — including the deepest satellite `c` and
    // the shallow `d` — must be tombstoned.
    for id in [&r1.id, &r2.id, &a.id, &b.id, &c.id, &d.id] {
        assert!(
            is_deleted(&pool, id.as_str()).await,
            "the cascade must reach {id} under its root — satellites at every \
             depth cascade identically to the pre-collapse per-root walk"
        );
    }
}
