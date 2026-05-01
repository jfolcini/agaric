#![allow(unused_imports)]
use super::super::*;
use super::common::*;

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

    let resp = get_backlinks_inner(&pool, "BL_TGT".into(), None, None, None)
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
// get_conflicts
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_conflicts_returns_conflict_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "CF_NORM", "content", "normal", None, None).await;
    insert_block(&pool, "CF_CONF", "content", "conflict", None, None).await;

    sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
        .bind("CF_CONF")
        .execute(&pool)
        .await
        .unwrap();

    let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

    assert_eq!(resp.items.len(), 1, "only one conflict block should exist");
    assert_eq!(
        resp.items[0].id, "CF_CONF",
        "conflict block ID should match"
    );
    assert!(
        resp.items[0].is_conflict,
        "conflict block should have is_conflict=true"
    );
}

// ======================================================================
// search_blocks_inner tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_blocks_inner_empty_query_returns_empty() {
    let (pool, _dir) = test_pool().await;
    assign_all_to_test_space(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "".into(),
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(),
    )
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
    let result = search_blocks_inner(
        &pool,
        "   ".into(),
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(),
    )
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
        None,
        None,
        TEST_SPACE_ID.into(),
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
        None,
        None,
        TEST_SPACE_ID.into(),
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
        None,
        None,
        TEST_SPACE_ID.into(),
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
        Some("PAGE_A".into()),
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        None,
        None,
        TEST_SPACE_ID.into(),
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
        None,
        Some(vec!["TAG_X".into()]),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        None,
        Some(vec!["TAG_X".into(), "TAG_Y".into()]),
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        None,
        None,
        TEST_SPACE_ID.into(),
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
        None,
        Some(vec![]),
        TEST_SPACE_ID.into(),
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

    let result = query_by_tags_inner(&pool, vec![], vec![], "or".into(), None, None, None, None)
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

    let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None, None)
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

    let result =
        query_by_property_inner(&pool, "".into(), None, None, None, None, None, None).await;

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
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'QP_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None, None)
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
    set_due_date_inner(&pool, DEV, &mat, b1.id.clone(), Some("2025-06-15".into()))
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
    set_due_date_inner(&pool, DEV, &mat, b2.id.clone(), Some("2025-12-31".into()))
        .await
        .unwrap();

    // Query all blocks with due_date (no value filter)
    let all = query_by_property_inner(&pool, "due_date".into(), None, None, None, None, None, None)
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
    insert_block(&pool, "OP_GT2", "content", "middle", None, Some(2)).await;
    insert_block(&pool, "OP_GT3", "content", "late", None, Some(3)).await;

    insert_property_date(&pool, "OP_GT1", "deadline", "2025-01-01").await;
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
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        2,
        "gt operator should return blocks with deadline after 2025-06-01"
    );
    assert_eq!(result.items[0].id, "OP_GT2", "first match is OP_GT2");
    assert_eq!(result.items[1].id, "OP_GT3", "second match is OP_GT3");
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
// count_backlinks_batch
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_empty_page_ids_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let result = count_backlinks_batch_inner(&pool, vec![]).await.unwrap();
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
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
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

    let result = count_backlinks_batch_inner(&pool, vec!["BLD_TGT".into()])
        .await
        .unwrap();

    assert_eq!(
        result.get("BLD_TGT"),
        Some(&1),
        "only the live source block should be counted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_backlinks_batch_excludes_conflict_source_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "CTGT", "page", "target", None, None).await;
    insert_block(&pool, "CLIVE", "content", "live src", None, None).await;
    insert_block(&pool, "CCONF", "content", "conflict src", None, None).await;

    // Mark CCONF as conflict
    sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
        .bind("CCONF")
        .execute(&pool)
        .await
        .unwrap();

    // Both link to the same target
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("CLIVE")
        .bind("CTGT")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("CCONF")
        .bind("CTGT")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_backlinks_batch_inner(&pool, vec!["CTGT".into()])
        .await
        .unwrap();

    assert_eq!(
        result.get("CTGT"),
        Some(&1),
        "only the non-conflict source block should be counted"
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

    let result = count_backlinks_batch_inner(&pool, vec!["SNG_TGT".into()])
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

    let result = count_backlinks_batch_inner(&pool, ids).await.unwrap();

    assert_eq!(result.len(), 2, "only two IDs have backlinks");
    assert_eq!(result.get("BIG_TGT1"), Some(&2), "BIG_TGT1 has 2 backlinks");
    assert_eq!(result.get("BIG_TGT2"), Some(&1), "BIG_TGT2 has 1 backlink");
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
        Some(TEST_SPACE_ID.into()),
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
        Some("DOES_NOT_EXIST".into()),
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
        Some(TEST_SPACE_ID.into()),
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
        Some(TEST_SPACE_B_ID.into()),
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
        Some(TEST_SPACE_ID.into()),
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
        Some(TEST_SPACE_ID.into()),
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

    let result =
        query_by_property_inner(&pool, "status".into(), None, None, None, None, None, None)
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
        Some("DOES_NOT_EXIST".into()),
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
        Some(TEST_SPACE_ID.into()),
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
        Some(TEST_SPACE_B_ID.into()),
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
        Some(TEST_SPACE_ID.into()),
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

    let resp = get_backlinks_inner(&pool, "GBL_TGT".into(), None, None, None)
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
        Some("01NONEXISTENT0000000000000".into()),
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
        Some(TEST_SPACE_ID.into()),
    )
    .await
    .unwrap();
    let b = get_backlinks_inner(
        &pool,
        "GBL_TGT".into(),
        None,
        None,
        Some(TEST_SPACE_B_ID.into()),
    )
    .await
    .unwrap();
    let unscoped = get_backlinks_inner(&pool, "GBL_TGT".into(), None, None, None)
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
        Some(TEST_SPACE_ID.into()),
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

    let resp =
        query_backlinks_filtered_inner(&pool, "QBF_TGT".into(), None, None, None, None, None)
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
        Some("01NONEXISTENT0000000000000".into()),
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
        Some(TEST_SPACE_ID.into()),
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
        Some(TEST_SPACE_B_ID.into()),
    )
    .await
    .unwrap();
    let unscoped =
        query_backlinks_filtered_inner(&pool, "QBF_TGT".into(), None, None, None, None, None)
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
        Some(TEST_SPACE_ID.into()),
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

    let resp = list_backlinks_grouped_inner(&pool, "LBG_TGT".into(), None, None, None, None, None)
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
        Some("01NONEXISTENT0000000000000".into()),
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
        Some(TEST_SPACE_ID.into()),
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
        Some(TEST_SPACE_B_ID.into()),
    )
    .await
    .unwrap();
    let unscoped =
        list_backlinks_grouped_inner(&pool, "LBG_TGT".into(), None, None, None, None, None)
            .await
            .unwrap();
    let collect_ids = |resp: &crate::backlink::GroupedBacklinkResponse| {
        resp.groups
            .iter()
            .flat_map(|g| g.blocks.iter().map(|b| b.id.clone()))
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
        "LUR_TGT",
        None,
        None,
        None,
        None,
        Some(TEST_SPACE_ID.into()),
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

    let resp = list_unlinked_references_inner(&pool, "LUR_TGT", None, None, None, None, None)
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
        "LUR_TGT",
        None,
        None,
        None,
        None,
        Some("01NONEXISTENT0000000000000".into()),
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
            .flat_map(|g| g.blocks.iter().map(|b| b.id.clone()))
            .collect::<std::collections::HashSet<_>>()
    };
    let a = list_unlinked_references_inner(
        &pool,
        "LUR_TGT",
        None,
        None,
        None,
        None,
        Some(TEST_SPACE_ID.into()),
    )
    .await
    .unwrap();
    let b = list_unlinked_references_inner(
        &pool,
        "LUR_TGT",
        None,
        None,
        None,
        None,
        Some(TEST_SPACE_B_ID.into()),
    )
    .await
    .unwrap();
    let unscoped = list_unlinked_references_inner(&pool, "LUR_TGT", None, None, None, None, None)
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

    let scoped_a = crate::commands::list_page_links_inner(&pool, Some(TEST_SPACE_ID.into()))
        .await
        .unwrap();
    let edges_a: std::collections::HashSet<(String, String)> = scoped_a
        .iter()
        .map(|l| (l.source_id.clone(), l.target_id.clone()))
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

    let unscoped = crate::commands::list_page_links_inner(&pool, None)
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

    let resp =
        crate::commands::list_page_links_inner(&pool, Some("01NONEXISTENT0000000000000".into()))
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
            .map(|l| (l.source_id, l.target_id))
            .collect::<std::collections::HashSet<(String, String)>>()
    };
    let a = to_set(
        crate::commands::list_page_links_inner(&pool, Some(TEST_SPACE_ID.into()))
            .await
            .unwrap(),
    );
    let b = to_set(
        crate::commands::list_page_links_inner(&pool, Some(TEST_SPACE_B_ID.into()))
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
