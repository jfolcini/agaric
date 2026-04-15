use super::strip::strip_for_fts_with_maps;
use super::*;
use crate::db::init_pool;
use crate::pagination::{Cursor, PageRequest};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tempfile::TempDir;

// ── Helpers ──────────────────────────────────────────────────────────

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_block_with_null_content(pool: &SqlitePool, id: &str, block_type: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, NULL, NULL, NULL)",
    )
    .bind(id)
    .bind(block_type)
    .execute(pool)
    .await
    .unwrap();
}

async fn soft_delete_block(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn mark_conflict(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

// Valid ULID-style IDs for tests (26 uppercase alphanumeric chars)
const TAG_ULID: &str = "01HQTAG000000000000000TAG1";
const PAGE_ULID: &str = "01HQPAGE00000000000000PG01";
const BLOCK_A: &str = "01HQBLKA00000000000000BKA1";
const BLOCK_B: &str = "01HQBLKB00000000000000BKB1";
const BLOCK_C: &str = "01HQBLKC00000000000000BKC1";
const BLOCK_D: &str = "01HQBLKD00000000000000BKD1";
const UNKNOWN_ULID: &str = "01HQUNKN00000000000000UK01";

// ======================================================================
// strip_for_fts tests
// ======================================================================

#[tokio::test]
async fn strip_plain_text_unchanged() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("hello world", &pool).await.unwrap();
    assert_eq!(
        result, "hello world",
        "plain text should pass through unchanged"
    );
}

#[tokio::test]
async fn strip_bold() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("**hello**", &pool).await.unwrap();
    assert_eq!(result, "hello", "bold markers should be stripped");
}

#[tokio::test]
async fn strip_italic() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("*hello*", &pool).await.unwrap();
    assert_eq!(result, "hello", "italic markers should be stripped");
}

#[tokio::test]
async fn strip_code() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("`hello`", &pool).await.unwrap();
    assert_eq!(result, "hello", "inline code backticks should be stripped");
}

#[tokio::test]
async fn strip_strikethrough() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("~~deleted~~", &pool).await.unwrap();
    assert_eq!(
        result, "deleted",
        "strikethrough markers should be stripped"
    );
}

#[tokio::test]
async fn strip_highlight() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("==important==", &pool).await.unwrap();
    assert_eq!(result, "important", "highlight markers should be stripped");
}

#[tokio::test]
async fn strip_mixed_formatting() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("**bold** and *italic* and `code`", &pool)
        .await
        .unwrap();
    assert_eq!(
        result, "bold and italic and code",
        "mixed bold/italic/code formatting should be stripped"
    );
}

#[tokio::test]
async fn strip_mixed_with_strike_and_highlight() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("**bold** and ~~deleted~~ and ==highlighted==", &pool)
        .await
        .unwrap();
    assert_eq!(
        result, "bold and deleted and highlighted",
        "mixed bold/strikethrough/highlight formatting should be stripped"
    );
}

#[tokio::test]
async fn strip_tag_ref_resolved() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;

    let input = format!("task #[{TAG_ULID}]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "task urgent",
        "tag reference should resolve to tag name"
    );
}

#[tokio::test]
async fn strip_page_link_resolved() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;

    let input = format!("see [[{PAGE_ULID}]]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "see My Page",
        "page link should resolve to page title"
    );
}

#[tokio::test]
async fn strip_unknown_tag_ref_becomes_empty() {
    let (pool, _dir) = test_pool().await;
    let input = format!("task #[{UNKNOWN_ULID}]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "task ",
        "unknown tag reference should resolve to empty string"
    );
}

#[tokio::test]
async fn strip_unknown_page_link_becomes_empty() {
    let (pool, _dir) = test_pool().await;
    let input = format!("see [[{UNKNOWN_ULID}]]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "see ",
        "unknown page link should resolve to empty string"
    );
}

#[tokio::test]
async fn strip_nested_bold_italic() {
    let (pool, _dir) = test_pool().await;
    // **bold *italic*** — bold outer stripped first, then italic
    let result = strip_for_fts("**bold *italic***", &pool).await.unwrap();
    // After bold strip: "bold *italic*", after italic strip: "bold italic"
    assert_eq!(
        result, "bold italic",
        "nested bold/italic should be fully stripped"
    );
}

#[tokio::test]
async fn strip_multiple_refs_batched() {
    let (pool, _dir) = test_pool().await;
    let tag_id = "01AAAAAAAAAAAAAAAAAAAAATAG";
    let page_id = "01AAAAAAAAAAAAAAAAAAAAPGE1";
    insert_block(&pool, tag_id, "tag", "urgent", None, None).await;
    insert_block(&pool, page_id, "page", "My Page", None, None).await;

    let input = format!("task #[{tag_id}] and #[{tag_id}] see [[{page_id}]] and [[{page_id}]]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "task urgent and urgent see My Page and My Page",
        "multiple duplicate refs should all be resolved"
    );
}

// ======================================================================
// strip_for_fts_with_maps tests
// ======================================================================

#[test]
fn strip_with_maps_resolves_tag_and_page() {
    let mut tag_names = HashMap::new();
    tag_names.insert(TAG_ULID.to_string(), "urgent".to_string());
    let mut page_titles = HashMap::new();
    page_titles.insert(PAGE_ULID.to_string(), "My Page".to_string());

    let input = format!("**bold** #[{TAG_ULID}] see [[{PAGE_ULID}]]");
    let result = strip_for_fts_with_maps(&input, &tag_names, &page_titles);
    assert_eq!(
        result, "bold urgent see My Page",
        "should strip bold and resolve tag/page refs via maps"
    );
}

#[test]
fn strip_with_maps_unknown_refs_empty() {
    let tag_names = HashMap::new();
    let page_titles = HashMap::new();

    let input = format!("#[{UNKNOWN_ULID}] and [[{UNKNOWN_ULID}]]");
    let result = strip_for_fts_with_maps(&input, &tag_names, &page_titles);
    assert_eq!(
        result, " and ",
        "unknown refs should resolve to empty strings via maps"
    );
}

