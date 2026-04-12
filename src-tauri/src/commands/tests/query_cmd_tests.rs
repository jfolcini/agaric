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

    let resp = get_backlinks_inner(&pool, "BL_TGT".into(), None, None)
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
    let result = search_blocks_inner(&pool, "".into(), None, None, None, None)
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
    let result = search_blocks_inner(&pool, "   ".into(), None, None, None, None)
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

    let result = search_blocks_inner(&pool, "searchable".into(), None, None, None, None)
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

    let result = search_blocks_inner(&pool, "cherry".into(), None, None, None, None)
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
    let all = search_blocks_inner(&pool, "searchable".into(), None, None, None, None)
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
    let all = search_blocks_inner(&pool, "findme".into(), None, None, None, None)
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
    let result = search_blocks_inner(&pool, "universal".into(), None, None, None, None)
        .await
        .unwrap();
    assert_eq!(
        result.items.len(),
        2,
        "no filters: should find all matching blocks"
    );

    // Empty tag_ids vec should be treated the same as None
    let result_empty_tags =
        search_blocks_inner(&pool, "universal".into(), None, None, None, Some(vec![]))
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

    let result = query_by_tags_inner(&pool, vec![], vec![], "or".into(), None, None, None)
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

    let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None)
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

    let result = query_by_property_inner(&pool, "".into(), None, None, None, None, None).await;

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
    let r1 = query_by_property_inner(&pool, "status".into(), None, None, None, None, Some(2))
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

    let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None)
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
    let all = query_by_property_inner(&pool, "due_date".into(), None, None, None, None, None)
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
