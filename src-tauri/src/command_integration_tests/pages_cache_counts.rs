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

/// #432 — a full `rebuild_pages_cache` whose title/orphan diff is empty must
/// still persist the recomputed counts (it previously rolled back when
/// `changed == 0`, discarding the count UPDATE).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_pages_cache_persists_counts_when_titles_unchanged() {
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

    // Ensure page_ids are derived, then run pages_cache rebuild twice. The
    // SECOND run has an empty title/orphan diff (changed==0) but must keep the
    // counts the first run computed — not roll them back to stale/zero.
    crate::cache::rebuild_page_ids(&pool).await.unwrap();
    crate::cache::rebuild_pages_cache(&pool).await.unwrap();
    crate::cache::rebuild_pages_cache(&pool).await.unwrap();
    let (_in, children) = read_counts(&pool, p.id.as_str()).await;
    assert_eq!(
        children, 1,
        "child_block_count must survive a no-title-change rebuild (#432)"
    );
}