// ======================================================================
// update_fts_for_block tests
// ======================================================================

#[tokio::test]
async fn update_fts_indexes_block_and_search_finds_it() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "hello wonderful world",
        None,
        Some(0),
    )
    .await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "wonderful", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        1,
        "search should return exactly 1 indexed block"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "search result should be the indexed block"
    );
}

#[tokio::test]
async fn update_fts_after_edit_finds_new_content() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "original content here",
        None,
        Some(0),
    )
    .await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    // Edit block content
    sqlx::query("UPDATE blocks SET content = 'completely different text' WHERE id = ?")
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Old content should NOT be found
    let old_results = search_fts(&pool, "original", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        old_results.items.len(),
        0,
        "old content should not be found after edit"
    );

    // New content should be found
    let new_results = search_fts(&pool, "different", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        new_results.items.len(),
        1,
        "new content should be found after edit"
    );
    assert_eq!(
        new_results.items[0].id, BLOCK_A,
        "edited block should match new content"
    );
}

#[tokio::test]
async fn update_fts_deleted_block_removes_from_index() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "searchable text", None, Some(0)).await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    // Soft-delete
    soft_delete_block(&pool, BLOCK_A).await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "searchable", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "deleted block should be removed from FTS index"
    );
}

#[tokio::test]
async fn update_fts_nonexistent_block_is_noop() {
    let (pool, _dir) = test_pool().await;
    // Should not error for a block that doesn't exist
    let result = update_fts_for_block(&pool, "NONEXISTENT00000000000000").await;
    assert!(
        result.is_ok(),
        "updating FTS for nonexistent block should not error"
    );
}

#[tokio::test]
async fn update_fts_conflict_block_removes_from_index() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "conflict text", None, Some(0)).await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    mark_conflict(&pool, BLOCK_A).await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "conflict", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "conflict block should be removed from FTS index"
    );
}

#[tokio::test]
async fn update_fts_null_content_removes_from_index() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_null_content(&pool, BLOCK_A, "content").await;
    // Should not error and should not index
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
        BLOCK_A
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0, "null-content block should not be indexed in FTS");
}

// ======================================================================
// remove_fts_for_block tests
// ======================================================================

#[tokio::test]
async fn remove_fts_makes_block_unsearchable() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "removable content",
        None,
        Some(0),
    )
    .await;
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();

    remove_fts_for_block(&pool, BLOCK_A).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "removable", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "removed block should not appear in search results"
    );
}

#[tokio::test]
async fn remove_fts_nonexistent_is_noop() {
    let (pool, _dir) = test_pool().await;
    let result = remove_fts_for_block(&pool, "NONEXISTENT00000000000000").await;
    assert!(
        result.is_ok(),
        "removing nonexistent block from FTS should not error"
    );
}

// ======================================================================
// rebuild_fts_index tests
// ======================================================================

#[tokio::test]
async fn rebuild_indexes_all_active_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "alpha content", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "beta content", None, Some(1)).await;
    insert_block(&pool, BLOCK_C, "content", "gamma content", None, Some(2)).await;

    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    let a = search_fts(&pool, "alpha", &page, None, None).await.unwrap();
    assert_eq!(a.items.len(), 1, "rebuild should index alpha block");
    assert_eq!(a.items[0].id, BLOCK_A, "alpha search should return BLOCK_A");

    let b = search_fts(&pool, "beta", &page, None, None).await.unwrap();
    assert_eq!(b.items.len(), 1, "rebuild should index beta block");
    assert_eq!(b.items[0].id, BLOCK_B, "beta search should return BLOCK_B");

    let g = search_fts(&pool, "gamma", &page, None, None).await.unwrap();
    assert_eq!(g.items.len(), 1, "rebuild should index gamma block");
    assert_eq!(g.items[0].id, BLOCK_C, "gamma search should return BLOCK_C");
}

#[tokio::test]
async fn rebuild_excludes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "visible", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "deleted content", None, Some(1)).await;
    soft_delete_block(&pool, BLOCK_B).await;

    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let deleted_results = search_fts(&pool, "deleted", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        deleted_results.items.len(),
        0,
        "deleted block should be excluded from rebuild"
    );

    let visible_results = search_fts(&pool, "visible", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        visible_results.items.len(),
        1,
        "visible block should be indexed after rebuild"
    );
}

#[tokio::test]
async fn rebuild_excludes_conflict_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "normal", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "conflicting", None, Some(1)).await;
    mark_conflict(&pool, BLOCK_B).await;

    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let conflict_results = search_fts(&pool, "conflicting", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        conflict_results.items.len(),
        0,
        "conflict block should be excluded from rebuild"
    );
}

#[tokio::test]
async fn rebuild_excludes_null_content_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "has content", None, Some(0)).await;
    insert_block_with_null_content(&pool, BLOCK_B, "content").await;

    rebuild_fts_index(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "only block with content should be indexed");
}

#[tokio::test]
async fn rebuild_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "first pass", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    // Delete block and rebuild — stale FTS entry should be cleared
    soft_delete_block(&pool, BLOCK_A).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "first", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "stale FTS entry should be cleared after rebuild"
    );
}

#[tokio::test]
async fn rebuild_resolves_tag_and_page_refs() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;
    insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;

    let content = format!("task #[{TAG_ULID}] see [[{PAGE_ULID}]]");
    insert_block(&pool, BLOCK_A, "content", &content, None, Some(0)).await;

    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Should find by resolved tag name — the tag block itself has "urgent"
    // and the content block references it via #[ULID], stripped to "urgent"
    let tag_results = search_fts(&pool, "urgent", &page, None, None)
        .await
        .unwrap();
    assert!(
        !tag_results.items.is_empty(),
        "at least the tag block should match 'urgent'"
    );

    // Should find the content block by "task" (unique to it)
    let task_results = search_fts(&pool, "task", &page, None, None).await.unwrap();
    assert_eq!(
        task_results.items.len(),
        1,
        "rebuild should resolve tag/page refs for search"
    );
    assert_eq!(
        task_results.items[0].id, BLOCK_A,
        "task search should return the content block"
    );
}

