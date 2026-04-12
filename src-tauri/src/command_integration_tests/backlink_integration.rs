use super::common::*;
use crate::backlink::{BacklinkFilter, BacklinkSort, CompareOp, SortDir};
use std::collections::HashSet;

// ======================================================================
// query_backlinks_filtered — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_returns_linking_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a target page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create two content blocks that reference the page
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("links to [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("also links to [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    let ids: HashSet<String> = resp.items.iter().map(|b| b.id.clone()).collect();
    assert!(ids.contains(&b1.id), "b1 must be in backlinks");
    assert!(ids.contains(&b2.id), "b2 must be in backlinks");
    assert_eq!(resp.items.len(), 2, "exactly two backlinks expected");
    assert_eq!(resp.total_count, 2, "total_count must be 2");
    assert_eq!(resp.filtered_count, 2, "filtered_count must be 2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_empty_for_no_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Lonely Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "no backlinks expected");
    assert_eq!(resp.total_count, 0, "total_count must be 0");
    assert_eq!(resp.filtered_count, 0, "filtered_count must be 0");
    assert!(!resp.has_more, "has_more must be false");
    assert!(resp.next_cursor.is_none(), "no cursor for empty results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_excludes_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("link [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Verify backlink exists
    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();
    assert_eq!(resp.items.len(), 1, "one backlink before deletion");

    // Delete the linking block
    delete_block_inner(&pool, DEV, &mat, b1.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "deleted backlink must be excluded");
    assert_eq!(resp.total_count, 0, "total_count must be 0 after deletion");
    assert_eq!(
        resp.filtered_count, 0,
        "filtered_count must be 0 after deletion"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_block_type_filter() {
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

    // Create a page-type block linking to target
    let page_linker = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        page_linker.id.clone(),
        format!("page ref [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a content-type block linking to target
    let content_linker = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        content_linker.id.clone(),
        format!("content ref [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Filter by block_type = content
    let filters = vec![BacklinkFilter::BlockType {
        block_type: "content".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only content backlink returned");
    assert_eq!(resp.items[0].id, content_linker.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_contains_filter() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("foo bar [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("baz qux [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let filters = vec![BacklinkFilter::Contains {
        query: "foo".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only 'foo' content returned");
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_property_text_filter() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("second [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("archived".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let filters = vec![BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only active status returned");
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_sort_created() {
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

    // Create blocks with slight time gaps so ULIDs differ
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("second [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Sort ascending (oldest first)
    let resp_asc = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp_asc.items.len(), 2);
    assert_eq!(
        resp_asc.items[0].id, b1.id,
        "b1 created first → first in Asc"
    );
    assert_eq!(
        resp_asc.items[1].id, b2.id,
        "b2 created second → second in Asc"
    );

    // Sort descending (newest first)
    let resp_desc = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp_desc.items.len(), 2);
    assert_eq!(resp_desc.items[0].id, b2.id, "b2 newest → first in Desc");
    assert_eq!(resp_desc.items[1].id, b1.id, "b1 oldest → second in Desc");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_sort_property() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("low [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "importance".into(),
        None,
        Some(1.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("high [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "importance".into(),
        None,
        Some(10.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Sort by importance Desc (highest first)
    let resp = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::PropertyNum {
            key: "importance".into(),
            dir: SortDir::Desc,
        }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2);
    assert_eq!(resp.items[0].id, b2.id, "importance=10 first in Desc");
    assert_eq!(resp.items[1].id, b1.id, "importance=1 second in Desc");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_pagination() {
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

    // Create 7 backlinks
    let mut block_ids = Vec::new();
    for i in 0..7 {
        let b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            None,
            Some(i + 10),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            b.id.clone(),
            format!("link {} [[{}]]", i, target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        block_ids.push(b.id);
    }

    // First page: limit=3
    let resp1 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        None,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp1.items.len(), 3, "first page has 3 items");
    assert!(resp1.has_more, "more pages expected");
    assert!(resp1.next_cursor.is_some(), "cursor must be present");
    assert_eq!(resp1.total_count, 7, "total_count reflects all backlinks");
    assert_eq!(
        resp1.filtered_count, 7,
        "filtered_count equals total_count with no filters"
    );

    // Second page
    let resp2 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        resp1.next_cursor,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp2.items.len(), 3, "second page has 3 items");
    assert!(resp2.has_more, "still more pages");
    assert!(resp2.next_cursor.is_some(), "cursor for third page");

    // Third page (last)
    let resp3 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        resp2.next_cursor,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp3.items.len(), 1, "third page has remaining 1 item");
    assert!(!resp3.has_more, "no more pages");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_total_count_matches() {
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

    // Create 5 backlinks
    for i in 0..5 {
        let b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            None,
            Some(i + 10),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            b.id.clone(),
            format!("link {} [[{}]]", i, target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;
    }

    // Query with limit=2 — total_count should still be 5
    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, Some(2))
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "page has 2 items");
    assert_eq!(
        resp.total_count, 5,
        "total_count reflects all 5 matches, not just page"
    );
    assert_eq!(
        resp.filtered_count, 5,
        "filtered_count equals total_count with no filters"
    );
    assert!(resp.has_more, "more pages available");
}

// ======================================================================
// query_backlinks_filtered — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_empty_block_id_returns_error() {
    let (pool, _dir) = test_pool().await;

    let result = query_backlinks_filtered_inner(&pool, "".into(), None, None, None, None).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_id must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_nonexistent_block_id_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let resp = query_backlinks_filtered_inner(
        &pool,
        "NONEXISTENT_BLOCK_XYZ".into(),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(
        resp.items.is_empty(),
        "nonexistent block_id returns empty, not error"
    );
    assert_eq!(resp.total_count, 0);
    assert_eq!(resp.filtered_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_and_filter_intersection() {
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

    // b1: content type, status=active
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("b1 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // b2: content type, status=archived
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("b2 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("archived".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // b3: page type, status=active
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "placeholder".into(),
        None,
        Some(4),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        format!("b3 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // AND filter: content type AND status=active → only b1
    let filters = vec![BacklinkFilter::And {
        filters: vec![
            BacklinkFilter::BlockType {
                block_type: "content".into(),
            },
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
        ],
    }];

    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "AND intersection must return 1 block");
    assert_eq!(resp.items[0].id, b1.id, "only b1 matches both conditions");
}

// ======================================================================
// query_backlinks_filtered — edge cases
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_unicode_content() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let unicode_content = format!("日本語テスト 🚀 [[{}]]", target.id);
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), unicode_content.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 1, "unicode backlink must be returned");
    assert_eq!(
        resp.items[0].content.as_deref(),
        Some(unicode_content.as_str()),
        "unicode content preserved"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_self_referencing() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Block references itself
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("self-ref [[{}]]", b1.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, b1.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "self-referencing block returned as backlink"
    );
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_multiple_refs_same_block() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Block has [[target]] twice in content
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]] second [[{}]]", target.id, target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "duplicate refs produce only one backlink entry"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_created_in_range() {
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

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Use a range that covers "now" — blocks just created should match
    let filters = vec![BacklinkFilter::CreatedInRange {
        after: Some("2020-01-01".into()),
        before: Some("2099-12-31".into()),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "block within date range is returned");

    // Use a range in the past — no blocks should match
    let filters_past = vec![BacklinkFilter::CreatedInRange {
        after: Some("2000-01-01".into()),
        before: Some("2001-01-01".into()),
    }];
    let resp_past = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        Some(filters_past),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(resp_past.items.is_empty(), "no blocks in past date range");
}

// ======================================================================
// list_property_keys — integration
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_returns_distinct_sorted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
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
    settle(&mat).await;

    let b2 = create_block_inner(
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
    settle(&mat).await;

    // Set properties: b1 has "zebra" and "alpha", b2 has "alpha"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "zebra".into(),
        Some("z".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "alpha".into(),
        Some("a".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "alpha".into(),
        Some("a2".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert_eq!(
        keys,
        vec!["alpha", "zebra"],
        "keys must be distinct and sorted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_empty_when_no_properties() {
    let (pool, _dir) = test_pool().await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert!(keys.is_empty(), "no properties → empty vec");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_includes_all_types() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set text property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "note".into(),
        Some("hello".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set numeric property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "count".into(),
        None,
        Some(42.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set date property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "due".into(),
        None,
        None,
        Some("2025-06-15".into()),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert_eq!(keys.len(), 3, "three distinct keys");
    assert!(keys.contains(&"note".to_string()), "text key included");
    assert!(keys.contains(&"count".to_string()), "num key included");
    assert!(keys.contains(&"due".to_string()), "date key included");
}

// ======================================================================
// batch_resolve — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "resolve-page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "resolve-tag".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let resolved = batch_resolve_inner(
        &pool,
        vec![b1.id.clone(), b2.id.clone(), "NONEXISTENT".into()],
    )
    .await
    .unwrap();

    assert_eq!(resolved.len(), 2, "only existing blocks should be returned");
    let ids: HashSet<&str> = resolved.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(b1.id.as_str()), "page block must be resolved");
    assert!(ids.contains(b2.id.as_str()), "tag block must be resolved");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_marks_deleted_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "soon-deleted".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resolved = batch_resolve_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    assert_eq!(resolved.len(), 1, "deleted block should still be resolved");
    assert!(resolved[0].deleted, "deleted flag must be true");
}

// ======================================================================
// get_backlinks — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_returns_linking_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "target-page".into(),
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
        "content".into(),
        format!("links to [[{}]]", target.id),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert a block_link row (normally done by materializer)
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&source.id)
        .bind(&target.id)
        .execute(&pool)
        .await
        .unwrap();

    let resp = get_backlinks_inner(&pool, target.id.clone(), None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 1, "one backlink expected");
    assert_eq!(
        resp.items[0].id, source.id,
        "source block must be the backlink"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_empty_when_no_links() {
    let (pool, _dir) = test_pool().await;

    insert_block(
        &pool,
        "BL_ORPHAN",
        "content",
        "no links here",
        None,
        Some(1),
    )
    .await;

    let resp = get_backlinks_inner(&pool, "BL_ORPHAN".into(), None, None)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "no backlinks expected for isolated block"
    );
}

// ======================================================================
// get_block_history — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_returns_ops_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "history-test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "v2".into())
        .await
        .unwrap();

    let resp = get_block_history_inner(&pool, block.id.clone(), None, None)
        .await
        .unwrap();

    assert!(
        resp.items.len() >= 2,
        "at least create + edit ops expected, got {}",
        resp.items.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_empty_for_nonexistent_block() {
    let (pool, _dir) = test_pool().await;

    let resp = get_block_history_inner(&pool, "GHOST_HIST".into(), None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "no history for nonexistent block");
}

// ======================================================================
// get_conflicts — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_conflicts_empty_when_none_exist() {
    let (pool, _dir) = test_pool().await;

    let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

    assert!(
        resp.items.is_empty(),
        "no conflicts should exist in a fresh DB"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_conflicts_returns_conflict_blocks() {
    let (pool, _dir) = test_pool().await;

    // Insert a conflict block directly
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict, position) \
         VALUES (?, ?, ?, 1, ?)",
    )
    .bind("CONFLICT01")
    .bind("content")
    .bind("conflict copy")
    .bind(1_i64)
    .execute(&pool)
    .await
    .unwrap();

    let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

    assert_eq!(resp.items.len(), 1, "one conflict block expected");
    assert_eq!(
        resp.items[0].id, "CONFLICT01",
        "conflict block ID must match"
    );
}

// ======================================================================
// list_backlinks_grouped — happy paths, edge cases, filters
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_returns_groups_by_source_page() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create target page
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

    // Source page 1 with two linking children
    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source1".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let c1a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        c1a.id.clone(),
        format!("link to [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let c1b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        c1b.id.clone(),
        format!("another link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Source page 2 with one linking child
    let page2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source2".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let c2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        c2.id.clone(),
        format!("see [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.groups.len(),
        2,
        "expected 2 groups (one per source page)"
    );

    let ids: HashSet<String> = resp.groups.iter().map(|g| g.page_id.clone()).collect();
    assert!(ids.contains(&page1.id), "page1 must be in groups");
    assert!(ids.contains(&page2.id), "page2 must be in groups");

    let g1 = resp.groups.iter().find(|g| g.page_id == page1.id).unwrap();
    assert_eq!(g1.page_title.as_deref(), Some("Source1"), "page1 title");
    assert_eq!(g1.blocks.len(), 2, "page1 group must have 2 blocks");

    let g2 = resp.groups.iter().find(|g| g.page_id == page2.id).unwrap();
    assert_eq!(g2.page_title.as_deref(), Some("Source2"), "page2 title");
    assert_eq!(g2.blocks.len(), 1, "page2 group must have 1 block");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_empty_for_no_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Lonely".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(
        resp.groups.is_empty(),
        "no groups for a page with no backlinks"
    );
    assert_eq!(resp.total_count, 0, "total_count must be 0");
    assert_eq!(resp.filtered_count, 0, "filtered_count must be 0");
    assert!(!resp.has_more, "has_more must be false");
    assert!(resp.next_cursor.is_none(), "no cursor expected");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_empty_block_id_returns_error() {
    let (pool, _dir) = test_pool().await;

    let result = list_backlinks_grouped_inner(&pool, "".into(), None, None, None, None).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_id must return Validation error, got {:?}",
        result
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_single_block_page() {
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

    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Single".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        format!("ref [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "exactly 1 group");
    assert_eq!(resp.groups[0].page_id, page1.id, "group page_id must match");
    assert_eq!(
        resp.groups[0].blocks.len(),
        1,
        "exactly 1 block in the group"
    );
    assert_eq!(
        resp.groups[0].blocks[0].id, child.id,
        "block id must match child"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_orphan_blocks_excluded_from_groups() {
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

    // Create an orphan content block (no page parent) that links to target
    let orphan = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        orphan.id.clone(),
        format!("orphan link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    // Orphan content blocks (no page ancestor) are omitted from grouped results
    assert!(
        resp.groups.is_empty(),
        "orphan content block with no page ancestor should be omitted from grouped results"
    );
    // But total_count still counts them in the base set
    assert_eq!(
        resp.total_count, 1,
        "orphan block is still in the base backlink set"
    );
    assert_eq!(
        resp.filtered_count, 1,
        "orphan block passes filters (no filters applied)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_excludes_deleted() {
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

    let page1 = create_block_inner(&pool, DEV, &mat, "page".into(), "Src".into(), None, Some(2))
        .await
        .unwrap();
    settle(&mat).await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        format!("link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Verify it appears before deletion
    let before = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();
    assert_eq!(before.groups.len(), 1, "link present before delete");

    // Soft-delete the linking block
    delete_block_inner(&pool, DEV, &mat, child.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let after = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(
        after.groups.is_empty(),
        "deleted block must be excluded from grouped results"
    );
    assert_eq!(after.total_count, 0, "deleted block not in base set");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_pagination() {
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

    // Create 3 source pages, each with one linking child
    let mut page_ids = Vec::new();
    for i in 0..3 {
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            format!("Page{}", i),
            None,
            Some((i + 2) as i64),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            format!("link [[{}]]", target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        page_ids.push(page.id.clone());
    }

    // Request limit=1
    let resp1 = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, Some(1))
        .await
        .unwrap();

    assert_eq!(resp1.groups.len(), 1, "first page must have 1 group");
    assert!(resp1.has_more, "must have more pages");
    assert!(resp1.next_cursor.is_some(), "next_cursor must be Some");

    // Fetch page 2 with cursor
    let resp2 = list_backlinks_grouped_inner(
        &pool,
        target.id.clone(),
        None,
        None,
        resp1.next_cursor.clone(),
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(resp2.groups.len(), 1, "second page must have 1 group");
    assert!(resp2.has_more, "must have a third page");
    assert_ne!(
        resp1.groups[0].page_id, resp2.groups[0].page_id,
        "page 2 must return a different group than page 1"
    );

    // Fetch page 3
    let resp3 = list_backlinks_grouped_inner(
        &pool,
        target.id.clone(),
        None,
        None,
        resp2.next_cursor.clone(),
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(resp3.groups.len(), 1, "third page must have 1 group");
    assert!(!resp3.has_more, "no more pages after third");

    // All three groups should be distinct
    let all_ids: HashSet<String> = vec![
        resp1.groups[0].page_id.clone(),
        resp2.groups[0].page_id.clone(),
        resp3.groups[0].page_id.clone(),
    ]
    .into_iter()
    .collect();
    assert_eq!(all_ids.len(), 3, "all three groups must be distinct pages");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_total_and_filtered_count() {
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

    // Page 1 with 2 linking children
    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Src1".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    for pos in 1..=2 {
        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            Some(page1.id.clone()),
            Some(pos),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            format!("link [[{}]]", target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;
    }

    // Page 2 with 1 linking child
    let page2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Src2".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let child2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child2.id.clone(),
        format!("link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Without filter
    let resp = list_backlinks_grouped_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "total_count must be 3");
    assert_eq!(
        resp.filtered_count, 3,
        "filtered_count must equal total when no filter"
    );

    // With SourcePage filter — include only page1
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![page1.id.clone()],
        excluded: vec![],
    }];
    let resp_filtered =
        list_backlinks_grouped_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();
    assert_eq!(
        resp_filtered.total_count, 3,
        "total_count unchanged with filter"
    );
    assert_eq!(
        resp_filtered.filtered_count, 2,
        "filtered_count must reflect only page1 blocks"
    );
    assert!(
        resp_filtered.filtered_count < resp_filtered.total_count,
        "filtered_count < total_count when filter is applied"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_with_source_page_include_filter() {
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

    // Create 3 source pages, each with one linking child
    let mut pages = Vec::new();
    for i in 0..3 {
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            format!("Src{}", i),
            None,
            Some((i + 2) as i64),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            format!("link [[{}]]", target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        pages.push(page);
    }

    // Include only page 0
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![pages[0].id.clone()],
        excluded: vec![],
    }];

    let resp =
        list_backlinks_grouped_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.groups.len(), 1, "only 1 group should be returned");
    assert_eq!(
        resp.groups[0].page_id, pages[0].id,
        "group must be from included page"
    );
    assert_eq!(resp.total_count, 3, "total_count is all backlinks");
    assert!(
        resp.filtered_count < resp.total_count,
        "filtered_count must be less than total_count"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_with_source_page_exclude_filter() {
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

    // Create 3 source pages, each with one linking child
    let mut pages = Vec::new();
    for i in 0..3 {
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            format!("Src{}", i),
            None,
            Some((i + 2) as i64),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            format!("link [[{}]]", target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        pages.push(page);
    }

    // Exclude page 1
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![],
        excluded: vec![pages[1].id.clone()],
    }];

    let resp =
        list_backlinks_grouped_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(
        resp.groups.len(),
        2,
        "2 groups should remain after excluding one page"
    );
    let group_ids: HashSet<String> = resp.groups.iter().map(|g| g.page_id.clone()).collect();
    assert!(
        !group_ids.contains(&pages[1].id),
        "excluded page must not appear in groups"
    );
    assert!(
        group_ids.contains(&pages[0].id),
        "page0 must still be present"
    );
    assert!(
        group_ids.contains(&pages[2].id),
        "page2 must still be present"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_with_source_page_include_and_exclude() {
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

    // Create 3 source pages, each with one linking child
    let mut pages = Vec::new();
    for i in 0..3 {
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            format!("Src{}", i),
            None,
            Some((i + 2) as i64),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            format!("link [[{}]]", target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        pages.push(page);
    }

    // Include page0 and page1, but exclude page1 → only page0 should remain
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![pages[0].id.clone(), pages[1].id.clone()],
        excluded: vec![pages[1].id.clone()],
    }];

    let resp =
        list_backlinks_grouped_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(
        resp.groups.len(),
        1,
        "only page0 should remain after include+exclude"
    );
    assert_eq!(
        resp.groups[0].page_id, pages[0].id,
        "the sole group must be page0"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_backlinks_with_contains_filter() {
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

    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Src1".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Child with "alpha" keyword
    let alpha = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        alpha.id.clone(),
        format!("alpha link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Child with "beta" keyword on same page
    let beta = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        beta.id.clone(),
        format!("beta link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Page2 with "beta" keyword
    let page2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Src2".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let beta2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        Some(page2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        beta2.id.clone(),
        format!("beta link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Filter: only blocks containing "alpha"
    let filters = vec![BacklinkFilter::Contains {
        query: "alpha".into(),
    }];

    let resp =
        list_backlinks_grouped_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(
        resp.groups.len(),
        1,
        "only page1 group should match 'alpha' filter"
    );
    assert_eq!(
        resp.groups[0].page_id, page1.id,
        "matching group must be page1"
    );
    assert_eq!(
        resp.groups[0].blocks.len(),
        1,
        "only the alpha block should be in the group"
    );
    assert_eq!(
        resp.groups[0].blocks[0].id, alpha.id,
        "block must be the alpha block"
    );
    assert_eq!(resp.total_count, 3, "total_count reflects all 3 backlinks");
    assert_eq!(
        resp.filtered_count, 1,
        "filtered_count reflects only the alpha block"
    );
}
