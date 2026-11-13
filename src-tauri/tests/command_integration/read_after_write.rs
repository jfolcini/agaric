//! #6567 — the views a local write keeps fresh inside its own transaction,
//! read the moment the command returns, with no `settle`.
//!
//! The frontend refetches a view when the write command answers, not when the
//! background queue has drained, so a view is only safe to read then if the
//! write maintained it before returning. The Pages list (`pages_cache` rows
//! and counts) and Linked References (`block_links`) are; every sibling suite
//! settles before it reads, which also passes if that work moves behind the
//! queue. Search, the tags list and `agenda_cache` are rebuilt behind the
//! queue and are stale at this point: the measurement is on #6567.

use super::common::*;
use agaric_core::ulid::BlockId;
use agaric_lib::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner,
};

/// `(inbound_link_count, child_block_count)` of the page titled `title`, as
/// the Pages list reads it.
async fn pages_list_counts(pool: &SqlitePool, space: &str, title: &str) -> Option<(i64, i64)> {
    list_pages_with_metadata_inner(
        pool,
        ListPagesWithMetadataFilter {
            sort: PageSort::default(),
            space_id: space.into(),
            filters: Vec::new(),
        },
        None,
        Some(50),
    )
    .await
    .unwrap()
    .items
    .into_iter()
    .find(|page| page.content.as_deref() == Some(title))
    .map(|page| (page.inbound_link_count, page.child_block_count))
}

async fn page(pool: &SqlitePool, mat: &Materializer, space: &str, title: &str) -> BlockId {
    create_page_in_space_inner(pool, DEV, mat, None, title.into(), space.into())
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pages_list_and_backlinks_are_fresh_when_a_local_write_returns_6567() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = create_space_inner(&pool, DEV, &mat, "Space".into(), None)
        .await
        .unwrap()
        .into_string();
    let scope = SpaceScope::Active(SpaceId::from_trusted(&space));
    let source = page(&pool, &mat, &space, "Source").await;
    settle(&mat).await;

    let target = page(&pool, &mat, &space, "Target").await;
    assert_eq!(
        pages_list_counts(&pool, &space, "Target").await,
        Some((0, 0)),
        "a new page is in the Pages list when its create returns"
    );
    settle(&mat).await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "plain".into(),
        Some(source.clone()),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        pages_list_counts(&pool, &space, "Source").await,
        Some((0, 1)),
        "the page counts a new child when its create returns"
    );
    settle(&mat).await;

    edit_block_inner(&pool, DEV, &mat, child.id, format!("see [[{target}]]"))
        .await
        .unwrap();
    assert_eq!(
        pages_list_counts(&pool, &space, "Target").await,
        Some((1, 0)),
        "the linked page counts the link when the edit returns"
    );
    let backlinks =
        list_backlinks_grouped_inner(&pool, target, None, None, None, None, &scope, None)
            .await
            .unwrap();
    assert_eq!(
        (backlinks.total_count, backlinks.groups.len()),
        (1, 1),
        "Linked References lists the new link when the edit returns"
    );
}