// ======================================================================
// fts_optimize test
// ======================================================================

#[tokio::test]
async fn fts_optimize_succeeds_and_search_still_works() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "optimize test alpha",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "optimize test beta",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_C,
        "content",
        "optimize test gamma",
        None,
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    // Run optimize
    fts_optimize(&pool).await.unwrap();

    // Search should still work
    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "optimize", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        3,
        "search should still work after FTS optimize"
    );
}

// ======================================================================
// search_fts tests
// ======================================================================

#[tokio::test]
async fn search_basic_finds_correct_block() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "unique keyword alpha",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "another thing beta",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_C,
        "content",
        "something else gamma",
        None,
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "alpha", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        1,
        "search should find exactly one matching block"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "search should return the correct block"
    );
}

#[tokio::test]
async fn search_no_results() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "nonexistent", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "search for nonexistent term should return no results"
    );
    assert!(
        !results.has_more,
        "no-results response should not indicate more pages"
    );
    assert!(
        results.next_cursor.is_none(),
        "no-results response should have no cursor"
    );
}

#[tokio::test]
async fn search_empty_query_returns_empty() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "empty query should return no results"
    );
    assert!(
        !results.has_more,
        "empty query should not indicate more pages"
    );
}

#[tokio::test]
async fn search_whitespace_query_returns_empty() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "   ", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "whitespace-only query should return no results"
    );
    assert!(
        !results.has_more,
        "whitespace-only query should not indicate more pages"
    );
}

#[tokio::test]
async fn search_deleted_blocks_excluded() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "visible content", None, Some(0)).await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "deleted visible content",
        None,
        Some(1),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    // Soft-delete block B (FTS entry remains but JOIN filter excludes it)
    soft_delete_block(&pool, BLOCK_B).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "visible", &page, None, None)
        .await
        .unwrap();
    // Only BLOCK_A should appear (BLOCK_B is deleted)
    assert_eq!(
        results.items.len(),
        1,
        "only non-deleted block should appear in search"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "search result should be the non-deleted block"
    );
}

#[tokio::test]
async fn search_pagination_works() {
    let (pool, _dir) = test_pool().await;

    // Insert enough blocks for pagination (use limit=2)
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "pagination test item",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "pagination test item",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_C,
        "content",
        "pagination test item",
        None,
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_D,
        "content",
        "pagination test item",
        None,
        Some(3),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    // First page with limit 2
    let page1 = PageRequest::new(None, Some(2)).unwrap();
    let results1 = search_fts(&pool, "pagination", &page1, None, None)
        .await
        .unwrap();
    assert_eq!(results1.items.len(), 2, "first page should return 2 items");
    assert!(results1.has_more, "first page should indicate more results");
    assert!(
        results1.next_cursor.is_some(),
        "first page should have a next cursor"
    );

    // Second page using cursor
    let page2 = PageRequest::new(results1.next_cursor, Some(2)).unwrap();
    let results2 = search_fts(&pool, "pagination", &page2, None, None)
        .await
        .unwrap();
    assert_eq!(
        results2.items.len(),
        2,
        "second page should return remaining 2 items"
    );
    assert!(
        !results2.has_more,
        "second page should not indicate more results"
    );

    // Verify no duplicates across pages
    let all_ids: Vec<&str> = results1
        .items
        .iter()
        .chain(results2.items.iter())
        .map(|b| b.id.as_str())
        .collect();
    let unique: std::collections::HashSet<&str> = all_ids.iter().copied().collect();
    assert_eq!(all_ids.len(), unique.len(), "no duplicate IDs across pages");
    assert_eq!(
        all_ids.len(),
        4,
        "all 4 blocks should be returned across pages"
    );
}

#[tokio::test]
async fn search_fts5_syntax_error_returns_validation() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "test", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    // With query sanitization, unmatched quotes are escaped and no longer
    // produce syntax errors.  The query succeeds (returns 0 results since
    // the literal token does not match any content).
    let result = search_fts(&pool, "\"unclosed quote", &page, None, None).await;
    assert!(
        result.is_ok(),
        "sanitized query should not produce a syntax error"
    );
}

#[tokio::test]
async fn search_multiple_terms_matches() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "rust programming language",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "python programming language",
        None,
        Some(1),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Both blocks match "programming"
    let both = search_fts(&pool, "programming", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        both.items.len(),
        2,
        "both blocks should match 'programming'"
    );

    // Only BLOCK_A matches "rust"
    let rust_only = search_fts(&pool, "rust", &page, None, None).await.unwrap();
    assert_eq!(
        rust_only.items.len(),
        1,
        "only one block should match 'rust'"
    );
    assert_eq!(
        rust_only.items[0].id, BLOCK_A,
        "rust search should return BLOCK_A"
    );
}

// ======================================================================
// F09: SQL injection / FTS5 operator injection tests
// ======================================================================

#[tokio::test]
async fn search_sql_injection_attempt_no_crash() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "normal searchable content",
        None,
        Some(0),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Classic SQL injection attempts -- should not crash or inject
    let injections = vec![
        "'; DROP TABLE blocks; --",
        "\" OR 1=1 --",
        "Robert'); DROP TABLE fts_blocks;--",
        "1 UNION SELECT * FROM blocks",
    ];
    for injection in injections {
        let result = search_fts(&pool, injection, &page, None, None).await;
        assert!(
            result.is_ok(),
            "SQL injection attempt should not crash: {injection}"
        );
    }

    // Verify the database is intact
    let check = search_fts(&pool, "normal", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        check.items.len(),
        1,
        "database should be intact after injection attempts"
    );
}

