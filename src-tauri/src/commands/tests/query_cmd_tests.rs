use super::super::*;
use super::common::*;
use crate::space::{SpaceId, SpaceScope};

// ======================================================================
// get_backlinks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_returns_linked_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BL_TGT", "page", "target", None, None).await;
    insert_block(&pool, "BL_SRC1", "content", "src1", None, None).await;
    insert_block(&pool, "BL_SRC2", "content", "src2", None, None).await;

    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BL_SRC1")
        .bind("BL_TGT")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BL_SRC2")
        .bind("BL_TGT")
        .execute(&pool)
        .await
        .unwrap();

    let resp = get_backlinks_inner(&pool, "BL_TGT".into(), None, None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "should return both linked source blocks"
    );
    assert_eq!(resp.items[0].id, "BL_SRC1", "first backlink should be SRC1");
    assert_eq!(
        resp.items[1].id, "BL_SRC2",
        "second backlink should be SRC2"
    );
}

// ======================================================================
// search_blocks_inner tests
// ======================================================================

/// Helper: a [`SearchFilter`] scoped to [`TEST_SPACE_ID`] with no other
/// predicates. Mirrors today's "default filter + space" callsite shape.
fn test_space_filter() -> SearchFilter {
    SearchFilter {
        space_id: Some(TEST_SPACE_ID.into()),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_inner_empty_query_returns_empty() {
    let (pool, _dir) = test_pool().await;
    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(&pool, "".into(), None, None, test_space_filter(), None)
        .await
        .unwrap();
    assert_eq!(
        result.items.len(),
        0,
        "empty query should return no results"
    );
    assert!(!result.has_more, "empty query should not have more results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_inner_whitespace_query_returns_empty() {
    let (pool, _dir) = test_pool().await;
    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(&pool, "   ".into(), None, None, test_space_filter(), None)
        .await
        .unwrap();
    assert_eq!(
        result.items.len(),
        0,
        "whitespace query should return no results"
    );
    assert!(
        !result.has_more,
        "whitespace query should not have more results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_inner_finds_indexed_block() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "SRCH1",
        "content",
        "searchable content",
        None,
        Some(0),
    )
    .await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "searchable".into(),
        None,
        None,
        test_space_filter(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.items.len(), 1, "should find one matching block");
    assert_eq!(result.items[0].id, "SRCH1", "found block should be SRCH1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_inner_no_results_for_unindexed_term() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "SRCH2", "content", "apple banana", None, Some(0)).await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "cherry".into(),
        None,
        None,
        test_space_filter(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.items.len(),
        0,
        "unindexed term should return no results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_with_parent_id_filter() {
    let (pool, _dir) = test_pool().await;

    // Create a page block as parent
    insert_block(&pool, "PAGE_A", "page", "Page A", None, Some(1)).await;

    // Two content blocks: one under PAGE_A, one root-level
    insert_block(
        &pool,
        "BLK_UNDER_PAGE",
        "content",
        "searchable under page",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "BLK_ROOT",
        "content",
        "searchable at root",
        None,
        Some(2),
    )
    .await;

    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    // Without filter — both should appear
    assign_all_to_test_space(&pool).await;
    let all = search_blocks_inner(
        &pool,
        "searchable".into(),
        None,
        None,
        test_space_filter(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(all.items.len(), 2, "no filter: should find both blocks");

    // With parent_id filter — only block under PAGE_A
    let filtered = search_blocks_inner(
        &pool,
        "searchable".into(),
        None,
        None,
        SearchFilter {
            parent_id: Some("PAGE_A".into()),
            space_id: Some(TEST_SPACE_ID.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        filtered.items.len(),
        1,
        "parent_id filter: should find one block"
    );
    assert_eq!(filtered.items[0].id, "BLK_UNDER_PAGE");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_with_tag_filter() {
    let (pool, _dir) = test_pool().await;

    // Create tag blocks
    insert_block(&pool, "TAG_X", "tag", "tagx", None, Some(1)).await;
    insert_block(&pool, "TAG_Y", "tag", "tagy", None, Some(2)).await;

    // Create content blocks
    insert_block(
        &pool,
        "BLK_XY",
        "content",
        "findme both tags",
        None,
        Some(1),
    )
    .await;
    insert_block(&pool, "BLK_X", "content", "findme one tag", None, Some(2)).await;
    insert_block(
        &pool,
        "BLK_NONE",
        "content",
        "findme no tags",
        None,
        Some(3),
    )
    .await;

    // Associate tags
    insert_tag_assoc(&pool, "BLK_XY", "TAG_X").await;
    insert_tag_assoc(&pool, "BLK_XY", "TAG_Y").await;
    insert_tag_assoc(&pool, "BLK_X", "TAG_X").await;

    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    // Without tag filter — all three
    assign_all_to_test_space(&pool).await;
    let all = search_blocks_inner(
        &pool,
        "findme".into(),
        None,
        None,
        test_space_filter(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        all.items.len(),
        3,
        "no tag filter: should find all 3 blocks"
    );

    // Filter by TAG_X only — BLK_XY and BLK_X
    let tag_x = search_blocks_inner(
        &pool,
        "findme".into(),
        None,
        None,
        SearchFilter {
            tag_ids: vec!["TAG_X".into()],
            space_id: Some(TEST_SPACE_ID.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(tag_x.items.len(), 2, "TAG_X filter: should find 2 blocks");
    let ids: Vec<&str> = tag_x.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        ids.contains(&"BLK_XY"),
        "TAG_X filter should include BLK_XY"
    );
    assert!(ids.contains(&"BLK_X"), "TAG_X filter should include BLK_X");

    // Filter by both TAG_X and TAG_Y (ALL semantics) — only BLK_XY
    let tag_xy = search_blocks_inner(
        &pool,
        "findme".into(),
        None,
        None,
        SearchFilter {
            tag_ids: vec!["TAG_X".into(), "TAG_Y".into()],
            space_id: Some(TEST_SPACE_ID.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        tag_xy.items.len(),
        1,
        "TAG_X+TAG_Y filter: should find 1 block"
    );
    assert_eq!(tag_xy.items[0].id, "BLK_XY");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_without_filters() {
    let (pool, _dir) = test_pool().await;

    // Create blocks
    insert_block(
        &pool,
        "BLK_NF1",
        "content",
        "universal search term",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "BLK_NF2",
        "content",
        "universal search term too",
        None,
        Some(2),
    )
    .await;

    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    // No filters (backward compatible) — all matching results returned
    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "universal".into(),
        None,
        None,
        test_space_filter(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.items.len(),
        2,
        "no filters: should find all matching blocks"
    );

    // Empty tag_ids vec should be treated the same as None
    let result_empty_tags = search_blocks_inner(
        &pool,
        "universal".into(),
        None,
        None,
        SearchFilter {
            tag_ids: vec![],
            space_id: Some(TEST_SPACE_ID.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result_empty_tags.items.len(),
        2,
        "empty tag_ids: should find all matching blocks"
    );
}

// ======================================================================
// query_by_tags_inner
// ======================================================================

/// Helper: insert a tag_cache entry for command-level tests.
async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
    )
    .bind(tag_id)
    .bind(name)
    .bind(usage_count)
    .execute(pool)
    .await
    .unwrap();
}

/// Helper: associate a block with a tag.
async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_inner_empty_inputs_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let result = query_by_tags_inner(
        &pool,
        vec![],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();

    assert!(
        result.items.is_empty(),
        "empty tag inputs should return no items"
    );
    assert!(
        !result.has_more,
        "empty tag inputs should not have more results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_inner_or_mode_unions_tag_ids() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
    insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
    insert_block(&pool, "BLK_1", "content", "one", None, Some(1)).await;
    insert_block(&pool, "BLK_2", "content", "two", None, Some(2)).await;

    insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
    insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;

    let result = query_by_tags_inner(
        &pool,
        vec!["TAG_A".into(), "TAG_B".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "OR mode should return both tagged blocks"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_inner_and_mode_intersects_tag_ids() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
    insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
    insert_block(&pool, "BLK_1", "content", "both", None, Some(1)).await;
    insert_block(&pool, "BLK_2", "content", "only-a", None, Some(2)).await;

    insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
    insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
    insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;

    let result = query_by_tags_inner(
        &pool,
        vec!["TAG_A".into(), "TAG_B".into()],
        vec![],
        "and".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        1,
        "AND mode should return only block with both tags"
    );
    assert_eq!(
        result.items[0].id, "BLK_1",
        "block with both tags should be BLK_1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_inner_with_prefix() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
    insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;

    insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
    insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

    insert_block(&pool, "BLK_1", "content", "meeting notes", None, Some(1)).await;
    insert_block(&pool, "BLK_2", "content", "email draft", None, Some(2)).await;

    insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
    insert_tag_assoc(&pool, "BLK_2", "TAG_WE").await;

    let result = query_by_tags_inner(
        &pool,
        vec![],
        vec!["work/".into()],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "prefix query should match both work/ blocks"
    );
}

// ======================================================================
// query_by_property_inner
// ======================================================================

/// Helper: insert a property directly into the block_properties table.
async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_text)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "QP_B1", "content", "task 1", None, Some(1)).await;
    insert_block(&pool, "QP_B2", "content", "task 2", None, Some(2)).await;
    insert_block(&pool, "QP_B3", "content", "no prop", None, Some(3)).await;

    insert_property(&pool, "QP_B1", "todo", "TODO").await;
    insert_property(&pool, "QP_B2", "todo", "DONE").await;

    let result = query_by_property_inner(
        &pool,
        "todo".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.items.len(), 2, "both blocks with 'todo' property");
    assert_eq!(
        result.items[0].id, "QP_B1",
        "first matching block should be QP_B1"
    );
    assert_eq!(
        result.items[1].id, "QP_B2",
        "second matching block should be QP_B2"
    );
}

#[tokio::test]
async fn query_by_property_empty_key_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let result = query_by_property_inner(
        &pool,
        "".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty key must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_filters_by_value() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "QP_A", "content", "task a", None, Some(1)).await;
    insert_block(&pool, "QP_B", "content", "task b", None, Some(2)).await;

    insert_property(&pool, "QP_A", "todo", "TODO").await;
    insert_property(&pool, "QP_B", "todo", "DONE").await;

    let result = query_by_property_inner(
        &pool,
        "todo".into(),
        Some("TODO".into()),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.items.len(), 1, "only block with todo=TODO");
    assert_eq!(result.items[0].id, "QP_A", "only TODO block should match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_paginates_correctly() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let id = format!("QP_P{i:02}");
        insert_block(&pool, &id, "content", &format!("item {i}"), None, Some(i)).await;
        insert_property(&pool, &id, "status", "active").await;
    }

    // First page: limit 2
    let r1 = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        Some(2),
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(r1.items.len(), 2, "first page should have 2 items");
    assert!(r1.has_more, "first page should indicate more items");
    assert!(
        r1.next_cursor.is_some(),
        "first page should provide a cursor"
    );
    assert_eq!(
        r1.items[0].id, "QP_P01",
        "first page item 1 should be QP_P01"
    );
    assert_eq!(
        r1.items[1].id, "QP_P02",
        "first page item 2 should be QP_P02"
    );

    // Second page
    let r2 = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        r1.next_cursor,
        Some(2),
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(r2.items.len(), 2, "second page should have 2 items");
    assert!(r2.has_more, "second page should indicate more items");
    assert_eq!(
        r2.items[0].id, "QP_P03",
        "second page item 1 should be QP_P03"
    );
    assert_eq!(
        r2.items[1].id, "QP_P04",
        "second page item 2 should be QP_P04"
    );

    // Third page: last item
    let r3 = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        r2.next_cursor,
        Some(2),
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(r3.items.len(), 1, "last page should have 1 item");
    assert!(!r3.has_more, "last page should not have more items");
    assert!(r3.next_cursor.is_none(), "last page should have no cursor");
    assert_eq!(r3.items[0].id, "QP_P05", "last page item should be QP_P05");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_excludes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "QP_DEL", "content", "deleted", None, Some(1)).await;
    insert_property(&pool, "QP_DEL", "todo", "TODO").await;

    // Soft-delete the block
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = 'QP_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let result = query_by_property_inner(
        &pool,
        "todo".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(
        result.items.is_empty(),
        "deleted block must be excluded from query_by_property"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_reserved_date_key_filters_by_value_date() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create blocks with due_date set via set_due_date_inner
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task jun".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        b1.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task dec".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        b2.id.as_str().into(),
        Some("2025-12-31".into()),
    )
    .await
    .unwrap();

    // Query all blocks with due_date (no value filter)
    let all = query_by_property_inner(
        &pool,
        "due_date".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(all.items.len(), 2, "both blocks have due_date");

    // Query with specific date value
    let filtered = query_by_property_inner(
        &pool,
        "due_date".into(),
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(filtered.items.len(), 1, "only one block matches 2025-06-15");
    assert_eq!(
        filtered.items[0].id, b1.id,
        "filtered block should match the June due date"
    );

    mat.shutdown();
}

/// Helper: insert a property with a date value.
async fn insert_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_date)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_gt_operator() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_GT1", "content", "early", None, Some(1)).await;
    // OP_GT_BOUNDARY has deadline == threshold; gt must EXCLUDE it (distinguishes > from >=)
    insert_block(
        &pool,
        "OP_GT_BOUNDARY",
        "content",
        "boundary",
        None,
        Some(2),
    )
    .await;
    insert_block(&pool, "OP_GT2", "content", "middle", None, Some(3)).await;
    insert_block(&pool, "OP_GT3", "content", "late", None, Some(4)).await;

    insert_property_date(&pool, "OP_GT1", "deadline", "2025-01-01").await;
    insert_property_date(&pool, "OP_GT_BOUNDARY", "deadline", "2025-06-01").await;
    insert_property_date(&pool, "OP_GT2", "deadline", "2025-06-15").await;
    insert_property_date(&pool, "OP_GT3", "deadline", "2025-12-31").await;

    // Query blocks with deadline > "2025-06-01"
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        None,
        Some("2025-06-01".into()),
        Some("gt".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // OP_GT_BOUNDARY (deadline == threshold) must be excluded — this pin
    // distinguishes `>` from `>=`.
    assert_eq!(
        result.items.len(),
        2,
        "gt operator should return blocks with deadline strictly after 2025-06-01 (boundary excluded)"
    );
    assert_eq!(result.items[0].id, "OP_GT2", "first match is OP_GT2");
    assert_eq!(result.items[1].id, "OP_GT3", "second match is OP_GT3");
    assert!(
        result.items.iter().all(|b| b.id != "OP_GT_BOUNDARY"),
        "OP_GT_BOUNDARY (deadline == threshold) must NOT appear in gt results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_lt_operator() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_LT1", "content", "early", None, Some(1)).await;
    insert_block(&pool, "OP_LT2", "content", "middle", None, Some(2)).await;
    insert_block(&pool, "OP_LT3", "content", "late", None, Some(3)).await;

    insert_property_date(&pool, "OP_LT1", "deadline", "2025-01-01").await;
    insert_property_date(&pool, "OP_LT2", "deadline", "2025-06-15").await;
    insert_property_date(&pool, "OP_LT3", "deadline", "2025-12-31").await;

    // Query blocks with deadline < "2025-06-15"
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        None,
        Some("2025-06-15".into()),
        Some("lt".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        1,
        "lt operator should return blocks with deadline before 2025-06-15"
    );
    assert_eq!(
        result.items[0].id, "OP_LT1",
        "only OP_LT1 is before the cutoff"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_neq_operator() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_NEQ1", "content", "early", None, Some(1)).await;
    insert_block(&pool, "OP_NEQ2", "content", "middle", None, Some(2)).await;
    insert_block(&pool, "OP_NEQ3", "content", "late", None, Some(3)).await;

    insert_property_date(&pool, "OP_NEQ1", "deadline", "2025-01-01").await;
    insert_property_date(&pool, "OP_NEQ2", "deadline", "2025-06-15").await;
    insert_property_date(&pool, "OP_NEQ3", "deadline", "2025-12-31").await;

    // Query blocks with deadline != "2025-06-15"
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        None,
        Some("2025-06-15".into()),
        Some("neq".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "neq operator should return blocks with deadline not equal to 2025-06-15"
    );
    assert_eq!(result.items[0].id, "OP_NEQ1", "first match is OP_NEQ1");
    assert_eq!(result.items[1].id, "OP_NEQ3", "second match is OP_NEQ3");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_lte_operator() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_LTE1", "content", "early", None, Some(1)).await;
    insert_block(&pool, "OP_LTE2", "content", "middle", None, Some(2)).await;
    insert_block(&pool, "OP_LTE3", "content", "late", None, Some(3)).await;

    insert_property_date(&pool, "OP_LTE1", "deadline", "2025-01-01").await;
    insert_property_date(&pool, "OP_LTE2", "deadline", "2025-06-15").await;
    insert_property_date(&pool, "OP_LTE3", "deadline", "2025-12-31").await;

    // Query blocks with deadline <= "2025-06-15"
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        None,
        Some("2025-06-15".into()),
        Some("lte".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "lte operator should return blocks with deadline on or before 2025-06-15"
    );
    assert_eq!(result.items[0].id, "OP_LTE1", "first match is OP_LTE1");
    assert_eq!(result.items[1].id, "OP_LTE2", "second match is OP_LTE2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_gte_operator() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_GTE1", "content", "early", None, Some(1)).await;
    insert_block(&pool, "OP_GTE2", "content", "middle", None, Some(2)).await;
    insert_block(&pool, "OP_GTE3", "content", "late", None, Some(3)).await;

    insert_property_date(&pool, "OP_GTE1", "deadline", "2025-01-01").await;
    insert_property_date(&pool, "OP_GTE2", "deadline", "2025-06-15").await;
    insert_property_date(&pool, "OP_GTE3", "deadline", "2025-12-31").await;

    // Query blocks with deadline >= "2025-06-15"
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        None,
        Some("2025-06-15".into()),
        Some("gte".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "gte operator should return blocks with deadline on or after 2025-06-15"
    );
    assert_eq!(result.items[0].id, "OP_GTE2", "first match is OP_GTE2");
    assert_eq!(result.items[1].id, "OP_GTE3", "second match is OP_GTE3");
}

// #384 regression: neq must not drop rows whose value lives in the sibling (value_date) column
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_neq_sibling_column_regression_384() {
    let (pool, _dir) = test_pool().await;

    // OP_384_DATE: deadline stored in value_date column (value_text = NULL)
    insert_block(&pool, "OP_384_DATE", "content", "date-col", None, Some(1)).await;
    insert_property_date(&pool, "OP_384_DATE", "deadline", "2025-03-01").await;

    // OP_384_TEXT: deadline stored in value_text column (value_date = NULL)
    insert_block(&pool, "OP_384_TEXT", "content", "text-col", None, Some(2)).await;
    insert_property(&pool, "OP_384_TEXT", "deadline", "2025-06-15").await;

    // Query: deadline != "2025-06-15" using value_text parameter
    // OP_384_DATE has value_text = NULL → the null-sibling fix keeps it (IS NULL guard is TRUE)
    // OP_384_TEXT has value_text = "2025-06-15" → "2025-06-15" != "2025-06-15" = FALSE → excluded
    let result = query_by_property_inner(
        &pool,
        "deadline".into(),
        Some("2025-06-15".into()), // value_text
        None,                      // value_date
        Some("neq".into()),
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        1,
        "neq must preserve the row whose deadline lives in value_date (sibling column fix)"
    );
    assert_eq!(
        result.items[0].id, "OP_384_DATE",
        "the date-column row must be kept by the neq null-sibling guard"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_defaults_to_eq() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OP_EQ1", "content", "exact", None, Some(1)).await;
    insert_block(&pool, "OP_EQ2", "content", "other", None, Some(2)).await;

    insert_property(&pool, "OP_EQ1", "status", "active").await;
    insert_property(&pool, "OP_EQ2", "status", "inactive").await;

    // None operator should default to equality
    let result = query_by_property_inner(
        &pool,
        "status".into(),
        Some("active".into()),
        None,
        None, // operator = None → defaults to "eq"
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        1,
        "None operator must default to equality"
    );
    assert_eq!(
        result.items[0].id, "OP_EQ1",
        "only the 'active' block matches"
    );
}

// ======================================================================
// PEND-35 Tier 1.5 — query_by_property_inner exclude_parent_id +
// content_non_empty filters (DonePanel pagination correctness)
// ======================================================================
//
// The DonePanel used to drop blocks whose `parent_id == excludePageId`
// and blocks with empty content AFTER the cursor page returned, which
// made `total_count` and "Load more" disagree with the visible set.
// These tests pin the SQL push-down so the inner returns the
// post-filter rows directly.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_excludes_parent_id() {
    let (pool, _dir) = test_pool().await;

    // Three blocks share the same property; two sit under PARENT_X
    // (which the caller wants to hide), one under PARENT_Y (kept), one
    // with NULL parent (kept — `IS NOT` is NULL-safe so a parentless
    // block is never accidentally filtered).
    insert_block(&pool, "PARENT_X", "page", "X", None, None).await;
    insert_block(&pool, "PARENT_Y", "page", "Y", None, None).await;
    insert_block(&pool, "QPX_A", "content", "in X", Some("PARENT_X"), Some(1)).await;
    insert_block(&pool, "QPX_B", "content", "in X", Some("PARENT_X"), Some(2)).await;
    insert_block(&pool, "QPX_C", "content", "in Y", Some("PARENT_Y"), Some(3)).await;
    insert_block(&pool, "QPX_D", "content", "orphan", None, Some(4)).await;
    for id in &["QPX_A", "QPX_B", "QPX_C", "QPX_D"] {
        insert_property(&pool, id, "completed_at", "2026-05-08").await;
    }

    // Unfiltered baseline — all four come back.
    let unfiltered = query_by_property_inner(
        &pool,
        "completed_at".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        unfiltered.items.len(),
        4,
        "baseline must surface all four blocks; got {:?}",
        unfiltered.items.iter().map(|b| &b.id).collect::<Vec<_>>()
    );

    // Filtered — drop PARENT_X children, keep PARENT_Y child + orphan.
    let filtered = query_by_property_inner(
        &pool,
        "completed_at".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        Some("PARENT_X".into()),
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> =
        filtered.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["QPX_C", "QPX_D"].into_iter().collect(),
        "exclude_parent_id must drop only the PARENT_X children; \
         orphan (NULL parent) must survive the IS NOT comparison; \
         got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_content_non_empty() {
    let (pool, _dir) = test_pool().await;

    // Mix of content shapes — only "real text" should survive.
    // Note: SQLite stores NULL for `INSERT INTO blocks (..., content, ...) VALUES (?, NULL, ?)`,
    // and an empty string distinct from NULL for explicit ''. Whitespace-only
    // content (E) must also be dropped so the SQL push-down matches the
    // legacy FE predicate (`!b.content?.trim()`); without `TRIM(...)` in
    // the SQL clause, a row of "   " would silently survive.
    insert_block(&pool, "QPCNE_A", "content", "real text", None, Some(1)).await;
    insert_block(&pool, "QPCNE_B", "content", "", None, Some(2)).await;
    sqlx::query("UPDATE blocks SET content = NULL WHERE id = ?")
        .bind("QPCNE_B")
        .execute(&pool)
        .await
        .unwrap();
    insert_block(&pool, "QPCNE_C", "content", "", None, Some(3)).await;
    insert_block(&pool, "QPCNE_D", "content", "more", None, Some(4)).await;
    insert_block(&pool, "QPCNE_E", "content", "   \t\n", None, Some(5)).await;
    for id in &["QPCNE_A", "QPCNE_B", "QPCNE_C", "QPCNE_D", "QPCNE_E"] {
        insert_property(&pool, id, "completed_at", "2026-05-08").await;
    }

    // Disabled filter — all five come back (unfiltered parity).
    let unfiltered = query_by_property_inner(
        &pool,
        "completed_at".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(unfiltered.items.len(), 5, "filter disabled = no-op");

    // Enabled — drop NULL, empty-string, and whitespace-only content.
    let filtered = query_by_property_inner(
        &pool,
        "completed_at".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        true,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> =
        filtered.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["QPCNE_A", "QPCNE_D"].into_iter().collect(),
        "content_non_empty must drop NULL, '', and whitespace-only content; got {ids:?}"
    );
}

// ======================================================================
// PEND-35 Tier 3.4 — query_by_property_inner block_type +
// value_text_in + value_date_range push-downs
// ======================================================================
//
// These four tests pin the SQL push-downs added in Tier 3.4:
//
// 1. `block_type` — equality on `b.block_type` so callers can restrict
//    a property query to (e.g.) `block_type = 'page'` without an
//    FE-side `.filter()`.
// 2. `value_text_in` — set-membership over `bp.value_text`. Replaces
//    the per-value `queryByProperty` fan-out in `agenda-filters`.
// 3. `value_date_range` — half-open `[from, to)` range. The exclusive
//    upper bound is asserted explicitly: a row whose date equals `to`
//    must NOT be returned.
// 4. Mutual exclusion between `value_text` and `value_text_in` —
//    rejected at the boundary so the SQL evaluation has a single
//    precedence rule.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_filters_by_block_type() {
    let (pool, _dir) = test_pool().await;

    // Mix of block_types — only `page` rows should be returned.
    insert_block(&pool, "QPBT_PG1", "page", "page one", None, Some(1)).await;
    insert_block(&pool, "QPBT_PG2", "page", "page two", None, Some(2)).await;
    insert_block(&pool, "QPBT_CT1", "content", "content one", None, Some(3)).await;
    for id in &["QPBT_PG1", "QPBT_PG2", "QPBT_CT1"] {
        insert_property(&pool, id, "topic", "rust").await;
    }

    let unfiltered = query_by_property_inner(
        &pool,
        "topic".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(unfiltered.items.len(), 3, "baseline returns all three");

    let pages_only = query_by_property_inner(
        &pool,
        "topic".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        Some("page".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> =
        pages_only.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["QPBT_PG1", "QPBT_PG2"].into_iter().collect(),
        "block_type='page' must drop the content row; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_value_text_in() {
    let (pool, _dir) = test_pool().await;

    // Three blocks with property `status` set to "a"/"b"/"c". A
    // `value_text_in = ["a","c"]` query must return exactly 2 rows.
    insert_block(&pool, "QPVI_A", "content", "a", None, Some(1)).await;
    insert_block(&pool, "QPVI_B", "content", "b", None, Some(2)).await;
    insert_block(&pool, "QPVI_C", "content", "c", None, Some(3)).await;
    insert_property(&pool, "QPVI_A", "status", "a").await;
    insert_property(&pool, "QPVI_B", "status", "b").await;
    insert_property(&pool, "QPVI_C", "status", "c").await;

    let result = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        Some(vec!["a".into(), "c".into()]),
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["QPVI_A", "QPVI_C"].into_iter().collect(),
        "value_text_in must surface only matching values; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_value_date_range() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three blocks with `due_date` (reserved key path):
    //   - 2026-01-01 (lower bound, INCLUDED)
    //   - 2026-01-15 (interior, INCLUDED)
    //   - 2026-02-01 (upper bound, EXCLUDED — half-open semantic)
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task jan 1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        b1.id.as_str().into(),
        Some("2026-01-01".into()),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task jan 15".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        b2.id.as_str().into(),
        Some("2026-01-15".into()),
    )
    .await
    .unwrap();
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task feb 1".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        b3.id.as_str().into(),
        Some("2026-02-01".into()),
    )
    .await
    .unwrap();

    let result = query_by_property_inner(
        &pool,
        "due_date".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        Some(("2026-01-01".into(), "2026-02-01".into())),
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        [b1.id.as_str(), b2.id.as_str()].into_iter().collect(),
        "value_date_range must include `from` and EXCLUDE `to` \
         (half-open [from, to)); got {ids:?}"
    );

    mat.shutdown();
}

#[tokio::test]
async fn query_by_property_value_text_in_rejects_with_value_text() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "QPVR_A", "content", "task", None, Some(1)).await;
    insert_property(&pool, "QPVR_A", "status", "a").await;

    let err = query_by_property_inner(
        &pool,
        "status".into(),
        Some("a".into()),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        Some(vec!["a".into()]),
        None,
    )
    .await
    .expect_err("value_text + value_text_in must be rejected");
    match err {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("value_text_in") && msg.contains("value_text"),
                "validation message must name both inputs; got {msg:?}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

// ======================================================================
// PEND-35 Tier 3.4 — query_by_tags_inner block_type push-down
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_filters_by_block_type() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "QTBT_TAG", "tag", "atag", None, None).await;
    insert_block(&pool, "QTBT_PG1", "page", "page one", None, Some(1)).await;
    insert_block(&pool, "QTBT_PG2", "page", "page two", None, Some(2)).await;
    insert_block(&pool, "QTBT_CT1", "content", "content one", None, Some(3)).await;
    insert_tag_assoc(&pool, "QTBT_PG1", "QTBT_TAG").await;
    insert_tag_assoc(&pool, "QTBT_PG2", "QTBT_TAG").await;
    insert_tag_assoc(&pool, "QTBT_CT1", "QTBT_TAG").await;

    // Baseline — all three tagged blocks come back.
    let unfiltered = query_by_tags_inner(
        &pool,
        vec!["QTBT_TAG".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        unfiltered.items.len(),
        3,
        "baseline must return all three tagged blocks"
    );

    // Filter to block_type='page' — drops the content row.
    let pages_only = query_by_tags_inner(
        &pool,
        vec!["QTBT_TAG".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        Some("page".into()),
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> =
        pages_only.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["QTBT_PG1", "QTBT_PG2"].into_iter().collect(),
        "block_type='page' must drop the content row; got {ids:?}"
    );
}

// ======================================================================
// count_backlinks_batch
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_empty_page_ids_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let result = count_backlinks_batch_inner(&pool, vec![], &SpaceScope::Global)
        .await
        .unwrap();
    assert!(
        result.is_empty(),
        "empty page_ids input should return empty map"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_returns_correct_counts() {
    let (pool, _dir) = test_pool().await;

    // Target pages
    insert_block(&pool, "BLB_TGT1", "page", "target 1", None, None).await;
    insert_block(&pool, "BLB_TGT2", "page", "target 2", None, None).await;
    // Source blocks
    insert_block(&pool, "BLB_SRC1", "content", "src 1", None, None).await;
    insert_block(&pool, "BLB_SRC2", "content", "src 2", None, None).await;
    insert_block(&pool, "BLB_SRC3", "content", "src 3", None, None).await;

    // 2 links to TGT1, 1 link to TGT2
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLB_SRC1")
        .bind("BLB_TGT1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLB_SRC2")
        .bind("BLB_TGT1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLB_SRC3")
        .bind("BLB_TGT2")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_backlinks_batch_inner(
        &pool,
        vec!["BLB_TGT1".into(), "BLB_TGT2".into(), "NONEXISTENT".into()],
        &SpaceScope::Global,
    )
    .await
    .unwrap();

    assert_eq!(
        result.get("BLB_TGT1"),
        Some(&2),
        "BLB_TGT1 should have 2 backlinks"
    );
    assert_eq!(
        result.get("BLB_TGT2"),
        Some(&1),
        "BLB_TGT2 should have 1 backlink"
    );
    assert_eq!(
        result.get("NONEXISTENT"),
        None,
        "page with no backlinks should not appear in result"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_excludes_deleted_source_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLD_TGT", "page", "target", None, None).await;
    insert_block(&pool, "BLD_LIVE", "content", "live src", None, None).await;
    insert_block(&pool, "BLD_DEL", "content", "deleted src", None, None).await;

    // Soft-delete BLD_DEL
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = ?")
        .bind("BLD_DEL")
        .execute(&pool)
        .await
        .unwrap();

    // Both link to the same target
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLD_LIVE")
        .bind("BLD_TGT")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLD_DEL")
        .bind("BLD_TGT")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_backlinks_batch_inner(&pool, vec!["BLD_TGT".into()], &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(
        result.get("BLD_TGT"),
        Some(&1),
        "only the live source block should be counted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_single_id_returns_expected_count() {
    // Regression test for PERF-17: json_each conversion preserves single-ID semantics.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SNG_TGT", "page", "target", None, None).await;
    insert_block(&pool, "SNG_SRC1", "content", "src1", None, None).await;
    insert_block(&pool, "SNG_SRC2", "content", "src2", None, None).await;
    insert_block(&pool, "SNG_SRC3", "content", "src3", None, None).await;

    for src in ["SNG_SRC1", "SNG_SRC2", "SNG_SRC3"] {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind("SNG_TGT")
            .execute(&pool)
            .await
            .unwrap();
    }

    let result = count_backlinks_batch_inner(&pool, vec!["SNG_TGT".into()], &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(result.len(), 1, "result must contain exactly one entry");
    assert_eq!(
        result.get("SNG_TGT"),
        Some(&3),
        "single ID must return correct count"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_large_input_beyond_sqlite_param_limit() {
    // Regression test for PERF-17: json_each avoids the SQLite ~999 bind-parameter
    // limit that the old `IN (?, ?, …)` format-string approach hit at scale.
    let (pool, _dir) = test_pool().await;

    // Seed 3 real target pages with backlinks, then request counts for 1200 IDs.
    insert_block(&pool, "BIG_TGT1", "page", "target 1", None, None).await;
    insert_block(&pool, "BIG_TGT2", "page", "target 2", None, None).await;
    insert_block(&pool, "BIG_SRC1", "content", "src 1", None, None).await;
    insert_block(&pool, "BIG_SRC2", "content", "src 2", None, None).await;

    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BIG_SRC1")
        .bind("BIG_TGT1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BIG_SRC2")
        .bind("BIG_TGT1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BIG_SRC1")
        .bind("BIG_TGT2")
        .execute(&pool)
        .await
        .unwrap();

    let mut ids: Vec<String> = (0..1200).map(|i| format!("MISSING_{i:04}")).collect();
    ids.push("BIG_TGT1".into());
    ids.push("BIG_TGT2".into());

    let result = count_backlinks_batch_inner(
        &pool,
        ids.into_iter()
            .map(Into::into)
            .collect::<Vec<crate::ulid::PageId>>(),
        &SpaceScope::Global,
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 2, "only two IDs have backlinks");
    assert_eq!(result.get("BIG_TGT1"), Some(&2), "BIG_TGT1 has 2 backlinks");
    assert_eq!(result.get("BIG_TGT2"), Some(&1), "BIG_TGT2 has 1 backlink");
}

// ----------------------------------------------------------------------
// PEND-35 Tier 1.6 — `count_backlinks_batch_inner` honours `&SpaceScope`
// ----------------------------------------------------------------------
//
// Without space-scoping a page in space A could surface a non-zero
// badge count whose source blocks live in space B — backlinks the user
// can't actually see. This test seeds two pages, each with a backlink
// from each space, and asserts:
//   - Active(A) sees only the A-source backlink.
//   - Active(B) sees only the B-source backlink.
//   - Global counts both (parity with the pre-PEND-35 behaviour).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_active_scope() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Two target pages — one in each space.
    insert_block(&pool, "PG_A", "page", "page A", None, None).await;
    assign_to_space(&pool, "PG_A", TEST_SPACE_ID).await;
    insert_block(&pool, "PG_B", "page", "page B", None, None).await;
    assign_to_space(&pool, "PG_B", TEST_SPACE_B_ID).await;

    // Source blocks — one per space, each linking to BOTH targets.
    insert_block(&pool, "SRC_A", "content", "src in A", None, None).await;
    assign_to_space(&pool, "SRC_A", TEST_SPACE_ID).await;
    insert_block(&pool, "SRC_B", "content", "src in B", None, None).await;
    assign_to_space(&pool, "SRC_B", TEST_SPACE_B_ID).await;

    for (src, tgt) in [
        ("SRC_A", "PG_A"),
        ("SRC_A", "PG_B"),
        ("SRC_B", "PG_A"),
        ("SRC_B", "PG_B"),
    ] {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }

    let page_ids = vec!["PG_A".to_string(), "PG_B".to_string()];

    // Global — every backlink counted regardless of space.
    let global = count_backlinks_batch_inner(
        &pool,
        page_ids
            .clone()
            .into_iter()
            .map(Into::into)
            .collect::<Vec<crate::ulid::PageId>>(),
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    assert_eq!(global.get("PG_A"), Some(&2), "Global counts both sources");
    assert_eq!(global.get("PG_B"), Some(&2), "Global counts both sources");

    // Active(A) — only SRC_A's links are visible.
    let active_a = count_backlinks_batch_inner(
        &pool,
        page_ids
            .clone()
            .into_iter()
            .map(Into::into)
            .collect::<Vec<crate::ulid::PageId>>(),
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        active_a.get("PG_A"),
        Some(&1),
        "Active(A) drops the SRC_B → PG_A backlink"
    );
    assert_eq!(
        active_a.get("PG_B"),
        Some(&1),
        "Active(A) drops the SRC_B → PG_B backlink"
    );

    // Active(B) — only SRC_B's links are visible.
    let active_b = count_backlinks_batch_inner(
        &pool,
        page_ids
            .into_iter()
            .map(Into::into)
            .collect::<Vec<crate::ulid::PageId>>(),
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        active_b.get("PG_A"),
        Some(&1),
        "Active(B) drops the SRC_A → PG_A backlink"
    );
    assert_eq!(
        active_b.get("PG_B"),
        Some(&1),
        "Active(B) drops the SRC_A → PG_B backlink"
    );
}

// ======================================================================
// FEAT-3p4 — space scoping for query_by_tags_inner
// ======================================================================
//
// These tests cover the `Some(space_id)` branch of `query_by_tags_inner`
// so the `(? IS NULL OR COALESCE(b.page_id, b.id) IN (...))` clause
// added to `tag_query::eval_tag_query`'s final projection is verified
// end-to-end. Tags themselves are never assigned to a space (they are
// global by design); the filter applies to the resulting blocks.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "TAG_X", "tag", "x", None, None).await;

    insert_block(&pool, "QT_A1", "content", "task A1", None, None).await;
    insert_tag_assoc(&pool, "QT_A1", "TAG_X").await;
    assign_to_space(&pool, "QT_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QT_B1", "content", "task B1", None, None).await;
    insert_tag_assoc(&pool, "QT_B1", "TAG_X").await;
    assign_to_space(&pool, "QT_B1", TEST_SPACE_B_ID).await;

    let result = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["QT_A1"],
        "space A filter must surface exactly QT_A1; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "TAG_X", "tag", "x", None, None).await;

    insert_block(&pool, "QT_A1", "content", "task A1", None, None).await;
    insert_tag_assoc(&pool, "QT_A1", "TAG_X").await;
    assign_to_space(&pool, "QT_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QT_B1", "content", "task B1", None, None).await;
    insert_tag_assoc(&pool, "QT_B1", "TAG_X").await;
    assign_to_space(&pool, "QT_B1", TEST_SPACE_B_ID).await;

    let result = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        ids.contains("QT_A1"),
        "None must include QT_A1; got {ids:?}"
    );
    assert!(
        ids.contains("QT_B1"),
        "None must include QT_B1; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(&pool, "TAG_X", "tag", "x", None, None).await;
    insert_block(&pool, "QT_A1", "content", "task A1", None, None).await;
    insert_tag_assoc(&pool, "QT_A1", "TAG_X").await;
    assign_to_space(&pool, "QT_A1", TEST_SPACE_ID).await;

    let result = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("DOES_NOT_EXIST")),
        None,
    )
    .await
    .unwrap();
    assert!(
        result.items.is_empty(),
        "nonexistent space must return zero rows; got {} items",
        result.items.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "TAG_X", "tag", "x", None, None).await;

    for id in &["QT_A1", "QT_A2", "QT_A3"] {
        insert_block(&pool, id, "content", "a task", None, None).await;
        insert_tag_assoc(&pool, id, "TAG_X").await;
        assign_to_space(&pool, id, TEST_SPACE_ID).await;
    }
    for id in &["QT_B1", "QT_B2"] {
        insert_block(&pool, id, "content", "b task", None, None).await;
        insert_tag_assoc(&pool, id, "TAG_X").await;
        assign_to_space(&pool, id, TEST_SPACE_B_ID).await;
    }

    let a = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    let b = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
    )
    .await
    .unwrap();
    let a_ids: std::collections::HashSet<&str> = a.items.iter().map(|b| b.id.as_str()).collect();
    let b_ids: std::collections::HashSet<&str> = b.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        a_ids.is_disjoint(&b_ids),
        "query_by_tags scoped to disjoint spaces must produce disjoint sets; \
         intersection = {:?}",
        a_ids.intersection(&b_ids).collect::<Vec<_>>()
    );
    assert_eq!(a_ids.len(), 3);
    assert_eq!(b_ids.len(), 2);
}

// PEND-18 Phase 2 — parity test: `&SpaceScope::Global` reproduces the
// pre-migration `space_id: None` behaviour bit-for-bit. Fixtures span
// two spaces; the global query must return the union of every block in
// the universe (i.e. no `block_properties.space` filter is applied at
// the SQL level). The old shape passed `None` as the trailing
// parameter; `as_filter_param()` returns `None` for `Global`, so the
// SQL `(? IS NULL OR ...)` short-circuit is identical.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_tags_inner_global_matches_legacy_none_pend18() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "TAG_X", "tag", "x", None, None).await;

    insert_block(&pool, "QT_A1", "content", "task A1", None, None).await;
    insert_tag_assoc(&pool, "QT_A1", "TAG_X").await;
    assign_to_space(&pool, "QT_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QT_B1", "content", "task B1", None, None).await;
    insert_tag_assoc(&pool, "QT_B1", "TAG_X").await;
    assign_to_space(&pool, "QT_B1", TEST_SPACE_B_ID).await;

    // Global scope: must surface blocks from BOTH spaces — exactly
    // what `space_id: None` did pre-migration.
    let global = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();
    let global_ids: std::collections::HashSet<&str> =
        global.items.iter().map(|b| b.id.as_str()).collect();
    assert!(global_ids.contains("QT_A1"));
    assert!(global_ids.contains("QT_B1"));
    assert_eq!(global_ids.len(), 2, "Global must span both spaces");

    // Active(A) and Active(B) must be the disjoint partition; their
    // union equals the Global result.
    let scope_a = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    let scope_b = query_by_tags_inner(
        &pool,
        vec!["TAG_X".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
    )
    .await
    .unwrap();
    let mut union: std::collections::HashSet<&str> =
        scope_a.items.iter().map(|b| b.id.as_str()).collect();
    union.extend(scope_b.items.iter().map(|b| b.id.as_str()));
    assert_eq!(
        union, global_ids,
        "Global ≡ Active(A) ∪ Active(B); confirms `as_filter_param()` \
         on Global produces the same `NULL` SQL bind as legacy `None`"
    );
}

// ======================================================================
// FEAT-3p4 — space scoping for query_by_property_inner
// ======================================================================
//
// These tests cover both routing branches: the reserved-column branch
// (`todo_state`, exercised via `assert_..._feat3p4` for the four reserved
// keys) and the non-reserved property branch (`status`). Both apply the
// same `(?N IS NULL OR COALESCE(b.page_id, b.id) IN (...))` clause; the
// reserved branch test pins the column-routed SELECT, the non-reserved
// branch test pins the JOIN form.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Non-reserved property `status`.
    insert_block(&pool, "QP_A1", "content", "a", None, None).await;
    insert_property(&pool, "QP_A1", "status", "open").await;
    assign_to_space(&pool, "QP_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QP_B1", "content", "b", None, None).await;
    insert_property(&pool, "QP_B1", "status", "open").await;
    assign_to_space(&pool, "QP_B1", TEST_SPACE_B_ID).await;

    let result = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["QP_A1"],
        "space A filter must surface exactly QP_A1; got {ids:?}"
    );

    // Reserved-column branch — `todo_state` lives on `blocks` directly.
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind("QP_A1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind("QP_B1")
        .execute(&pool)
        .await
        .unwrap();
    let result_reserved = query_by_property_inner(
        &pool,
        "todo_state".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let ids_reserved: Vec<&str> = result_reserved
        .items
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert_eq!(
        ids_reserved,
        vec!["QP_A1"],
        "reserved-column branch must also honour space filter; got {ids_reserved:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "QP_A1", "content", "a", None, None).await;
    insert_property(&pool, "QP_A1", "status", "open").await;
    assign_to_space(&pool, "QP_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QP_B1", "content", "b", None, None).await;
    insert_property(&pool, "QP_B1", "status", "open").await;
    assign_to_space(&pool, "QP_B1", TEST_SPACE_B_ID).await;

    let result = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains("QP_A1"));
    assert!(ids.contains("QP_B1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(&pool, "QP_A1", "content", "a", None, None).await;
    insert_property(&pool, "QP_A1", "status", "open").await;
    assign_to_space(&pool, "QP_A1", TEST_SPACE_ID).await;

    let result = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("DOES_NOT_EXIST")),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        result.items.is_empty(),
        "nonexistent space must return zero rows; got {} items",
        result.items.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    for id in &["QP_A1", "QP_A2", "QP_A3"] {
        insert_block(&pool, id, "content", "a", None, None).await;
        insert_property(&pool, id, "status", "open").await;
        assign_to_space(&pool, id, TEST_SPACE_ID).await;
    }
    for id in &["QP_B1", "QP_B2"] {
        insert_block(&pool, id, "content", "b", None, None).await;
        insert_property(&pool, id, "status", "open").await;
        assign_to_space(&pool, id, TEST_SPACE_B_ID).await;
    }

    let a = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let b = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let a_ids: std::collections::HashSet<&str> = a.items.iter().map(|b| b.id.as_str()).collect();
    let b_ids: std::collections::HashSet<&str> = b.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        a_ids.is_disjoint(&b_ids),
        "query_by_property scoped to disjoint spaces must produce \
         disjoint sets; intersection = {:?}",
        a_ids.intersection(&b_ids).collect::<Vec<_>>()
    );
    assert_eq!(a_ids.len(), 3);
    assert_eq!(b_ids.len(), 2);
}

// ----------------------------------------------------------------------
// PEND-18 Phase 2 parity test — `&SpaceScope::Global` is byte-equivalent
// to the pre-migration `None` shape, and `&SpaceScope::Active(_)` to
// `Some(_)`. Asserted on `query_by_property_inner` because it is the
// largest fan-in `_inner` in the queries domain (18 test call sites,
// covers reserved-column + non-reserved-column + value/operator
// branches). Seeds fixtures spanning two spaces and verifies:
//   - Global == union(Active(A), Active(B))
//   - Active(A) is the A-only subset
//   - Active(A) ∩ Active(B) is empty
// ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_global_equals_union_of_actives_pend18_parity() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Seed three blocks in space A and two in space B, all carrying the
    // same `status=open` property so the post-filter universe is the
    // five-block union.
    for id in &["PEND18_A1", "PEND18_A2", "PEND18_A3"] {
        insert_block(&pool, id, "content", "a", None, None).await;
        insert_property(&pool, id, "status", "open").await;
        assign_to_space(&pool, id, TEST_SPACE_ID).await;
    }
    for id in &["PEND18_B1", "PEND18_B2"] {
        insert_block(&pool, id, "content", "b", None, None).await;
        insert_property(&pool, id, "status", "open").await;
        assign_to_space(&pool, id, TEST_SPACE_B_ID).await;
    }

    let global = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let active_a = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let active_b = query_by_property_inner(
        &pool,
        "status".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let global_ids: std::collections::HashSet<&str> =
        global.items.iter().map(|b| b.id.as_str()).collect();
    let a_ids: std::collections::HashSet<&str> =
        active_a.items.iter().map(|b| b.id.as_str()).collect();
    let b_ids: std::collections::HashSet<&str> =
        active_b.items.iter().map(|b| b.id.as_str()).collect();

    // Active(A) is the A-only subset; Active(B) is the B-only subset.
    assert_eq!(
        a_ids,
        ["PEND18_A1", "PEND18_A2", "PEND18_A3"]
            .into_iter()
            .collect(),
        "Active(A) must surface exactly the A-side blocks; got {a_ids:?}"
    );
    assert_eq!(
        b_ids,
        ["PEND18_B1", "PEND18_B2"].into_iter().collect(),
        "Active(B) must surface exactly the B-side blocks; got {b_ids:?}"
    );

    // The two scoped result sets are disjoint.
    assert!(
        a_ids.is_disjoint(&b_ids),
        "Active(A) ∩ Active(B) must be empty; intersection = {:?}",
        a_ids.intersection(&b_ids).collect::<Vec<_>>()
    );

    // Global == union(Active(A), Active(B)) — the parity invariant.
    let union: std::collections::HashSet<&str> = a_ids.union(&b_ids).copied().collect();
    assert_eq!(
        global_ids, union,
        "Global must equal union(Active(A), Active(B)); \
         global = {global_ids:?}, union = {union:?}"
    );
}

// ======================================================================
// FEAT-3p4 — space scoping for backlink read-side commands
// ======================================================================
//
// Helper: insert a directed `block_links(source_id -> target_id)` row.
async fn insert_link(pool: &sqlx::SqlitePool, source_id: &str, target_id: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source_id)
        .bind(target_id)
        .execute(pool)
        .await
        .unwrap();
}

// ----------------------------------------------------------------------
// get_backlinks_inner — pagination::list_backlinks shared filter
// ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "GBL_TGT", "page", "target", None, None).await;

    insert_block(&pool, "GBL_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "GBL_A1", "GBL_TGT").await;
    assign_to_space(&pool, "GBL_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "GBL_B1", "content", "src B1", None, None).await;
    insert_link(&pool, "GBL_B1", "GBL_TGT").await;
    assign_to_space(&pool, "GBL_B1", TEST_SPACE_B_ID).await;

    let resp = get_backlinks_inner(
        &pool,
        "GBL_TGT".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["GBL_A1"],
        "space A scope must surface exactly GBL_A1; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "GBL_TGT", "page", "target", None, None).await;

    insert_block(&pool, "GBL_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "GBL_A1", "GBL_TGT").await;
    assign_to_space(&pool, "GBL_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "GBL_B1", "content", "src B1", None, None).await;
    insert_link(&pool, "GBL_B1", "GBL_TGT").await;
    assign_to_space(&pool, "GBL_B1", TEST_SPACE_B_ID).await;

    let resp = get_backlinks_inner(&pool, "GBL_TGT".into(), None, None, &SpaceScope::Global)
        .await
        .unwrap();
    let ids: std::collections::HashSet<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains("GBL_A1"));
    assert!(ids.contains("GBL_B1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(&pool, "GBL_TGT", "page", "target", None, None).await;
    insert_block(&pool, "GBL_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "GBL_A1", "GBL_TGT").await;
    assign_to_space(&pool, "GBL_A1", TEST_SPACE_ID).await;

    let resp = get_backlinks_inner(
        &pool,
        "GBL_TGT".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("01NONEXISTENT0000000000000")),
    )
    .await
    .unwrap();
    assert!(resp.items.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "GBL_TGT", "page", "target", None, None).await;

    for id in &["GBL_A1", "GBL_A2", "GBL_A3"] {
        insert_block(&pool, id, "content", "a", None, None).await;
        insert_link(&pool, id, "GBL_TGT").await;
        assign_to_space(&pool, id, TEST_SPACE_ID).await;
    }
    for id in &["GBL_B1", "GBL_B2"] {
        insert_block(&pool, id, "content", "b", None, None).await;
        insert_link(&pool, id, "GBL_TGT").await;
        assign_to_space(&pool, id, TEST_SPACE_B_ID).await;
    }

    let a = get_backlinks_inner(
        &pool,
        "GBL_TGT".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let b = get_backlinks_inner(
        &pool,
        "GBL_TGT".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    let unscoped = get_backlinks_inner(&pool, "GBL_TGT".into(), None, None, &SpaceScope::Global)
        .await
        .unwrap();
    let a_ids: std::collections::HashSet<&str> = a.items.iter().map(|b| b.id.as_str()).collect();
    let b_ids: std::collections::HashSet<&str> = b.items.iter().map(|b| b.id.as_str()).collect();
    let u_ids: std::collections::HashSet<&str> =
        unscoped.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        a_ids.is_disjoint(&b_ids),
        "scoped result sets must be disjoint; intersection = {:?}",
        a_ids.intersection(&b_ids).collect::<Vec<_>>()
    );
    let union: std::collections::HashSet<&str> = a_ids.union(&b_ids).copied().collect();
    assert_eq!(
        union, u_ids,
        "A ∪ B must equal the unscoped result set; \
         A = {a_ids:?}, B = {b_ids:?}, U = {u_ids:?}"
    );
    assert_eq!(a_ids.len(), 3);
    assert_eq!(b_ids.len(), 2);
}

// ----------------------------------------------------------------------
// query_backlinks_filtered_inner — base-set space filter
// ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_backlinks_filtered_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "QBF_TGT", "page", "target", None, None).await;

    insert_block(&pool, "QBF_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "QBF_A1", "QBF_TGT").await;
    assign_to_space(&pool, "QBF_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QBF_B1", "content", "src B1", None, None).await;
    insert_link(&pool, "QBF_B1", "QBF_TGT").await;
    assign_to_space(&pool, "QBF_B1", TEST_SPACE_B_ID).await;

    let resp = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["QBF_A1"],
        "space A scope must surface exactly QBF_A1; got {ids:?}"
    );
    assert_eq!(
        resp.total_count, 1,
        "total_count must reflect the post-space-filter universe"
    );
    assert_eq!(resp.filtered_count, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_backlinks_filtered_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "QBF_TGT", "page", "target", None, None).await;

    insert_block(&pool, "QBF_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "QBF_A1", "QBF_TGT").await;
    assign_to_space(&pool, "QBF_A1", TEST_SPACE_ID).await;

    insert_block(&pool, "QBF_B1", "content", "src B1", None, None).await;
    insert_link(&pool, "QBF_B1", "QBF_TGT").await;
    assign_to_space(&pool, "QBF_B1", TEST_SPACE_B_ID).await;

    let resp = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains("QBF_A1"));
    assert!(ids.contains("QBF_B1"));
    assert_eq!(resp.total_count, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_backlinks_filtered_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(&pool, "QBF_TGT", "page", "target", None, None).await;
    insert_block(&pool, "QBF_A1", "content", "src A1", None, None).await;
    insert_link(&pool, "QBF_A1", "QBF_TGT").await;
    assign_to_space(&pool, "QBF_A1", TEST_SPACE_ID).await;

    let resp = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("01NONEXISTENT0000000000000")),
    )
    .await
    .unwrap();
    assert!(resp.items.is_empty());
    assert_eq!(resp.total_count, 0);
    assert_eq!(resp.filtered_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_backlinks_filtered_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "QBF_TGT", "page", "target", None, None).await;

    for id in &["QBF_A1", "QBF_A2", "QBF_A3"] {
        insert_block(&pool, id, "content", "a", None, None).await;
        insert_link(&pool, id, "QBF_TGT").await;
        assign_to_space(&pool, id, TEST_SPACE_ID).await;
    }
    for id in &["QBF_B1", "QBF_B2"] {
        insert_block(&pool, id, "content", "b", None, None).await;
        insert_link(&pool, id, "QBF_TGT").await;
        assign_to_space(&pool, id, TEST_SPACE_B_ID).await;
    }

    let a = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let b = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    let unscoped = query_backlinks_filtered_inner(
        &pool,
        "QBF_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let a_ids: std::collections::HashSet<&str> = a.items.iter().map(|b| b.id.as_str()).collect();
    let b_ids: std::collections::HashSet<&str> = b.items.iter().map(|b| b.id.as_str()).collect();
    let u_ids: std::collections::HashSet<&str> =
        unscoped.items.iter().map(|b| b.id.as_str()).collect();
    assert!(a_ids.is_disjoint(&b_ids));
    let union: std::collections::HashSet<&str> = a_ids.union(&b_ids).copied().collect();
    assert_eq!(union, u_ids);
    assert_eq!(a_ids.len(), 3);
    assert_eq!(b_ids.len(), 2);
}

// ----------------------------------------------------------------------
// list_backlinks_grouped_inner — grouped base-set space filter
// ----------------------------------------------------------------------
//
// The grouped path resolves each source block to its OWN root page and
// then drops same-page self-references. To exercise the space filter
// cleanly we put each source under its own page, and put the target on
// a third page so no source-target pair shares a root.

/// Insert a "child block under page" pair: page is created at the root,
/// then `child_id` is inserted with `parent_id = page_id` and `page_id =
/// page_id` so the denormalized root-page resolver returns `page_id`.
async fn seed_block_under_page(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    page_title: &str,
    child_id: &str,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, NULL, NULL)",
    )
    .bind(page_id)
    .bind(page_title)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'content', 'src', ?, 0, ?)",
    )
    .bind(child_id)
    .bind(page_id)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_grouped_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Target page lives on its own dedicated page so no source's root
    // matches it (avoids same-page self-ref drop).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LBG_TGT', 'page', 'tgt', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();

    seed_block_under_page(&pool, "LBG_PA", "page A", "LBG_SRC_A1").await;
    insert_link(&pool, "LBG_SRC_A1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LBG_PB", "page B", "LBG_SRC_B1").await;
    insert_link(&pool, "LBG_SRC_B1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PB", TEST_SPACE_B_ID).await;

    let resp = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let block_ids: Vec<&str> = resp
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert_eq!(
        block_ids,
        vec!["LBG_SRC_A1"],
        "space A scope must surface exactly LBG_SRC_A1; got {block_ids:?}"
    );
    assert_eq!(resp.total_count, 1);
    assert_eq!(resp.filtered_count, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_grouped_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LBG_TGT', 'page', 'tgt', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();

    seed_block_under_page(&pool, "LBG_PA", "page A", "LBG_SRC_A1").await;
    insert_link(&pool, "LBG_SRC_A1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LBG_PB", "page B", "LBG_SRC_B1").await;
    insert_link(&pool, "LBG_SRC_B1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PB", TEST_SPACE_B_ID).await;

    let resp = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = resp
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert!(ids.contains("LBG_SRC_A1"));
    assert!(ids.contains("LBG_SRC_B1"));
    assert_eq!(resp.total_count, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_grouped_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LBG_TGT', 'page', 'tgt', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_block_under_page(&pool, "LBG_PA", "page A", "LBG_SRC_A1").await;
    insert_link(&pool, "LBG_SRC_A1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PA", TEST_SPACE_ID).await;

    let resp = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("01NONEXISTENT0000000000000")),
    )
    .await
    .unwrap();
    assert!(resp.groups.is_empty());
    assert_eq!(resp.total_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_grouped_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LBG_TGT', 'page', 'tgt', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Each source page hosts multiple sources to broaden the test.
    seed_block_under_page(&pool, "LBG_PA", "page A", "LBG_SRC_A1").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LBG_SRC_A2', 'content', 'src', 'LBG_PA', 1, 'LBG_PA')",
    )
    .execute(&pool)
    .await
    .unwrap();
    insert_link(&pool, "LBG_SRC_A1", "LBG_TGT").await;
    insert_link(&pool, "LBG_SRC_A2", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LBG_PB", "page B", "LBG_SRC_B1").await;
    insert_link(&pool, "LBG_SRC_B1", "LBG_TGT").await;
    assign_to_space(&pool, "LBG_PB", TEST_SPACE_B_ID).await;

    let a = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let b = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    let unscoped = list_backlinks_grouped_inner(
        &pool,
        "LBG_TGT".into(),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let collect_ids = |resp: &crate::backlink::GroupedBacklinkResponse| {
        resp.groups
            .iter()
            .flat_map(|g| g.blocks.iter().map(|b| -> String { b.id.as_str().into() }))
            .collect::<std::collections::HashSet<_>>()
    };
    let a_ids = collect_ids(&a);
    let b_ids = collect_ids(&b);
    let u_ids = collect_ids(&unscoped);
    assert!(a_ids.is_disjoint(&b_ids));
    let union: std::collections::HashSet<String> = a_ids.union(&b_ids).cloned().collect();
    assert_eq!(union, u_ids);
    assert_eq!(a_ids.len(), 2);
    assert_eq!(b_ids.len(), 1);
}

// ----------------------------------------------------------------------
// list_unlinked_references_inner — FTS base-set space filter
// ----------------------------------------------------------------------
//
// We build a target page whose title is a unique tokenizable string,
// then create source blocks (under their own pages) that mention the
// title as text but DON'T have a `[[link]]`. Each source page is
// assigned to a different space; the scoped query must surface only
// the in-space sources.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_unlinked_references_returns_only_current_space_blocks_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Target page (the title to match) — give it a distinctive token.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LUR_TGT', 'page', 'fnordzazz', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_TGT")
        .bind("fnordzazz")
        .execute(&pool)
        .await
        .unwrap();

    // Two source pages, each with one mention but no [[link]].
    seed_block_under_page(&pool, "LUR_PA", "Page A", "LUR_SRC_A1").await;
    sqlx::query("UPDATE blocks SET content = 'see fnordzazz here' WHERE id = ?")
        .bind("LUR_SRC_A1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_A1")
        .bind("see fnordzazz here")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LUR_PB", "Page B", "LUR_SRC_B1").await;
    sqlx::query("UPDATE blocks SET content = 'also fnordzazz' WHERE id = ?")
        .bind("LUR_SRC_B1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_B1")
        .bind("also fnordzazz")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PB", TEST_SPACE_B_ID).await;

    let resp = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = resp
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert!(
        ids.contains("LUR_SRC_A1"),
        "space A must contain LUR_SRC_A1; got {ids:?}"
    );
    assert!(
        !ids.contains("LUR_SRC_B1"),
        "space A must NOT contain LUR_SRC_B1; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_unlinked_references_with_none_space_id_returns_all_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LUR_TGT', 'page', 'fnordzazz', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_TGT")
        .bind("fnordzazz")
        .execute(&pool)
        .await
        .unwrap();

    seed_block_under_page(&pool, "LUR_PA", "Page A", "LUR_SRC_A1").await;
    sqlx::query("UPDATE blocks SET content = 'see fnordzazz here' WHERE id = ?")
        .bind("LUR_SRC_A1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_A1")
        .bind("see fnordzazz here")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LUR_PB", "Page B", "LUR_SRC_B1").await;
    sqlx::query("UPDATE blocks SET content = 'also fnordzazz' WHERE id = ?")
        .bind("LUR_SRC_B1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_B1")
        .bind("also fnordzazz")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PB", TEST_SPACE_B_ID).await;

    let resp = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let ids: std::collections::HashSet<&str> = resp
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert!(ids.contains("LUR_SRC_A1"));
    assert!(ids.contains("LUR_SRC_B1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_unlinked_references_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LUR_TGT', 'page', 'fnordzazz', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_TGT")
        .bind("fnordzazz")
        .execute(&pool)
        .await
        .unwrap();
    seed_block_under_page(&pool, "LUR_PA", "Page A", "LUR_SRC_A1").await;
    sqlx::query("UPDATE blocks SET content = 'fnordzazz' WHERE id = ?")
        .bind("LUR_SRC_A1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_A1")
        .bind("fnordzazz")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PA", TEST_SPACE_ID).await;

    let resp = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted("01NONEXISTENT0000000000000")),
    )
    .await
    .unwrap();
    assert!(resp.groups.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_unlinked_references_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LUR_TGT', 'page', 'fnordzazz', NULL, NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_TGT")
        .bind("fnordzazz")
        .execute(&pool)
        .await
        .unwrap();

    // Two A-side sources (under one page), one B-side source.
    seed_block_under_page(&pool, "LUR_PA", "Page A", "LUR_SRC_A1").await;
    sqlx::query("UPDATE blocks SET content = 'fnordzazz x1' WHERE id = ?")
        .bind("LUR_SRC_A1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_A1")
        .bind("fnordzazz x1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES ('LUR_SRC_A2', 'content', 'fnordzazz x2', 'LUR_PA', 1, 'LUR_PA')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_A2")
        .bind("fnordzazz x2")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PA", TEST_SPACE_ID).await;

    seed_block_under_page(&pool, "LUR_PB", "Page B", "LUR_SRC_B1").await;
    sqlx::query("UPDATE blocks SET content = 'fnordzazz y' WHERE id = ?")
        .bind("LUR_SRC_B1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("LUR_SRC_B1")
        .bind("fnordzazz y")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_space(&pool, "LUR_PB", TEST_SPACE_B_ID).await;

    let collect_ids = |resp: &crate::backlink::GroupedBacklinkResponse| {
        resp.groups
            .iter()
            .flat_map(|g| g.blocks.iter().map(|b| -> String { b.id.as_str().into() }))
            .collect::<std::collections::HashSet<_>>()
    };
    let a = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let b = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    let unscoped = list_unlinked_references_inner(
        &pool,
        &crate::ulid::PageId::from("LUR_TGT"),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    let a_ids = collect_ids(&a);
    let b_ids = collect_ids(&b);
    let u_ids = collect_ids(&unscoped);
    assert!(a_ids.is_disjoint(&b_ids));
    let union: std::collections::HashSet<String> = a_ids.union(&b_ids).cloned().collect();
    assert_eq!(union, u_ids);
    assert_eq!(a_ids.len(), 2);
    assert_eq!(b_ids.len(), 1);
}

// ======================================================================
// FEAT-3p4 — space scoping for list_page_links_inner (graph view)
// ======================================================================
//
// Build a fixture with two source pages (one per space) linking to two
// target pages (one per space). When scoped to A, only the A→A edge
// must surface — cross-space edges are filtered out by the
// AND-of-both-endpoints space-filter clause.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_returns_only_current_space_edges_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Four pages: PSA & PTA in space A, PSB & PTB in space B.
    for (id, title) in &[
        ("LPL_PSA", "src A"),
        ("LPL_PTA", "tgt A"),
        ("LPL_PSB", "src B"),
        ("LPL_PTB", "tgt B"),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, NULL, NULL)",
        )
        .bind(id)
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    }
    assign_to_space(&pool, "LPL_PSA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PTA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PSB", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "LPL_PTB", TEST_SPACE_B_ID).await;

    // Four directed edges: A→A, A→B, B→A, B→B.
    insert_link(&pool, "LPL_PSA", "LPL_PTA").await;
    insert_link(&pool, "LPL_PSA", "LPL_PTB").await;
    insert_link(&pool, "LPL_PSB", "LPL_PTA").await;
    insert_link(&pool, "LPL_PSB", "LPL_PTB").await;

    let scoped_a = crate::commands::list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    let edges_a: std::collections::HashSet<(String, String)> = scoped_a
        .iter()
        .map(|l| (l.source_id.clone().into(), l.target_id.clone().into()))
        .collect();
    assert_eq!(
        edges_a,
        [("LPL_PSA".into(), "LPL_PTA".into())]
            .iter()
            .cloned()
            .collect(),
        "scoped to A must yield exactly the A→A edge; got {edges_a:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_with_none_space_id_returns_all_edges_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    for (id, title) in &[
        ("LPL_PSA", "src A"),
        ("LPL_PTA", "tgt A"),
        ("LPL_PSB", "src B"),
        ("LPL_PTB", "tgt B"),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, NULL, NULL)",
        )
        .bind(id)
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    }
    assign_to_space(&pool, "LPL_PSA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PTA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PSB", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "LPL_PTB", TEST_SPACE_B_ID).await;

    insert_link(&pool, "LPL_PSA", "LPL_PTA").await;
    insert_link(&pool, "LPL_PSA", "LPL_PTB").await;
    insert_link(&pool, "LPL_PSB", "LPL_PTA").await;
    insert_link(&pool, "LPL_PSB", "LPL_PTB").await;

    let unscoped = crate::commands::list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    assert_eq!(
        unscoped.len(),
        4,
        "None must surface all four edges across spaces; got {unscoped:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_with_nonexistent_space_id_returns_empty_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    for (id, title) in &[("LPL_PSA", "src A"), ("LPL_PTA", "tgt A")] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, NULL, NULL)",
        )
        .bind(id)
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    }
    assign_to_space(&pool, "LPL_PSA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PTA", TEST_SPACE_ID).await;
    insert_link(&pool, "LPL_PSA", "LPL_PTA").await;

    let resp = crate::commands::list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted("01NONEXISTENT0000000000000")),
        None,
    )
    .await
    .unwrap();
    assert!(resp.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_disjointness_feat3p4() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    for (id, title) in &[
        ("LPL_PSA", "src A"),
        ("LPL_PTA", "tgt A"),
        ("LPL_PSB", "src B"),
        ("LPL_PTB", "tgt B"),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, NULL, NULL)",
        )
        .bind(id)
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    }
    assign_to_space(&pool, "LPL_PSA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PTA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PSB", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "LPL_PTB", TEST_SPACE_B_ID).await;

    insert_link(&pool, "LPL_PSA", "LPL_PTA").await; // A→A
    insert_link(&pool, "LPL_PSA", "LPL_PTB").await; // A→B (cross-space)
    insert_link(&pool, "LPL_PSB", "LPL_PTA").await; // B→A (cross-space)
    insert_link(&pool, "LPL_PSB", "LPL_PTB").await; // B→B

    let to_set = |v: Vec<crate::commands::PageLink>| {
        v.into_iter()
            .map(|l| (l.source_id.into(), l.target_id.into()))
            .collect::<std::collections::HashSet<(String, String)>>()
    };
    let a = to_set(
        crate::commands::list_page_links_inner(
            &pool,
            &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
            None,
        )
        .await
        .unwrap(),
    );
    let b = to_set(
        crate::commands::list_page_links_inner(
            &pool,
            &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
            None,
        )
        .await
        .unwrap(),
    );
    assert!(a.is_disjoint(&b), "A and B edge sets must be disjoint");
    assert!(a.contains(&("LPL_PSA".into(), "LPL_PTA".into())));
    assert!(b.contains(&("LPL_PSB".into(), "LPL_PTB".into())));
    // Cross-space edges (A→B, B→A) are excluded from BOTH scoped queries —
    // their union with the unscoped set is what completes the picture.
    assert_eq!(a.len(), 1);
    assert_eq!(b.len(), 1);
}

/// PEND-20 F parity: the CTE-based space-filter dedup must produce
/// identical results to the previous twice-inlined subquery shape.
///
/// Fixture: source page only in space A; target page only in space B
/// (cross-space edge). The space filter requires BOTH endpoints to
/// belong to the requested space, so the edge must be excluded from
/// both A's and B's scoped query — exactly as before. This anchors
/// the contract that wrapping the membership lookup in a `WITH
/// space_members AS (...)` CTE doesn't change result-set semantics.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_cte_parity_with_inlined_subquery_pend20f() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    for (id, title) in &[
        ("PEND20F_AA", "in A"),
        ("PEND20F_AB", "in A second"),
        ("PEND20F_BA", "in B"),
        ("PEND20F_BB", "in B second"),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, NULL, NULL)",
        )
        .bind(id)
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    }
    assign_to_space(&pool, "PEND20F_AA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "PEND20F_AB", TEST_SPACE_ID).await;
    assign_to_space(&pool, "PEND20F_BA", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "PEND20F_BB", TEST_SPACE_B_ID).await;

    // Within-A edge.
    insert_link(&pool, "PEND20F_AA", "PEND20F_AB").await;
    // Cross-space edges — both endpoints would need to belong to the
    // scoped space, so neither should ever appear in a scoped result.
    insert_link(&pool, "PEND20F_AA", "PEND20F_BA").await;
    insert_link(&pool, "PEND20F_BA", "PEND20F_AA").await;
    // Within-B edge.
    insert_link(&pool, "PEND20F_BA", "PEND20F_BB").await;

    let scope_a = crate::commands::list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    let scope_b = crate::commands::list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
    )
    .await
    .unwrap();
    let unscoped = crate::commands::list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();

    let to_set = |v: Vec<crate::commands::PageLink>| {
        v.into_iter()
            .map(|l| (l.source_id.into(), l.target_id.into()))
            .collect::<std::collections::HashSet<(String, String)>>()
    };
    let edges_a = to_set(scope_a);
    let edges_b = to_set(scope_b);
    let edges_unscoped = to_set(unscoped);

    assert_eq!(
        edges_a,
        [("PEND20F_AA".into(), "PEND20F_AB".into())]
            .iter()
            .cloned()
            .collect(),
        "PEND-20 F: scoped A must yield exactly the within-A edge after CTE refactor",
    );
    assert_eq!(
        edges_b,
        [("PEND20F_BA".into(), "PEND20F_BB".into())]
            .iter()
            .cloned()
            .collect(),
        "PEND-20 F: scoped B must yield exactly the within-B edge after CTE refactor",
    );
    // The unscoped query (which never enters the CTE branch) should
    // see all four edges, including the two cross-space ones.
    assert_eq!(
        edges_unscoped.len(),
        4,
        "PEND-20 F: unscoped query must surface every edge regardless of space",
    );
}

// ======================================================================
// PEND-18 Phase 2 — SpaceScope parity test
// ======================================================================
//
// Asserts that `query_by_property_inner` honours the `&SpaceScope`
// boundary: `Global` returns the union across spaces, `Active(SpaceId)`
// returns only the named space's subset. Mirror of the pre-migration
// `space_id: None` / `Some(...)` semantics.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend18_query_by_property_scope_parity() {
    let (pool, _dir) = test_pool().await;

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    // Two blocks, same property key, distinct spaces.
    insert_block(&pool, "P18_QP_A", "content", "block A", None, None).await;
    insert_block(&pool, "P18_QP_B", "content", "block B", None, None).await;
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'todo', 'TODO')",
    )
    .bind("P18_QP_A")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'todo', 'TODO')",
    )
    .bind("P18_QP_B")
    .execute(&pool)
    .await
    .unwrap();
    assign_to_space(&pool, "P18_QP_A", TEST_SPACE_ID).await;
    assign_to_space(&pool, "P18_QP_B", TEST_SPACE_B_ID).await;

    let global = query_by_property_inner(
        &pool,
        "todo".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        global.items.len(),
        2,
        "Global must return both spaces' blocks"
    );

    let active_a = query_by_property_inner(
        &pool,
        "todo".into(),
        None,
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        false,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        active_a.items.len(),
        1,
        "Active(TEST_SPACE_ID) must return only space A's block"
    );
    assert_eq!(active_a.items[0].id, "P18_QP_A");
}

// ======================================================================
// PEND-35 Tier 2.3 — get_blocks (full BlockRow batch)
// ======================================================================

/// Seeds 5 blocks with diverse types/states + asserts the inner returns
/// every row with the full BlockRow shape preserved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_blocks_returns_full_rows_for_n_ids() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "GB_PAGE", "page", "the page", None, Some(1)).await;
    insert_block(
        &pool,
        "GB_C1",
        "content",
        "child one",
        Some("GB_PAGE"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "GB_C2",
        "content",
        "child two",
        Some("GB_PAGE"),
        Some(2),
    )
    .await;
    // Stamp non-default columns on GB_C2 so the test pins that
    // `todo_state`/`priority`/`due_date`/`scheduled_date` survive the round-trip.
    sqlx::query(
        "UPDATE blocks SET todo_state = 'TODO', priority = 'A', \
         due_date = '2026-05-08', scheduled_date = '2026-05-09' WHERE id = 'GB_C2'",
    )
    .execute(&pool)
    .await
    .unwrap();
    insert_block(&pool, "GB_TAG", "tag", "tag block", None, None).await;
    insert_block(&pool, "GB_GONE", "content", "deleted", None, None).await;
    sqlx::query("UPDATE blocks SET deleted_at = 1767225600000 WHERE id = 'GB_GONE'")
        .execute(&pool)
        .await
        .unwrap();

    let rows = get_blocks_inner(
        &pool,
        vec![
            "GB_PAGE".into(),
            "GB_C1".into(),
            "GB_C2".into(),
            "GB_TAG".into(),
            "GB_GONE".into(),
        ],
    )
    .await
    .unwrap();
    assert_eq!(rows.len(), 5, "all 5 ids resolve to a row");

    // Map by id so we can pin specific fields without depending on row order.
    let by_id: std::collections::HashMap<String, _> = rows
        .into_iter()
        .map(|r| (r.id.clone().into_string(), r))
        .collect();

    let c2 = by_id.get("GB_C2").expect("GB_C2 returned");
    assert_eq!(c2.block_type, "content");
    assert_eq!(c2.content.as_deref(), Some("child two"));
    assert_eq!(
        c2.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some("GB_PAGE")
    );
    assert_eq!(c2.position, Some(2));
    assert_eq!(c2.todo_state.as_deref(), Some("TODO"));
    assert_eq!(c2.priority.as_deref(), Some("A"));
    assert_eq!(c2.due_date.as_deref(), Some("2026-05-08"));
    assert_eq!(c2.scheduled_date.as_deref(), Some("2026-05-09"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_blocks_rejects_empty_oversize() {
    let (pool, _dir) = test_pool().await;
    let empty = get_blocks_inner(&pool, vec![]).await;
    assert!(
        matches!(empty, Err(crate::error::AppError::Validation(_))),
        "empty input must reject with Validation"
    );

    let oversize: Vec<String> = (0..(crate::commands::properties::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| format!("ID{i}"))
        .collect();
    let big = get_blocks_inner(
        &pool,
        oversize.into_iter().map(Into::into).collect::<Vec<_>>(),
    )
    .await;
    assert!(
        matches!(big, Err(crate::error::AppError::Validation(_))),
        "oversize input must reject with Validation"
    );
}

// ======================================================================
// PEND-35 Tier 2.10b — filtered_blocks_query_inner
// ======================================================================
//
// AND-intersection of property + tag predicates resolved entirely in
// SQL. Replaces the FE `useQueryExecution.fetchFilteredQuery` shape that
// fanned out one IPC per sub-filter (each capped at 200 rows) and
// intersected the IDs in JS. Tests below pin three semantic guarantees:
//
//   1. AND across multiple property filters (intersection, not union)
//   2. AND across property + tag filters
//   3. **Silent-cap regression** — the load-bearing fix: an AND-set
//      member outside the top-200 of any one sub-query was silently
//      dropped under the old shape; the new SQL pushdown returns it.
//   4. Empty-input rejection (validation, not silent full-table scan)
//   5. Cursor pagination across the filtered set

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_and_intersection_two_properties() {
    let (pool, _dir) = test_pool().await;

    // Three blocks:
    //   FBQ_BOTH    — has both `status:active` AND `priority:high`
    //   FBQ_STATUS  — has only `status:active`
    //   FBQ_PRIO    — has only `priority:high`
    insert_block(&pool, "FBQ_BOTH", "content", "both", None, Some(1)).await;
    insert_block(&pool, "FBQ_STATUS", "content", "status only", None, Some(2)).await;
    insert_block(&pool, "FBQ_PRIO", "content", "prio only", None, Some(3)).await;

    insert_property(&pool, "FBQ_BOTH", "status", "active").await;
    insert_property(&pool, "FBQ_BOTH", "priority_label", "high").await;
    insert_property(&pool, "FBQ_STATUS", "status", "active").await;
    insert_property(&pool, "FBQ_PRIO", "priority_label", "high").await;

    let result = filtered_blocks_query_inner(
        &pool,
        vec![
            PropertyFilter {
                key: "status".into(),
                value_text: Some("active".into()),
                value_text_in: Vec::new(),
                value_date: None,
                value_date_range: None,
                operator: "eq".into(),
            },
            PropertyFilter {
                key: "priority_label".into(),
                value_text: Some("high".into()),
                value_text_in: Vec::new(),
                value_date: None,
                value_date_range: None,
                operator: "eq".into(),
            },
        ],
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBQ_BOTH"].into_iter().collect(),
        "AND-intersection must keep only blocks satisfying every filter; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_property_plus_tag() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FBT_TAG", "tag", "project", None, None).await;
    insert_block(&pool, "FBT_BOTH", "content", "both", None, Some(1)).await;
    insert_block(
        &pool,
        "FBT_PROP_ONLY",
        "content",
        "prop only",
        None,
        Some(2),
    )
    .await;
    insert_block(&pool, "FBT_TAG_ONLY", "content", "tag only", None, Some(3)).await;

    insert_property(&pool, "FBT_BOTH", "status", "active").await;
    insert_property(&pool, "FBT_PROP_ONLY", "status", "active").await;
    insert_tag_assoc(&pool, "FBT_BOTH", "FBT_TAG").await;
    insert_tag_assoc(&pool, "FBT_TAG_ONLY", "FBT_TAG").await;

    let result = filtered_blocks_query_inner(
        &pool,
        vec![PropertyFilter {
            key: "status".into(),
            value_text: Some("active".into()),
            value_text_in: Vec::new(),
            value_date: None,
            value_date_range: None,
            operator: "eq".into(),
        }],
        Some(TagFilterExpr {
            tag_ids: vec!["FBT_TAG".into()],
            prefixes: Vec::new(),
            mode: "or".into(),
            include_inherited: false,
        }),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBT_BOTH"].into_iter().collect(),
        "property+tag AND must keep only blocks satisfying both predicates; got {ids:?}"
    );
}

/// **Load-bearing regression test** for the silent-cap bug PEND-35
/// Tier 2.10b fixes.
///
/// The old shape (`useQueryExecution.fetchFilteredQuery`) issued one
/// IPC per sub-filter with `FILTERED_SUBQUERY_LIMIT = 200`, then
/// intersected the resulting block-id sets in JS. Any AND-set member
/// whose ULID sorted outside the top-200 of any one sub-query was
/// silently absent from that sub-query's response — and therefore
/// missing from the JS intersection. Even a perfectly valid match
/// disappeared from results.
///
/// The fix pushes the AND-intersection into SQL via composed `EXISTS`
/// subqueries; SQLite walks the full universe so the row cap (now
/// only the requested page limit) applies AFTER the intersection, not
/// per-sub-query.
///
/// This test seeds 250 blocks where ULID `Z…` (highest sort key) is the
/// ONLY block matching both predicates, plus 249 blocks satisfying just
/// the `noise` property. Under the old shape, the noise sub-query's
/// 200-row cap pushed the `Z…` ULID off the end and the intersection
/// returned empty. Under the new shape, the ID is returned because the
/// AND-intersection happens before the row cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_silent_cap_regression() {
    let (pool, _dir) = test_pool().await;

    // Seed 249 "noise" blocks with ULIDs `01...A`..`01...IO` (low
    // sort keys) carrying ONLY the `noise:on` property — they
    // satisfy the noise filter but NOT the rare-tag filter.
    //
    // Then seed one block at ULID `ZZZZZZZZZZZZZZZZZZZZZZZZZZ` (top
    // sort key, bigger than every noise block) carrying BOTH
    // `noise:on` AND `target:rare` — the only AND-set member, and
    // the one the old shape would silently drop because it sorts
    // past the noise sub-query's 200-row cap.
    for i in 0..249 {
        let id = format!("01FBQCAP{:018}", i);
        insert_block(&pool, &id, "content", "noise", None, Some(i64::from(i))).await;
        insert_property(&pool, &id, "noise", "on").await;
    }

    let rare_id = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    insert_block(&pool, rare_id, "content", "rare match", None, Some(9999)).await;
    insert_property(&pool, rare_id, "noise", "on").await;
    insert_property(&pool, rare_id, "target", "rare").await;

    // Caller requests the default page size — the previous JS shape
    // would have capped each sub-query at 200 rows BEFORE intersecting,
    // dropping the rare ULID. The new SQL shape applies the row cap
    // only to the post-intersection page so the rare ID survives.
    let result = filtered_blocks_query_inner(
        &pool,
        vec![
            PropertyFilter {
                key: "noise".into(),
                value_text: Some("on".into()),
                value_text_in: Vec::new(),
                value_date: None,
                value_date_range: None,
                operator: "eq".into(),
            },
            PropertyFilter {
                key: "target".into(),
                value_text: Some("rare".into()),
                value_text_in: Vec::new(),
                value_date: None,
                value_date_range: None,
                operator: "eq".into(),
            },
        ],
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![rare_id],
        "rare AND-set member past row 200 of one sub-query must be returned (silent-cap regression)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_empty_filters_rejected() {
    let (pool, _dir) = test_pool().await;

    // No property filter, no tag filter, no block_type — caller almost
    // certainly meant `list_blocks`. Reject loudly so the caller sees
    // the misuse instead of silently scanning every active block.
    let result = filtered_blocks_query_inner(
        &pool,
        Vec::new(),
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await;

    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("at least one"),
                "empty-filter validation message should describe the contract; got {msg:?}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_cursor_pagination() {
    let (pool, _dir) = test_pool().await;

    // 5 blocks all carrying `kind:taggable`. Paginate across with limit=2
    // and assert the cursor walks the filtered set in id-asc order.
    for i in 0..5 {
        let id = format!("FBQPAG{:020}", i);
        insert_block(&pool, &id, "content", "row", None, Some(i64::from(i))).await;
        insert_property(&pool, &id, "kind", "taggable").await;
    }

    let make_filter = || {
        vec![PropertyFilter {
            key: "kind".into(),
            value_text: Some("taggable".into()),
            value_text_in: Vec::new(),
            value_date: None,
            value_date_range: None,
            operator: "eq".into(),
        }]
    };

    let p1 = filtered_blocks_query_inner(
        &pool,
        make_filter(),
        None,
        None,
        &SpaceScope::Global,
        None,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(p1.items.len(), 2, "page 1 size");
    assert!(p1.has_more, "page 1 should have_more");
    assert!(p1.next_cursor.is_some(), "page 1 should produce a cursor");

    let p2 = filtered_blocks_query_inner(
        &pool,
        make_filter(),
        None,
        None,
        &SpaceScope::Global,
        p1.next_cursor.clone(),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(p2.items.len(), 2, "page 2 size");
    assert!(p2.has_more, "page 2 should have_more");

    let p3 = filtered_blocks_query_inner(
        &pool,
        make_filter(),
        None,
        None,
        &SpaceScope::Global,
        p2.next_cursor.clone(),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(p3.items.len(), 1, "page 3 (final) size");
    assert!(!p3.has_more, "page 3 should not have_more");
    assert!(p3.next_cursor.is_none(), "final page yields no cursor");

    // Walked-set must be the full seeded set, in ascending id order.
    let mut walked: Vec<&str> = Vec::new();
    for r in [&p1, &p2, &p3] {
        walked.extend(r.items.iter().map(|b| b.id.as_str()));
    }
    let mut sorted = walked.clone();
    sorted.sort();
    assert_eq!(
        walked, sorted,
        "pagination must yield ids in ascending order"
    );
    assert_eq!(walked.len(), 5, "every seeded block should be walked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_value_text_in_intersects() {
    // Tier 3.4 set-membership pushdown participates in the AND with
    // other filters. Pin the predicate composition.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FBVTI_HIT", "content", "hit", None, Some(1)).await;
    insert_block(&pool, "FBVTI_MISS", "content", "miss", None, Some(2)).await;
    insert_property(&pool, "FBVTI_HIT", "k", "alpha").await;
    insert_property(&pool, "FBVTI_MISS", "k", "gamma").await;

    let result = filtered_blocks_query_inner(
        &pool,
        vec![PropertyFilter {
            key: "k".into(),
            value_text: None,
            value_text_in: vec!["alpha".into(), "beta".into()],
            value_date: None,
            value_date_range: None,
            operator: "eq".into(),
        }],
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBVTI_HIT"].into_iter().collect(),
        "value_text_in must filter via SET membership; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_value_date_range_half_open() {
    // Half-open `[from, to)` — rows on `to` are excluded. Mirrors the
    // Tier 3.4 contract on `query_by_property_inner`.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FBDR_IN", "content", "in", None, Some(1)).await;
    insert_block(&pool, "FBDR_BOUNDARY", "content", "on `to`", None, Some(2)).await;
    insert_block(&pool, "FBDR_OUT", "content", "out", None, Some(3)).await;
    insert_property_date(&pool, "FBDR_IN", "due", "2026-01-15").await;
    insert_property_date(&pool, "FBDR_BOUNDARY", "due", "2026-02-01").await;
    insert_property_date(&pool, "FBDR_OUT", "due", "2026-02-15").await;

    let result = filtered_blocks_query_inner(
        &pool,
        vec![PropertyFilter {
            key: "due".into(),
            value_text: None,
            value_text_in: Vec::new(),
            value_date: None,
            value_date_range: Some(("2026-01-01".into(), "2026-02-01".into())),
            operator: "eq".into(),
        }],
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBDR_IN"].into_iter().collect(),
        "value_date_range must be half-open `[from, to)`; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_block_type_pushdown() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FBBT_PG", "page", "page row", None, Some(1)).await;
    insert_block(&pool, "FBBT_CT", "content", "content row", None, Some(2)).await;
    insert_property(&pool, "FBBT_PG", "k", "v").await;
    insert_property(&pool, "FBBT_CT", "k", "v").await;

    let result = filtered_blocks_query_inner(
        &pool,
        vec![PropertyFilter {
            key: "k".into(),
            value_text: Some("v".into()),
            value_text_in: Vec::new(),
            value_date: None,
            value_date_range: None,
            operator: "eq".into(),
        }],
        None,
        Some("page".into()),
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBBT_PG"].into_iter().collect(),
        "block_type pushdown must restrict to the requested type; got {ids:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_reserved_key_routes_to_column() {
    // Reserved keys (todo_state, priority, due_date, scheduled_date)
    // live as columns on `blocks`, not in `block_properties`. The
    // filter must route to the column predicate, not generate a
    // (silently empty) EXISTS over `block_properties`.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FBR_TODO", "content", "todo", None, Some(1)).await;
    insert_block(&pool, "FBR_DONE", "content", "done", None, Some(2)).await;
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = 'FBR_TODO'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = 'FBR_DONE'")
        .execute(&pool)
        .await
        .unwrap();

    let result = filtered_blocks_query_inner(
        &pool,
        vec![PropertyFilter {
            key: "todo_state".into(),
            value_text: Some("TODO".into()),
            value_text_in: Vec::new(),
            value_date: None,
            value_date_range: None,
            operator: "eq".into(),
        }],
        None,
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        ["FBR_TODO"].into_iter().collect(),
        "reserved-key filter must route to b.todo_state; got {ids:?}"
    );
}
