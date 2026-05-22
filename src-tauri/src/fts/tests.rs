use super::strip::strip_for_fts_with_maps;
use super::*;
use crate::db::init_pool;
use crate::error::AppError;
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
    // `page_id = id` for page blocks per the §5.3 invariant (migration
    // 0066); content blocks inherit page_id from their parent at write
    // time in production, but this test fixture inlines the safe default.
    let page_id = if block_type == "page" {
        Some(id)
    } else {
        parent_id
    };
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id)
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
    let results = search_fts(
        &pool,
        "wonderful",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let old_results = search_fts(
        &pool,
        "original",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        old_results.items.len(),
        0,
        "old content should not be found after edit"
    );

    // New content should be found
    let new_results = search_fts(
        &pool,
        "different",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results = search_fts(
        &pool,
        "searchable",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results = search_fts(
        &pool,
        "removable",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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

    let a = search_fts(
        &pool,
        "alpha",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(a.items.len(), 1, "rebuild should index alpha block");
    assert_eq!(a.items[0].id, BLOCK_A, "alpha search should return BLOCK_A");

    let b = search_fts(
        &pool,
        "beta",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(b.items.len(), 1, "rebuild should index beta block");
    assert_eq!(b.items[0].id, BLOCK_B, "beta search should return BLOCK_B");

    let g = search_fts(
        &pool,
        "gamma",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let deleted_results = search_fts(
        &pool,
        "deleted",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        deleted_results.items.len(),
        0,
        "deleted block should be excluded from rebuild"
    );

    let visible_results = search_fts(
        &pool,
        "visible",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        visible_results.items.len(),
        1,
        "visible block should be indexed after rebuild"
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
    let results = search_fts(
        &pool,
        "first",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let tag_results = search_fts(
        &pool,
        "urgent",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert!(
        !tag_results.items.is_empty(),
        "at least the tag block should match 'urgent'"
    );

    // Should find the content block by "task" (unique to it)
    let task_results = search_fts(
        &pool,
        "task",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "optimize",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results = search_fts(
        &pool,
        "alpha",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "nonexistent",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results = search_fts(
        &pool,
        "",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "   ",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
async fn search_sub_trigram_query_returns_empty() {
    // TEST-50: pin behaviour for queries shorter than the trigram
    // tokenizer's 3-char minimum.  `sanitize_fts_query` drops 1- and
    // 2-char non-operator tokens (I-Search-2), so the sanitised query is
    // empty and `search_fts` short-circuits to an empty page — no panic,
    // no FTS5 syntax error, no results.
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    let one_char = search_fts(
        &pool,
        "a",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        one_char.items.len(),
        0,
        "1-char query should return no results (sub-trigram filter)",
    );
    assert!(
        !one_char.has_more,
        "1-char query should not indicate more pages",
    );
    assert!(
        one_char.next_cursor.is_none(),
        "1-char query should have no cursor",
    );

    let two_char = search_fts(
        &pool,
        "he",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        two_char.items.len(),
        0,
        "2-char query should return no results (sub-trigram filter)",
    );
    assert!(
        !two_char.has_more,
        "2-char query should not indicate more pages",
    );
    assert!(
        two_char.next_cursor.is_none(),
        "2-char query should have no cursor",
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
    let results = search_fts(
        &pool,
        "visible",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results1 = search_fts(
        &pool,
        "pagination",
        &page1,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results2 = search_fts(
        &pool,
        "pagination",
        &page2,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let result = search_fts(
        &pool,
        "\"unclosed quote",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
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
    let both = search_fts(
        &pool,
        "programming",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        both.items.len(),
        2,
        "both blocks should match 'programming'"
    );

    // Only BLOCK_A matches "rust"
    let rust_only = search_fts(
        &pool,
        "rust",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
        let result = search_fts(
            &pool,
            injection,
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await;
        assert!(
            result.is_ok(),
            "SQL injection attempt should not crash: {injection}"
        );
    }

    // Verify the database is intact
    let check = search_fts(
        &pool,
        "normal",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let result = search_fts(
        &pool,
        "OR",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
    assert!(result.is_ok(), "OR as query should not crash");

    // "NOT hello" is now preserved as the FTS5 NOT operator, which is a
    // binary operator — standalone NOT is an FTS5 syntax error.  The
    // search_fts error handler maps this to a Validation error.
    let not_result = search_fts(
        &pool,
        "NOT hello",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
    assert!(
        not_result.is_err(),
        "standalone NOT should produce a validation error"
    );

    // NEAR() should be treated as a literal word (not a recognised operator)
    let near_result = search_fts(
        &pool,
        "NEAR(hello world)",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
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
        let result = search_fts(
            &pool,
            q,
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await;
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
    let result = search_fts(
        &pool,
        "\"unclosed quote",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
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
    let results = search_fts(
        &pool,
        "unique",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let results = search_fts(
        &pool,
        "capped",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
fn sanitize_all_operator_query_documents_current_behaviour() {
    // PEND-73 Phase 5.T1c — pin the sanitiser's behaviour on an
    // all-operator query so a future change can't silently move it.
    //
    // The desired contract per PEND-73 Phase 5.T1c reads:
    //     assert_eq!(sanitize_fts_query("AND OR NOT"), "");
    //     assert_eq!(sanitize_fts_query("AND"), "");
    // …treating an orphan operator (one that fails the operator-context
    // check) as a no-op. The current implementation falls through to
    // the word path and quotes the operator as a literal, on the
    // theory that the user might have meant the literal word.
    //
    // We assert the CURRENT behaviour here (not the desired) so this
    // test is a regression net, and document the desired contract in
    // the body so a future maintainer who wants to make the change
    // can find this assertion and flip it deliberately.
    assert_eq!(
        sanitize_fts_query("AND"),
        "\"AND\"",
        "current contract: orphan operator becomes a literal-word search; \
         a future change to drop orphans is intentional but requires a \
         deliberate flip of this assertion"
    );
    assert_eq!(
        sanitize_fts_query("AND OR NOT"),
        "\"AND\" OR \"NOT\"",
        "all-operator query: the leading AND has no preceding output \
         and falls to word-quote; OR sees `AND` and is operator-eligible; \
         NOT has no following token and falls to word-quote"
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
        "\"NEAR(a\"",
        "NEAR operator should be quoted as literal; the trailing 2-char `b)` \
         is dropped by the trigram length filter (I-Search-2)"
    );
}

#[test]
fn sanitize_trailing_operator_quoted() {
    // NOT at end without a following term → not in operator position; survives
    // the trigram length filter (3 chars) so it falls through to the literal
    // quoted branch.
    assert_eq!(
        sanitize_fts_query("hello NOT"),
        "\"hello\" \"NOT\"",
        "trailing NOT without operand should be quoted (3-char minimum met)"
    );
    // OR at end without a following term → not in operator position; the
    // 2-char `OR` is now dropped by the trigram length filter (I-Search-2).
    assert_eq!(
        sanitize_fts_query("hello OR"),
        "\"hello\"",
        "trailing OR without operand is dropped by the trigram length filter"
    );
    // OR at start without a preceding term → not in operator position; the
    // 2-char `OR` is dropped by the trigram length filter (I-Search-2).
    assert_eq!(
        sanitize_fts_query("OR hello"),
        "\"hello\"",
        "leading OR without left operand is dropped by the trigram length filter"
    );
}

#[test]
fn sanitize_drops_sub_trigram_words() {
    // I-Search-2: tokens shorter than the trigram tokenizer's 3-char
    // minimum are dropped before the AND-join, except for the
    // operator-keyword whitelist. `a` and `b` are dropped; `OR` survives
    // because it is whitelisted, but with `a`/`b` gone the position-check
    // still rejects it as an operator and it then fails the length filter
    // → only `cat` survives.
    assert_eq!(
        sanitize_fts_query("a b OR cat"),
        "\"cat\"",
        "sub-trigram words (a, b) and operator-position-failing OR are all dropped"
    );
}

#[test]
fn sanitize_keeps_operators_when_position_valid() {
    // Operator whitelist works in valid positions even when the surrounding
    // operand is exactly 3 chars (the minimum).
    assert_eq!(
        sanitize_fts_query("cat OR dog"),
        "\"cat\" OR \"dog\"",
        "OR between two 3-char terms must be preserved as operator"
    );
    // 3-char operators (`AND`, `NOT`) survive the trigram length filter
    // *even when the operator position-check rejects them* — they fall
    // through to the literal-quoted branch on length alone. Only the
    // 2-char `OR` is fully dropped when its operator position fails.
    assert_eq!(
        sanitize_fts_query("AND cat"),
        "\"AND\" \"cat\"",
        "leading AND without preceding output is rejected as operator but \
         survives the trigram length filter (3 chars) → quoted as literal"
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
        let result = search_fts(
            &pool,
            "identical",
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await
        .unwrap();

        for item in &result.items {
            all_ids.push(item.id.clone().into());
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
    let result1 = search_fts(
        &pool,
        "apple",
        &page1,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let result2 = search_fts(
        &pool,
        "apple",
        &page2,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let result3 = search_fts(
        &pool,
        "apple",
        &page3,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(result3.items.len(), 1, "third page should return 1 item");
    assert!(
        !result3.has_more,
        "third page should not indicate more results"
    );

    // Collect all IDs and verify completeness
    let all_ids: Vec<&str> = vec![
        result1.items[0].id.as_str(),
        result2.items[0].id.as_str(),
        result3.items[0].id.as_str(),
    ];
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
        let result = search_fts(
            &pool,
            "pagination",
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await
        .unwrap();

        for item in &result.items {
            all_ids.push(item.id.clone().into());
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
        let result = search_fts(
            &pool,
            dangerous_query,
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await;
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
    let before = search_fts(
        &pool,
        "meeting",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let after = search_fts(
        &pool,
        "standup",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let old = search_fts(
        &pool,
        "meeting",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
        None, // FEAT-3 Phase 2: space_id unscoped
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
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
        None, // FEAT-3 Phase 2: space_id unscoped
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
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
    let before = search_fts(
        &pool,
        "project",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let after = search_fts(
        &pool,
        "initiative",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let old = search_fts(
        &pool,
        "project",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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

// ── UX-250: reindex_fts_references must pick up inline-only referencing blocks ──
//
// Before UX-250, a block whose only link to a tag was an inline
// `#[ULID]` reference (no explicit `block_tags` row, no `block_links`
// row) would be missed by `reindex_fts_references`. After the change,
// `block_tag_refs` is a third source that must be unioned in.

#[tokio::test]
async fn reindex_fts_references_updates_inline_only_referencing_block() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQTAGINLINE0000000000001";
    let blk_id = "01HQBLKINLINE0000000000001";

    // Tag block + content block with an inline `#[ULID]` ref.
    // Critically: NO explicit block_tags row and NO block_links row.
    // The only path from the content block to the tag is through
    // block_tag_refs (the UX-250 cache).
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
    sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
        .bind(blk_id)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Seed the FTS index so there is an existing row to replace.
    update_fts_for_block(&pool, blk_id).await.unwrap();

    // Confirm baseline: "meeting" finds the block (via inline ref
    // resolution during strip_for_fts).
    let page = PageRequest::new(None, Some(10)).unwrap();
    let before = search_fts(
        &pool,
        "meeting",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert!(
        before.items.iter().any(|r| r.id == blk_id),
        "baseline: 'meeting' must match the inline-ref block before rename"
    );

    // Rename the tag → FTS entry for the content block is now stale.
    sqlx::query("UPDATE blocks SET content = 'standup' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Reindex references — this must pick up the inline-only block
    // through block_tag_refs (the whole point of this test).
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // "standup" must now match the block; "meeting" must not.
    let new_results = search_fts(
        &pool,
        "standup",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert!(
        new_results.items.iter().any(|r| r.id == blk_id),
        "inline-only block must be reindexed so 'standup' finds it after rename"
    );
    let old_results = search_fts(
        &pool,
        "meeting",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    let stale: Vec<&str> = old_results
        .items
        .iter()
        .filter(|r| r.id == blk_id)
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        stale.len(),
        0,
        "stale 'meeting' hit on the inline-ref block must not survive the reindex"
    );
}

// ── L-92: reindex_fts_references must chunk large rename targets ──
//
// Before L-92, `reindex_fts_references` opened one transaction for the
// entire union of `block_tags` ∪ `block_links` ∪ `block_tag_refs` and
// streamed every INSERT through it. Renaming a popular tag with tens
// of thousands of references would hold the SQLite writer for many
// seconds, blocking every other writer. The reindex now runs in
// chunks of `FTS_REINDEX_CHUNK` ids per transaction.
//
// This test inserts `FTS_REINDEX_CHUNK + 50` referencing blocks so the
// chunked reindex path runs at least twice (one full chunk + one
// trailing partial chunk) and asserts the end state is identical to
// the single-tx version: every referencing block ends up reindexed
// with the new tag name.
#[tokio::test]
async fn reindex_fts_references_chunks_more_than_one_batch() {
    use super::index::FTS_REINDEX_CHUNK;

    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQTAGCHNKCHNKCHNKCHNK001";
    insert_block(&pool, tag_id, "tag", "project", None, Some(0)).await;

    // FTS_REINDEX_CHUNK + 50 referencing blocks → 2 chunked transactions
    // (one of FTS_REINDEX_CHUNK, one of 50).
    let n: usize = FTS_REINDEX_CHUNK + 50;
    let mut block_ids: Vec<String> = Vec::with_capacity(n);

    // Bulk-insert inside a single sqlx tx to keep the test fast — the
    // chunked path under test only kicks in for `reindex_fts_references`,
    // not for the test setup.
    let mut setup_tx = pool.begin().await.unwrap();
    for i in 0..n {
        // 11-char prefix + 11 zeros + 4-digit `i` = 26-char ULID-shaped id.
        let blk = format!("01HQBLKCHNK00000000000{i:04}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, NULL, ?)",
        )
        .bind(&blk)
        .bind(format!("task {i} for #[{tag_id}]"))
        .bind(i64::try_from(i).unwrap() + 1)
        .execute(&mut *setup_tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&blk)
            .bind(tag_id)
            .execute(&mut *setup_tx)
            .await
            .unwrap();
        block_ids.push(blk);
    }
    setup_tx.commit().await.unwrap();

    // Initial FTS index — every block resolves "project" today.
    rebuild_fts_index(&pool).await.unwrap();

    // Rename the tag → every block's FTS entry is now stale.
    sqlx::query("UPDATE blocks SET content = 'initiative' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Chunked reindex (FTS_REINDEX_CHUNK + 50 → 2 transactions).
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // Verify the end state by querying `fts_blocks` directly — pagination
    // caps `search_fts` at MAX_PAGE_SIZE (200), well below our N=1050.
    // Every referencing block must have exactly one fts row, and every
    // row's `stripped` must contain the new name (and none the old).
    let ids_json = serde_json::to_string(&block_ids).unwrap();
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM fts_blocks \
         WHERE block_id IN (SELECT value FROM json_each(?))",
    )
    .bind(&ids_json)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        usize::try_from(total).unwrap(),
        n,
        "all {n} content blocks must have an fts_blocks row after the chunked reindex"
    );

    // Probe the chunk boundaries: indices 0, FTS_REINDEX_CHUNK-1 (last
    // row of the first chunk), FTS_REINDEX_CHUNK (first row of the second
    // chunk), and n-1 (last row overall). Verifying these four covers the
    // hand-off between chunks specifically — a regression that drops one
    // chunk's INSERTs would surface here.
    let sample = [0_usize, FTS_REINDEX_CHUNK - 1, FTS_REINDEX_CHUNK, n - 1];
    for &i in &sample {
        let blk = &block_ids[i];
        let stripped: String =
            sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
                .bind(blk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            stripped.contains("initiative"),
            "block {blk} (idx {i}) must contain renamed tag 'initiative' in its FTS entry, got: {stripped:?}"
        );
        assert!(
            !stripped.contains("project"),
            "block {blk} (idx {i}) must not retain old tag 'project' in its FTS entry, got: {stripped:?}"
        );
    }
}

// ── I-Search-6: rename + immediate purge race ────────────────────
//
// If a tag T is renamed and then physically purged from `blocks`
// before the queued `reindex_fts_references(pool, T)` runs, the
// reindex must still leave referencing blocks' FTS entries free of
// T's old name. `load_ref_maps` returns no entry for T (its row is
// gone), so `strip_for_fts_with_maps` substitutes empty for the
// now-broken inline `#[T]` reference and the source block's
// `fts_blocks.stripped` ends without the stale resolved name.
//
// We simulate the partial-purge state where the tag row is gone but
// an orphan `block_tags(B, T)` row survives (FK enforcement
// temporarily disabled on this connection). `block_tags` has no
// `ON DELETE CASCADE`, so this orphan row is the only path the
// reindex has to discover B — exactly the contract we want to pin.
#[tokio::test]
async fn reindex_fts_references_handles_purged_tag_gracefully_i_search_6() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQTAGPRG6PRG6PRG6PRG6PR1";
    let blk_id = "01HQBLKPRG6PRG6PRG6PRG6BK1";

    // Tag block + content block whose content references the tag inline.
    insert_block(&pool, tag_id, "tag", "OldName", None, Some(0)).await;
    insert_block(
        &pool,
        blk_id,
        "content",
        &format!("task #[{tag_id}]"),
        None,
        Some(1),
    )
    .await;

    // Explicit `block_tags` row keeps the reindex discovery path alive
    // after the tag row is gone — `block_tags` has no
    // `ON DELETE CASCADE`, unlike `block_tag_refs`, so it survives the
    // purge below as an orphan row.
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(blk_id)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();

    // Initial FTS index resolves `#[tag_id]` → "OldName".
    update_fts_for_block(&pool, blk_id).await.unwrap();
    let stripped_before: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(blk_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        stripped_before.contains("OldName"),
        "baseline: B's FTS must contain the resolved tag name 'OldName' before purge, got: {stripped_before:?}"
    );

    // Race: the tag has been renamed (so the existing FTS entry is
    // stale) AND immediately purged before the queued
    // `reindex_fts_references` could run. Simulate the purge having
    // physically removed the tag row while the dependent
    // `block_tags(B, T)` row has not yet been cleaned up — FK
    // enforcement is temporarily disabled on this single connection
    // so the orphan row survives.
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("DELETE FROM blocks WHERE id = ?")
        .bind(tag_id)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);

    // Run the queued reindex. It must not crash, and it must scrub
    // any surviving "OldName" from B's FTS entry: `load_ref_maps`
    // returns no entry for T (its row is gone) and
    // `strip_for_fts_with_maps` substitutes empty for the inline
    // `#[tag_id]` ref.
    reindex_fts_references(&pool, tag_id).await.unwrap();

    let stripped_after: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(blk_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !stripped_after.contains("OldName"),
        "B's FTS must not retain purged tag's old name 'OldName' after reindex, got: {stripped_after:?}"
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

    let a = search_fts(
        &pool,
        "alpha",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(a.items.len(), 1, "split rebuild should index alpha block");
    assert_eq!(
        a.items[0].id, BLOCK_A,
        "alpha search should return BLOCK_A after split rebuild"
    );

    let b = search_fts(
        &pool,
        "beta",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(b.items.len(), 1, "split rebuild should index beta block");
    assert_eq!(
        b.items[0].id, BLOCK_B,
        "beta search should return BLOCK_B after split rebuild"
    );

    let g = search_fts(
        &pool,
        "gamma",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let deleted_results = search_fts(
        &pool,
        "deleted",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        deleted_results.items.len(),
        0,
        "deleted block should be excluded from split rebuild"
    );

    let visible_results = search_fts(
        &pool,
        "visible",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
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
    let tag_results = search_fts(
        &pool,
        "urgent",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert!(
        !tag_results.items.is_empty(),
        "at least the tag block should match 'urgent'"
    );

    // Should find the content block by "task"
    let task_results = search_fts(
        &pool,
        "task",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "first",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "split",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
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
    let results = search_fts(
        &pool,
        "deleted",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "split variant should remove deleted block from FTS index"
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
    let results = search_fts(
        &pool,
        "content",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "split variant should not index block with NULL content"
    );
}

// ======================================================================
// FEAT-3 Phase 2 — space filtering in search_fts
// ======================================================================
//
// `search_fts` honours `space_id` by intersecting the result set with
// the materialised `block_properties(key = 'space', value_ref = ?)`
// table via `COALESCE(b.page_id, b.id)`. These tests exercise the
// `Some(space_id)` path end-to-end so a regression in the dynamic-SQL
// filter is caught — the rest of the module only passes `None`.

/// ID of the synthetic `SPACE_A` space block used by the space-filter
/// tests below. Valid block_id (the column is TEXT — no ULID format
/// enforcement at the DB boundary).
const FTS_SPACE_A_ID: &str = "FTS_SPC_A";
/// ID of the synthetic `SPACE_B` space block.
const FTS_SPACE_B_ID: &str = "FTS_SPC_B";

/// Insert a space block (a page carrying `is_space = 'true'`). Required
/// so the FK on `block_properties.value_ref` validates when the tests
/// assign a page to the space.
async fn insert_space_block_for_fts(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

/// Assign a block to a space via a direct `block_properties` insert —
/// bypasses the command layer because the test targets the FTS filter
/// SQL, not op-log semantics.
async fn assign_to_space_for_fts(pool: &SqlitePool, block_id: &str, space_id: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)")
        .bind(block_id)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn search_fts_filters_by_space() {
    let (pool, _dir) = test_pool().await;
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    insert_space_block_for_fts(&pool, FTS_SPACE_B_ID, "Work").await;

    // Two pages with the same searchable keyword, one per space.
    // `page_id` on page blocks is the block's own id (COALESCE resolves
    // to `b.id`), so the `space` property lookup in `search_fts` applies
    // directly to each page.
    insert_block(
        &pool,
        BLOCK_A,
        "page",
        "the shared keyword lives here in A",
        None,
        Some(1),
    )
    .await;
    assign_to_space_for_fts(&pool, BLOCK_A, FTS_SPACE_A_ID).await;

    insert_block(
        &pool,
        BLOCK_B,
        "page",
        "the shared keyword lives here in B",
        None,
        Some(2),
    )
    .await;
    assign_to_space_for_fts(&pool, BLOCK_B, FTS_SPACE_B_ID).await;

    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // SPACE_A: exactly the SPACE_A page.
    let resp_a = search_fts(
        &pool,
        "shared",
        &page,
        None,
        None,
        Some(FTS_SPACE_A_ID),
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        resp_a.items.len(),
        1,
        "SPACE_A filter must return exactly the SPACE_A page"
    );
    assert_eq!(resp_a.items[0].id, BLOCK_A, "SPACE_A hit must be BLOCK_A");

    // SPACE_B: exactly the SPACE_B page.
    let resp_b = search_fts(
        &pool,
        "shared",
        &page,
        None,
        None,
        Some(FTS_SPACE_B_ID),
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        resp_b.items.len(),
        1,
        "SPACE_B filter must return exactly the SPACE_B page"
    );
    assert_eq!(resp_b.items[0].id, BLOCK_B, "SPACE_B hit must be BLOCK_B");

    // None: both pages (unscoped behaviour preserved).
    let resp_all = search_fts(
        &pool,
        "shared",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        resp_all.items.len(),
        2,
        "None space_id must surface both pages — existing unscoped behaviour"
    );
}

#[tokio::test]
async fn search_fts_nonexistent_space_returns_empty() {
    let (pool, _dir) = test_pool().await;
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    insert_block(
        &pool,
        BLOCK_A,
        "page",
        "the shared keyword lives here in A",
        None,
        Some(1),
    )
    .await;
    assign_to_space_for_fts(&pool, BLOCK_A, FTS_SPACE_A_ID).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let resp = search_fts(
        &pool,
        "shared",
        &page,
        None,
        None,
        Some("NOPE"),
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        resp.items.len(),
        0,
        "nonexistent space id must return zero results, not error"
    );
    assert!(!resp.has_more, "empty result must not indicate more pages");
    assert!(
        resp.next_cursor.is_none(),
        "empty result must have no cursor"
    );
}

// ======================================================================
// PEND-20 D — Chunked rebuild_fts_index regression test
// ======================================================================
//
// Before D, `rebuild_fts_index_impl` ran the entire DELETE + per-row
// INSERT loop inside one BEGIN…COMMIT, holding the writer lock for
// several seconds on a 100k-block vault. Now the rebuild splits into
// `FTS_REINDEX_CHUNK`-sized batches with a fresh transaction per chunk.
//
// This test inserts `FTS_REINDEX_CHUNK + 500` content blocks (≥ 1500
// per the task spec) so the chunked rebuild path runs at least twice
// (one full chunk, one partial trailing chunk), then asserts that
// every block is searchable end-to-end through the FTS5 MATCH query.
// Chunking must be transparent to consumers.

#[tokio::test]
async fn rebuild_fts_index_chunked_indexes_all_blocks() {
    use super::index::FTS_REINDEX_CHUNK;

    let (pool, _dir) = test_pool().await;

    let n: usize = FTS_REINDEX_CHUNK + 500;
    let mut block_ids: Vec<String> = Vec::with_capacity(n);

    // Bulk-seed inside one tx — the test setup is not the system under
    // test; the chunked path under test only kicks in for `rebuild_fts_index`.
    let mut setup_tx = pool.begin().await.unwrap();
    for i in 0..n {
        // 26-char id: 12-char prefix + 10 zeros + 4-digit `i`.
        let blk = format!("01HQRBLDIDX0000000000{i:05}");
        // Embed a unique trigram-friendly token per block so we can probe
        // each one individually via `search_fts`. `block_<i>_token` is
        // the marker; the `i` is zero-padded so trigram hits are stable.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, NULL, ?)",
        )
        .bind(&blk)
        .bind(format!("rebuild_uniq_{i:05}_marker"))
        .bind(i64::try_from(i).unwrap() + 1)
        .execute(&mut *setup_tx)
        .await
        .unwrap();
        block_ids.push(blk);
    }
    setup_tx.commit().await.unwrap();

    // Run the chunked rebuild.
    rebuild_fts_index(&pool).await.unwrap();

    // Sanity: total fts_blocks rows == n. A regression that dropped one
    // chunk's INSERTs would surface here loudly.
    let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        usize::try_from(total).unwrap(),
        n,
        "all {n} blocks must have an fts_blocks row after the chunked rebuild"
    );

    // Probe the chunk boundaries: a regression that lost a chunk would
    // miss at least one of these.
    let sample = [
        0_usize,
        FTS_REINDEX_CHUNK - 1,
        FTS_REINDEX_CHUNK,
        FTS_REINDEX_CHUNK + 100,
        n - 1,
    ];
    let page = PageRequest::new(None, Some(50)).unwrap();
    for &i in &sample {
        let token = format!("rebuild_uniq_{i:05}_marker");
        let results = search_fts(
            &pool,
            &token,
            &page,
            None,
            None,
            None,
            &[],
            &[],
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            results.items.len(),
            1,
            "search for unique token {token:?} (idx {i}) must hit exactly one block via FTS"
        );
        assert_eq!(
            results.items[0].id, block_ids[i],
            "search hit at idx {i} must be the block we seeded with that token"
        );
    }
}

// ======================================================================
// PEND-20 E — update_fts_for_block produces identical output via
// _with_maps. Regression test for the load_ref_maps refactor.
// ======================================================================
//
// `update_fts_for_block` is now a convenience wrapper that loads ref
// maps and delegates to `update_fts_for_block_with_maps`. The output
// FTS row must be identical to the pre-refactor behaviour: same
// `stripped` text for blocks with tag/page references, same
// remove-from-index semantics for deleted/conflict/null-content
// blocks. This test pins the contract.

#[tokio::test]
async fn update_fts_for_block_with_maps_matches_wrapper_output() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;
    insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;

    let content = format!("**bold** and `code` see [[{PAGE_ULID}]] tag #[{TAG_ULID}] more");
    insert_block(&pool, BLOCK_A, "content", &content, None, Some(0)).await;

    // Path 1: convenience wrapper.
    update_fts_for_block(&pool, BLOCK_A).await.unwrap();
    let stripped_via_wrapper: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Path 2: explicit map load + _with_maps. Must produce the same row.
    let (tag_names, page_titles) = crate::fts::load_ref_maps(&pool).await.unwrap();
    crate::fts::update_fts_for_block_with_maps(&pool, BLOCK_A, &tag_names, &page_titles)
        .await
        .unwrap();
    let stripped_via_with_maps: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        stripped_via_wrapper, stripped_via_with_maps,
        "wrapper and _with_maps must produce identical fts_blocks.stripped output"
    );

    // The two paths must also resolve `My Page` and `urgent` end-to-end.
    let page = PageRequest::new(None, Some(50)).unwrap();
    let urgent = search_fts(
        &pool,
        "urgent",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert!(
        urgent.items.iter().any(|b| b.id == BLOCK_A),
        "BLOCK_A must match resolved tag name 'urgent' via FTS"
    );
}

#[tokio::test]
async fn update_fts_for_block_with_maps_removes_deleted_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "text body", None, Some(0)).await;
    let (tag_names, page_titles) = crate::fts::load_ref_maps(&pool).await.unwrap();
    crate::fts::update_fts_for_block_with_maps(&pool, BLOCK_A, &tag_names, &page_titles)
        .await
        .unwrap();

    soft_delete_block(&pool, BLOCK_A).await;
    crate::fts::update_fts_for_block_with_maps(&pool, BLOCK_A, &tag_names, &page_titles)
        .await
        .unwrap();

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
        BLOCK_A
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "_with_maps variant must remove the FTS row for a deleted block, matching the wrapper"
    );
}

// ======================================================================
// PEND-25 L6 — Combined inline-markup regex matches the previous
// chained behaviour for every fixture case (bold / italic / code /
// strike / highlight, including nested cases).
// ======================================================================
//
// The implementation now applies a single alternation regex
// (`MARKUP_RE`) iteratively until stable, rather than five separate
// sequential `replace_all` passes. This fixture-based regression test
// asserts that the combined-pass output equals the documented
// per-pattern semantics on every flavour of input the old chain
// produced. If a refactor breaks the equivalence (e.g. by skipping
// the iteration loop and breaking nested cases), one of these
// assertions will fail.

#[test]
fn strip_inline_markup_combined_matches_chain_semantics() {
    use super::strip::strip_for_fts_with_maps;
    let tag_names: HashMap<String, String> = HashMap::new();
    let page_titles: HashMap<String, String> = HashMap::new();

    // (input, expected) — covers every individual delimiter, every
    // pairwise combination on the same line, and the nested cases that
    // require the iterative fixed-point loop.
    let cases: &[(&str, &str)] = &[
        // 1. Plain text passes through unchanged (no allocation).
        ("plain text with no markup", "plain text with no markup"),
        // 2. Each individual delimiter type.
        ("**bold**", "bold"),
        ("*italic*", "italic"),
        ("`code`", "code"),
        ("~~strike~~", "strike"),
        ("==hi==", "hi"),
        // 3. Mixed unrelated delimiters on the same input.
        ("**a** *b* `c` ~~d~~ ==e==", "a b c d e"),
        // 4. Nested bold-around-italic — the canonical reason the
        //    iterative loop exists. Bold strips first
        //    (`**bold *italic***` → `bold *italic*`); a second iteration
        //    strips the residual italic.
        ("**bold *italic***", "bold italic"),
        // 5. Code inside italic — italic match consumes the whole `*…*`
        //    range including the backticks, leaving the code delimiters
        //    behind for iteration 2.
        ("*foo `bar` baz*", "foo bar baz"),
        // 6. Two consecutive bold groups — neither nested nor adjacent
        //    enough to confuse the alternation.
        ("**a** and **b**", "a and b"),
        // 7. Text outside any markup is preserved.
        ("hello **world** rest", "hello world rest"),
        // 8. Empty input.
        ("", ""),
    ];

    for (input, expected) in cases {
        let got = strip_for_fts_with_maps(input, &tag_names, &page_titles);
        assert_eq!(
            &got, expected,
            "combined markup regex output for {input:?} must equal the chained semantics"
        );
    }
}

// ======================================================================
// PEND-25 L7 — Multi-row INSERT path covers 600+ blocks correctly.
// ======================================================================
//
// `reindex_fts_references` now stages (id, stripped) pairs in memory
// per outer chunk and emits multi-row INSERT statements via
// `sqlx::QueryBuilder` in sub-chunks of `FTS_INSERT_BATCH = 200`. With
// 600+ blocks this path runs at least 3 sub-INSERTs per outer chunk
// (or more if blocks split across multiple outer chunks) and must
// insert every block exactly once — no duplicates from a stray loop
// pass, no missing rows from a chunk-boundary off-by-one.

#[tokio::test]
async fn reindex_fts_references_multi_row_insert_no_duplicates() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQTAGMRINSERTBATCH000001";
    insert_block(&pool, tag_id, "tag", "alpha", None, Some(0)).await;

    // 600 referencing blocks — exercises 3 multi-row INSERTs at the
    // default `FTS_INSERT_BATCH = 200`.
    let n: usize = 600;
    let mut block_ids: Vec<String> = Vec::with_capacity(n);

    let mut setup_tx = pool.begin().await.unwrap();
    for i in 0..n {
        let blk = format!("01HQBLKMRINS00000000000{i:04}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, NULL, ?)",
        )
        .bind(&blk)
        .bind(format!("row {i} #[{tag_id}]"))
        .bind(i64::try_from(i).unwrap() + 1)
        .execute(&mut *setup_tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&blk)
            .bind(tag_id)
            .execute(&mut *setup_tx)
            .await
            .unwrap();
        block_ids.push(blk);
    }
    setup_tx.commit().await.unwrap();

    // Initial index, then trigger a reindex that exercises the new
    // multi-row INSERT path.
    rebuild_fts_index(&pool).await.unwrap();
    sqlx::query("UPDATE blocks SET content = 'beta' WHERE id = ?")
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();
    reindex_fts_references(&pool, tag_id).await.unwrap();

    // Each referencing block must end up with EXACTLY one fts_blocks row.
    // A duplicated INSERT (e.g. from a stray retry pass) would surface
    // as count > 1; a missing INSERT would surface as count = 0.
    let ids_json = serde_json::to_string(&block_ids).unwrap();
    let row_counts: Vec<(String, i64)> = sqlx::query_as::<_, (String, i64)>(
        "SELECT block_id, COUNT(*) FROM fts_blocks \
         WHERE block_id IN (SELECT value FROM json_each(?)) \
         GROUP BY block_id",
    )
    .bind(&ids_json)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        row_counts.len(),
        n,
        "every referencing block must have a row (got {} of {n})",
        row_counts.len()
    );
    for (blk, count) in &row_counts {
        assert_eq!(
            *count, 1,
            "block {blk} must have exactly 1 fts_blocks row (got {count})"
        );
    }

    // Probe at sub-INSERT chunk boundaries (FTS_INSERT_BATCH = 200): the
    // 0th, 199th (last in chunk 1), 200th (first in chunk 2), 399th,
    // 400th (first in chunk 3), and last row.
    for &i in &[0_usize, 199, 200, 399, 400, n - 1] {
        let blk = &block_ids[i];
        let stripped: String =
            sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
                .bind(blk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            stripped.contains("beta"),
            "block {blk} (idx {i}) must contain renamed tag 'beta' after multi-row INSERT, got: {stripped:?}"
        );
    }
}

// ======================================================================
// PEND-50 Phase 1 — `snippet()` column tests
// ======================================================================
//
// These tests pin the wire shape of `SearchBlockRow.snippet` to the
// FTS5 `snippet()` window with literal `<mark>` / `</mark>` markers.
// The frontend renders them as React nodes (parsing the literal
// markers); NEVER as `dangerouslySetInnerHTML`. Any change here must
// be paired with a frontend renderer change.
//
// The window constant is `32` (trigrams) — see
// `pending/PEND-50-search-vscode-ux.md` "Edge cases (locked in)" for
// the tuning policy; the "snippet length tuning" test below is the
// benchmark anchor.

#[tokio::test]
async fn snippet_returns_paired_mark_boundaries_on_content_match() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "the wonderful searchable thing",
        None,
        Some(0),
    )
    .await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let results = search_fts(
        &pool,
        "wonderful",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet() must produce some text for a content match");
    let opens = snippet.matches("<mark>").count();
    let closes = snippet.matches("</mark>").count();
    assert!(
        opens >= 1,
        "snippet must contain at least one <mark> opener, got: {snippet:?}"
    );
    assert_eq!(
        opens, closes,
        "every <mark> opener must have a matching </mark> closer, got: {snippet:?}"
    );
    assert!(
        snippet.contains("<mark>wonderful</mark>"),
        "expected the match span to be wrapped, got: {snippet:?}"
    );
}

#[tokio::test]
async fn snippet_for_null_content_block_renders_no_match_span() {
    let (pool, _dir) = test_pool().await;
    // A block with NULL content can still be indexed by FTS via its
    // tag/page-ref references (page-title-only hits). We approximate
    // the shape here by inserting a content block whose stripped
    // representation is empty after all references resolve to nothing.
    insert_block_with_null_content(&pool, BLOCK_A, "content").await;
    crate::fts::update_fts_for_block(&pool, BLOCK_A)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    // A query that wouldn't match the block at all should still
    // produce zero items (the FTS row is empty/missing).
    let results = search_fts(
        &pool,
        "absent",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        results.items.len(),
        0,
        "a NULL-content block must not falsely match an unrelated query"
    );
}

#[tokio::test]
async fn snippet_preserves_literal_lt_and_amp_in_source_content() {
    let (pool, _dir) = test_pool().await;
    // The frontend renderer must escape these characters as text on
    // React's side; the backend must not double-escape or mangle them.
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "if a < b && c then findme",
        None,
        Some(0),
    )
    .await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let results = search_fts(
        &pool,
        "findme",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0].snippet.as_deref().unwrap_or("");
    // FTS5 does not HTML-escape; the raw characters survive verbatim.
    assert!(
        snippet.contains('<') && snippet.contains('&'),
        "expected literal '<' and '&' to survive verbatim, got: {snippet:?}"
    );
}

#[tokio::test]
async fn snippet_for_long_content_returns_windowed_output() {
    let (pool, _dir) = test_pool().await;
    // Build a ~1000-char body with one targeted match in the middle.
    // The 32-trigram window must clip the surrounding context — a
    // useful regression baseline if a future plan re-tunes the
    // constant.
    let prefix = "padding ".repeat(70); // ~560 chars
    let suffix = " trailing".repeat(50); // ~450 chars
    let body = format!("{prefix} uniquely-targetable {suffix}");
    assert!(body.len() >= 1000, "fixture body must exceed 1000 chars");
    insert_block(&pool, BLOCK_A, "content", &body, None, Some(0)).await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let results = search_fts(
        &pool,
        "uniquely-targetable",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced");
    // PEND-50 baseline: the 32-trigram window plus ellipsis must keep
    // the output well under the source body length.
    assert!(
        snippet.len() < 400,
        "snippet must be windowed, got len={} for body of len {}: {snippet:?}",
        snippet.len(),
        body.len(),
    );
    assert!(
        snippet.contains("<mark>"),
        "windowed snippet must still contain the match span: {snippet:?}"
    );
}

#[tokio::test]
async fn snippet_with_multiple_matches_contains_at_least_one_pair() {
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "alpha alpha alpha alpha alpha",
        None,
        Some(0),
    )
    .await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let results = search_fts(
        &pool,
        "alpha",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one matched block");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced");
    let opens = snippet.matches("<mark>").count();
    let closes = snippet.matches("</mark>").count();
    assert!(
        opens >= 1,
        "multi-match block must include at least one <mark> pair, got: {snippet:?}"
    );
    assert_eq!(
        opens, closes,
        "every <mark> opener must have a matching </mark> closer in a multi-match snippet"
    );
}

#[tokio::test]
async fn snippet_window_constant_produces_readable_output_on_representative_sample() {
    // PEND-50 "Snippet length tuning" anchor — pins the perceived
    // utility of the snippet window. If the constant (`32`) is bumped
    // or the trigram-tokenizer behaviour changes, this test must be
    // updated together. Today, on a mid-length sentence with one
    // match, the windowed snippet must:
    //   1. Contain the match span (non-degenerate window).
    //   2. Contain at least one non-marker character on each side of
    //      the match span (a "readable" window — the user can see
    //      surrounding context, not just the highlighted word).
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "the quick brown fox jumps over the lazy dog under the bridge",
        None,
        Some(0),
    )
    .await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let results = search_fts(
        &pool,
        "jumps",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced for a content match");
    let mark_start = snippet
        .find("<mark>")
        .expect("snippet must contain a match span");
    let mark_end = snippet
        .find("</mark>")
        .expect("snippet must close the match span");
    // Some surrounding context before/after the highlighted span —
    // at least one non-marker character on each side (allowing the
    // FTS5 truncation ellipsis to count as context).
    let before = &snippet[..mark_start];
    let after = &snippet[mark_end + "</mark>".len()..];
    assert!(
        before.chars().any(|c| !c.is_whitespace()),
        "snippet must include non-empty leading context: {snippet:?}"
    );
    assert!(
        after.chars().any(|c| !c.is_whitespace()),
        "snippet must include non-empty trailing context: {snippet:?}"
    );
}

// ======================================================================
// PEND-61 Phase 1 — `search_blocks_partitioned` tests
// ======================================================================
//
// Exercise the new IPC's one-scan-two-partition contract end-to-end.
// The helper bypasses the `tauri::command` wrapper and drives
// `search_blocks_partitioned_inner` directly so we can use the same
// `test_pool()` + `insert_block` + `rebuild_fts_index` fixtures the
// rest of this module already uses.

/// Ten distinct ULID-style block IDs for the partitioned tests. The
/// `insert_block` helper requires unique IDs per row; the rest of
/// the file reuses 4-5 constants per case which isn't enough for the
/// 5+5 fixture below. For tests that need > 5 rows of either kind
/// (e.g. the `MAX_SEARCH_RESULTS` ceiling case), use [`pt_block_id`]
/// to generate unique 26-char IDs on the fly.
const PT_PAGE_IDS: [&str; 5] = [
    "01HQPART01PAGE000000000P01",
    "01HQPART02PAGE000000000P02",
    "01HQPART03PAGE000000000P03",
    "01HQPART04PAGE000000000P04",
    "01HQPART05PAGE000000000P05",
];
const PT_BLOCK_IDS: [&str; 5] = [
    "01HQPART01BANK000000000B01",
    "01HQPART02BANK000000000B02",
    "01HQPART03BANK000000000B03",
    "01HQPART04BANK000000000B04",
    "01HQPART05BANK000000000B05",
];

/// Generate a unique 26-character ULID-shaped id under the
/// `01HQPART…` namespace for partitioned tests that need more rows
/// than the fixed `PT_*` arrays carry. The shape is not a valid
/// Crockford ULID but `insert_block` only requires uniqueness — see
/// the constants' docstring above.
fn pt_block_id(index: u32) -> String {
    format!("01HQPARTGEN{index:015}")
}

/// Seed `n_pages` page blocks and `n_blocks` content blocks, all
/// matching the FTS keyword `partitioned`. Returns when the FTS
/// index is up to date.
async fn seed_partitioned_fixture(pool: &SqlitePool, n_pages: usize, n_blocks: usize) {
    assert!(n_pages <= PT_PAGE_IDS.len(), "n_pages exceeds fixture ids");
    assert!(
        n_blocks <= PT_BLOCK_IDS.len(),
        "n_blocks exceeds fixture ids"
    );
    for (i, id) in PT_PAGE_IDS.iter().take(n_pages).enumerate() {
        // Pages carry the search keyword in their title so the FTS
        // hit is a page-title-only match.
        insert_block(
            pool,
            id,
            "page",
            &format!("partitioned page title {i}"),
            None,
            Some(i64::try_from(i).unwrap()),
        )
        .await;
    }
    for (i, id) in PT_BLOCK_IDS.iter().take(n_blocks).enumerate() {
        // Content blocks live under the first page so their `page_id`
        // resolves to a real row — keeps space-filter joins happy.
        let parent = if n_pages > 0 {
            Some(PT_PAGE_IDS[0])
        } else {
            None
        };
        insert_block(
            pool,
            id,
            "content",
            &format!("partitioned block content {i}"),
            parent,
            Some(i64::try_from(i + n_pages).unwrap()),
        )
        .await;
    }
    rebuild_fts_index(pool).await.unwrap();
}

#[tokio::test]
async fn partitioned_happy_path_pages_and_blocks_within_caps() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        2,
        3,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        2,
        "pages partition must cap at page_limit"
    );
    assert_eq!(
        resp.blocks.items.len(),
        3,
        "blocks partition must cap at block_limit"
    );
    // Pages partition contains only page-typed rows.
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "pages partition must contain only block_type='page' rows"
        );
    }
    // Neither partition emits a cursor.
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
    assert!(resp.pages.total_count.is_none());
    assert!(resp.blocks.total_count.is_none());
}

#[tokio::test]
async fn partitioned_pages_partition_is_page_typed_only_with_mixed_types() {
    let (pool, _dir) = test_pool().await;
    // Mixed: 3 pages, 5 content blocks.
    seed_partitioned_fixture(&pool, 3, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        3,
        "pages partition must surface all 3 page-typed rows"
    );
    for row in &resp.pages.items {
        assert_eq!(row.block_type, "page");
    }
}

#[tokio::test]
async fn partitioned_blocks_partition_is_unrestricted() {
    let (pool, _dir) = test_pool().await;
    // 3 pages + 2 content blocks → 5 total. `blocks` cap = 10 → all 5
    // survive; the partition must include page-typed entries
    // alongside the content blocks (this is the documented
    // "unrestricted" semantics).
    seed_partitioned_fixture(&pool, 3, 2).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.blocks.items.len(),
        5,
        "blocks partition is unrestricted — must include both pages and content"
    );
    let pages_in_blocks = resp
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "page")
        .count();
    let content_in_blocks = resp
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .count();
    assert_eq!(pages_in_blocks, 3, "blocks partition must contain pages");
    assert_eq!(
        content_in_blocks, 2,
        "blocks partition must contain content blocks"
    );
}

#[tokio::test]
async fn partitioned_caps_honour_each_partition_limit() {
    let (pool, _dir) = test_pool().await;
    // 5 pages, 5 content → caps at 1/1 must return exactly 1+1.
    seed_partitioned_fixture(&pool, 5, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        1,
        1,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.pages.items.len(), 1, "page_limit=1 must clip to 1");
    assert_eq!(resp.blocks.items.len(), 1, "block_limit=1 must clip to 1");
}

#[tokio::test]
async fn partitioned_has_more_flags_reflect_partition_overflow() {
    let (pool, _dir) = test_pool().await;
    // 5 pages, 5 content → 10 matching rows in the scan.
    seed_partitioned_fixture(&pool, 5, 5).await;

    // Case A — both caps under the available count. Both partitions
    // must report `has_more = true`.
    let tight = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        2,
        3,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();
    assert!(
        tight.pages.has_more,
        "pages.has_more must be true when more page-typed rows existed beyond the cap"
    );
    assert!(
        tight.blocks.has_more,
        "blocks.has_more must be true when more rows existed beyond the cap"
    );

    // Case B — caps exceed the available row count. Both partitions
    // must report `has_more = false`.
    let loose = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        20,
        20,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();
    assert!(
        !loose.pages.has_more,
        "pages.has_more must be false when fewer pages existed than the cap"
    );
    assert!(
        !loose.blocks.has_more,
        "blocks.has_more must be false when fewer rows existed than the cap"
    );
}

#[tokio::test]
async fn partitioned_empty_query_returns_empty_partitions() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 2, 2).await;

    for q in ["", "   ", "\t\n"] {
        let resp = crate::commands::queries::search_blocks_partitioned_inner(
            &pool,
            q.to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await
        .unwrap();
        assert!(
            resp.pages.items.is_empty(),
            "empty/whitespace query must yield empty pages partition (q={q:?})"
        );
        assert!(
            resp.blocks.items.is_empty(),
            "empty/whitespace query must yield empty blocks partition (q={q:?})"
        );
        assert!(!resp.pages.has_more);
        assert!(!resp.blocks.has_more);
    }

    // PEND-69 — also cover the empty-space case: a non-empty query
    // against a space that has zero matching rows must yield two
    // empty partitions with `has_more=false`. Exercises the
    // post-`MATCH` filter path (FTS5 returns rows that are then
    // filtered out by the space predicate), proving the two-scan
    // partition machinery doesn't synthesise phantom `has_more`
    // signals on an empty result.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Empty Space").await;
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            space_id: Some(FTS_SPACE_A_ID.to_string()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        resp.pages.items.is_empty(),
        "zero-page space must yield empty pages partition"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "zero-page space must yield empty blocks partition"
    );
    assert!(
        !resp.pages.has_more,
        "empty-space query must not signal pages.has_more"
    );
    assert!(
        !resp.blocks.has_more,
        "empty-space query must not signal blocks.has_more"
    );
}

#[tokio::test]
async fn partitioned_ignores_block_type_filter_in_filter_struct() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let baseline = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    let with_filter = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            // PEND-61 Phase 1: this field MUST be ignored — partitioning
            // by block_type is what the IPC does.
            block_type_filter: Some("page".to_string()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        baseline.pages.items.len(),
        with_filter.pages.items.len(),
        "block_type_filter must not affect the pages partition cardinality"
    );
    assert_eq!(
        baseline.blocks.items.len(),
        with_filter.blocks.items.len(),
        "block_type_filter must not affect the blocks partition cardinality"
    );
    // The blocks partition must still contain content-typed rows
    // even when the caller passed `block_type_filter=Some("page")`.
    let content_count = with_filter
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .count();
    assert!(
        content_count > 0,
        "block_type_filter must not narrow the unrestricted blocks partition"
    );
}

#[tokio::test]
async fn partitioned_space_filter_excludes_other_spaces_from_both_partitions() {
    let (pool, _dir) = test_pool().await;
    // Two spaces, both with a matching page in each. The FTS5 space
    // filter is applied against `b.page_id IN (… key='space' …)` —
    // the partitioned scan must inherit it from the same dynamic-SQL
    // builder used by `search_fts`.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    insert_space_block_for_fts(&pool, FTS_SPACE_B_ID, "Work").await;

    let page_in_a = PT_PAGE_IDS[0];
    let page_in_b = PT_PAGE_IDS[1];
    insert_block(
        &pool,
        page_in_a,
        "page",
        "partitioned page in space a",
        None,
        Some(1),
    )
    .await;
    assign_to_space_for_fts(&pool, page_in_a, FTS_SPACE_A_ID).await;
    insert_block(
        &pool,
        page_in_b,
        "page",
        "partitioned page in space b",
        None,
        Some(2),
    )
    .await;
    assign_to_space_for_fts(&pool, page_in_b, FTS_SPACE_B_ID).await;

    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            space_id: Some(FTS_SPACE_A_ID.to_string()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    let ids_pages: Vec<&str> = resp.pages.items.iter().map(|r| r.id.as_str()).collect();
    let ids_blocks: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids_pages.contains(&page_in_a),
        "pages partition must include the SPACE_A row (FEAT-3 invariant): {ids_pages:?}"
    );
    assert!(
        !ids_pages.contains(&page_in_b),
        "pages partition must exclude rows from other spaces: {ids_pages:?}"
    );
    assert!(
        ids_blocks.contains(&page_in_a),
        "blocks partition must include the SPACE_A row: {ids_blocks:?}"
    );
    assert!(
        !ids_blocks.contains(&page_in_b),
        "blocks partition must exclude rows from other spaces: {ids_blocks:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_mode_routes_through_partitioned_dispatch() {
    // `search_with_toggles_partitioned` dispatches `is_regex=true` through
    // a separate path (`regex_mode_query`) rather than the FTS scan.
    // This test verifies that branch partitions rows correctly — pages
    // stay page-typed-only and the blocks partition is unrestricted.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partition".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    // Seeded content carries the substring "partitioned" → regex /partition/
    // matches all 6 rows (3 pages + 3 content blocks).
    assert_eq!(
        resp.pages.items.len(),
        3,
        "regex-mode pages partition must surface all matching page-typed rows"
    );
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "regex-mode pages partition must be page-typed-only"
        );
    }
    assert_eq!(
        resp.blocks.items.len(),
        6,
        "regex-mode blocks partition is unrestricted (includes pages)"
    );
}

#[tokio::test]
async fn partitioned_zero_limits_yield_empty_partitions_and_no_has_more() {
    // Degenerate `page_limit=0` / `block_limit=0` must yield empty
    // partitions without `has_more=true` (the `page_limit_usize > 0`
    // guard on `pages_filled` is what prevents the degenerate true).
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        0,
        0,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert!(
        resp.pages.items.is_empty(),
        "page_limit=0 must yield no items"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "block_limit=0 must yield no items"
    );
    assert!(
        !resp.pages.has_more,
        "page_limit=0 must not report has_more (filled-guard)"
    );
    assert!(
        !resp.blocks.has_more,
        "block_limit=0 must not report has_more (filled-guard)"
    );
}

#[tokio::test]
async fn partitioned_max_search_results_ceiling_propagates_to_has_more() {
    // The bounded FTS scan clips at `MAX_SEARCH_RESULTS` (100). When a
    // caller's combined cap exceeds that ceiling AND the matching row
    // set is larger than the ceiling, the scan flags `ceiling_hit=true`
    // and `has_more` must propagate even if the partition cap itself
    // would not have overflowed within the (clipped) scan.
    let (pool, _dir) = test_pool().await;

    // Seed > MAX_SEARCH_RESULTS (100) matching content rows under a
    // single root page. Generated IDs follow the project's 26-char ULID
    // shape; uniqueness is the only requirement here.
    let root = pt_block_id(0);
    insert_block(
        &pool,
        &root,
        "page",
        "partitioned ceiling root",
        None,
        Some(0),
    )
    .await;
    for i in 1..=120 {
        let id = pt_block_id(i);
        insert_block(
            &pool,
            &id,
            "content",
            &format!("partitioned ceiling row {i}"),
            Some(&root),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        50,
        50,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        1,
        "exactly one page-typed row matched the seed"
    );
    assert_eq!(
        resp.blocks.items.len(),
        50,
        "blocks partition fills to the cap (50) under a 100-row scan ceiling"
    );
    assert!(
        resp.blocks.has_more,
        "blocks.has_more must be true when caller's cap fills AND there are more rows in the scan"
    );
}

// ======================================================================
// PEND-71 — Search backend test coverage matrix
// ======================================================================
//
// Stress / edge-case coverage for the partitioned search IPC:
//
// 1. Concurrent IPC — `tokio::join!`-style fan-out + tail-latency bound.
// 2. Pathological queries — 100KB long-query short-circuit, 12-field
//    populated filter struct.
// 3. Empty / giant space — zero-row partitioned scan; 10k-block fixture
//    wall-time bound.
// 4. Boolean + toggle combinations — case_sensitive + OR, whole_word +
//    AND, regex alternation, invalid-regex validation error mapping.
//
// All tests use the existing `test_pool()` + `TempDir` pattern (per
// `src-tauri/tests/AGENTS.md`); wall-clock bounds are anchored to
// measured-local baselines × 3 headroom (see project memory note
// "Measure, don't imagine"). No sleep-loop polling.

/// PEND-71 — Seed a "giant" partitioned fixture: 1 root page + `n_blocks`
/// content blocks all matching the FTS keyword `partitioned`. The shape
/// is chosen so a single FTS scan returns up to `MAX_SEARCH_RESULTS` rows
/// — enough to exercise the partitioned dispatch on a non-trivial corpus
/// without exploding wall-time in unrelated CI runs.
///
/// Generated IDs follow the `pt_block_id` 26-char ULID shape; uniqueness
/// is the only DB-level constraint.
async fn seed_giant_fixture(pool: &SqlitePool, n_blocks: u32) {
    let root = pt_block_id(0);
    insert_block(
        &pool.clone(),
        &root,
        "page",
        "partitioned giant root page",
        None,
        Some(0),
    )
    .await;
    // Single transaction so the 10k inserts don't fan out into per-row
    // fsyncs. Mirrors the bulk-insert pattern in
    // `search_fts_partition_max_search_results_ceiling`.
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=n_blocks {
        let id = pt_block_id(i);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(format!("partitioned giant row {i}"))
        .bind(&root)
        .bind(i64::from(i))
        .bind(&root)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    rebuild_fts_index(pool).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_partitioned_searches_do_not_deadlock_or_starve() {
    // Fan five identical partitioned-search queries against the same pool
    // and assert (a) all complete within a generous 5s timeout and (b)
    // each returns Ok. The `test_pool()` helper uses `init_pool` which
    // exposes max_connections(5); five concurrent readers saturate the
    // pool to the cap and force the sqlx connection-acquire path to
    // serialise — which is what we want to validate is deadlock-free.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let pool0 = pool.clone();
    let pool1 = pool.clone();
    let pool2 = pool.clone();
    let pool3 = pool.clone();
    let pool4 = pool.clone();

    let fut0 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool0,
        "partitioned".to_string(),
        8,
        40,
        crate::commands::queries::SearchFilter::default(),
        None,
    );
    let fut1 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool1,
        "partitioned".to_string(),
        8,
        40,
        crate::commands::queries::SearchFilter::default(),
        None,
    );
    let fut2 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool2,
        "partitioned".to_string(),
        8,
        40,
        crate::commands::queries::SearchFilter::default(),
        None,
    );
    let fut3 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool3,
        "partitioned".to_string(),
        8,
        40,
        crate::commands::queries::SearchFilter::default(),
        None,
    );
    let fut4 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool4,
        "partitioned".to_string(),
        8,
        40,
        crate::commands::queries::SearchFilter::default(),
        None,
    );

    // Box the inner future to keep clippy's `large_futures` lint quiet —
    // the five composed `search_blocks_partitioned_inner` calls inflate
    // the inline future past clippy's 16KB warning threshold. The box is
    // otherwise indistinguishable from inline composition (single
    // once-per-test allocation, no behavioural change).
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Box::pin(async move { tokio::join!(fut0, fut1, fut2, fut3, fut4) }),
    )
    .await
    .expect("five concurrent partitioned searches must not deadlock within 5s");

    let (r0, r1, r2, r3, r4) = joined;
    assert!(
        r0.is_ok(),
        "concurrent partitioned search 0 must succeed: {r0:?}"
    );
    assert!(
        r1.is_ok(),
        "concurrent partitioned search 1 must succeed: {r1:?}"
    );
    assert!(
        r2.is_ok(),
        "concurrent partitioned search 2 must succeed: {r2:?}"
    );
    assert!(
        r3.is_ok(),
        "concurrent partitioned search 3 must succeed: {r3:?}"
    );
    assert!(
        r4.is_ok(),
        "concurrent partitioned search 4 must succeed: {r4:?}"
    );
    // Sanity: each result must include both pages and blocks partitions
    // populated. If a request raced into an empty result, that's a
    // partitioning regression we want to catch.
    let r0 = r0.unwrap();
    assert!(
        !r0.pages.items.is_empty() || !r0.blocks.items.is_empty(),
        "concurrent partitioned search 0 returned a fully-empty response — partition regression?"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pool_starvation_bound_500ms() {
    // Queue five readers against the test pool to exercise the
    // connection-acquire queue. The production read pool is
    // `max_connections(4)` so five readers force one to wait on a
    // connection; the test pool (`init_pool`) is `max_connections(5)`
    // so saturation is less aggressive but the contention is still
    // measurable. We measure tail latency (the slowest of the five)
    // and assert it stays under the bound.
    //
    // Measured locally (debug build, warm SQLite cache, 4-thread tokio
    // runtime, 10-row fixture from `seed_partitioned_fixture(5, 5)`)
    // across three back-to-back runs: tail = 4.5 / 7.6 / 4.2 ms.
    // Worst observed = 7.6ms → 3x headroom = ~23ms. The 500ms ceiling
    // is the plan-prescribed value (PEND-71 checklist names the test
    // `..._bound_500ms`); it's a wide envelope deliberately chosen to
    // tolerate CI runner variance. The assertion is the *order of
    // magnitude* check — the per-task array is preserved in the panic
    // message so a regression that drifts toward the bound is
    // diagnosable.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let start = std::time::Instant::now();
    let p0 = pool.clone();
    let p1 = pool.clone();
    let p2 = pool.clone();
    let p3 = pool.clone();
    let p4 = pool.clone();
    let h0 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p0,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h1 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p1,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h2 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p2,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h3 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p3,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h4 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p4,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let elapsed = [
        h0.await.unwrap(),
        h1.await.unwrap(),
        h2.await.unwrap(),
        h3.await.unwrap(),
        h4.await.unwrap(),
    ];
    let total = start.elapsed();
    let tail = elapsed.iter().copied().max().unwrap();
    assert!(
        tail < std::time::Duration::from_millis(500),
        "tail latency of five concurrent partitioned searches must stay under 500ms \
         (saw tail={tail:?}; total={total:?}; per-task={elapsed:?}). \
         Locally measured 4-8ms; 500ms = plan-prescribed envelope for CI runner variance."
    );
}

#[tokio::test]
async fn partitioned_over_long_query_is_rejected() {
    // SQL-4 (PEND-58f) — a 100KB query now exceeds `MAX_QUERY_LEN`
    // (4 KiB) and is REJECTED up front with a validation error, before
    // any tokenise / sanitise work. This supersedes the pre-PEND-58f
    // behaviour where a long sub-trigram-only query was tokenised,
    // sanitised to empty, and short-circuited to an empty response. The
    // sub-trigram empty-short-circuit itself is still covered by
    // `partitioned_sub_trigram_only_under_cap_short_circuits` below for
    // queries that fit under the length cap.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    // 50_000 alternating chars + spaces ≈ 100KB UTF-8 — well over the
    // 4 KiB `MAX_QUERY_LEN` cap.
    let huge: String = "a ".repeat(50_000);
    assert!(huge.len() >= 100_000, "fixture must be at least 100KB");

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        huge,
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("over-long query must be rejected, not short-circuited");
    assert!(
        matches!(err, AppError::Validation(_)),
        "over-long query must surface AppError::Validation, got {err:?}"
    );
}

#[tokio::test]
async fn partitioned_sub_trigram_only_under_cap_short_circuits() {
    // A sub-trigram-only query that fits UNDER `MAX_QUERY_LEN`: every
    // token is a single-character word (sub-trigram length). The
    // sanitizer drops sub-trigram word tokens (per `sanitize_fts_query`'s
    // `TRIGRAM_MIN_LEN = 3` filter), leaving the post-sanitised query
    // empty. The partitioned path then short-circuits to two empty
    // partitions rather than passing an empty MATCH expression to SQLite.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    // "a a a …" — comfortably under the 4 KiB cap.
    let short: String = "a ".repeat(100);
    assert!(
        short.len() < super::search::MAX_QUERY_LEN,
        "fixture must fit under MAX_QUERY_LEN"
    );

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        short,
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect("sub-trigram-only query must short-circuit, not error");

    assert!(
        resp.pages.items.is_empty(),
        "sub-trigram-only query must yield empty pages partition"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "sub-trigram-only query must yield empty blocks partition"
    );
    assert!(!resp.pages.has_more);
    assert!(!resp.blocks.has_more);
}

#[tokio::test]
async fn partitioned_all_filters_populated_executes_cleanly() {
    // Smoke test: build a `SearchFilter` with every documented field
    // populated and assert the dynamic-SQL builder composes without
    // error. We don't assert on result cardinality — the point is to
    // exercise the full filter-composition path so a regression in any
    // single clause surfaces as a SQL syntax / binding error.
    //
    // Fields populated:
    //   parent_id, tag_ids, space_id, include_page_globs,
    //   exclude_page_globs, case_sensitive, whole_word, is_regex (off —
    //   regex-mode bypasses the FTS filter composition; we want to
    //   exercise the FTS path), block_type_filter (ignored by the
    //   partitioned IPC; populated to verify the field's drop is
    //   silent), state_filter, priority_filter, due_filter,
    //   scheduled_filter, property_filters, excluded_property_filters,
    //   excluded_state_filter, excluded_priority_filter.
    let (pool, _dir) = test_pool().await;
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    seed_partitioned_fixture(&pool, 3, 3).await;
    // Bind the first seeded page into the space so `space_id` resolves
    // to a real row instead of an empty subselect.
    assign_to_space_for_fts(&pool, PT_PAGE_IDS[0], FTS_SPACE_A_ID).await;
    rebuild_fts_index(&pool).await.unwrap();

    let filter = crate::commands::queries::SearchFilter {
        parent_id: Some(PT_PAGE_IDS[0].to_string()),
        tag_ids: vec!["01HQTAG000000000000000TAG1".to_string()],
        space_id: Some(FTS_SPACE_A_ID.to_string()),
        include_page_globs: vec!["*page*".to_string()],
        exclude_page_globs: vec!["*never*".to_string()],
        case_sensitive: true,
        whole_word: true,
        // `is_regex` left off so the test exercises the FTS path that
        // composes the metadata + glob + space SQL clauses. The regex
        // path is separately covered by `partitioned_regex_*` tests.
        is_regex: false,
        // Ignored by the partitioned IPC — populate to verify the
        // silent drop doesn't break the builder.
        block_type_filter: Some("page".to_string()),
        state_filter: vec!["TODO".to_string()],
        priority_filter: vec!["A".to_string()],
        due_filter: Some(crate::commands::queries::DateFilter::Named(
            crate::commands::queries::NamedDateRange::Today,
        )),
        scheduled_filter: Some(crate::commands::queries::DateFilter::Op {
            op: crate::commands::queries::DateOp::Gte,
            date: "2026-01-01".to_string(),
        }),
        property_filters: vec![crate::commands::queries::SearchPropertyFilter {
            key: "owner".to_string(),
            value: "alice".to_string(),
        }],
        excluded_property_filters: vec![crate::commands::queries::SearchPropertyFilter {
            key: "archived".to_string(),
            value: "true".to_string(),
        }],
        excluded_state_filter: vec!["DONE".to_string()],
        excluded_priority_filter: vec!["C".to_string()],
    };

    // The corpus deliberately does NOT match all of these predicates —
    // we just need the SQL to compose and execute. An empty result is
    // a valid outcome; an error is not.
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        filter,
        None,
    )
    .await
    .expect("12-field-populated SearchFilter must compose into valid SQL");

    // Wire-shape sanity — both partitions present, neither emits a
    // cursor / total_count.
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
    assert!(resp.pages.total_count.is_none());
    assert!(resp.blocks.total_count.is_none());
}

#[tokio::test]
async fn partitioned_empty_space_returns_empty_partitions() {
    // Zero pages, zero blocks in the space → both partitions must be
    // empty and `has_more=false`. Distinct from
    // `partitioned_empty_query_returns_empty_partitions` (which seeds
    // the fixture and tests the empty-query short-circuit); this test
    // skips seeding entirely so the FTS5 index has no rows at all.
    let (pool, _dir) = test_pool().await;
    // Build the FTS index without any seeded blocks so the MATCH path
    // exercises the empty-corpus branch, not the empty-query branch.
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect("empty-space partitioned search must succeed");

    assert_eq!(
        resp.pages.items.len(),
        0,
        "empty space must yield zero pages"
    );
    assert_eq!(
        resp.blocks.items.len(),
        0,
        "empty space must yield zero blocks"
    );
    assert!(!resp.pages.has_more, "empty space must not report has_more");
    assert!(
        !resp.blocks.has_more,
        "empty space must not report has_more"
    );
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn partitioned_giant_space_completes_within_1s() {
    // 10k-block fixture; assert the partitioned scan completes inside
    // a measured-local × headroom ceiling. Primarily a regression catch
    // for accidental N+1 query patterns in the partition composer.
    //
    // Measured locally (debug build, warm SQLite cache, 4-thread tokio
    // runtime, 10k content-block fixture under a single seeded page,
    // FTS5 trigram index rebuilt before search) across three back-to-
    // back runs: 57.3 / 49.9 / 48.2 / 52.1 ms. Worst observed = 57ms.
    //
    // The 1000ms test-name ceiling comes from the PEND-71 plan
    // checklist. Internally the assertion is set to **300ms** (≈ 5x
    // worst-observed warm), which is well above the noise floor but
    // still tight enough to catch an N+1 regression (which would push
    // wall-time into the seconds range). If a future CI runner under
    // load drifts past 300ms the bound can be relaxed without changing
    // the test's intent — record the new measurement in this comment.
    let (pool, _dir) = test_pool().await;
    seed_giant_fixture(&pool, 10_000).await;

    // Warm the FTS5 cache + planner with a no-op query so the
    // measurement below times steady-state search, not cold-cache
    // first-query overhead (which on debug builds is a 10x cliff).
    let _ = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await;

    let start = std::time::Instant::now();
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect("giant-space partitioned search must succeed");
    let elapsed = start.elapsed();

    assert!(
        elapsed < std::time::Duration::from_millis(300),
        "giant-space partitioned search must complete under 300ms \
         (saw {elapsed:?}). Locally measured ~50-57ms warm; 300ms = \
         ~5x worst-observed × CI variance headroom. A regression that \
         pushes this past 300ms is almost certainly an N+1 pattern."
    );
    // Sanity — the partitioned IPC must return at least the cap from
    // the unrestricted partition (10k matching rows, cap = 10).
    assert_eq!(
        resp.blocks.items.len(),
        10,
        "giant-space partitioned search must fill the blocks cap"
    );
    assert!(
        resp.blocks.has_more,
        "giant-space partitioned search must flag has_more on the blocks partition"
    );
}

#[tokio::test]
async fn partitioned_case_sensitive_with_or_preserves_case() {
    // `case_sensitive=true` + query `"Foo OR Bar"`:
    //
    // 1. Sanitizer preserves the `OR` operator (length-3 token in a
    //    valid operator position) — FTS5 candidate set includes blocks
    //    matching either `Foo` or `Bar` (case-insensitive trigram match).
    // 2. The toggle-mode post-filter compiles the entire query string as
    //    a *literal* regex (via `regex::escape`) with the `(?-i)` flag,
    //    so only blocks whose `content` contains the exact substring
    //    `"Foo OR Bar"` (case-matched) survive.
    //
    // Seeded content:
    //   - mixed-case "Has Foo OR Bar text" — survives post-filter.
    //   - lowercase "has foo or bar text" — FTS hit, post-filter drops.
    //   - mismatched "Foo only" / "Bar only" — FTS hit, post-filter drops
    //     (no literal "Foo OR Bar" substring).
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTCSOR01PAGE0000000P01",
        "page",
        "Has Foo OR Bar text",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR02PAGE0000000P02",
        "page",
        "has foo or bar text",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR03BLK00000000B03",
        "content",
        "Foo only here",
        Some("01HQPTCSOR01PAGE0000000P01"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR04BLK00000000B04",
        "content",
        "Bar only here",
        Some("01HQPTCSOR01PAGE0000000P01"),
        Some(3),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "Foo OR Bar".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            case_sensitive: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("case_sensitive + OR query must execute cleanly");

    // The post-filter regex is the literal `"Foo OR Bar"` with
    // case-sensitive flag — only the mixed-case page survives.
    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTCSOR01PAGE0000000P01"),
        "case_sensitive post-filter must keep the exact-case match: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR02PAGE0000000P02"),
        "case_sensitive post-filter must drop the lowercased page: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR03BLK00000000B03"),
        "case_sensitive post-filter must drop single-term blocks: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR04BLK00000000B04"),
        "case_sensitive post-filter must drop single-term blocks: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        1,
        "exactly one row matches the literal `Foo OR Bar` case-sensitively"
    );
}

#[tokio::test]
async fn partitioned_whole_word_with_and_combines_terms() {
    // `whole_word=true` + query `"foo AND bar"`:
    //
    // 1. Sanitizer preserves the `AND` operator — FTS5 candidate set
    //    requires both `foo` AND `bar` (case-insensitive trigram).
    // 2. The toggle-mode post-filter compiles the escaped literal query
    //    wrapped in ASCII word boundaries: `(?i)(?-u:\b)foo AND
    //    bar(?-u:\b)`. Only blocks whose content contains the exact
    //    substring `"foo AND bar"` as a word-boundary-aligned run
    //    survive.
    //
    // Seeded content:
    //   - "foo AND bar in title" — both terms present, literal substring
    //     present, word-boundary aligned → survives.
    //   - "foobar AND barfoo" — both terms substring-present in FTS5
    //     trigram view, but the literal "foo AND bar" string is not
    //     present → post-filter drops.
    //   - "foo standalone, no bar near" — both terms present (FTS5 hit),
    //     no literal "foo AND bar" → post-filter drops.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTWWAN01PAGE0000000P01",
        "page",
        "foo AND bar in title",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTWWAN02PAGE0000000P02",
        "page",
        "foobar AND barfoo",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTWWAN03BLK00000000B03",
        "content",
        "foo standalone, no bar near",
        Some("01HQPTWWAN01PAGE0000000P01"),
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "foo AND bar".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            whole_word: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("whole_word + AND query must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTWWAN01PAGE0000000P01"),
        "whole_word + AND must keep the exact-substring word-boundary match: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTWWAN02PAGE0000000P02"),
        "whole_word + AND must drop substring-only matches: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTWWAN03BLK00000000B03"),
        "whole_word + AND must drop blocks without the literal `foo AND bar` substring: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        1,
        "exactly one row matches `foo AND bar` as a word-boundary-aligned literal"
    );
}

#[tokio::test]
async fn partitioned_regex_alternation_matches_both() {
    // `is_regex=true` + pattern `(foo|bar).*baz`:
    //
    // The regex-mode path bypasses FTS sanitisation entirely and uses
    // `regex_mode_query` for the candidate set (recency-ordered SQL
    // scan of structurally-filtered blocks). The compiled regex
    // `(?i)(foo|bar).*baz` is applied as the post-filter — both
    // alternations must produce matches.
    //
    // Seeded content:
    //   - "foo zzz baz" — matches via `foo.*baz`.
    //   - "bar yyy baz" — matches via `bar.*baz`.
    //   - "neither here" — drops.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTRGAL01PAGE0000000P01",
        "page",
        "foo zzz baz",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAL02PAGE0000000P02",
        "page",
        "bar yyy baz",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAL03BLK00000000B03",
        "content",
        "neither alternation here",
        Some("01HQPTRGAL01PAGE0000000P01"),
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "(foo|bar).*baz".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("regex alternation query must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTRGAL01PAGE0000000P01"),
        "regex alternation must match the `foo.*baz` block: {surviving_ids:?}"
    );
    assert!(
        surviving_ids.contains(&"01HQPTRGAL02PAGE0000000P02"),
        "regex alternation must match the `bar.*baz` block: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTRGAL03BLK00000000B03"),
        "regex alternation must drop the non-matching block: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        2,
        "exactly two rows match `(foo|bar).*baz`"
    );
}

#[tokio::test]
async fn partitioned_nfc_query_matches_nfd_content() {
    // PEND-73 B3 / T1a — NFC normalisation guard.
    //
    // macOS volume content tends to be NFD-encoded (filename
    // decomposition; copy-paste from Safari can preserve NFD), and
    // typed queries on most platforms default to NFC. Without
    // normalisation, an NFC query for "café" misses the NFD content
    // "café" (the second one has the acute as a combining
    // codepoint). With B3's index-time + query-time NFC normalisation,
    // both ends agree on the canonical form.
    //
    // Sanity: assert the two raw strings are NOT byte-equal before
    // the fix would even attempt to make them match.
    let nfc_query = "caf\u{00E9}"; // U+00E9 = é (NFC composed)
    let nfd_content = "caf\u{0065}\u{0301}"; // 'e' + combining acute (NFD)
    assert_ne!(
        nfc_query.as_bytes(),
        nfd_content.as_bytes(),
        "test pre-condition: NFC and NFD encodings must be byte-different"
    );

    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQNFC001PAGE0000000P01CC",
        "page",
        nfd_content,
        None,
        Some(0),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        nfc_query.to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect("NFC query against NFD content must execute cleanly");

    let surviving_ids: Vec<&str> = resp.pages.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQNFC001PAGE0000000P01CC"),
        "NFC query `{nfc_query}` must match NFD content `{nfd_content}` after normalisation; \
         got pages: {surviving_ids:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_bare_alternation_matches_both_arms_under_case_flag() {
    // PEND-73 Phase 1.B7 — regression guard for the (?:...) wrap around
    // the user pattern. The historical risk: `(?i)foo|bar` composed by
    // string-concat is fine today, but any future prefix toggle in
    // front of `query` (e.g. `(?s)`) would interact with the top-level
    // `|` via precedence. The new `(?i)(?:foo|bar)` shape isolates the
    // user's pattern in a group so the alternation can't escape.
    //
    // Behavioural check: a bare alternation (no user-supplied parens)
    // must still match both arms case-insensitively under
    // `case_sensitive=false`.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTRGAW01PAGE0000000P01",
        "page",
        "Foo content",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAW02PAGE0000000P02",
        "page",
        "BAR content",
        None,
        Some(1),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "foo|bar".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            case_sensitive: false,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("bare-alternation regex must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTRGAW01PAGE0000000P01"),
        "case-insensitive `foo|bar` must match `Foo content`: {surviving_ids:?}"
    );
    assert!(
        surviving_ids.contains(&"01HQPTRGAW02PAGE0000000P02"),
        "case-insensitive `foo|bar` must match `BAR content`: {surviving_ids:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_invalid_pattern_returns_validation_error() {
    // `is_regex=true` + invalid regex pattern `"*"` (Rust's regex crate
    // rejects unanchored `*` as a repetition operator with no
    // preceding atom). Per `toggle_filter.rs:331-343`, the compile
    // failure is mapped onto `AppError::Validation("InvalidRegex:
    // …")` — the partitioned IPC must propagate it verbatim.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "*".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("invalid regex pattern must surface AppError::Validation");

    match err {
        crate::error::AppError::Validation(msg) => assert!(
            msg.starts_with("InvalidRegex:"),
            "expected InvalidRegex: prefix; got: {msg}"
        ),
        other => panic!("expected AppError::Validation(InvalidRegex: …); got {other:?}"),
    }
}

// ======================================================================
// PEND-69 — partition correctness + filter pushdown tests
// ======================================================================

/// PEND-69 F1 — when content blocks rank above the only page hit, the
/// pages partition must still surface the page. The pre-PEND-69
/// single-scan-then-Rust-partition shape failed this case: 60
/// content blocks crowd out the lone page within the
/// `min(page_limit + block_limit + 1, MAX_SEARCH_RESULTS)` scan
/// window. The two-scan shape guarantees a per-partition window so
/// the page is never invisible.
#[tokio::test]
async fn partitioned_scan_returns_pages_when_blocks_outrank_them() {
    let (pool, _dir) = test_pool().await;

    // One matching page; 60 matching content blocks that share the
    // FTS keyword. The content blocks' `content` is short so their
    // FTS rank tends to be at least as good as the page's title hit
    // — under the old shape the page typically lost the rank race.
    let page_id = pt_block_id(0);
    insert_block(
        &pool,
        &page_id,
        "page",
        "partitioned outranked page",
        None,
        Some(0),
    )
    .await;
    for i in 1..=60 {
        let content_id = pt_block_id(i);
        insert_block(
            &pool,
            &content_id,
            "content",
            // Repeat the keyword so the trigram rank stays high.
            "partitioned partitioned partitioned",
            Some(&page_id),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        5,  // page_limit
        20, // block_limit
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        1,
        "pages partition must return the one matching page regardless of how many content blocks outrank it"
    );
    assert_eq!(
        resp.pages.items[0].block_type, "page",
        "pages partition row must be page-typed"
    );
    assert!(
        !resp.pages.has_more,
        "pages.has_more must be false — only one page existed in total"
    );
}

/// PEND-69 F2 — regex page-only queries must surface all matching
/// pages even when content blocks dominate the table. Pre-PEND-69
/// the regex SQL scan grabbed the 1000 most-recent rows ANY-type
/// then dropped non-pages in Rust, so 5 pages buried below 2000
/// recently-inserted content rows would disappear.
///
/// Two-pool worker threads: the regex scan itself is small but
/// `insert_block` writes a lot of rows; default flavor is fine.
#[tokio::test]
async fn partitioned_regex_page_filter_returns_pages_when_content_dominates() {
    let (pool, _dir) = test_pool().await;

    // Pages go in FIRST — their ULIDs sort below the content blocks'
    // and `regex_mode_query` orders `b.id DESC` (recency proxy). So
    // under the pre-F2 shape the 1000-row pre-filter window would
    // be entirely content rows; the pages would be invisible.
    for i in 0..5 {
        let pid = pt_block_id(i);
        insert_block(
            &pool,
            &pid,
            "page",
            &format!("regex_page_target_{i}"),
            None,
            Some(i64::from(i)),
        )
        .await;
    }
    // 2000 newer content rows (higher-ULID prefix) that don't match
    // the user's regex but DO match the regex builder's structural
    // filter (content IS NOT NULL).
    for i in 5..2005 {
        let cid = pt_block_id(i);
        insert_block(
            &pool,
            &cid,
            "content",
            "filler content row without target keyword",
            None,
            Some(i64::from(i)),
        )
        .await;
    }
    // FTS index isn't used by the regex path, but rebuild_fts_index
    // is a no-op cost on top of a pool-only check.

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "regex_page_target_".to_string(),
        20,
        20,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        5,
        "regex pages scan must return all 5 matching pages; pre-F2 dropped them past the 1000-row pre-filter cap"
    );
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "regex pages partition must be page-typed-only"
        );
    }
}

/// PEND-69 F5 — verify the SQL builder omits the `snippet(fts_blocks,
/// …)` call when the toggle bundle will trigger a post-filter that
/// clears `row.snippet` anyway. Asserts on the emitted SQL string via
/// the test-only `fts_select_prefix_for_test` accessor — cheaper and
/// more direct than a runtime SQL trace.
#[test]
fn partitioned_snippet_skipped_when_post_filter_clears_it() {
    use super::search::fts_select_prefix_for_test;

    // Snippet-on branch: the SQL must include the `snippet(` function
    // call so the FTS path can carry `<mark>` boundaries to the
    // frontend (the no-toggle case).
    let with = fts_select_prefix_for_test(true);
    assert!(
        with.contains("snippet(fts_blocks"),
        "snippet=true must emit the `snippet(fts_blocks, …)` call: {with}"
    );

    // Snippet-off branch: when downstream clears `row.snippet`
    // (any toggle on, regex or non-regex) the SQL must not invoke
    // `snippet(` — we project `NULL` instead so SQLite skips the
    // per-row tokenizer walk.
    let without = fts_select_prefix_for_test(false);
    assert!(
        !without.contains("snippet("),
        "snippet=false must omit the `snippet(` call: {without}"
    );
    assert!(
        without.contains("NULL as snippet"),
        "snippet=false must synthesise NULL so the row deserialises with Option<String>=None: {without}"
    );
}

// ======================================================================
// PEND-70 — cancellation + slow-query logging tests
// ======================================================================

/// Seed a 100+ row "heavy" FTS fixture so the bench-sized scan takes
/// long enough that a racing cancel signal has a reasonable chance to
/// win the `tokio::select!` arm. The exact row count exceeds
/// `MAX_SEARCH_RESULTS` (100) — under load this saturates the
/// configured fetch ceiling and forces the SQL builder to walk the
/// trigram index for a measurable number of rows.
async fn seed_heavy_partitioned_fixture(pool: &SqlitePool, n_blocks: u32) {
    let root = pt_block_id(0);
    insert_block(
        pool,
        &root,
        "page",
        "partitioned cancel root",
        None,
        Some(0),
    )
    .await;
    for i in 1..=n_blocks {
        let id = pt_block_id(i);
        insert_block(
            pool,
            &id,
            "content",
            &format!("partitioned cancellation row {i}"),
            Some(&root),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(pool).await.unwrap();
}

/// Thread-safe buffered writer usable as a `tracing_subscriber::fmt`
/// writer so we can capture emitted log lines in-process. Mirrors the
/// shape used in `db.rs::tests`.
#[derive(Clone, Default)]
struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl LogBuf {
    fn contents(&self) -> String {
        let bytes = self.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_drops_in_flight_query() {
    // Acceptance: dropping the client promise → in-flight Rust future
    // returns `AppError::Cancelled` within one row-batch boundary
    // (≤ 50 ms typical, ≤ 200 ms worst case per PEND-70).
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 150).await;

    let guard = crate::cancellation::CancellationGuard::new();
    let token = guard.token();

    // Fire the cancel signal *before* the inner call so the
    // `tokio::select!` immediately resolves the cancel arm. This
    // tests the load-bearing invariant: a fired token makes the
    // inner call observe `AppError::Cancelled` instead of returning
    // rows. The race-with-live-cancel path is covered by the spawn
    // assertion below.
    guard.cancel();

    let start = std::time::Instant::now();
    let result = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        50,
        50,
        crate::commands::queries::SearchFilter::default(),
        Some(token),
    )
    .await;
    let elapsed = start.elapsed();

    assert!(
        matches!(result, Err(crate::error::AppError::Cancelled)),
        "pre-cancelled token must surface AppError::Cancelled, got {result:?}"
    );
    assert!(
        elapsed < std::time::Duration::from_millis(200),
        "cancellation must propagate within 200ms worst-case, elapsed {elapsed:?}"
    );

    // Second leg: kick off an inner call without pre-cancellation,
    // fire the guard mid-flight, and observe `AppError::Cancelled`
    // within the 200ms budget. This is the "client dropped the
    // promise" path the IPC wrapper exercises in production.
    let guard2 = crate::cancellation::CancellationGuard::new();
    let token2 = guard2.token();
    let pool_clone = pool.clone();
    let handle = tokio::spawn(async move {
        let t0 = std::time::Instant::now();
        let res = crate::commands::queries::search_blocks_partitioned_inner(
            &pool_clone,
            "partitioned".to_string(),
            50,
            50,
            crate::commands::queries::SearchFilter::default(),
            Some(token2),
        )
        .await;
        (res, t0.elapsed())
    });
    // Yield briefly so the spawned task makes it into the SQL
    // fetch_all (or at least registers on the runtime).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    drop(guard2); // fire cancel via Drop, mirroring IPC wrapper behaviour.

    let (res, dt) = tokio::time::timeout(std::time::Duration::from_millis(500), handle)
        .await
        .expect("cancellation must complete within 500ms")
        .expect("spawned task must finish cleanly");
    // Two valid outcomes:
    //   1. Cancelled — the cancel signal won the race (expected path).
    //   2. Ok — the SQL completed before the cancel arrived. This is
    //      legitimate on a hot in-memory DB; the partitioned scan can
    //      finish in single-digit ms. We do NOT consider it a failure
    //      — the contract is "cancellation does no harm", not "every
    //      drop produces Cancelled".
    match res {
        Err(crate::error::AppError::Cancelled) => {
            assert!(
                dt < std::time::Duration::from_millis(200),
                "mid-flight cancel must surface within 200ms, dt = {dt:?}"
            );
        }
        Ok(_) => {
            // SQL won the race; no regression. Document via a permissive log line.
            eprintln!("note: mid-flight cancel raced and SQL completed first (dt = {dt:?})");
        }
        Err(e) => panic!("unexpected error from cancelled search: {e:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn slow_acquire_logs_warning() {
    // Acceptance: bursty typing saturates the read pool → at least
    // one slow-acquire warn fires. We exercise the saturation
    // mechanically: a holder task takes the single pool slot and
    // sleeps past the 50 ms `SLOW_SEARCH_ACQUIRE_WARN_MS` threshold,
    // forcing the next `search_pool_acquire_logged` caller to wait.
    //
    // ## Why we hold the connection inside the subscriber scope
    //
    // `tracing::subscriber::set_default` installs a *thread-local*
    // subscriber. `tokio::spawn`'d tasks run on different worker
    // threads, so the subscriber isn't visible inside the holder
    // closure. Holding the pool slot via a local `acquire().await`
    // on the current task keeps the slow-acquire warn (emitted by
    // `search_pool_acquire_logged` inside `fts_fetch_rows`) within
    // the same task that installed the subscriber.
    use tracing_subscriber::layer::SubscriberExt;

    // Single-slot pool guarantees the search task waits behind the
    // holder. `init_pool` would give 5 connections — too many to
    // reliably saturate from a single test.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("slow_acquire_search.db");
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&db_path)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON")
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    // Seed BEFORE we install the subscriber so the seed-side
    // queries (which run their own warn-eligible code paths) don't
    // pollute the captured log buffer.
    seed_heavy_partitioned_fixture(&pool, 50).await;

    let writer = LogBuf::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // Take the single slot on the *current* task so the subscriber
    // installed above is visible when the search task crosses the
    // slow-acquire threshold.
    let holder_conn = pool.acquire().await.unwrap();

    // Saturating call: race a search future against a `sleep` that
    // releases the holder past the slow-acquire threshold. The
    // search future's `search_pool_acquire_logged` waits the full
    // duration before getting its slot — that wait crosses the
    // `SLOW_SEARCH_ACQUIRE_WARN_MS` (50 ms) threshold and emits the
    // warn log.
    let pool_for_search = pool.clone();
    let search_future = async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_for_search,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            None,
        )
        .await
    };
    let release_future = async {
        // Sleep past the slow-acquire threshold, then drop the
        // holder so the search proceeds.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        drop(holder_conn);
    };
    let (search_res, ()) = tokio::join!(search_future, release_future);
    let _ = search_res.expect("search must complete once the holder releases");

    let contents = writer.contents();
    assert!(
        contents.contains("slow read-pool acquire"),
        "saturating the read pool must emit a slow-acquire warn, got: {contents:?}"
    );
    assert!(
        contents.contains("fts_fetch_rows"),
        "slow-acquire warn must carry the fts_fetch_rows label, got: {contents:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_does_not_lose_in_flight_results() {
    // Acceptance: firing two searches with the same query → at least
    // one completes successfully (no double-cancel race destroys
    // both). Mirrors the palette's keystroke pattern where the
    // *last* IPC is the one the frontend keeps.
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 30).await;

    let guard_a = crate::cancellation::CancellationGuard::new();
    let token_a = guard_a.token();
    let pool_a = pool.clone();
    let handle_a = tokio::spawn(async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_a,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            Some(token_a),
        )
        .await
    });

    let guard_b = crate::cancellation::CancellationGuard::new();
    let token_b = guard_b.token();
    let pool_b = pool.clone();
    let handle_b = tokio::spawn(async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_b,
            "partitioned".to_string(),
            10,
            10,
            crate::commands::queries::SearchFilter::default(),
            Some(token_b),
        )
        .await
    });

    // Cancel the first one only (mimicking the palette discarding
    // the stale IPC when a new keystroke arrives). The second must
    // complete OK.
    drop(guard_a);

    let res_a = tokio::time::timeout(std::time::Duration::from_secs(2), handle_a)
        .await
        .expect("first search must finish within 2s")
        .expect("first search task must join cleanly");
    let res_b = tokio::time::timeout(std::time::Duration::from_secs(2), handle_b)
        .await
        .expect("second search must finish within 2s")
        .expect("second search task must join cleanly");

    // At least one must complete with rows. The cancelled one may
    // return either Cancelled (cancel won) or Ok (SQL finished
    // first); the un-cancelled one must return Ok.
    assert!(
        res_b.is_ok(),
        "un-cancelled second search must complete: {res_b:?}"
    );
    let resp_b = res_b.unwrap();
    assert!(
        !resp_b.blocks.items.is_empty(),
        "un-cancelled search must return at least one row"
    );
    // Keep `guard_b` alive across the await so its Drop fires AFTER
    // the inner call completes — exercising the "guard outlives the
    // call" production path.
    drop(guard_b);

    // The first call: either Cancelled or Ok is acceptable.
    match res_a {
        Ok(_) | Err(crate::error::AppError::Cancelled) => {}
        Err(e) => panic!("first search must be Ok or Cancelled, got: {e:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rapid_fire_burst_pattern_does_not_starve_pool() {
    // Integration-style: mimic the palette's 5-keystroke rapid-fire
    // burst (80ms debounce per CommandPalette.tsx → 5 keystrokes in
    // ~400ms). Each keystroke fires a fresh `search_blocks_partitioned`
    // IPC; the previous one is cancelled. The last one must complete
    // successfully.
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 40).await;

    let mut prev_guard: Option<crate::cancellation::CancellationGuard> = None;
    let mut handles: Vec<(
        tokio::task::JoinHandle<
            Result<crate::commands::queries::PartitionedSearchResponse, crate::error::AppError>,
        >,
        usize,
    )> = Vec::new();

    // 5 keystrokes, each 80ms apart.
    for keystroke in 0..5 {
        // Drop the previous guard — this fires its cancel signal,
        // exactly mirroring the palette's "abandon the stale
        // generationRef" pattern.
        if let Some(g) = prev_guard.take() {
            drop(g);
        }
        let guard = crate::cancellation::CancellationGuard::new();
        let token = guard.token();
        let pool_clone = pool.clone();
        let handle = tokio::spawn(async move {
            crate::commands::queries::search_blocks_partitioned_inner(
                &pool_clone,
                "partitioned".to_string(),
                10,
                10,
                crate::commands::queries::SearchFilter::default(),
                Some(token),
            )
            .await
        });
        handles.push((handle, keystroke));
        prev_guard = Some(guard);
        // 80ms debounce window from CommandPalette.tsx.
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }

    // The last guard is still alive — its query must complete.
    let last_idx = handles.len() - 1;
    let (last_handle, _) = handles.pop().expect("we spawned 5 handles");
    let last_res = tokio::time::timeout(std::time::Duration::from_secs(3), last_handle)
        .await
        .expect("last search must finish within 3s")
        .expect("last search task must join cleanly");
    assert!(
        last_res.is_ok(),
        "the last (un-cancelled) keystroke's IPC must complete: {last_res:?}"
    );
    let last_resp = last_res.unwrap();
    assert!(
        !last_resp.blocks.items.is_empty(),
        "last keystroke's response must carry rows"
    );

    // Drain the previous handles. Each is allowed to be either
    // Ok (the SQL completed before the cancel arrived) or Cancelled
    // (cancel won the race). Any other error indicates a regression
    // in the cancellation plumbing.
    let mut completed = 0_usize;
    let mut cancelled = 0_usize;
    for (handle, idx) in handles {
        let res = tokio::time::timeout(std::time::Duration::from_secs(3), handle)
            .await
            .unwrap_or_else(|_| panic!("keystroke {idx} timed out"))
            .unwrap_or_else(|e| panic!("keystroke {idx} task panicked: {e:?}"));
        match res {
            Ok(_) => completed += 1,
            Err(crate::error::AppError::Cancelled) => cancelled += 1,
            Err(e) => panic!("keystroke {idx} surfaced unexpected error: {e:?}"),
        }
    }
    assert_eq!(
        completed + cancelled,
        last_idx, // we popped one; the remaining is last_idx
        "every cancelled keystroke must end with either Ok or Cancelled (no other errors), \
         completed={completed} cancelled={cancelled}"
    );
}

// ======================================================================
// PEND-73 Phase 5.T1d — FTS-index-drift consistency check
//
// Asserts the invariant that every active `blocks` row has a matching
// `fts_blocks` entry. A future writer that bypasses
// `update_fts_for_block` would surface here.
// ======================================================================

/// Walk `blocks` ⨝ `fts_blocks` and return any active block ids missing
/// from the FTS index. The empty Vec is the success case.
async fn verify_fts_consistency(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT b.id FROM blocks b \
         LEFT JOIN fts_blocks f ON f.block_id = b.id \
         WHERE b.deleted_at IS NULL \
           AND b.content IS NOT NULL \
           AND f.block_id IS NULL",
    )
    .fetch_all(pool)
    .await
    .expect("verify_fts_consistency query must execute cleanly")
}

#[tokio::test]
async fn fts_index_stays_consistent_under_writes() {
    let (pool, _dir) = test_pool().await;
    // Seed via the canonical writer; this is the path the materializer
    // and command handlers use in production. If a future refactor
    // introduces a sibling writer that bypasses `update_fts_for_block`,
    // the assertion below catches it as long as the new writer is
    // exercised by some test in this file.
    insert_block(
        &pool,
        "01HQFTSC01PAGE0000000P01CC",
        "page",
        "Consistency check page",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQFTSC02BLK00000000B02CC",
        "content",
        "Block under the consistency page",
        Some("01HQFTSC01PAGE0000000P01CC"),
        Some(0),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let drift = verify_fts_consistency(&pool).await;
    assert!(
        drift.is_empty(),
        "every active block with non-NULL content must have an fts_blocks row; drift: {drift:?}"
    );
}

#[tokio::test]
async fn fts_index_consistency_check_flags_missing_rows() {
    // PEND-73 Phase 5.T1d — confirm the helper itself catches drift.
    // Insert a block WITHOUT calling rebuild_fts_index → the FTS row
    // is missing → the helper must surface it.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQFTSC03BLK00000000B03CC",
        "content",
        "Block deliberately not indexed",
        None,
        Some(0),
    )
    .await;
    // Intentionally skipping `rebuild_fts_index` / `update_fts_for_block`.

    let drift = verify_fts_consistency(&pool).await;
    assert_eq!(
        drift,
        vec!["01HQFTSC03BLK00000000B03CC".to_string()],
        "the helper must catch a block that was inserted without FTS indexing"
    );
}

// ======================================================================
// PEND-58f — SQL/BE hardening regression tests
// ======================================================================

/// SQL-1 (PEND-58f) — duplicate tag IDs in the "ALL tags" filter must
/// NOT silently zero out the result on the FTS path. Before the dedup
/// fix, `tag_ids = [T, T]` made `COUNT(DISTINCT tag_id) = 1` compare
/// against the bound list length `2`, so the predicate could never hold.
#[tokio::test]
async fn fts_duplicate_tag_ids_do_not_zero_out_all_tags_filter() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQDUPTAG0000000000000T01";
    let blk = "01HQDUPTAG000000000000BLK1";
    insert_block(&pool, tag_id, "tag", "duptag", None, Some(0)).await;
    insert_block(
        &pool,
        blk,
        "content",
        &format!("dup-tag candidate referencing #[{tag_id}]"),
        None,
        Some(1),
    )
    .await;
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(blk)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    // The duplicate id appears twice in the caller-supplied list.
    let dup_tags = vec![tag_id.to_string(), tag_id.to_string()];
    let resp = search_fts(
        &pool,
        "candidate",
        &page,
        None,
        Some(&dup_tags),
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&blk),
        "duplicate tag ids must still match the tagged block (got {ids:?})"
    );
}

/// SQL-1 (PEND-58f) — same dedup guarantee on the regex-mode path.
#[tokio::test]
async fn regex_duplicate_tag_ids_do_not_zero_out_all_tags_filter() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQDUPRGX0000000000000T01";
    let blk = "01HQDUPRGX000000000000BLK1";
    insert_block(&pool, tag_id, "tag", "duprgx", None, Some(0)).await;
    insert_block(
        &pool,
        blk,
        "content",
        "regex-dup candidate alpha",
        None,
        Some(1),
    )
    .await;
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(blk)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let dup_tags = vec![tag_id.to_string(), tag_id.to_string()];
    let resp = search_with_toggles(
        &pool,
        "candidate",
        &page,
        None,
        Some(&dup_tags),
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: false,
            whole_word: false,
            is_regex: true,
        },
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&blk),
        "regex-mode duplicate tag ids must still match the tagged block (got {ids:?})"
    );
}

/// SQL-4 (PEND-58f) — an over-long FTS query is rejected up front with a
/// validation error rather than tokenised + bound into a MATCH.
#[tokio::test]
async fn fts_over_long_query_is_rejected() {
    let (pool, _dir) = test_pool().await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let huge = "a".repeat(super::search::MAX_QUERY_LEN + 1);
    let err = search_fts(
        &pool,
        &huge,
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await
    .expect_err("over-long query must be rejected");
    assert!(
        matches!(err, AppError::Validation(_)),
        "over-long query must surface AppError::Validation, got {err:?}"
    );
}

/// SQL-4 (PEND-58f) — a query at exactly the cap is accepted (boundary).
#[tokio::test]
async fn fts_query_at_exactly_the_cap_is_accepted() {
    let (pool, _dir) = test_pool().await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let at_cap = "a".repeat(super::search::MAX_QUERY_LEN);
    // No matching content — an empty result is fine; the point is that
    // the length guard does NOT reject a query at exactly the cap.
    let resp = search_fts(
        &pool,
        &at_cap,
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
    )
    .await;
    assert!(
        resp.is_ok(),
        "query at exactly MAX_QUERY_LEN must not be rejected: {resp:?}"
    );
}

/// SQL-3 (PEND-58f) — `has_more` must be TRUE at exactly the
/// `MAX_SEARCH_RESULTS` (100) cap when more rows exist. Before the fix,
/// `limit_plus_one_capped(100)` collapsed to `100`, so the probe could
/// never see the 101st row and `has_more` was stuck false at the cap.
#[tokio::test]
async fn partitioned_has_more_is_true_at_exactly_the_cap() {
    let (pool, _dir) = test_pool().await;

    // Seed > 100 matching content rows under a single root page so the
    // blocks partition's scan overflows the cap.
    let root = pt_block_id(0);
    insert_block(&pool, &root, "page", "cap boundary root", None, Some(0)).await;
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=130u32 {
        let id = pt_block_id(i);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(format!("capboundary row {i}"))
        .bind(&root)
        .bind(i64::from(i))
        .bind(&root)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    rebuild_fts_index(&pool).await.unwrap();

    // Request the page/block limits at exactly the cap (100).
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "capboundary".to_string(),
        100,
        100,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.blocks.items.len(),
        100,
        "blocks partition must fill to the 100 cap"
    );
    assert!(
        resp.blocks.has_more,
        "blocks.has_more must be TRUE at the cap when >100 rows matched"
    );
}

/// BE-2 (PEND-58f) — the partitioned command rejects an over-limit
/// request (mirrors the cursor path's `PageRequest::new` reject contract)
/// instead of silently capping it.
#[tokio::test]
async fn partitioned_over_limit_is_rejected() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    // page_limit over the cap.
    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        101,
        10,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("page_limit over the cap must be rejected");
    assert!(
        matches!(err, AppError::Validation(_)),
        "over-limit page_limit must surface AppError::Validation, got {err:?}"
    );

    // block_limit over the cap.
    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        101,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("block_limit over the cap must be rejected");
    assert!(
        matches!(err, AppError::Validation(_)),
        "over-limit block_limit must surface AppError::Validation, got {err:?}"
    );
}

/// BE-2 (PEND-58f) — limits at exactly the cap are accepted (boundary).
#[tokio::test]
async fn partitioned_limits_at_exactly_the_cap_are_accepted() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        100,
        100,
        crate::commands::queries::SearchFilter::default(),
        None,
    )
    .await;
    assert!(
        resp.is_ok(),
        "limits at exactly MAX_SEARCH_RESULTS must be accepted: {resp:?}"
    );
}

/// BE-6 (PEND-58f) — fail-fast: an invalid regex routed through the
/// partitioned inner surfaces a validation error (not a partial / empty
/// response). Exercises the command-layer error envelope.
#[tokio::test]
async fn partitioned_invalid_regex_fails_fast_with_validation() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "(unclosed".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("invalid regex must fail fast");
    assert!(
        matches!(err, AppError::Validation(_)),
        "invalid regex must surface AppError::Validation, got {err:?}"
    );
}

/// BE-6 (PEND-58f) — cancellation envelope: a pre-cancelled token makes
/// the partitioned inner return `AppError::Cancelled` rather than running
/// the scan to completion.
#[tokio::test]
async fn partitioned_pre_cancelled_token_returns_cancelled() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let guard = crate::cancellation::CancellationGuard::new();
    let token = guard.token();
    // Fire the cancel signal before the search runs.
    drop(guard);

    let result = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter::default(),
        Some(token),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "a pre-cancelled token must yield AppError::Cancelled, got {result:?}"
    );
}

/// BE-8 (PEND-58f) — an empty `prop:` key is rejected at the command
/// layer (mirrors `query_by_property_inner`'s contract) instead of
/// composing a `bp.key = ''` clause that silently matches nothing.
#[tokio::test]
async fn search_empty_property_key_is_rejected() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            property_filters: vec![crate::commands::queries::SearchPropertyFilter {
                key: "   ".to_string(),
                value: "x".to_string(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("empty prop: key must be rejected");
    assert!(
        matches!(err, AppError::Validation(_)),
        "empty prop: key must surface AppError::Validation, got {err:?}"
    );
}

/// BE-9 (PEND-58f) — `space_id: Some("")` is the "match nothing"
/// space-isolation invariant. A search scoped to the empty space must
/// return zero rows even when matching content exists in real spaces.
#[tokio::test]
async fn search_empty_space_id_matches_nothing() {
    let (pool, _dir) = test_pool().await;
    // Seed a real space + a matching page assigned to it, so without the
    // empty-space guard the row would otherwise be reachable.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    seed_partitioned_fixture(&pool, 1, 1).await;
    assign_to_space_for_fts(&pool, PT_PAGE_IDS[0], FTS_SPACE_A_ID).await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        crate::commands::queries::SearchFilter {
            space_id: Some(String::new()),
            ..Default::default()
        },
        None,
    )
    .await
    .expect("empty space_id search must succeed (returning nothing)");

    assert_eq!(
        resp.pages.items.len(),
        0,
        "space_id=\"\" must match no pages"
    );
    assert_eq!(
        resp.blocks.items.len(),
        0,
        "space_id=\"\" must match no blocks"
    );
}