#[tokio::test]
async fn search_fts5_operators_are_sanitized() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "hello OR world", None, Some(1)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Bare "OR" with no surrounding terms is quoted as a literal word.
    let result = search_fts(&pool, "OR", &page, None, None).await;
    assert!(result.is_ok(), "OR as query should not crash");

    // "NOT hello" is now preserved as the FTS5 NOT operator, which is a
    // binary operator — standalone NOT is an FTS5 syntax error.  The
    // search_fts error handler maps this to a Validation error.
    let not_result = search_fts(&pool, "NOT hello", &page, None, None).await;
    assert!(
        not_result.is_err(),
        "standalone NOT should produce a validation error"
    );

    // NEAR() should be treated as a literal word (not a recognised operator)
    let near_result = search_fts(&pool, "NEAR(hello world)", &page, None, None).await;
    assert!(near_result.is_ok(), "NEAR() as query should not crash");
}

// ======================================================================
// F10: Special FTS5 characters (*, +, -, etc.)
// ======================================================================

#[tokio::test]
async fn search_special_fts5_characters_no_crash() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "test content", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    let special_queries = vec![
        "*",
        "test*",
        "+test",
        "-test",
        "test + content",
        "(test)",
        "test AND content",
        "^test",
        "block_id:something",
        "\"exact phrase\"",
        "col1 : col2",
    ];
    for q in special_queries {
        let result = search_fts(&pool, q, &page, None, None).await;
        assert!(
            result.is_ok(),
            "Special FTS5 character query should not crash: {q}"
        );
    }
}

#[tokio::test]
async fn search_unmatched_quotes_no_crash() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "test content", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // With sanitization, unmatched quotes are escaped -- should succeed
    let result = search_fts(&pool, "\"unclosed quote", &page, None, None).await;
    assert!(
        result.is_ok(),
        "unmatched quotes should not crash after sanitization"
    );
}

// ======================================================================
// Strip: escape sequences and edge cases
// ======================================================================

#[tokio::test]
async fn strip_escaped_asterisk() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts(r"use \*args", &pool).await.unwrap();
    assert_eq!(result, "use *args", "escaped asterisk should be unescaped");
}

#[tokio::test]
async fn strip_escaped_backtick() {
    let (pool, _dir) = test_pool().await;
    // A single (unpaired) escaped backtick is not matched by CODE_RE,
    // so it passes through to the unescape step.
    // Paired `\`...\`` would be consumed by CODE_RE first (known limitation).
    let result = strip_for_fts("it costs 5\\` USD", &pool).await.unwrap();
    assert_eq!(
        result, "it costs 5` USD",
        "escaped backtick should be unescaped"
    );
}

#[tokio::test]
async fn strip_complex_nested_markup() {
    let (pool, _dir) = test_pool().await;
    let result = strip_for_fts("**bold *nested*** rest", &pool)
        .await
        .unwrap();
    assert_eq!(
        result, "bold nested rest",
        "complex nested bold/italic should be fully stripped"
    );
}

#[tokio::test]
async fn strip_mixed_formatting_and_refs() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;

    let input = format!("**bold** and `code` with #[{TAG_ULID}]");
    let result = strip_for_fts(&input, &pool).await.unwrap();
    assert_eq!(
        result, "bold and code with urgent",
        "mixed formatting and tag ref should be stripped/resolved"
    );
}

#[test]
fn strip_with_maps_handles_formatting() {
    let tag_names = HashMap::new();
    let page_titles = HashMap::new();

    // Verify the sync batch path handles markdown + unescape.
    // Use a single \* (unpaired) so ITALIC_RE doesn't consume it.
    let result = strip_for_fts_with_maps(r"**bold** `code` \*args", &tag_names, &page_titles);
    assert_eq!(
        result, "bold code *args",
        "sync strip should handle formatting and unescape"
    );
}

#[test]
fn strip_with_maps_handles_strike_and_highlight() {
    let tag_names = HashMap::new();
    let page_titles = HashMap::new();

    let result = strip_for_fts_with_maps(
        "**bold** and ~~deleted~~ and ==highlighted==",
        &tag_names,
        &page_titles,
    );
    assert_eq!(
        result, "bold and deleted and highlighted",
        "sync strip should handle strikethrough and highlight"
    );
}

// ======================================================================
// F12: Search excludes deleted blocks (verifies JOIN filter)
// ======================================================================

#[tokio::test]
async fn search_excludes_soft_deleted_blocks_after_index() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "findable unique word",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        "deleted unique word",
        None,
        Some(1),
    )
    .await;
    // Index both blocks
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();
    update_fts_for_block(&pool, BLOCK_B).await.unwrap();

    // Soft-delete BLOCK_B *without* re-indexing -- the FTS entry persists
    // but the JOIN filter in search_fts should exclude it.
    soft_delete_block(&pool, BLOCK_B).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "unique", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        1,
        "deleted block should be excluded by JOIN filter"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "non-deleted block should be the search result"
    );
}

// ======================================================================
// F13: Search pagination with MAX_SEARCH_RESULTS cap
// ======================================================================

#[tokio::test]
async fn search_respects_max_results_cap() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "capped search result",
        None,
        Some(0),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    // Request a limit higher than MAX_SEARCH_RESULTS (100)
    let page = PageRequest::new(None, Some(200)).unwrap();
    let results = search_fts(&pool, "capped", &page, None, None)
        .await
        .unwrap();

    // Should still find the result (not broken by capping)
    assert_eq!(
        results.items.len(),
        1,
        "capped limit should still find matching block"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "capped search should return the correct block"
    );
}

// ======================================================================
// sanitize_fts_query unit tests
// ======================================================================

#[test]
fn sanitize_still_quotes_plain_terms() {
    assert_eq!(
        sanitize_fts_query("hello world"),
        "\"hello\" \"world\"",
        "plain terms should be individually quoted (backward compat)"
    );
}

#[test]
fn sanitize_empty_query() {
    assert_eq!(
        sanitize_fts_query(""),
        "",
        "empty string should produce empty output"
    );
    assert_eq!(
        sanitize_fts_query("   "),
        "",
        "whitespace-only string should produce empty output"
    );
}

#[test]
fn sanitize_escapes_internal_quotes() {
    assert_eq!(
        sanitize_fts_query("say\"hello"),
        "\"say\"\"hello\"",
        "internal double quotes should be escaped by doubling"
    );
}

#[test]
fn sanitize_preserves_quoted_phrases() {
    assert_eq!(
        sanitize_fts_query("\"hello world\""),
        "\"hello world\"",
        "quoted phrase should be kept as a single token"
    );
}

#[test]
fn sanitize_preserves_not_operator() {
    assert_eq!(
        sanitize_fts_query("NOT spam"),
        "NOT \"spam\"",
        "NOT followed by a term should be preserved as operator"
    );
}

#[test]
fn sanitize_preserves_or_operator() {
    assert_eq!(
        sanitize_fts_query("cats OR dogs"),
        "\"cats\" OR \"dogs\"",
        "OR between two terms should be preserved as operator"
    );
}

#[test]
fn sanitize_mixed_operators_and_terms() {
    assert_eq!(
        sanitize_fts_query("\"exact match\" NOT spam OR dogs"),
        "\"exact match\" NOT \"spam\" OR \"dogs\"",
        "mixed quoted phrases, NOT, and OR should all be handled"
    );
}

#[test]
fn sanitize_case_insensitive_operators() {
    assert_eq!(
        sanitize_fts_query("not spam or dogs"),
        "NOT \"spam\" OR \"dogs\"",
        "lowercase operators should be uppercased"
    );
    assert_eq!(
        sanitize_fts_query("cats Or dogs"),
        "\"cats\" OR \"dogs\"",
        "mixed-case OR should be uppercased"
    );
    assert_eq!(
        sanitize_fts_query("cats aNd dogs"),
        "\"cats\" AND \"dogs\"",
        "mixed-case AND should be uppercased"
    );
}

#[test]
fn sanitize_prevents_injection() {
    // Wildcards, parentheses, column filters, and NEAR are all quoted.
    assert_eq!(
        sanitize_fts_query("test*"),
        "\"test*\"",
        "wildcard should be quoted as literal"
    );
    assert_eq!(
        sanitize_fts_query("(group)"),
        "\"(group)\"",
        "parentheses should be quoted as literal"
    );
    assert_eq!(
        sanitize_fts_query("col:value"),
        "\"col:value\"",
        "column filter syntax should be quoted as literal"
    );
    assert_eq!(
        sanitize_fts_query("NEAR(a b)"),
        "\"NEAR(a\" \"b)\"",
        "NEAR operator should be quoted as literal"
    );
}

#[test]
fn sanitize_trailing_operator_quoted() {
    // NOT at end without a following term → quoted as literal.
    assert_eq!(
        sanitize_fts_query("hello NOT"),
        "\"hello\" \"NOT\"",
        "trailing NOT without operand should be quoted"
    );
    // OR at end without a following term → quoted as literal.
    assert_eq!(
        sanitize_fts_query("hello OR"),
        "\"hello\" \"OR\"",
        "trailing OR without operand should be quoted"
    );
    // OR at start without a preceding term → quoted as literal.
    assert_eq!(
        sanitize_fts_query("OR hello"),
        "\"OR\" \"hello\"",
        "leading OR without left operand should be quoted"
    );
}

#[test]
fn sanitize_unmatched_quote_fallback() {
    // Unmatched opening quote — contents treated as individual words.
    assert_eq!(
        sanitize_fts_query("\"hello world"),
        "\"hello\" \"world\"",
        "unmatched quote should fall back to individual word quoting"
    );
}

// ======================================================================
// FTS pagination with identical/close ranks (REVIEW-LATER #3 fix)
// ======================================================================

#[tokio::test]
async fn search_pagination_identical_ranks_no_duplicates_no_skips() {
    // All blocks have identical content → identical FTS5 rank.
    // The composite cursor (rank, block_id) with epsilon comparison must
    // paginate correctly using block_id as the deterministic tiebreaker.
    let (pool, _dir) = test_pool().await;

    // Use 6 blocks with identical content to test multi-page traversal
    // at page_size=2 (3 pages).
    const BLK_E: &str = "01HQBLKE00000000000000BKE1";
    const BLK_F: &str = "01HQBLKF00000000000000BKF1";

    let ids = [BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D, BLK_E, BLK_F];
    for (i, id) in ids.iter().enumerate() {
        insert_block(
            &pool,
            id,
            "content",
            "identical searchword",
            None,
            Some(i64::try_from(i).unwrap()),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    // Walk all pages collecting IDs
    let mut all_ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let page = PageRequest::new(cursor.clone(), Some(2)).unwrap();
        let result = search_fts(&pool, "identical", &page, None, None)
            .await
            .unwrap();

        for item in &result.items {
            all_ids.push(item.id.clone());
        }

        pages += 1;
        if !result.has_more {
            break;
        }
        cursor = result.next_cursor;
        assert!(pages <= 4, "too many pages — possible infinite loop");
    }

    // Verify: exactly 6 results, no duplicates, all blocks present
    let unique: std::collections::HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(
        all_ids.len(),
        6,
        "all 6 blocks should be returned across pages"
    );
    assert_eq!(
        unique.len(),
        6,
        "no duplicate IDs across pages with identical ranks"
    );
    for id in &ids {
        assert!(
            unique.contains(*id),
            "block {id} should be present in results"
        );
    }

    // Verify results are ordered by block_id (tiebreaker) within same rank
    for window in all_ids.windows(2) {
        assert!(
            window[0] <= window[1],
            "results should be ordered by block_id within same rank: {} should come before {}",
            window[0],
            window[1]
        );
    }
}

#[tokio::test]
async fn search_cursor_round_trip_with_float_rank() {
    // Verify cursor encoding/decoding preserves float rank correctly
    // and the decoded cursor produces correct results.
    let (pool, _dir) = test_pool().await;

    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "apple banana cherry",
        None,
        Some(0),
    )
    .await;
    insert_block(&pool, BLOCK_B, "content", "apple banana", None, Some(1)).await;
    insert_block(&pool, BLOCK_C, "content", "apple", None, Some(2)).await;
    rebuild_fts_index(&pool).await.unwrap();

    // First page: limit 1
    let page1 = PageRequest::new(None, Some(1)).unwrap();
    let result1 = search_fts(&pool, "apple", &page1, None, None)
        .await
        .unwrap();
    assert_eq!(result1.items.len(), 1, "first page should return 1 item");
    assert!(result1.has_more, "first page should indicate more results");
    assert!(
        result1.next_cursor.is_some(),
        "first page should have a next cursor"
    );

    // Decode the cursor and verify rank is present
    let cursor_str = result1.next_cursor.clone().unwrap();
    let decoded = Cursor::decode(&cursor_str).unwrap();
    assert!(decoded.rank.is_some(), "FTS cursor should contain rank");
    assert!(
        !decoded.id.is_empty(),
        "FTS cursor should contain block_id as tiebreaker"
    );
    // seq should NOT be set for FTS cursors (was the old fts_rowid approach)
    assert!(
        decoded.seq.is_none(),
        "FTS cursor should not use seq (old fts_rowid approach)"
    );

    // Second page using the cursor
    let page2 = PageRequest::new(result1.next_cursor, Some(1)).unwrap();
    let result2 = search_fts(&pool, "apple", &page2, None, None)
        .await
        .unwrap();
    assert_eq!(result2.items.len(), 1, "second page should return 1 item");

    // Verify no duplicate between page 1 and page 2
    assert_ne!(
        result1.items[0].id, result2.items[0].id,
        "consecutive pages should not return the same block"
    );

    // Third page
    let page3 = PageRequest::new(result2.next_cursor, Some(1)).unwrap();
    let result3 = search_fts(&pool, "apple", &page3, None, None)
        .await
        .unwrap();
    assert_eq!(result3.items.len(), 1, "third page should return 1 item");
    assert!(
        !result3.has_more,
        "third page should not indicate more results"
    );

    // Collect all IDs and verify completeness
    let all_ids: Vec<&str> = vec![
        &result1.items[0].id,
        &result2.items[0].id,
        &result3.items[0].id,
    ]
    .into_iter()
    .map(String::as_str)
    .collect();
    let unique: std::collections::HashSet<&str> = all_ids.iter().copied().collect();
    assert_eq!(
        unique.len(),
        3,
        "all 3 blocks should be returned across pages"
    );
}

#[tokio::test]
async fn search_pagination_close_ranks_epsilon_boundary() {
    // Verify that blocks with very close (but not identical) ranks are
    // correctly paginated — the epsilon comparison should not conflate
    // truly different ranks.
    //
    // Trigram BM25 produces very small rank differences for similar-length
    // documents, so we use drastically different document lengths to push
    // the scores apart beyond the 1e-9 epsilon.
    let (pool, _dir) = test_pool().await;

    let long_padding = " filler".repeat(200); // ~1400 chars of padding
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        &format!("pagination{long_padding}"),
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        BLOCK_B,
        "content",
        &format!("pagination{}", " filler".repeat(20)),
        None,
        Some(1),
    )
    .await;
    insert_block(&pool, BLOCK_C, "content", "pagination", None, Some(2)).await;
    rebuild_fts_index(&pool).await.unwrap();

    // Walk all pages with limit=1
    let mut all_ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let page = PageRequest::new(cursor.clone(), Some(1)).unwrap();
        let result = search_fts(&pool, "pagination", &page, None, None)
            .await
            .unwrap();

        for item in &result.items {
            all_ids.push(item.id.clone());
        }

        pages += 1;
        if !result.has_more {
            break;
        }
        cursor = result.next_cursor;
        assert!(pages <= 5, "too many pages — possible infinite loop");
    }

    let unique: std::collections::HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(all_ids.len(), 3, "all 3 blocks should be returned");
    assert_eq!(unique.len(), 3, "no duplicates across pages");
}

// ======================================================================
// FTS5 parse error mapping (defense-in-depth)
// ======================================================================

/// Directly execute an invalid FTS5 MATCH query to verify SQLite returns
/// a parse-error-like error. This validates the error indicators that the
/// `search_fts` `.map_err` closure checks for (lines 443-445).
#[tokio::test]
async fn fts5_invalid_match_syntax_returns_error() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "test content", None, Some(1)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let result = sqlx::query("SELECT * FROM fts_blocks WHERE fts_blocks MATCH 'AND OR'")
        .fetch_all(&pool)
        .await;

    assert!(
        result.is_err(),
        "invalid FTS5 syntax should produce an error"
    );
    let err_msg = result.err().unwrap().to_string();
    assert!(
        err_msg.contains("fts5") || err_msg.contains("parse") || err_msg.contains("syntax"),
        "FTS5 error should mention parse/syntax issue, got: {err_msg}"
    );
}

/// Verify that `search_fts` with dangerous inputs does NOT return
/// a parse error — the sanitizer protects against FTS5 operator injection.
#[tokio::test]
async fn search_fts_sanitizer_protects_against_fts5_operators() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(1)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();

    for dangerous_query in &[
        "AND OR NOT",
        "col: value",
        "\"unclosed quote",
        "* prefix",
        "(grouping)",
        "NEAR(a b)",
    ] {
        let result = search_fts(&pool, dangerous_query, &page, None, None).await;
        assert!(
            result.is_ok(),
            "sanitizer should protect query '{}' from parse error, got: {:?}",
            dangerous_query,
            result.err()
        );
    }
}

// ── #72: reindex_fts_references after tag/page rename ────────────

#[tokio::test]
async fn reindex_fts_references_batches_correctly() {
    let (pool, _dir) = test_pool().await;

    // Use 26-char ULID-style IDs
    let tag_id = "01BBBBBBBBBBBBBBBBBBBBTAG1";
    let blk1 = "01BBBBBBBBBBBBBBBBBBBBBLK1";
    let blk2 = "01BBBBBBBBBBBBBBBBBBBBBLK2";
    let blk3 = "01BBBBBBBBBBBBBBBBBBBBBLK3";

    // Create tag and 3 content blocks referencing it
    insert_block(&pool, tag_id, "tag", "meeting", None, Some(0)).await;
    for (i, blk) in [blk1, blk2, blk3].iter().enumerate() {
        insert_block(
            &pool,
            blk,
            "content",
            &format!("item {} about #[{tag_id}]", i + 1),
            None,
            Some(i64::try_from(i).unwrap() + 1),
        )
        .await;
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(*blk)
            .bind(tag_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Initial index — all 3 blocks should resolve #[tag_id] → "meeting"
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let before = search_fts(&pool, "meeting", &page, None, None)
        .await
        .unwrap();
    // tag block itself + 3 content blocks
    assert!(
        before.items.len() >= 3,
        "expected at least 3 matches for 'meeting', got {}",
        before.items.len()
    );

    // Rename the tag
    sqlx::query("UPDATE blocks SET content = 'standup' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Reindex references (batched)
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // All 3 content blocks should now resolve to "standup"
    let after = search_fts(&pool, "standup", &page, None, None)
        .await
        .unwrap();
    let content_ids: Vec<&str> = after
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        content_ids.len(),
        3,
        "all 3 content blocks should match 'standup' after batched reindex, got: {content_ids:?}"
    );
    for blk in [blk1, blk2, blk3] {
        assert!(
            content_ids.contains(&blk),
            "block {blk} should be in results"
        );
    }

    // Old tag name should no longer match any content blocks
    let old = search_fts(&pool, "meeting", &page, None, None)
        .await
        .unwrap();
    let old_content: Vec<&str> = old
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        old_content.len(),
        0,
        "no content blocks should match old tag name 'meeting', got: {old_content:?}"
    );
}

#[tokio::test]
async fn reindex_fts_references_updates_tag_refs() {
    let (pool, _dir) = test_pool().await;

    // Use 26-char ULID-style IDs so TAG_REF_RE matches
    let tag_id = "01AAAAAAAAAAAAAAAAAAAAATAG";
    let blk_id = "01AAAAAAAAAAAAAAAAAAAABLK1";

    // Create a tag block and a content block referencing it
    insert_block(&pool, tag_id, "tag", "meeting", None, Some(1)).await;
    insert_block(
        &pool,
        blk_id,
        "content",
        &format!("notes about #[{tag_id}]"),
        None,
        Some(2),
    )
    .await;

    // Index the tag reference in block_tags
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(blk_id)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Index the content block — should resolve #[TAG_ID] to "meeting"
    update_fts_for_block(&pool, blk_id).await.unwrap();

    // Search for "meeting" — should find blk_id
    let results = search_fts(
        &pool,
        "meeting",
        &crate::pagination::PageRequest::new(None, Some(10)).unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        results.items.iter().any(|r| r.id == blk_id),
        "should find block when searching 'meeting'"
    );

    // Now rename the tag
    sqlx::query("UPDATE blocks SET content = 'standup' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Reindex references — should update block's FTS entry
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // Search for "standup" — should now find the block
    let results2 = search_fts(
        &pool,
        "standup",
        &crate::pagination::PageRequest::new(None, Some(10)).unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        results2.items.iter().any(|r| r.id == blk_id),
        "should find block when searching 'standup' after rename"
    );
}

#[tokio::test]
async fn reindex_fts_references_with_no_refs_is_noop() {
    let (pool, _dir) = test_pool().await;

    // Create an orphan tag with no references
    insert_block(&pool, "TAG_ORPHAN", "tag", "orphan", None, Some(1)).await;

    // Should succeed without errors even with no referencing blocks
    let result = reindex_fts_references(&pool, "TAG_ORPHAN").await;
    assert!(
        result.is_ok(),
        "reindex with no refs should be ok: {result:?}"
    );
}

#[tokio::test]
async fn reindex_fts_references_batch_50_blocks() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01CCCCCCCCCCCCCCCCCCCTAG50";
    insert_block(&pool, tag_id, "tag", "project", None, Some(0)).await;

    // Create 50 content blocks, each referencing the tag
    let mut block_ids: Vec<String> = Vec::with_capacity(50);
    for i in 0..50u64 {
        let blk = format!("01CCCCCCCCCCCCCCCCCBLK{i:04}");
        insert_block(
            &pool,
            &blk,
            "content",
            &format!("task {i} for #[{tag_id}]"),
            None,
            Some(i.cast_signed() + 1),
        )
        .await;
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&blk)
            .bind(tag_id)
            .execute(&pool)
            .await
            .unwrap();
        block_ids.push(blk);
    }

    // Initial index
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(100)).unwrap();
    let before = search_fts(&pool, "project", &page, None, None)
        .await
        .unwrap();
    assert!(
        before
            .items
            .iter()
            .filter(|r| r.block_type == "content")
            .count()
            >= 50,
        "expected at least 50 content matches for 'project' before rename"
    );

    // Rename the tag
    sqlx::query("UPDATE blocks SET content = 'initiative' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Batched reindex
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // All 50 blocks should now resolve to "initiative"
    let after = search_fts(&pool, "initiative", &page, None, None)
        .await
        .unwrap();
    let content_after: Vec<&str> = after
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        content_after.len(),
        50,
        "all 50 content blocks should match 'initiative', got {}",
        content_after.len()
    );
    for blk in &block_ids {
        assert!(
            content_after.contains(&blk.as_str()),
            "block {blk} missing from results"
        );
    }

    // Old name should no longer match any content blocks
    let old = search_fts(&pool, "project", &page, None, None)
        .await
        .unwrap();
    let old_content: Vec<&str> = old
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        old_content.len(),
        0,
        "no content blocks should match old name 'project', got: {old_content:?}"
    );
}

#[tokio::test]
async fn rebuild_fts_index_populates_empty_table() {
    let (pool, _dir) = test_pool().await;

    // Insert a block with content
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;

    // FTS table should be empty initially (no materializer ran)
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "FTS should be empty before rebuild");

    // Rebuild
    rebuild_fts_index(&pool).await.unwrap();

    // FTS table should now have the block
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "FTS should have 1 entry after rebuild");
}

// ======================================================================
// rebuild_fts_index_split tests
// ======================================================================

#[tokio::test]
async fn rebuild_fts_index_split_indexes_all_active_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "alpha content", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "beta content", None, Some(1)).await;
    insert_block(&pool, BLOCK_C, "content", "gamma content", None, Some(2)).await;

    rebuild_fts_index_split(&pool, &pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    let a = search_fts(&pool, "alpha", &page, None, None).await.unwrap();
    assert_eq!(a.items.len(), 1, "split rebuild should index alpha block");
    assert_eq!(
        a.items[0].id, BLOCK_A,
        "alpha search should return BLOCK_A after split rebuild"
    );

    let b = search_fts(&pool, "beta", &page, None, None).await.unwrap();
    assert_eq!(b.items.len(), 1, "split rebuild should index beta block");
    assert_eq!(
        b.items[0].id, BLOCK_B,
        "beta search should return BLOCK_B after split rebuild"
    );

    let g = search_fts(&pool, "gamma", &page, None, None).await.unwrap();
    assert_eq!(g.items.len(), 1, "split rebuild should index gamma block");
    assert_eq!(
        g.items[0].id, BLOCK_C,
        "gamma search should return BLOCK_C after split rebuild"
    );
}

#[tokio::test]
async fn rebuild_fts_index_split_excludes_deleted() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "visible", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "deleted content", None, Some(1)).await;
    soft_delete_block(&pool, BLOCK_B).await;

    rebuild_fts_index_split(&pool, &pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let deleted_results = search_fts(&pool, "deleted", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        deleted_results.items.len(),
        0,
        "deleted block should be excluded from split rebuild"
    );

    let visible_results = search_fts(&pool, "visible", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        visible_results.items.len(),
        1,
        "visible block should be indexed after split rebuild"
    );
}

#[tokio::test]
async fn rebuild_fts_index_split_resolves_refs() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;
    insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;

    let content = format!("task #[{TAG_ULID}] see [[{PAGE_ULID}]]");
    insert_block(&pool, BLOCK_A, "content", &content, None, Some(0)).await;

    rebuild_fts_index_split(&pool, &pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Should find by resolved tag name
    let tag_results = search_fts(&pool, "urgent", &page, None, None)
        .await
        .unwrap();
    assert!(
        !tag_results.items.is_empty(),
        "at least the tag block should match 'urgent'"
    );

    // Should find the content block by "task"
    let task_results = search_fts(&pool, "task", &page, None, None).await.unwrap();
    assert_eq!(
        task_results.items.len(),
        1,
        "split rebuild should resolve refs for search"
    );
    assert_eq!(
        task_results.items[0].id, BLOCK_A,
        "task search should return content block after split rebuild"
    );
}

#[tokio::test]
async fn rebuild_fts_index_split_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "first pass", None, Some(0)).await;
    rebuild_fts_index_split(&pool, &pool).await.unwrap();

    // Delete block and rebuild — stale FTS entry should be cleared
    soft_delete_block(&pool, BLOCK_A).await;
    rebuild_fts_index_split(&pool, &pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "first", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "stale FTS entry should be cleared after split rebuild"
    );
}

// ======================================================================
// update_fts_for_block_split tests
// ======================================================================

#[tokio::test]
async fn update_fts_for_block_split_indexes_active_block() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "split indexing works great",
        None,
        Some(0),
    )
    .await;
    // Pass pool as both write and read pool (test pool is a single combined pool)
    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "split", &page, None, None).await.unwrap();
    assert_eq!(
        results.items.len(),
        1,
        "split variant should index active block into FTS"
    );
    assert_eq!(
        results.items[0].id, BLOCK_A,
        "split variant search result should be the indexed block"
    );
}

#[tokio::test]
async fn update_fts_for_block_split_removes_deleted_block() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "will be deleted soon",
        None,
        Some(0),
    )
    .await;
    // First index it
    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    // Soft-delete and re-run split
    soft_delete_block(&pool, BLOCK_A).await;
    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "deleted", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "split variant should remove deleted block from FTS index"
    );
}

#[tokio::test]
async fn update_fts_for_block_split_removes_conflict_block() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "conflict block content",
        None,
        Some(0),
    )
    .await;
    // First index it
    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    // Mark as conflict and re-run split
    mark_conflict(&pool, BLOCK_A).await;
    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "conflict", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "split variant should remove conflict block from FTS index"
    );
}

#[tokio::test]
async fn update_fts_for_block_split_handles_missing_block() {
    let (pool, _dir) = test_pool().await;
    // Should not error for a block that doesn't exist
    let result = update_fts_for_block_split(&pool, &pool, "NONEXISTENT00000000000000").await;
    assert!(
        result.is_ok(),
        "split variant should not error for nonexistent block"
    );
}

#[tokio::test]
async fn update_fts_for_block_split_handles_null_content() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_null_content(&pool, BLOCK_A, "content").await;

    update_fts_for_block_split(&pool, &pool, BLOCK_A)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let results = search_fts(&pool, "content", &page, None, None)
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "split variant should not index block with NULL content"
    );
}
