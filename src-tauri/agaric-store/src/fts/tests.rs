use super::*;
use crate::pagination::{Cursor, PageRequest};
use agaric_core::error::AppError;
use sqlx::SqlitePool;
use std::collections::HashMap;
use tempfile::TempDir;

/// #1321 — test shim. `strip_for_fts_with_maps` now takes a `block_id` first
/// argument (threaded so the FTS truncation warning can name the offending
/// block). The dozens of strip-semantics tests below don't care about the
/// block id, so this wrapper injects a fixed placeholder and keeps their call
/// sites unchanged. Tests that exercise the truncation warning itself call the
/// real `super::strip::strip_for_fts_with_maps` directly with a meaningful id.
fn strip_for_fts_with_maps(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    super::strip::strip_for_fts_with_maps("test-block", content, tag_names, page_titles)
}

// ── Helpers ──────────────────────────────────────────────────────────

async fn test_pool() -> (SqlitePool, TempDir) {
    crate::test_support::test_pool().await
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
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = ?")
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
// strip_for_fts_with_maps tests (markup stripping — no refs needed)
// ======================================================================

#[test]
fn strip_plain_text_unchanged() {
    let result = strip_for_fts_with_maps("hello world", &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "hello world",
        "plain text should pass through unchanged"
    );
}

#[test]
fn strip_bold() {
    let result = strip_for_fts_with_maps("**hello**", &HashMap::new(), &HashMap::new());
    assert_eq!(result, "hello", "bold markers should be stripped");
}

#[test]
fn strip_italic() {
    let result = strip_for_fts_with_maps("*hello*", &HashMap::new(), &HashMap::new());
    assert_eq!(result, "hello", "italic markers should be stripped");
}

#[test]
fn strip_code() {
    let result = strip_for_fts_with_maps("`hello`", &HashMap::new(), &HashMap::new());
    assert_eq!(result, "hello", "inline code backticks should be stripped");
}

#[test]
fn strip_strikethrough() {
    let result = strip_for_fts_with_maps("~~deleted~~", &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "deleted",
        "strikethrough markers should be stripped"
    );
}

#[test]
fn strip_highlight() {
    let result = strip_for_fts_with_maps("==important==", &HashMap::new(), &HashMap::new());
    assert_eq!(result, "important", "highlight markers should be stripped");
}

#[test]
fn strip_mixed_formatting() {
    let result = strip_for_fts_with_maps(
        "**bold** and *italic* and `code`",
        &HashMap::new(),
        &HashMap::new(),
    );
    assert_eq!(
        result, "bold and italic and code",
        "mixed bold/italic/code formatting should be stripped"
    );
}

#[test]
fn strip_mixed_with_strike_and_highlight() {
    let result = strip_for_fts_with_maps(
        "**bold** and ~~deleted~~ and ==highlighted==",
        &HashMap::new(),
        &HashMap::new(),
    );
    assert_eq!(
        result, "bold and deleted and highlighted",
        "mixed bold/strikethrough/highlight formatting should be stripped"
    );
}

#[test]
fn strip_tag_ref_resolved() {
    let mut tag_names = HashMap::new();
    tag_names.insert(TAG_ULID.to_string(), "urgent".to_string());

    let input = format!("task #[{TAG_ULID}]");
    let result = strip_for_fts_with_maps(&input, &tag_names, &HashMap::new());
    assert_eq!(
        result, "task urgent",
        "tag reference should resolve to tag name"
    );
}

#[test]
fn strip_page_link_resolved() {
    let mut page_titles = HashMap::new();
    page_titles.insert(PAGE_ULID.to_string(), "My Page".to_string());

    let input = format!("see [[{PAGE_ULID}]]");
    let result = strip_for_fts_with_maps(&input, &HashMap::new(), &page_titles);
    assert_eq!(
        result, "see My Page",
        "page link should resolve to page title"
    );
}

#[test]
fn strip_unknown_tag_ref_becomes_empty() {
    let input = format!("task #[{UNKNOWN_ULID}]");
    let result = strip_for_fts_with_maps(&input, &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "task ",
        "unknown tag reference should resolve to empty string"
    );
}

#[test]
fn strip_unknown_page_link_becomes_empty() {
    let input = format!("see [[{UNKNOWN_ULID}]]");
    let result = strip_for_fts_with_maps(&input, &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "see ",
        "unknown page link should resolve to empty string"
    );
}

#[test]
fn strip_nested_bold_italic() {
    // **bold *italic*** — bold outer stripped first, then italic
    let result = strip_for_fts_with_maps("**bold *italic***", &HashMap::new(), &HashMap::new());
    // After bold strip: "bold *italic*", after italic strip: "bold italic"
    assert_eq!(
        result, "bold italic",
        "nested bold/italic should be fully stripped"
    );
}

#[test]
fn strip_multiple_refs_batched() {
    let tag_id = "01AAAAAAAAAAAAAAAAAAAAATAG";
    let page_id = "01AAAAAAAAAAAAAAAAAAAAPGE1";
    let mut tag_names = HashMap::new();
    tag_names.insert(tag_id.to_string(), "urgent".to_string());
    let mut page_titles = HashMap::new();
    page_titles.insert(page_id.to_string(), "My Page".to_string());

    let input = format!("task #[{tag_id}] and #[{tag_id}] see [[{page_id}]] and [[{page_id}]]");
    let result = strip_for_fts_with_maps(&input, &tag_names, &page_titles);
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

/// #435 — a pathological multi-MB block must have its FTS-indexed text capped
/// (UTF-8-safe), so one giant paste cannot dominate the trigram index. A normal
/// block is returned unchanged.
#[test]
fn strip_caps_pathological_block_indexed_length() {
    let tag_names = HashMap::new();
    let page_titles = HashMap::new();

    // A small (sub-cap) block is returned unchanged. Call the real function
    // directly with a named block_id so we exercise the #1321 signature.
    let small = super::strip::strip_for_fts_with_maps(
        "blk-small",
        "just a normal note",
        &tag_names,
        &page_titles,
    );
    assert_eq!(small, "just a normal note");

    // A 1 MB multibyte block (`é` = 2 bytes) is capped at a char boundary. The
    // #1321 truncation warning fires here (naming `blk-big`, original vs indexed
    // bytes) — we assert on the truncation length behaviour rather than the log
    // line, as `tracing-test` is not a dev-dependency.
    let big = "é".repeat(512 * 1024); // 1 MiB of valid UTF-8
    let capped = super::strip::strip_for_fts_with_maps("blk-big", &big, &tag_names, &page_titles);
    assert!(
        capped.len() <= 128 * 1024,
        "indexed text must be capped at 128 KiB; got {}",
        capped.len()
    );
    assert!(
        capped.len() > 128 * 1024 - 8,
        "cap should keep close to the full budget; got {}",
        capped.len()
    );
    // Truncation must land on a UTF-8 boundary (no panic / no replacement char).
    assert!(capped.chars().all(|c| c == 'é'));
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
    // Pin behaviour for queries shorter than the trigram
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
            None,
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
        None,
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
        None,
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
        None,
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
        None,
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
            None,
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
        None,
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

#[test]
fn strip_escaped_asterisk() {
    let result = strip_for_fts_with_maps(r"use \*args", &HashMap::new(), &HashMap::new());
    assert_eq!(result, "use *args", "escaped asterisk should be unescaped");
}

#[test]
fn strip_escaped_backtick() {
    // A single (unpaired) escaped backtick is not matched by CODE_RE,
    // so it passes through to the unescape step.
    // Paired `\`...\`` would be consumed by CODE_RE first (known limitation).
    let result = strip_for_fts_with_maps("it costs 5\\` USD", &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "it costs 5` USD",
        "escaped backtick should be unescaped"
    );
}

#[test]
fn strip_complex_nested_markup() {
    let result =
        strip_for_fts_with_maps("**bold *nested*** rest", &HashMap::new(), &HashMap::new());
    assert_eq!(
        result, "bold nested rest",
        "complex nested bold/italic should be fully stripped"
    );
}

#[test]
fn strip_mixed_formatting_and_refs() {
    let mut tag_names = HashMap::new();
    tag_names.insert(TAG_ULID.to_string(), "urgent".to_string());

    let input = format!("**bold** and `code` with #[{TAG_ULID}]");
    let result = strip_for_fts_with_maps(&input, &tag_names, &HashMap::new());
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
        None,
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
        None,
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
    // #669 — the sanitiser emits the bare leading `NOT` unchanged. This is a
    // *binary*-operator keyword in FTS5: a leading `NOT term` has no left
    // operand and is an FTS5 syntax error at MATCH time (see the `search_fts`
    // "standalone NOT should produce a validation error" test). The sanitiser
    // does NOT silently drop it (that would invert intent) — it preserves it
    // so the error surfaces as `AppError::Validation`.
    assert_eq!(
        sanitize_fts_query("NOT spam"),
        "NOT \"spam\"",
        "leading bare NOT preserved verbatim; FTS5 rejects it at MATCH time (#669)"
    );
}

#[test]
fn sanitize_preserves_binary_not_operator_669() {
    // #669 — the *valid* form is the binary `A NOT B`, which FTS5 accepts.
    // This is the form the rustdoc now advertises (not the leading `NOT B`).
    assert_eq!(
        sanitize_fts_query("cats NOT dogs"),
        "\"cats\" NOT \"dogs\"",
        "binary NOT between two terms is the FTS5-valid form"
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
    // Phase 5.T1c — pin the sanitiser's behaviour on an
    // all-operator query so a future change can't silently move it.
    //
    // The desired contract Phase 5.T1c reads:
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

#[test]
fn sanitize_drops_dangling_operator_after_subtrigram_drop() {
    // R5 (#347) — the first pass promotes `NOT` to a bare operator
    // because a token (`ab`) follows it, but the trigram length filter
    // then drops `ab` (2 chars), leaving a bare trailing `NOT`. Before
    // the fix this produced `"cats" NOT`, which FTS5 rejects with a
    // syntax error on benign input. The second pass must drop the
    // operand-less operator.
    assert_eq!(
        sanitize_fts_query("cats NOT ab"),
        "\"cats\"",
        "operand of NOT was dropped by the trigram filter; the now-dangling \
         bare NOT must be dropped, not emitted as `\"cats\" NOT`"
    );
    // Same hazard with the binary OR (right operand sub-trigram).
    assert_eq!(
        sanitize_fts_query("cats OR ab"),
        "\"cats\"",
        "right operand of OR dropped by trigram filter → dangling bare OR removed"
    );
    // Left operand of OR dropped → dangling leading bare OR removed.
    assert_eq!(
        sanitize_fts_query("ab OR cats"),
        "\"cats\"",
        "left operand of OR dropped by trigram filter → dangling bare OR removed"
    );
    // Both operands of OR survive → operator preserved (no regression).
    assert_eq!(
        sanitize_fts_query("cats OR dogs"),
        "\"cats\" OR \"dogs\"",
        "valid binary operator with both operands present is preserved"
    );
    // NOT with a surviving operand stays a bare operator.
    assert_eq!(
        sanitize_fts_query("cats NOT dogs"),
        "\"cats\" NOT \"dogs\"",
        "NOT with a surviving 3-char operand is a valid operator"
    );
    // Two operators collapse when the middle operand is dropped:
    // `cats OR ab NOT dogs` → `cats`, OR(bare), [ab dropped], NOT(bare),
    // dogs → `"cats" OR NOT "dogs"`. The adjacent bare-op pair `OR NOT`
    // is invalid; the post-pass drops the operand-less `OR`, leaving a
    // valid `"cats" NOT "dogs"`.
    assert_eq!(
        sanitize_fts_query("cats OR ab NOT dogs"),
        "\"cats\" NOT \"dogs\"",
        "middle operand dropped → adjacent bare operators reduced to the \
         one that still has both operands"
    );
    // All-sub-trigram operands → everything drops, including operators.
    assert_eq!(
        sanitize_fts_query("ab NOT cd"),
        "",
        "both operands sub-trigram → empty MATCH (no dangling operator)"
    );
}

// ======================================================================
// #477 — empty / whitespace-only QuotedPhrase must not produce FTS5 syntax error
// ======================================================================

#[test]
fn sanitize_empty_quoted_phrase_yields_empty() {
    assert_eq!(
        sanitize_fts_query("\"\""),
        "",
        "empty quoted phrase is a FTS5 syntax error and must be dropped"
    );
}

#[test]
fn sanitize_whitespace_only_quoted_phrase_yields_empty() {
    assert_eq!(
        sanitize_fts_query("\"  \""),
        "",
        "whitespace-only quoted phrase is a FTS5 syntax error and must be dropped"
    );
}

#[test]
fn sanitize_sub_trigram_quoted_phrase_dropped_673() {
    // #673 — a quoted phrase shorter than a trigram emits zero trigram
    // tokens, so on its own it AND-collapses the query to no rows. Dropping
    // it (rather than honouring the quote-intent bypass) prevents the silent
    // empty result the bare-word length filter already guards against.
    assert_eq!(
        sanitize_fts_query("\"ab\""),
        "",
        "a sub-trigram quoted phrase cannot match the trigram index; drop it"
    );
    // Mixed with a real term: the short phrase is dropped, the term survives —
    // the query no longer collapses to nothing.
    assert_eq!(
        sanitize_fts_query("\"ab\" hello"),
        "\"hello\"",
        "sub-trigram phrase dropped; the matchable term must survive"
    );
    // A phrase whose words are each sub-trigram but which spans >=3 chars
    // (the trigram tokenizer indexes across the space) is KEPT.
    assert_eq!(
        sanitize_fts_query("\"ab cd\""),
        "\"ab cd\"",
        "phrase spanning >= 3 chars has trigrams across the space; keep it"
    );
}

// ======================================================================
// FTS pagination with identical/close ranks (#3 fix)
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
            None,
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
        None,
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
        None,
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
        None,
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
            None,
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

#[tokio::test]
async fn search_pagination_equal_ranks_id_tiebreak() {
    // #1598 — when several blocks share the *same* bm25 rank (identical
    // content/length), the rank comparison falls entirely within the
    // epsilon band, so pagination must advance purely on the unique
    // `block_id` tiebreaker. Walk the whole corpus one row per page and
    // assert every block appears exactly once: a broken tiebreak would
    // either skip a row (the boundary row's id is excluded) or loop on a
    // duplicate. Three identical-content blocks is the minimal corpus that
    // forces a page boundary *inside* a run of equal ranks.
    let (pool, _dir) = test_pool().await;

    // Identical content ⇒ identical bm25 rank for all three rows.
    for (id, pos) in [(BLOCK_A, 0), (BLOCK_B, 1), (BLOCK_C, 2)] {
        insert_block(
            &pool,
            id,
            "content",
            "pagination identical body",
            None,
            Some(pos),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

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
            None,
        )
        .await
        .unwrap();
        for item in &result.items {
            all_ids.push(item.id.clone().into());
        }
        pages += 1;
        assert!(pages <= 5, "too many pages — possible infinite loop / dup");
        if !result.has_more {
            break;
        }
        cursor = result.next_cursor;
    }

    let unique: std::collections::HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(
        all_ids.len(),
        3,
        "equal-rank rows must paginate exactly once each (got {all_ids:?})"
    );
    assert_eq!(unique.len(), 3, "no equal-rank row skipped or duplicated");
}

/// #1598 — the cursor keyset predicate must absorb float-precision drift
/// proportional to the rank's *magnitude*, so pagination correctness is
/// not coupled to bm25's numeric scale. Real trigram bm25 ranks are
/// sub-unit (≈ -1e-6), where the relative band `1e-9 * MAX(1, |rank|)`
/// collapses to the old fixed `1e-9` — so the two only diverge at large
/// magnitudes. To exercise that regime directly we run the EXACT
/// production WHERE predicate against a synthetic rowset.
///
/// Scenario: the boundary row (the last row of page 1, the one the cursor
/// points at) is re-presented to the page-2 query with its rank drifted
/// UPWARD by an amount proportional to magnitude — wider than `1e-9` but
/// within `1e-9 * |rank|` (the kind of drift SQLite's f64 recomputation
/// produces for large-magnitude ranks). The page-2 query must NOT
/// re-emit that already-seen row.
///
/// - Relative epsilon (production): the drift stays inside the band, so
///   the boundary row falls through to the `id > cursor_id` tiebreak,
///   which excludes it (same id) — correct, no duplicate.
/// - Old fixed `1e-9`: the drift exceeds the band, so the boundary row
///   satisfies `rank > cursor_rank + 1e-9` and is DUPLICATED.
///
/// The test asserts both arms, locking the relative fix in as a
/// mutation-killer (revert to `1e-9` ⇒ the duplicate reappears ⇒ fail).
#[tokio::test]
async fn fts_cursor_keyset_predicate_scale_invariant() {
    let (pool, _dir) = test_pool().await;

    // Cursor points at the boundary row (R, "ID_B") emitted on page 1.
    let cursor_rank = -1000.0_f64;
    let cursor_id = "ID_B";

    // The boundary row's rank as RE-COMPUTED on the page-2 query, drifted
    // upward by 5e-7. At |rank|=1000 the relative band half-width is
    // 1e-9*1000 = 1e-6, so 5e-7 < 1e-6 (absorbed) but 5e-7 > 1e-9 (NOT
    // absorbed by the old fixed band).
    let drift = 5e-7_f64;
    let boundary_recomputed = cursor_rank + drift;
    assert!(drift > 1e-9, "drift must exceed the OLD fixed epsilon");
    assert!(
        drift < 1e-9 * cursor_rank.abs(),
        "drift must stay within the relative band"
    );

    // Page-2 candidate rowset (as the `fts JOIN blocks` projection would
    // yield it), ordered by `(rank, id)`:
    //   - the boundary row, re-presented with its drifted rank + SAME id
    //   - a genuinely-later row that page 2 SHOULD return
    let later_rank = cursor_rank + 1.0; // unambiguously greater (less negative)
    let rows: Vec<(f64, &str)> = vec![(boundary_recomputed, "ID_B"), (later_rank, "ID_C")];
    let values_clause = rows
        .iter()
        .map(|(r, id)| format!("({r:?}, '{id}')"))
        .collect::<Vec<_>>()
        .join(", ");

    // (a) Relative epsilon — the production predicate (mirrors fetch.rs).
    //     Must return ONLY the genuinely-later row; the drifted boundary
    //     row is excluded by the id tiebreak.
    let sql_rel = format!(
        "WITH rows(rank, id) AS (VALUES {values_clause}) \
         SELECT id FROM rows \
         WHERE rank > ?1 + (1e-9 * MAX(1.0, ABS(?1))) \
            OR (ABS(rank - ?1) <= (1e-9 * MAX(1.0, ABS(?1))) AND id > ?2) \
         ORDER BY rank, id"
    );
    let page2_rel: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql_rel))
        .bind(cursor_rank)
        .bind(cursor_id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        page2_rel,
        vec!["ID_C".to_string()],
        "relative-epsilon keyset must exclude the drifted boundary row (no dup) \
         and return exactly the unseen row"
    );

    // (b) The OLD fixed-`1e-9` predicate — demonstrate it DUPLICATES the
    //     boundary row "ID_B" at this magnitude, which is exactly the bug
    //     the relative band fixes.
    let sql_fixed = format!(
        "WITH rows(rank, id) AS (VALUES {values_clause}) \
         SELECT id FROM rows \
         WHERE rank > ?1 + 1e-9 \
            OR (ABS(rank - ?1) < 1e-9 AND id > ?2) \
         ORDER BY rank, id"
    );
    let page2_fixed: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql_fixed))
        .bind(cursor_rank)
        .bind(cursor_id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(
        page2_fixed.contains(&"ID_B".to_string()),
        "guard: the OLD fixed-1e-9 predicate is expected to DUPLICATE the boundary \
         row at this scale (proving the relative fix is load-bearing); got {page2_fixed:?}"
    );
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
            None,
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
        None,
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
        None,
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
        None,
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
        None, //  Phase 2: space_id unscoped
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
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
        None, //  Phase 2: space_id unscoped
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
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
        None,
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
        None,
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
        None,
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

// ── reindex_fts_references must pick up inline-only referencing blocks ──
//
// Before a block whose only link to a tag was an inline
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
    // Block_tag_refs (the cache).
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
        None,
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
        None,
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
        None,
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

// ── reindex_fts_references must chunk large rename targets ──
//
// Before `reindex_fts_references` opened one transaction for the
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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
// Phase 2 — space filtering in search_fts
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
/// so the FK on `blocks.space_id` validates when the tests assign a page
/// to the space.
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

/// Assign a block to a space by stamping the denormalized `blocks.space_id`
/// column directly — bypasses the command layer because the test targets
/// the FTS filter SQL, not op-log semantics.
async fn assign_to_space_for_fts(pool: &SqlitePool, block_id: &str, space_id: &str) {
    // #533: stamp the denormalized `blocks.space_id` column the FTS filter
    // reads (every block whose owning page is `block_id`).
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(space_id)
        .bind(block_id)
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
        None,
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
        None,
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
        None,
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
        None,
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
// #1320-C — `last-edited:` window filter (routed through
// `SearchProjection::compile_last_edited` via the builder's
// `add_last_edited_via_projection` splice).
// ======================================================================

/// Append one `op_log` row pinning a block's last-edit timestamp.
///
/// `compile_last_edited` compares `COALESCE(MAX(op_log.created_at WHERE
/// block_id = b.id), 0)` (epoch-ms, migration 0079) against a rolling /
/// absolute boundary, so the only column that matters for these tests is
/// `created_at`. The remaining NOT-NULL columns get inert placeholders;
/// `seq` is unique per call so the `(device_id, seq)` PK never collides.
async fn insert_op_log_at(pool: &SqlitePool, block_id: &str, seq: i64, created_at_ms: i64) {
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES ('test-device', ?, 'h' || ?, 'edit_block', '{}', ?, ?)",
    )
    .bind(seq)
    .bind(seq)
    .bind(created_at_ms)
    .bind(block_id)
    .execute(pool)
    .await
    .unwrap();
}

/// epoch-ms `n` days before `now`.
fn ms_days_ago(days: i64) -> i64 {
    (chrono::Utc::now() - chrono::Duration::days(days)).timestamp_millis()
}

fn last_edited_meta(
    spec: crate::filters::primitive::LastEditedSpec,
) -> crate::fts::metadata_filter::MetadataPredicates {
    crate::fts::metadata_filter::MetadataPredicates {
        last_edited: Some(spec),
        ..Default::default()
    }
}

#[tokio::test]
async fn search_last_edited_rolling_returns_only_in_window_blocks() {
    use crate::filters::primitive::LastEditedSpec;
    let (pool, _dir) = test_pool().await;

    // Three blocks sharing the keyword, edited 1 / 10 / 100 days ago.
    insert_block(&pool, BLOCK_A, "content", "rolling needle", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "rolling needle", None, Some(1)).await;
    insert_block(&pool, BLOCK_C, "content", "rolling needle", None, Some(2)).await;
    insert_op_log_at(&pool, BLOCK_A, 1, ms_days_ago(1)).await;
    insert_op_log_at(&pool, BLOCK_B, 2, ms_days_ago(10)).await;
    insert_op_log_at(&pool, BLOCK_C, 3, ms_days_ago(100)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // Rolling 7d — only the 1-day-old block is in-window.
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::Rolling { days: 7 }),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![BLOCK_A], "Rolling{{7}} must return only BLOCK_A");

    // Rolling 30d — BLOCK_A (1d) and BLOCK_B (10d), not BLOCK_C (100d).
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::Rolling { days: 30 }),
        None,
    )
    .await
    .unwrap();
    let mut ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![BLOCK_A, BLOCK_B],
        "Rolling{{30}} must return BLOCK_A + BLOCK_B, exclude the 100d-old BLOCK_C"
    );

    // No filter (default metadata) — all three blocks.
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        resp.items.len(),
        3,
        "no last_edited filter must surface all three matches"
    );
}

#[tokio::test]
async fn search_last_edited_older_than_returns_only_stale_blocks() {
    use crate::filters::primitive::LastEditedSpec;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "older needle", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "older needle", None, Some(1)).await;
    insert_op_log_at(&pool, BLOCK_A, 1, ms_days_ago(2)).await; // recent
    insert_op_log_at(&pool, BLOCK_B, 2, ms_days_ago(90)).await; // stale
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();

    // OlderThan 30d — only the 90-day-old block.
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::OlderThan { days: 30 }),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![BLOCK_B],
        "OlderThan{{30}} must return only the stale BLOCK_B"
    );
}

#[tokio::test]
async fn search_last_edited_range_returns_only_blocks_inside_window() {
    use crate::filters::primitive::LastEditedSpec;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "range needle", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "range needle", None, Some(1)).await;
    insert_block(&pool, BLOCK_C, "content", "range needle", None, Some(2)).await;
    insert_op_log_at(&pool, BLOCK_A, 1, ms_days_ago(5)).await; // inside
    insert_op_log_at(&pool, BLOCK_B, 2, ms_days_ago(40)).await; // before start
    insert_op_log_at(&pool, BLOCK_C, 3, ms_days_ago(1)).await; // after end
    rebuild_fts_index(&pool).await.unwrap();

    // Window: [10 days ago, 3 days ago] (inclusive calendar days).
    let start = (chrono::Utc::now() - chrono::Duration::days(10))
        .format("%Y-%m-%d")
        .to_string();
    let end = (chrono::Utc::now() - chrono::Duration::days(3))
        .format("%Y-%m-%d")
        .to_string();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::Range { start, end }),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![BLOCK_A],
        "Range must return only the in-window BLOCK_A (BLOCK_B before start, BLOCK_C after end)"
    );
}

#[tokio::test]
async fn search_last_edited_no_op_log_block_excluded_from_rolling() {
    use crate::filters::primitive::LastEditedSpec;
    let (pool, _dir) = test_pool().await;

    // BLOCK_A has a recent op-log; BLOCK_B has NONE → its
    // COALESCE(MAX(...), 0) is the epoch sentinel, far in the past, so a
    // Rolling window must exclude it (the no-op-log rule).
    insert_block(&pool, BLOCK_A, "content", "coalesce needle", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "coalesce needle", None, Some(1)).await;
    insert_op_log_at(&pool, BLOCK_A, 1, ms_days_ago(1)).await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::Rolling { days: 7 }),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![BLOCK_A],
        "no-op-log block (epoch sentinel) must be excluded from a Rolling window"
    );

    // OlderThan must INCLUDE the no-op-log block (epoch < now-N).
    let resp = search_fts(
        &pool,
        "needle",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &last_edited_meta(LastEditedSpec::OlderThan { days: 7 }),
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![BLOCK_B],
        "no-op-log block (epoch sentinel) must be INCLUDED by OlderThan"
    );
}

// ======================================================================
// D — Chunked rebuild_fts_index regression test
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
            None,
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
// E — update_fts_for_block produces identical output via
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
    let (tag_names, page_titles) = crate::fts::strip::load_ref_maps(&pool).await.unwrap();
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
        None,
    )
    .await
    .unwrap();
    assert!(
        urgent.items.iter().any(|b| b.id == BLOCK_A),
        "BLOCK_A must match resolved tag name 'urgent' via FTS"
    );
}

/// Audit #418 — `load_ref_maps_for_block` must return maps scoped to ONLY the
/// references in the given block's content, not the whole vault's tags/pages
/// (which `load_ref_maps` does). It must also produce the same FTS output as
/// the full-scan loader for the block's own refs.
#[tokio::test]
async fn load_ref_maps_for_block_is_scoped_to_block_refs() {
    const TAG_ULID_2: &str = "01HQTAG000000000000000TAG2";
    const PAGE_ULID_2: &str = "01HQPAGE00000000000000PG02";
    let (pool, _dir) = test_pool().await;

    // Two tags + two pages exist in the vault; the block references only one of
    // each.
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;
    insert_block(&pool, TAG_ULID_2, "tag", "someday", None, None).await;
    insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;
    insert_block(&pool, PAGE_ULID_2, "page", "Other Page", None, None).await;

    let content = format!("see [[{PAGE_ULID}]] and tag #[{TAG_ULID}]");
    insert_block(&pool, BLOCK_A, "content", &content, None, Some(0)).await;

    let (tag_names, page_titles) = crate::fts::load_ref_maps_for_block(&pool, BLOCK_A)
        .await
        .unwrap();

    // Scoped: exactly the one referenced tag and page, NOT the unreferenced ones.
    assert_eq!(tag_names.len(), 1, "only the referenced tag must be loaded");
    assert_eq!(tag_names.get(TAG_ULID).map(String::as_str), Some("urgent"));
    assert!(
        !tag_names.contains_key(TAG_ULID_2),
        "unreferenced tag must NOT be loaded"
    );
    assert_eq!(
        page_titles.len(),
        1,
        "only the referenced page must be loaded"
    );
    assert_eq!(
        page_titles.get(PAGE_ULID).map(String::as_str),
        Some("My Page")
    );
    assert!(
        !page_titles.contains_key(PAGE_ULID_2),
        "unreferenced page must NOT be loaded"
    );

    // The scoped maps must produce the same fts output as the full-scan loader.
    crate::fts::update_fts_for_block_with_maps(&pool, BLOCK_A, &tag_names, &page_titles)
        .await
        .unwrap();
    let scoped_stripped: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();

    let (all_tags, all_pages) = crate::fts::strip::load_ref_maps(&pool).await.unwrap();
    crate::fts::update_fts_for_block_with_maps(&pool, BLOCK_A, &all_tags, &all_pages)
        .await
        .unwrap();
    let full_stripped: String =
        sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        scoped_stripped, full_stripped,
        "scoped loader must yield identical fts output to the full-scan loader"
    );
}

/// Audit #418 — a block with no inline refs loads empty maps (no DB scan).
#[tokio::test]
async fn load_ref_maps_for_block_empty_for_no_refs() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;
    insert_block(
        &pool,
        BLOCK_A,
        "content",
        "plain text, no refs",
        None,
        Some(0),
    )
    .await;

    let (tag_names, page_titles) = crate::fts::load_ref_maps_for_block(&pool, BLOCK_A)
        .await
        .unwrap();
    assert!(
        tag_names.is_empty() && page_titles.is_empty(),
        "a ref-free block must load empty maps (no whole-vault scan)"
    );
}

#[tokio::test]
async fn update_fts_for_block_with_maps_removes_deleted_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, BLOCK_A, "content", "text body", None, Some(0)).await;
    let (tag_names, page_titles) = crate::fts::strip::load_ref_maps(&pool).await.unwrap();
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
// Combined inline-markup regex matches the previous
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
// Multi-row INSERT path covers 600+ blocks correctly.
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

    // #345 / C6 — whole-table integrity scan: the riskiest write path
    // (reindex's batch DELETE + multi-row INSERT) must leave NO block_id
    // with duplicate fts rows. FTS5 can't enforce this with a UNIQUE
    // constraint, so this guards the single-row-per-block invariant
    // documented at the top of `fts/index.rs`.
    super::index::assert_no_duplicate_fts_rows(&pool).await;
}

// ======================================================================
// Phase 1 — `snippet()` column tests
// ======================================================================
//
// These tests pin the wire shape of `SearchBlockRow.snippet` to the
// FTS5 `snippet()` window with #828 PUA sentinel markers (U+E000 open /
// U+E001 close). The web UI renders them as React nodes (parsing the
// sentinels); NEVER as `dangerouslySetInnerHTML`. The MCP search tool
// converts them back to `<mark>` / `</mark>`. Any change here must be
// paired with a frontend renderer change.
//
// The window constant is `32` (trigrams) — see
// "Edge cases (locked in)" for
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
        None,
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet() must produce some text for a content match");
    let opens = snippet.matches('\u{E000}').count();
    let closes = snippet.matches('\u{E001}').count();
    assert!(
        opens >= 1,
        "snippet must contain at least one U+E000 opener, got: {snippet:?}"
    );
    assert_eq!(
        opens, closes,
        "every U+E000 opener must have a matching U+E001 closer, got: {snippet:?}"
    );
    assert!(
        snippet.contains("\u{E000}wonderful\u{E001}"),
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
        None,
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
        None,
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0].snippet.as_deref().unwrap_or("");
    // FTS5 does not HTML-escape; the raw characters survive verbatim.
    assert!(
        snippet.contains("a < b"),
        "expected literal 'a < b' to survive verbatim, got: {snippet:?}"
    );
    assert!(
        snippet.contains('&'),
        "expected literal '&' to survive verbatim, got: {snippet:?}"
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
        None,
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one match");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced");
    // Baseline: the 32-trigram window plus ellipsis must keep
    // the output well under the source body length.
    assert!(
        snippet.len() < 400,
        "snippet must be windowed, got len={} for body of len {}: {snippet:?}",
        snippet.len(),
        body.len(),
    );
    assert!(
        snippet.contains('\u{E000}'),
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
        None,
    )
    .await
    .unwrap();
    assert_eq!(results.items.len(), 1, "expected exactly one matched block");
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced");
    let opens = snippet.matches('\u{E000}').count();
    let closes = snippet.matches('\u{E001}').count();
    assert!(
        opens >= 1,
        "multi-match block must include at least one U+E000 pair, got: {snippet:?}"
    );
    assert_eq!(
        opens, closes,
        "every U+E000 opener must have a matching U+E001 closer in a multi-match snippet"
    );
}

#[tokio::test]
async fn snippet_window_constant_produces_readable_output_on_representative_sample() {
    // "Snippet length tuning" anchor — pins the perceived
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
        None,
    )
    .await
    .unwrap();
    let snippet = results.items[0]
        .snippet
        .as_deref()
        .expect("snippet must be produced for a content match");
    let mark_start = snippet
        .find('\u{E000}')
        .expect("snippet must contain a match span");
    let mark_end = snippet
        .find('\u{E001}')
        .expect("snippet must close the match span");
    // Some surrounding context before/after the highlighted span —
    // at least one non-marker character on each side (allowing the
    // FTS5 truncation ellipsis to count as context).
    let before = &snippet[..mark_start];
    let after = &snippet[mark_end + '\u{E001}'.len_utf8()..];
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
// Phase 1 — `search_blocks_partitioned` fixture helpers
// ======================================================================
//
// The command-coupled partitioned / cursor tests that drove
// `search_blocks_partitioned_inner` end-to-end relocated to the app crate
// (`src/fts_app_tests.rs`, #2621 wave S4d) because that inner function lives
// above the store layer. The `pt_block_id` id generator below is retained
// here for the pure FTS tests that still seed `01HQPART…` rows.

/// Generate a unique 26-character ULID-shaped id under the
/// `01HQPART…` namespace for tests that need more rows than a fixed
/// fixture array carries. The shape is not a valid Crockford ULID but
/// `insert_block` only requires uniqueness.
fn pt_block_id(index: u32) -> String {
    format!("01HQPARTGEN{index:015}")
}

// ── #2200 (Tier-2): DB-side content-prefix cap on the palette scan ────

/// The preview-length cap the display-only palette path applies to
/// `content` at the DB. Bound to the real constant so the two never drift.
const EXPECTED_PALETTE_CONTENT_CAP: usize = crate::fts::search::PALETTE_CONTENT_PREVIEW_CAP;

#[tokio::test]
async fn partitioned_content_is_capped_to_preview_prefix_snippet_and_order_unchanged() {
    let (pool, _dir) = test_pool().await;

    // A body far longer than the cap, with the keyword up front so the
    // `snippet()` highlight window still lands inside the shipped prefix.
    let long_body = format!("palettecap needle {}", "x".repeat(2000));
    let full_len = long_body.chars().count();
    assert!(
        full_len > EXPECTED_PALETTE_CONTENT_CAP,
        "fixture must exceed the cap to prove truncation"
    );

    // Two content blocks matching the keyword, plus a matching page, so we
    // can also assert row count + rank order are untouched by the cap.
    insert_block(&pool, BLOCK_A, "content", &long_body, None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", &long_body, None, Some(1)).await;
    insert_block(&pool, PAGE_ULID, "page", "palettecap page", None, Some(2)).await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let scan = crate::fts::search::search_fts_partitioned(
        &pool,
        "palettecap",
        10,
        10,
        None,
        None,
        None,
        &[],
        &[],
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        true, // with_snippet — highlight must survive the content cap
        Some(EXPECTED_PALETTE_CONTENT_CAP), // display-only path opts into the cap
        None,
    )
    .await
    .unwrap();

    // Row count unchanged: both content blocks + the page appear in `blocks`;
    // the page also appears in `pages`.
    assert_eq!(
        scan.blocks.len(),
        3,
        "blocks partition row count must be unchanged by the content cap"
    );
    assert_eq!(scan.pages.len(), 1, "pages partition unchanged");

    // Every capped content string is exactly the 512-codepoint PREFIX of the
    // original body (never longer, never a different substring).
    let expected_prefix: String = long_body
        .chars()
        .take(EXPECTED_PALETTE_CONTENT_CAP)
        .collect();
    let mut saw_capped_content = false;
    for row in scan.blocks.iter().chain(scan.pages.iter()) {
        if let Some(content) = row.content.as_deref() {
            assert!(
                content.chars().count() <= EXPECTED_PALETTE_CONTENT_CAP,
                "content must be capped to <= {EXPECTED_PALETTE_CONTENT_CAP} codepoints, got {}",
                content.chars().count()
            );
            if row.id.as_str() == BLOCK_A || row.id.as_str() == BLOCK_B {
                assert_eq!(
                    content, expected_prefix,
                    "capped content must equal the {EXPECTED_PALETTE_CONTENT_CAP}-codepoint prefix"
                );
                saw_capped_content = true;
            }
        }
    }
    assert!(
        saw_capped_content,
        "the long-body blocks must have surfaced with capped content"
    );

    // The snippet() highlight is UNCHANGED — paired PUA sentinels wrapping
    // the match still ship even though the full body does not.
    let content_hit = scan
        .blocks
        .iter()
        .find(|r| r.id.as_str() == BLOCK_A)
        .expect("BLOCK_A must be in the blocks partition");
    let snippet = content_hit
        .snippet
        .as_deref()
        .expect("snippet() highlight must be present for a content match");
    let opens = snippet.matches(crate::fts::SNIPPET_HL_OPEN).count();
    let closes = snippet.matches(crate::fts::SNIPPET_HL_CLOSE).count();
    assert!(opens >= 1, "snippet must still carry a highlight opener");
    assert_eq!(opens, closes, "highlight sentinels must stay paired");

    // Order unchanged: `position 0` (BLOCK_A) then `position 1` (BLOCK_B)
    // among the two equally-ranked content rows (rank tiebreak is by id, and
    // BLOCK_A < BLOCK_B). The cap does not touch ORDER BY.
    let content_ids: Vec<&str> = scan
        .blocks
        .iter()
        .filter(|r| r.block_type == "content")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        content_ids,
        vec![BLOCK_A, BLOCK_B],
        "content-row order must be unchanged by the DB-side content cap"
    );
}

/// #2200 (Tier-2) regression — the display-only content cap MUST NOT leak
/// onto the case-sensitive / whole-word toggle path, whose post-filter runs
/// a literal regex against `content` and drops non-matching rows.
///
/// A block whose match term first appears AFTER the 512-codepoint preview
/// cap is FTS-matched (the trigram index is position-independent) but would
/// be silently DROPPED if the post-filter saw only a `substr(content,1,512)`
/// prefix (the term isn't in the prefix → regex no-match → row dropped).
/// The toggle path therefore scans with `snippet_len: None` (full content);
/// this test fails (row missing) if that regresses back to the capped call.
#[tokio::test]
async fn toggle_on_post_filter_keeps_match_beyond_preview_cap() {
    let (pool, _dir) = test_pool().await;

    // The exact-case term sits at codepoint 600 — well past the 512 cap — so
    // a truncated prefix would not contain it. `a`-filler carries no
    // uppercase `NeedleCase`, so the case-sensitive regex can only match the
    // trailing term.
    let padding = EXPECTED_PALETTE_CONTENT_CAP + 88; // 600
    let body = format!("{}NeedleCase", "a".repeat(padding));
    assert!(
        body.chars().count() > EXPECTED_PALETTE_CONTENT_CAP,
        "fixture must exceed the cap"
    );
    insert_block(&pool, BLOCK_A, "content", &body, None, Some(0)).await;
    crate::fts::rebuild_fts_index(&pool).await.unwrap();

    let scan = search_with_toggles_partitioned(
        &pool,
        "NeedleCase",
        10,
        10,
        None,
        None,
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        },
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let hit = scan
        .blocks
        .iter()
        .find(|r| r.id.as_str() == BLOCK_A)
        .expect("case-sensitive match beyond the preview cap must NOT be dropped");
    // Full content is shipped on the post-filter path (no display cap), so the
    // matched term survives on the wire and the emitted UTF-16 offsets stay
    // valid against `content`.
    let content = hit.content.as_deref().expect("row must carry content");
    assert!(
        content.contains("NeedleCase"),
        "shipped content must still contain the matched term (full body, not the 512 prefix)"
    );
    assert!(
        !hit.match_offsets.is_empty(),
        "post-filter must attach the match offsets for the beyond-cap hit"
    );
}
/// Verify the SQL builder omits the `snippet(fts_blocks,
/// …)` call when the toggle bundle will trigger a post-filter that
/// clears `row.snippet` anyway. Asserts on the emitted SQL string via
/// the test-only `fts_select_prefix_for_test` accessor — cheaper and
/// more direct than a runtime SQL trace.
#[test]
fn partitioned_snippet_skipped_when_post_filter_clears_it() {
    use super::search::fts_select_prefix_for_test;

    // Snippet-on branch: the SQL must include the `snippet(` function
    // call so the FTS path can carry the #828 PUA sentinel boundaries
    // (U+E000 / U+E001) to the frontend (the no-toggle case).
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

/// #1598: the FTS cursor keyset must scale the rank epsilon by the cursor
/// magnitude (a RELATIVE band `1e-9 * MAX(1.0, ABS(?3))`), not a fixed
/// `1e-9`, so pagination stays correct independent of bm25's numeric scale.
/// Pins the production-mirror SQL (byte-identical to the live query) so a
/// revert to the scale-coupled fixed epsilon fails CI — the inline-SQL
/// predicate tests don't guard the `fetch.rs` production path.
#[test]
fn fts_cursor_predicate_uses_relative_rank_epsilon_1598() {
    use super::search::fts_select_prefix_for_test;

    for with_snippet in [true, false] {
        let sql = fts_select_prefix_for_test(with_snippet);
        assert!(
            sql.contains("1e-9 * MAX(1.0, ABS(?3))"),
            "cursor keyset must use the relative rank epsilon `1e-9 * MAX(1.0, ABS(?3))` \
             (not a fixed 1e-9) — see #1598 (with_snippet={with_snippet}): {sql}"
        );
    }
}
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
    // Phase 5.T1d — confirm the helper itself catches drift.
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
// SQL/BE hardening regression tests
// ======================================================================

/// Duplicate tag IDs in the "ALL tags" filter must
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
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&blk),
        "duplicate tag ids must still match the tagged block (got {ids:?})"
    );
}

/// Same dedup guarantee on the regex-mode path.
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
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&blk),
        "regex-mode duplicate tag ids must still match the tagged block (got {ids:?})"
    );
}

/// SQL-A6 — a MIXED-CASE duplicate tag id must dedup so the
/// "ALL tags" predicate still matches. `block_tags.tag_id` stores the
/// canonical UPPERCASE ULID; before normalising the dedup set, the same
/// id arriving once lower-case and once upper-case survived byte-exact
/// dedup, inflated the bound list length to 2 against an achievable
/// `COUNT(DISTINCT) = 1`, and silently zeroed out the regex scan.
#[tokio::test]
async fn regex_mixed_case_duplicate_tag_ids_dedup_so_all_tags_predicate_matches() {
    let (pool, _dir) = test_pool().await;

    // Canonical (uppercase) stored tag id + tagged block.
    let tag_id = "01HQMIXTAG0000000000000T01";
    let blk = "01HQMIXTAG000000000000BLK1";
    insert_block(&pool, tag_id, "tag", "mixtag", None, Some(0)).await;
    insert_block(
        &pool,
        blk,
        "content",
        "mixed-case dup candidate alpha",
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
    // Same logical id, supplied once upper-case and once lower-case —
    // a byte-exact dedup would keep both and break the predicate.
    let mixed = vec![tag_id.to_string(), tag_id.to_ascii_lowercase()];
    let resp = search_with_toggles(
        &pool,
        "candidate",
        &page,
        None,
        Some(&mixed),
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
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![blk],
        "mixed-case duplicate tag ids must dedup to one and still match the tagged block (got {ids:?})"
    );
}

/// SQL-A6 — same mixed-case dedup guarantee on the FTS path.
#[tokio::test]
async fn fts_mixed_case_duplicate_tag_ids_dedup_so_all_tags_predicate_matches() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQMIXFTS0000000000000T01";
    let blk = "01HQMIXFTS000000000000BLK1";
    insert_block(&pool, tag_id, "tag", "mixfts", None, Some(0)).await;
    insert_block(
        &pool,
        blk,
        "content",
        &format!("mixed-case fts candidate referencing #[{tag_id}]"),
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
    let mixed = vec![tag_id.to_string(), tag_id.to_ascii_lowercase()];
    let resp = search_fts(
        &pool,
        "candidate",
        &page,
        None,
        Some(&mixed),
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![blk],
        "FTS mixed-case duplicate tag ids must dedup and still match (got {ids:?})"
    );
}

/// SQL-A4 — an over-long RAW regex pattern is rejected up
/// front (before NFC-normalise / compile) with a validation error,
/// mirroring the FTS path's `MAX_QUERY_LEN` guard. The raw guard fires
/// at `MAX_QUERY_LEN` bytes, well below the `MAX_PATTERN_LEN` (1 KiB)
/// composed-pattern cap, so it is the first guard a giant raw input hits.
#[tokio::test]
async fn regex_over_long_raw_pattern_is_rejected() {
    let (pool, _dir) = test_pool().await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    // One byte past the FTS query cap — the up-front raw guard must
    // reject this before any normalise/compile work.
    let huge = "a".repeat(super::search::MAX_QUERY_LEN + 1);
    let err = search_with_toggles(
        &pool,
        &huge,
        &page,
        None,
        None,
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
        None,
    )
    .await
    .expect_err("over-long raw regex pattern must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-long raw regex pattern must surface AppError::Validation, got {err:?}"
    );
}
/// Cluster-1 — REGRESSION CONTRACT: the regex path APPLIES
/// structural filters. A concurrent frontend change relies on regex
/// mode respecting a `tag_ids` filter, so this locks the contract:
/// seed two blocks whose content both match the regex but only one
/// carries the tag, search with `is_regex = true` + that tag filter,
/// and assert only the tagged block is returned.
#[tokio::test]
async fn regex_path_applies_tag_filter() {
    let (pool, _dir) = test_pool().await;

    let tag_id = "01HQRGXFLT0000000000000T01";
    let tagged = "01HQRGXFLT00000000000TAGD1";
    let untagged = "01HQRGXFLT0000000000UNTAG1";
    insert_block(&pool, tag_id, "tag", "rgxfilter", None, Some(0)).await;
    // Both blocks contain "filterme" so the regex /filter.*/ matches both.
    insert_block(
        &pool,
        tagged,
        "content",
        "filterme tagged variant",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        untagged,
        "content",
        "filterme untagged variant",
        None,
        Some(2),
    )
    .await;
    // Only the `tagged` block carries the tag.
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(tagged)
        .bind(tag_id)
        .execute(&pool)
        .await
        .unwrap();
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![tag_id.to_string()];
    let resp = search_with_toggles(
        &pool,
        "filter.*", // regex matches both blocks' content
        &page,
        None,
        Some(&tags),
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
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![tagged],
        "regex mode must apply the tag_ids filter — only the tag-carrying \
         match may survive, despite both blocks matching the pattern (got {ids:?})"
    );
}

/// Cluster-1 sanity sibling: WITHOUT the tag filter the same regex
/// matches BOTH blocks — proves the filter (not the pattern) is what
/// narrowed the result above.
#[tokio::test]
async fn regex_path_without_tag_filter_matches_all() {
    let (pool, _dir) = test_pool().await;

    let tagged = "01HQRGXALL00000000000TAGD1";
    let untagged = "01HQRGXALL0000000000UNTAG1";
    insert_block(
        &pool,
        tagged,
        "content",
        "filterme tagged variant",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        untagged,
        "content",
        "filterme untagged variant",
        None,
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(50)).unwrap();
    let resp = search_with_toggles(
        &pool,
        "filter.*",
        &page,
        None,
        None, // no tag filter
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
        None,
    )
    .await
    .unwrap();

    let mut ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    ids.sort_unstable();
    let mut expected = vec![tagged, untagged];
    expected.sort_unstable();
    assert_eq!(
        ids, expected,
        "without a tag filter the regex must match BOTH blocks (got {ids:?})"
    );
}

/// An over-long FTS query is rejected up front with a
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
        None,
    )
    .await
    .expect_err("over-long query must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-long query must surface AppError::Validation, got {err:?}"
    );
}

/// A query at exactly the cap is accepted (boundary).
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
        None,
    )
    .await;
    assert!(
        resp.is_ok(),
        "query at exactly MAX_QUERY_LEN must not be rejected: {resp:?}"
    );
}
async fn seed_case_toggle_corpus(pool: &SqlitePool, count: u32) -> Vec<String> {
    let mut survivors: Vec<String> = Vec::new();
    for index in 0..count {
        let id = pt_block_id(index);
        // Identical token shape + length across survivor/drop so bm25
        // ranks tie and the keyset reduces to pure `id` order.
        let prefix = if index % 2 == 0 { "Cat" } else { "cat" };
        let content = format!("{prefix} row alpha bravo");
        insert_block(pool, &id, "content", &content, None, Some(i64::from(index))).await;
        if index % 2 == 0 {
            survivors.push(id);
        }
    }
    rebuild_fts_index(pool).await.unwrap();
    survivors
}

/// BE-A10 (1) — SQL-A3 cursor pagination: full pages, no under-fill, no
/// dropped rows, no duplicates across pages.
///
/// Seed 20 blocks; 10 survive the case-sensitive post-filter, 10 drop.
/// Page through with `limit = 3`. While more survivors remain each page
/// must be FULL (== limit) and `has_more = true`; the union across all
/// pages must equal the 10 survivors EXACTLY ONCE.
#[tokio::test]
async fn be_a10_sqla3_cursor_pagination_full_pages_no_drops_no_dupes() {
    let (pool, _dir) = test_pool().await;
    let expected_survivors = seed_case_toggle_corpus(&pool, 20).await;
    assert_eq!(
        expected_survivors.len(),
        10,
        "fixture invariant: 10 survivors"
    );

    let limit = 3;
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let page = PageRequest::new(cursor.clone(), Some(limit)).unwrap();
        let result = search_with_toggles(
            &pool,
            "Cat",
            &page,
            None,
            None,
            None,
            &[],
            &[],
            SearchToggles {
                case_sensitive: true,
                whole_word: false,
                is_regex: false,
            },
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
            None,
        )
        .await
        .unwrap();

        let remaining = expected_survivors.len() - collected.len();
        if result.has_more {
            // While more survivors remain the page MUST be full to limit —
            // this is the under-fill regression guard.
            assert_eq!(
                result.items.len(),
                usize::try_from(limit).unwrap(),
                "page {pages} must be FULL to limit while more survivors remain"
            );
            assert!(
                result.next_cursor.is_some(),
                "has_more=true page must carry a next_cursor"
            );
        } else {
            // Final page: at most `limit`, and exactly the leftover count.
            assert_eq!(
                result.items.len(),
                remaining,
                "final page must return exactly the remaining survivors"
            );
            assert!(
                result.next_cursor.is_none(),
                "final page must NOT carry a next_cursor"
            );
        }

        // Every returned row must be a real survivor (post-filter kept the
        // right rows) and must carry match offsets / no snippet.
        for item in &result.items {
            assert!(
                item.match_offsets.iter().any(|o| o.end > o.start),
                "survivor must carry a non-empty match offset"
            );
            assert!(
                item.snippet.is_none(),
                "post-filter survivor must have its FTS snippet cleared"
            );
            collected.push(item.id.clone().into());
        }

        pages += 1;
        if !result.has_more {
            break;
        }
        cursor = result.next_cursor;
        assert!(pages <= 10, "too many pages — possible infinite loop");
    }

    // Union across pages == every survivor exactly once: none dropped,
    // none duplicated.
    let unique: std::collections::HashSet<&str> = collected.iter().map(String::as_str).collect();
    assert_eq!(
        collected.len(),
        expected_survivors.len(),
        "no survivor dropped and none duplicated across pages"
    );
    assert_eq!(
        unique.len(),
        expected_survivors.len(),
        "no duplicate survivor across pages"
    );
    let mut sorted = collected.clone();
    sorted.sort();
    assert_eq!(
        sorted, expected_survivors,
        "page union must equal the exact survivor set"
    );
}

/// BE-A10 (2) — SQL-A3 boundary: survivors exactly == `limit` →
/// `has_more == false` and `next_cursor == None`.
///
/// Seed 6 blocks (3 survivors, 3 drops) and request `limit = 3`. The
/// single page must hold all 3 survivors, report `has_more = false`, and
/// emit no cursor (the `limit + 1`-th survivor probe finds nothing past
/// the candidate window).
#[tokio::test]
async fn be_a10_sqla3_boundary_survivors_equal_limit_no_more() {
    let (pool, _dir) = test_pool().await;
    let expected_survivors = seed_case_toggle_corpus(&pool, 6).await;
    assert_eq!(
        expected_survivors.len(),
        3,
        "fixture invariant: 3 survivors"
    );

    let page = PageRequest::new(None, Some(3)).unwrap();
    let result = search_with_toggles(
        &pool,
        "Cat",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        },
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        3,
        "boundary page returns all 3 survivors"
    );
    assert!(
        !result.has_more,
        "survivors == limit must report has_more = false"
    );
    assert!(
        result.next_cursor.is_none(),
        "survivors == limit must emit no next_cursor"
    );
    let mut ids: Vec<String> = result.items.iter().map(|r| r.id.clone().into()).collect();
    ids.sort();
    assert_eq!(
        ids, expected_survivors,
        "exact survivor set on the boundary page"
    );
}

/// BE-A10 (2b) — SQL-A3 multi-window fill: when survivors are SPARSER than
/// the candidate window, a single page must scan SUCCESSIVE windows to
/// fill (or exhaust). Seeds 250 candidates (all FTS-match `cat`) but only
/// two case-sensitive survivors at indices 120 and 245 — past the first
/// `POST_FILTER_WINDOW` (100) candidates, so window 1 yields zero
/// survivors and the loop MUST advance to windows 2 and 3 to find them.
/// Without the windowed over-fetch this page would render empty.
#[tokio::test]
async fn be_a10_sqla3_multi_window_fill_finds_sparse_survivors() {
    let (pool, _dir) = test_pool().await;
    let survivor_indices = [120u32, 245u32];
    let count: u32 = 250;
    for index in 0..count {
        let id = pt_block_id(index);
        // Only the two designated indices are capitalised survivors; the
        // rest are lowercase drops. All match the FTS `cat` trigram.
        let prefix = if survivor_indices.contains(&index) {
            "Cat"
        } else {
            "cat"
        };
        insert_block(
            &pool,
            &id,
            "content",
            &format!("{prefix} row alpha bravo"),
            None,
            Some(i64::from(index)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let expected: Vec<String> = survivor_indices.iter().map(|i| pt_block_id(*i)).collect();

    // limit = 2 (== survivor count): the loop must walk window 1 (empty),
    // window 2 (survivor #1), window 3 (survivor #2 + FTS exhaustion).
    let page = PageRequest::new(None, Some(2)).unwrap();
    let result = search_with_toggles(
        &pool,
        "Cat",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        },
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let mut ids: Vec<String> = result.items.iter().map(|r| r.id.clone().into()).collect();
    ids.sort();
    assert_eq!(
        ids, expected,
        "multi-window scan must surface both sparse survivors (not under-fill)"
    );
    assert!(
        !result.has_more,
        "exactly the two survivors exist → has_more = false"
    );
    assert!(
        result.next_cursor.is_none(),
        "no more survivors → no cursor"
    );
}

/// BE-A10 (3) — FTS plain `has_more` correct at exactly
/// `limit == MAX_SEARCH_RESULTS`.
///
/// Seed `MAX_SEARCH_RESULTS + 1` matching blocks and request a page of
/// `MAX_SEARCH_RESULTS` (all toggles off → straight FTS path). The page
/// must fill to the cap and report `has_more = true` (the `limit + 1`
/// candidate probe sees the extra row).
#[tokio::test]
async fn be_a10_fts_plain_has_more_at_exactly_max_search_results() {
    let (pool, _dir) = test_pool().await;
    let n = u32::try_from(MAX_SEARCH_RESULTS + 1).unwrap();
    for index in 0..n {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "ceiling probe keyword",
            None,
            Some(i64::from(index)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let limit = MAX_SEARCH_RESULTS;
    let page = PageRequest::new(None, Some(limit)).unwrap();
    let result = search_fts(
        &pool,
        "keyword",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        i64::try_from(result.items.len()).unwrap(),
        MAX_SEARCH_RESULTS,
        "page fills exactly to MAX_SEARCH_RESULTS"
    );
    assert!(
        result.has_more,
        "has_more must be true at exactly limit == MAX_SEARCH_RESULTS when one more row exists"
    );
    assert!(
        result.next_cursor.is_some(),
        "has_more=true must carry a next_cursor"
    );
}
#[tokio::test]
async fn be_a10_post_filter_max_windows_bound_stops_without_hanging() {
    let (pool, _dir) = test_pool().await;
    // 1050 > POST_FILTER_WINDOW (100) * POST_FILTER_MAX_WINDOWS (10) = 1000.
    // The lone survivor at index 1040 sits past the 1000-candidate ceiling.
    let n: u32 = 1050;
    let survivor_index: u32 = 1040;
    for index in 0..n {
        let id = pt_block_id(index);
        // All lowercase (drop vs "Cat") except the out-of-reach survivor.
        let prefix = if index == survivor_index {
            "Cat"
        } else {
            "cat"
        };
        insert_block(
            &pool,
            &id,
            "content",
            &format!("{prefix} lowercase only row"),
            None,
            Some(i64::from(index)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let page = PageRequest::new(None, Some(5)).unwrap();
    let result = search_with_toggles(
        &pool,
        "Cat",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        },
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        0,
        "survivor at index 1040 is past the 1000-candidate bound → empty page"
    );
    // #1556 — the window-count ceiling stopped the scan at 1000 candidates
    // while the FTS source still had ~50 rows (1050 total > 1000 ceiling).
    // That is NOT exhaustion, so `has_more` must be `true` (matching rows —
    // including the survivor at index 1040 — exist past the scan ceiling) and
    // a resuming cursor must be handed back so the caller can page further.
    assert!(
        result.has_more,
        "window-cap truncation with the FTS scan still live must report has_more = true (#1556)"
    );
    assert!(
        result.next_cursor.is_some(),
        "window-cap truncation must hand back a resuming next_cursor (#1556)"
    );
}

// ======================================================================
// NEW-3 — filter-only search (blank free-text + structural
// filters). A blank query bypasses FTS/regex entirely and runs a
// recency-ordered (`id DESC`) structural scan; with NO filter it stays
// empty (never the whole DB). Mode-independent.
// ======================================================================

/// Default (all-off) toggles — the common case for these tests.
fn new3_toggles_off() -> SearchToggles {
    SearchToggles {
        case_sensitive: false,
        whole_word: false,
        is_regex: false,
    }
}

/// Seed the `TAG_ULID` tag as a `tag`-typed block so `block_tags.tag_id`'s
/// FK to `blocks(id)` is satisfied. Call once per test before tagging.
async fn new3_seed_tag(pool: &SqlitePool) {
    insert_block(pool, TAG_ULID, "tag", "urgent", None, None).await;
}

/// Tag a block via a direct `block_tags` row (canonical UPPERCASE id).
/// Requires the tag block to already exist (see [`new3_seed_tag`]).
async fn new3_tag_block(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

/// NEW-3 (1) — filter-only by tag: a blank query plus one tag filter
/// returns ONLY blocks carrying that tag; an untagged block is excluded.
#[tokio::test]
async fn new3_filter_only_by_tag_returns_tagged_excludes_untagged() {
    let (pool, _dir) = test_pool().await;

    new3_seed_tag(&pool).await;
    let tagged_a = pt_block_id(0);
    let tagged_b = pt_block_id(1);
    let untagged = pt_block_id(2);
    insert_block(&pool, &tagged_a, "content", "tagged alpha", None, Some(0)).await;
    insert_block(&pool, &tagged_b, "content", "tagged bravo", None, Some(1)).await;
    insert_block(
        &pool,
        &untagged,
        "content",
        "untagged charlie",
        None,
        Some(2),
    )
    .await;
    new3_tag_block(&pool, &tagged_a, TAG_ULID).await;
    new3_tag_block(&pool, &tagged_b, TAG_ULID).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![TAG_ULID.to_string()];
    let result = search_with_toggles(
        &pool,
        "   ", // blank free-text (whitespace only)
        &page,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids.len(),
        2,
        "exactly the two tagged blocks return (got {ids:?})"
    );
    assert!(ids.contains(tagged_a.as_str()), "tagged_a must be present");
    assert!(ids.contains(tagged_b.as_str()), "tagged_b must be present");
    assert!(
        !ids.contains(untagged.as_str()),
        "untagged block must be excluded"
    );
    // No pattern → no highlight offsets, no snippet.
    for item in &result.items {
        assert!(
            item.match_offsets.is_empty(),
            "filter-only row carries no match offsets"
        );
        assert!(item.snippet.is_none(), "filter-only row carries no snippet");
    }
}

/// #674 — the filter-only scan must NOT inherit `content IS NOT NULL` from
/// the regex path: a NULL-content block carrying the filter's tag is a valid
/// structural match and was silently invisible. This is the reproduction
/// (pre-fix the block is dropped) AND the fix proof (post-fix it is returned).
#[tokio::test]
async fn new3_filter_only_includes_null_content_block_674() {
    let (pool, _dir) = test_pool().await;

    new3_seed_tag(&pool).await;
    let tagged_text = pt_block_id(0);
    let tagged_null = pt_block_id(1);
    insert_block(&pool, &tagged_text, "content", "has text", None, Some(0)).await;
    // A tagged block whose `content` is NULL (e.g. an empty/structural block
    // that nonetheless carries a tag). It satisfies the tag filter but the
    // inherited `content IS NOT NULL` clause used to hide it.
    insert_block_with_null_content(&pool, &tagged_null, "content").await;
    new3_tag_block(&pool, &tagged_text, TAG_ULID).await;
    new3_tag_block(&pool, &tagged_null, TAG_ULID).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![TAG_ULID.to_string()];
    let result = search_with_toggles(
        &pool,
        "", // blank free-text → filter-only scan
        &page,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(tagged_null.as_str()),
        "#674: NULL-content block matching the tag filter must be returned, not hidden"
    );
    assert!(
        ids.contains(tagged_text.as_str()),
        "the text-bearing tagged block is returned too"
    );
    assert_eq!(ids.len(), 2, "exactly the two tagged blocks (got {ids:?})");
}

/// NEW-3 (2) — blank query + NO filter → empty (preserved), cursor path.
#[tokio::test]
async fn new3_empty_query_no_filter_returns_empty_cursor() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "anything at all", None, Some(0)).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        None,
        Some("01HQSPACE0000000000000SP01"), // space_id is NOT a user filter
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert!(
        result.items.is_empty(),
        "blank query + no filter must return empty (never the whole DB)"
    );
    assert!(!result.has_more, "empty result has no more");
    assert!(result.next_cursor.is_none(), "empty result emits no cursor");
}

/// NEW-3 (2b) — blank query + NO filter → two empty partitions
/// (preserved), partitioned path. `space_id` supplied is not a filter.
#[tokio::test]
async fn new3_empty_query_no_filter_returns_empty_partitioned() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "page", "some page", None, Some(0)).await;
    insert_block(&pool, BLOCK_B, "content", "some block", None, Some(1)).await;

    let scan = search_with_toggles_partitioned(
        &pool,
        "  ",
        50,
        50,
        None,
        None,
        Some("01HQSPACE0000000000000SP01"),
        &[],
        &[],
        new3_toggles_off(),
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert!(scan.pages.is_empty(), "no-filter pages partition is empty");
    assert!(
        scan.blocks.is_empty(),
        "no-filter blocks partition is empty"
    );
    assert!(!scan.pages_has_more);
    assert!(!scan.blocks_has_more);
}

/// NEW-3 (3) — cursor pagination across multiple pages: no dropped rows,
/// no duplicates; the union of pages equals the full filtered set;
/// `has_more` is true until the last page then false; `next_cursor` is
/// present iff `has_more`.
#[tokio::test]
async fn new3_cursor_pagination_no_drops_no_dupes() {
    let (pool, _dir) = test_pool().await;

    new3_seed_tag(&pool).await;
    // 10 tagged blocks (the full filtered set) + 1 untagged decoy.
    let total = 10u32;
    let mut expected: Vec<String> = Vec::new();
    for index in 0..total {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "row alpha",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
        expected.push(id);
    }
    insert_block(&pool, &pt_block_id(99), "content", "decoy", None, Some(99)).await;
    expected.sort();

    let limit = 3i64;
    let tags = vec![TAG_ULID.to_string()];
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let page = PageRequest::new(cursor.clone(), Some(limit)).unwrap();
        let result = search_with_toggles(
            &pool,
            "",
            &page,
            None,
            Some(&tags),
            None,
            &[],
            &[],
            new3_toggles_off(),
            None,
            &crate::fts::metadata_filter::MetadataPredicates::default(),
            None,
        )
        .await
        .unwrap();

        let remaining = expected.len() - collected.len();
        if result.has_more {
            assert_eq!(
                i64::try_from(result.items.len()).unwrap(),
                limit,
                "non-final page must be FULL to limit while more rows remain"
            );
            assert!(
                result.next_cursor.is_some(),
                "has_more=true page must carry a next_cursor"
            );
        } else {
            assert_eq!(
                result.items.len(),
                remaining,
                "final page returns exactly the remaining rows"
            );
            assert!(
                result.next_cursor.is_none(),
                "final page must NOT carry a next_cursor"
            );
        }

        for item in &result.items {
            collected.push(item.id.clone().into());
        }

        pages += 1;
        if !result.has_more {
            break;
        }
        cursor = result.next_cursor;
        assert!(pages <= 10, "too many pages — possible infinite loop");
    }

    let unique: std::collections::HashSet<&str> = collected.iter().map(String::as_str).collect();
    assert_eq!(
        collected.len(),
        expected.len(),
        "no row dropped and none duplicated across pages"
    );
    assert_eq!(
        unique.len(),
        expected.len(),
        "no duplicate row across pages"
    );
    let mut sorted = collected.clone();
    sorted.sort();
    assert_eq!(
        sorted, expected,
        "page union must equal the exact filtered set"
    );
}

/// NEW-3 (3b) — exact-multiple boundary: when the filtered set size is an
/// exact multiple of the page limit, the final FULL page must report
/// `has_more == false` and emit NO cursor. This is the case the
/// `new3_cursor_pagination_no_drops_no_dupes` fixture (10 rows / limit 3,
/// final page = 1 row) never exercises: there the DB only ever returns
/// the `limit + 1` probe (so `rows.len() > limit` cleanly separates more
/// vs. done) or a short final page. Here the final page's query returns
/// EXACTLY `limit` rows with nothing older, so `rows.len() == limit`. That
/// distinguishes the correct `has_more = rows.len() > limit` from the
/// off-by-one `>=` mutation: `>=` would spuriously flag `has_more` on the
/// last full page, emit a cursor, and yield a phantom empty page.
#[tokio::test]
async fn new3_cursor_exact_multiple_final_full_page_has_no_more() {
    let (pool, _dir) = test_pool().await;

    new3_seed_tag(&pool).await;
    // 6 tagged rows, page limit 3 → two FULL pages, exact multiple.
    let total = 6u32;
    let mut expected: Vec<String> = Vec::new();
    for index in 0..total {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "exact row",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
        expected.push(id);
    }
    expected.sort();

    let limit = 3i64;
    let tags = vec![TAG_ULID.to_string()];

    // Page 1 — full, more remains.
    let page1 = PageRequest::new(None, Some(limit)).unwrap();
    let r1 = search_with_toggles(
        &pool,
        "",
        &page1,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 3, "page 1 is full");
    assert!(r1.has_more, "page 1 has more (3 of 6 returned)");
    let cursor = r1.next_cursor.clone();
    assert!(cursor.is_some(), "page 1 emits a cursor");

    // Page 2 — the FINAL full page. Exactly `limit` rows, nothing older.
    let page2 = PageRequest::new(cursor, Some(limit)).unwrap();
    let r2 = search_with_toggles(
        &pool,
        "",
        &page2,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        r2.items.len(),
        3,
        "page 2 is full (the exact-multiple tail)"
    );
    assert!(
        !r2.has_more,
        "final FULL page must report has_more=false (kills the `>=` off-by-one)"
    );
    assert!(
        r2.next_cursor.is_none(),
        "final FULL page must NOT emit a cursor (no phantom empty page)"
    );

    // Union of both pages is the exact filtered set, no drops/dupes.
    let mut collected: Vec<String> = r1
        .items
        .iter()
        .chain(r2.items.iter())
        .map(|r| r.id.clone().into())
        .collect();
    collected.sort();
    assert_eq!(
        collected, expected,
        "two full pages cover the exact filtered set"
    );
}

/// NEW-3 (4) — ordering is `id DESC` (most-recent ULID first). `pt_block_id`
/// zero-pads, so higher index == lexicographically larger == more recent.
#[tokio::test]
async fn new3_ordering_is_id_desc() {
    let (pool, _dir) = test_pool().await;
    new3_seed_tag(&pool).await;
    let total = 5u32;
    for index in 0..total {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "ordered row",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
    }

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![TAG_ULID.to_string()];
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: Vec<String> = result.items.iter().map(|r| r.id.clone().into()).collect();
    let mut expected_desc: Vec<String> = (0..total).map(pt_block_id).collect();
    expected_desc.sort();
    expected_desc.reverse(); // id DESC
    assert_eq!(
        ids, expected_desc,
        "filter-only scan must return rows in id-DESC (recency) order"
    );
}

/// NEW-3 (5a) — respects `parent_id`: blank query + parent filter returns
/// only children of that parent.
#[tokio::test]
async fn new3_respects_parent_id() {
    let (pool, _dir) = test_pool().await;
    let parent = pt_block_id(0);
    let child_a = pt_block_id(1);
    let child_b = pt_block_id(2);
    let other = pt_block_id(3);
    insert_block(&pool, &parent, "content", "the parent", None, Some(0)).await;
    insert_block(
        &pool,
        &child_a,
        "content",
        "child alpha",
        Some(&parent),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        &child_b,
        "content",
        "child bravo",
        Some(&parent),
        Some(2),
    )
    .await;
    insert_block(&pool, &other, "content", "elsewhere", None, Some(3)).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        Some(&parent),
        None,
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: std::collections::HashSet<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids.len(), 2, "only the two children return (got {ids:?})");
    assert!(ids.contains(child_a.as_str()));
    assert!(ids.contains(child_b.as_str()));
    assert!(!ids.contains(other.as_str()), "non-child excluded");
    assert!(!ids.contains(parent.as_str()), "the parent itself excluded");
}

/// NEW-3 (5b) — respects `block_type_filter`: blank query + `block_type =
/// 'page'` returns only page-typed blocks.
#[tokio::test]
async fn new3_respects_block_type_filter() {
    let (pool, _dir) = test_pool().await;
    let pg = pt_block_id(0);
    let blk = pt_block_id(1);
    insert_block(&pool, &pg, "page", "a page title", None, Some(0)).await;
    insert_block(&pool, &blk, "content", "a content block", None, Some(1)).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        new3_toggles_off(),
        Some("page"),
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![pg.as_str()], "only the page-typed block returns");
}

/// NEW-3 (5c) — respects a metadata predicate (`state:` / `todo_state`):
/// blank query + a `state_values` filter returns only blocks in that
/// todo_state.
#[tokio::test]
async fn new3_respects_metadata_state_predicate() {
    let (pool, _dir) = test_pool().await;
    let todo = pt_block_id(0);
    let done = pt_block_id(1);
    let none_state = pt_block_id(2);
    insert_block(&pool, &todo, "content", "todo item", None, Some(0)).await;
    insert_block(&pool, &done, "content", "done item", None, Some(1)).await;
    insert_block(
        &pool,
        &none_state,
        "content",
        "stateless item",
        None,
        Some(2),
    )
    .await;
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind(&todo)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = ?")
        .bind(&done)
        .execute(&pool)
        .await
        .unwrap();

    let metadata = crate::fts::metadata_filter::MetadataPredicates {
        state_values: vec!["TODO".to_string()],
        ..Default::default()
    };
    let page = PageRequest::new(None, Some(50)).unwrap();
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        new3_toggles_off(),
        None,
        &metadata,
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![todo.as_str()],
        "only the TODO-state block returns (got {ids:?})"
    );
}

/// NEW-3 (6a) — mode-independence: blank query + tag filter with
/// `is_regex = true` returns the filtered set (NOT empty). With no
/// pattern there is nothing for the regex engine to match, so the
/// structural scan runs regardless of the toggle.
#[tokio::test]
async fn new3_mode_independent_regex_toggle() {
    let (pool, _dir) = test_pool().await;
    new3_seed_tag(&pool).await;
    let tagged = pt_block_id(0);
    let untagged = pt_block_id(1);
    insert_block(&pool, &tagged, "content", "tagged row", None, Some(0)).await;
    insert_block(&pool, &untagged, "content", "plain row", None, Some(1)).await;
    new3_tag_block(&pool, &tagged, TAG_ULID).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![TAG_ULID.to_string()];
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        Some(&tags),
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
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![tagged.as_str()],
        "regex toggle + blank query + tag filter must still return the filtered set"
    );
}

/// NEW-3 (6b) — mode-independence: same with `case_sensitive = true`.
#[tokio::test]
async fn new3_mode_independent_case_sensitive_toggle() {
    let (pool, _dir) = test_pool().await;
    new3_seed_tag(&pool).await;
    let tagged = pt_block_id(0);
    let untagged = pt_block_id(1);
    insert_block(&pool, &tagged, "content", "tagged row", None, Some(0)).await;
    insert_block(&pool, &untagged, "content", "plain row", None, Some(1)).await;
    new3_tag_block(&pool, &tagged, TAG_ULID).await;

    let page = PageRequest::new(None, Some(50)).unwrap();
    let tags = vec![TAG_ULID.to_string()];
    let result = search_with_toggles(
        &pool,
        "",
        &page,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        SearchToggles {
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        },
        None,
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = result.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![tagged.as_str()],
        "case-sensitive toggle + blank query + tag filter must still return the filtered set"
    );
}

/// NEW-3 (7) — partitioned filter-only: the pages partition contains ONLY
/// `block_type == "page"`; the blocks partition contains ALL matching;
/// each partition's `has_more` comes from the `limit + 1` probe.
#[tokio::test]
async fn new3_partitioned_filter_only_partitions_and_has_more() {
    let (pool, _dir) = test_pool().await;

    new3_seed_tag(&pool).await;
    // 3 tagged pages + 4 tagged content blocks + 1 untagged decoy block.
    let mut page_ids: Vec<String> = Vec::new();
    for index in 0..3u32 {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "page",
            "tagged page",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
        page_ids.push(id);
    }
    let mut content_ids: Vec<String> = Vec::new();
    for index in 10..14u32 {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "tagged block",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
        content_ids.push(id);
    }
    insert_block(&pool, &pt_block_id(99), "content", "decoy", None, Some(99)).await;

    let tags = vec![TAG_ULID.to_string()];
    // page_limit = 2 (< 3 pages → has_more), block_limit = 50 (>= 7 → not).
    let scan = search_with_toggles_partitioned(
        &pool,
        "",
        2,
        50,
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    // Pages partition: ONLY page-typed rows, capped to page_limit.
    assert_eq!(
        scan.pages.len(),
        2,
        "pages partition truncated to page_limit"
    );
    for r in &scan.pages {
        assert_eq!(r.block_type, "page", "pages partition holds only pages");
    }
    assert!(
        scan.pages_has_more,
        "3 matching pages > page_limit 2 → pages_has_more from the limit+1 probe"
    );

    // Blocks partition: ALL matching (3 pages + 4 content = 7), no decoy.
    let block_ids: std::collections::HashSet<&str> =
        scan.blocks.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        scan.blocks.len(),
        7,
        "blocks partition holds all 7 tagged rows (3 pages + 4 content)"
    );
    for id in page_ids.iter().chain(content_ids.iter()) {
        assert!(
            block_ids.contains(id.as_str()),
            "blocks partition must contain tagged row {id}"
        );
    }
    assert!(
        !block_ids.contains(pt_block_id(99).as_str()),
        "untagged decoy excluded from blocks partition"
    );
    assert!(
        !scan.blocks_has_more,
        "7 matching <= block_limit 50 → blocks_has_more false"
    );
}

/// NEW-3 (7b) — partitioned filter-only `has_more` probe on the BLOCKS
/// partition: with more matching blocks than `block_limit`, the limit+1
/// probe flips `blocks_has_more` true and truncates to the limit.
#[tokio::test]
async fn new3_partitioned_blocks_has_more_probe() {
    let (pool, _dir) = test_pool().await;
    new3_seed_tag(&pool).await;
    let total = 5u32;
    for index in 0..total {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "tagged block",
            None,
            Some(i64::from(index)),
        )
        .await;
        new3_tag_block(&pool, &id, TAG_ULID).await;
    }

    let tags = vec![TAG_ULID.to_string()];
    let scan = search_with_toggles_partitioned(
        &pool,
        "",
        50,
        3, // block_limit < 5 matching → has_more
        None,
        Some(&tags),
        None,
        &[],
        &[],
        new3_toggles_off(),
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        scan.blocks.len(),
        3,
        "blocks partition truncated to block_limit"
    );
    assert!(
        scan.blocks_has_more,
        "5 matching blocks > block_limit 3 → blocks_has_more from the limit+1 probe"
    );
    // The pages partition is empty (no page-typed rows) and not has_more.
    assert!(
        scan.pages.is_empty(),
        "no page-typed rows → empty pages partition"
    );
    assert!(!scan.pages_has_more);
}

// ── #1320 Tag projection ↔ legacy COUNT(DISTINCT) equivalence ──────
//
// `fts_fetch_rows` now routes the ALL-tags filter through `SearchProjection`
// (`add_tags_via_projection`, N AND-joined per-tag IN-subselects) instead of
// the legacy single `COUNT(DISTINCT bt.tag_id) = N` fragment
// (`add_tags_all`). The two emit DIFFERENT SQL shapes but MUST return the
// IDENTICAL row set. These DB-level tests prove that equivalence end-to-end:
// they seed real blocks/block_tags, build both WHERE clauses, execute the
// resulting `SELECT id FROM blocks b WHERE …`, and assert the row sets match.

/// Build + execute a `SELECT id FROM blocks b WHERE 1=1 <fragment>` for the
/// given builder-population closure, returning the matched ids as a sorted
/// set. The builder is seeded at `?1` (no fixed base params) and uses a plain
/// `" AND "` glue prefix, so `1=1` swallows the leading AND of the first
/// fragment.
async fn tag_filter_ids<F>(pool: &SqlitePool, populate: F) -> std::collections::BTreeSet<String>
where
    F: FnOnce(&mut crate::fts::filter_builder::StructuralFilterBuilder),
{
    let mut fb = crate::fts::filter_builder::StructuralFilterBuilder::new(1);
    populate(&mut fb);
    let sql = format!("SELECT b.id FROM blocks b WHERE 1=1{}", fb.sql());
    let query = sqlx::query_as::<_, (String,)>(sqlx::AssertSqlSafe(sql.as_str()));
    let query = fb.apply(query);
    let rows = query.fetch_all(pool).await.unwrap();
    rows.into_iter().map(|(id,)| id).collect()
}

/// Seed a fixed fixture exercising single / both / superset / absent tag
/// memberships, then return the pool for the equivalence assertions.
///
/// Memberships (blocks are `content`-typed; tags are arbitrary distinct ids):
/// - `BLK_AB` carries TAG_X + TAG_Y      (matches "all of X,Y")
/// - `BLK_A`  carries TAG_X only          (matches "X", not "X,Y")
/// - `BLK_B`  carries TAG_Y only          (matches "Y", not "X,Y")
/// - `BLK_ABZ` carries TAG_X + TAG_Y + TAG_Z (superset → matches "X,Y")
/// - `BLK_NONE` carries no tags           (matches nothing tag-filtered)
async fn seed_tag_equivalence_fixture(pool: &SqlitePool) {
    // Distinct 26-char uppercase ULID-style ids.
    const TAG_X: &str = "01HQTAGX0000000000000000X1";
    const TAG_Y: &str = "01HQTAGY0000000000000000Y1";
    const TAG_Z: &str = "01HQTAGZ0000000000000000Z1";
    const BLK_AB: &str = "01HQBLKAB0000000000000AB01";
    const BLK_A: &str = "01HQBLKA00000000000000A001";
    const BLK_B: &str = "01HQBLKB00000000000000B001";
    const BLK_ABZ: &str = "01HQBLKABZ00000000000ABZ01";
    const BLK_NONE: &str = "01HQBLKNONE0000000000NON01";

    // Tag ids FK to `blocks(id)` (migration 0061: block_tags.tag_id
    // REFERENCES blocks(id)), so the tags must exist as `tag`-typed blocks
    // before any block_tags row can reference them.
    for (i, tag) in [TAG_X, TAG_Y, TAG_Z].iter().enumerate() {
        insert_block(
            pool,
            tag,
            "tag",
            "tagname",
            None,
            Some(i64::try_from(i).unwrap()),
        )
        .await;
    }

    for (i, blk) in [BLK_AB, BLK_A, BLK_B, BLK_ABZ, BLK_NONE].iter().enumerate() {
        insert_block(
            pool,
            blk,
            "content",
            "body",
            None,
            Some(i64::try_from(i).unwrap() + 10),
        )
        .await;
    }

    let memberships: &[(&str, &[&str])] = &[
        (BLK_AB, &[TAG_X, TAG_Y]),
        (BLK_A, &[TAG_X]),
        (BLK_B, &[TAG_Y]),
        (BLK_ABZ, &[TAG_X, TAG_Y, TAG_Z]),
        (BLK_NONE, &[]),
    ];
    for (blk, tags) in memberships {
        for tag in *tags {
            sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(*blk)
                .bind(*tag)
                .execute(pool)
                .await
                .unwrap();
        }
    }
}

/// For each scenario, the projection-routed path and the legacy
/// `COUNT(DISTINCT)` path MUST return identical row sets, AND that row set
/// MUST equal the hand-computed expectation.
#[tokio::test]
async fn tags_via_projection_matches_legacy_count_distinct_equivalence() {
    let (pool, _dir) = test_pool().await;
    seed_tag_equivalence_fixture(&pool).await;

    const TAG_X: &str = "01HQTAGX0000000000000000X1";
    const TAG_Y: &str = "01HQTAGY0000000000000000Y1";
    const TAG_MISSING: &str = "01HQTAGM0000000000000MISS1";
    const BLK_AB: &str = "01HQBLKAB0000000000000AB01";
    const BLK_A: &str = "01HQBLKA00000000000000A001";
    const BLK_ABZ: &str = "01HQBLKABZ00000000000ABZ01";

    // (label, tag set, expected matching block ids)
    let cases: &[(&str, Vec<String>, std::collections::BTreeSet<String>)] = &[
        (
            "single tag X",
            vec![TAG_X.to_string()],
            // Every block carrying X: AB, A, ABZ.
            [BLK_AB, BLK_A, BLK_ABZ]
                .iter()
                .map(ToString::to_string)
                .collect(),
        ),
        (
            "two tags X+Y (ALL-semantics)",
            vec![TAG_X.to_string(), TAG_Y.to_string()],
            // Only blocks carrying BOTH X and Y: AB and the superset ABZ.
            [BLK_AB, BLK_ABZ].iter().map(ToString::to_string).collect(),
        ),
        (
            "tag no block has (empty result)",
            vec![TAG_MISSING.to_string()],
            std::collections::BTreeSet::new(),
        ),
        (
            "missing tag AND-joined with a present tag (empty)",
            vec![TAG_X.to_string(), TAG_MISSING.to_string()],
            std::collections::BTreeSet::new(),
        ),
    ];

    const PREFIX: &str = " AND ";
    for (label, tags, expected) in cases {
        // #1320 the legacy `add_tags_allCOUNT(DISTINCT)` path was
        // Retired, so there is no live legacy builder to diff against.
        // proved the row-set equivalence; this test now pins the routed path
        // against the hand-computed oracle (the durable correctness invariant).
        let projected = tag_filter_ids(&pool, |fb| {
            fb.add_tags_via_projection(PREFIX, tags);
        })
        .await;

        assert_eq!(
            &projected, expected,
            "[{label}] routed row set must equal the hand-computed expectation"
        );
    }
}

// ── #1320 page-glob projection ↔ legacy GLOB sub-select equivalence ──
//
// `fts_fetch_rows` now routes the page-name-glob filter through
// `SearchProjection` (`add_page_globs_via_projection`: per-pattern
// `LOWER(title) GLOB ?` IN-subselects, OR-joined for include / AND-joined for
// exclude) instead of the legacy single `append_page_glob_subselect` fragment
// (`add_page_globs`: one IN-subselect whose inner GLOB terms are OR-joined).
// The two emit DIFFERENT SQL shapes but, because the projection keeps the
// LEGACY `LOWER(title) GLOB ?` dialect (NOT the Pages `COLLATE NOCASE LIKE`
// form), they MUST return the IDENTICAL row set. This DB-level test proves
// that zero-behaviour-change equivalence end-to-end: it seeds blocks +
// pages_cache with varied titles, runs RAW glob inputs through the SAME
// `prepare_globs` preprocessing both paths consume, builds both WHERE clauses,
// executes `SELECT id FROM blocks b WHERE …`, and asserts the row sets match.

/// Build + execute a `SELECT id FROM blocks b WHERE 1=1 <fragment>` for the
/// given builder-population closure, returning the matched ids as a sorted
/// set (same shape as `tag_filter_ids`).
async fn page_glob_filter_ids<F>(
    pool: &SqlitePool,
    populate: F,
) -> std::collections::BTreeSet<String>
where
    F: FnOnce(&mut crate::fts::filter_builder::StructuralFilterBuilder),
{
    let mut fb = crate::fts::filter_builder::StructuralFilterBuilder::new(1);
    populate(&mut fb);
    let sql = format!("SELECT b.id FROM blocks b WHERE 1=1{}", fb.sql());
    let query = sqlx::query_as::<_, (String,)>(sqlx::AssertSqlSafe(sql.as_str()));
    let query = fb.apply(query);
    let rows = query.fetch_all(pool).await.unwrap();
    rows.into_iter().map(|(id,)| id).collect()
}

/// Seed pages with varied titles (one content block per page sharing the
/// page's `page_id`, so `b.page_id` joins to `pages_cache`), returning the
/// `(block_id, title)` fixture for hand-computed expectations.
async fn seed_page_glob_equivalence_fixture(
    pool: &SqlitePool,
) -> Vec<(&'static str, &'static str)> {
    // (page_id == content-block page_id, title) — titles chosen to exercise
    // substring, brace alternation, and `[class]` bracket matching.
    let pages: &[(&str, &str)] = &[
        ("01HQPGFOO00000000000000PG01", "Foo Notes"),
        ("01HQPGBAR00000000000000PG02", "Bar Tasks"),
        ("01HQPGBAZ00000000000000PG03", "Baz Ideas"),
        ("01HQPGQUX00000000000000PG04", "Qux Log"),
        ("01HQPGAFOO0000000000000PG05", "afoo bracket"),
        ("01HQPGBFOO0000000000000PG06", "bfoo bracket"),
        ("01HQPGCFOO0000000000000PG07", "cfoo bracket"),
    ];
    // Content blocks live UNDER each page (page_id = page id) so the
    // `b.page_id IN (SELECT page_id FROM pages_cache …)` predicate selects
    // them. We return the BLOCK ids (what the SELECT yields).
    let mut block_ids: Vec<(&'static str, &'static str)> = Vec::new();
    for (i, (page_id, title)) in pages.iter().enumerate() {
        // The page block itself (page_id == id per the §5.3 invariant).
        insert_block(
            pool,
            page_id,
            "page",
            title,
            None,
            Some(i64::try_from(i).unwrap()),
        )
        .await;
        sqlx::query("INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, ?)")
            .bind(page_id)
            .bind(title)
            .bind(0_i64)
            .execute(pool)
            .await
            .unwrap();
        block_ids.push((page_id, title));
    }
    block_ids
}

/// For each raw-glob scenario, the projection-routed path and the legacy
/// `append_page_glob_subselect` path MUST return identical row sets, AND that
/// row set MUST equal the hand-computed expectation. Cases cover: plain
/// substring, brace alternation, `[class]` bracket (which LIKE could NOT
/// express — proves the GLOB dialect is preserved), an exclude pattern, and a
/// multi-pattern include (OR-join / set-union semantics).
#[tokio::test]
async fn page_globs_via_projection_matches_legacy_glob_equivalence() {
    let (pool, _dir) = test_pool().await;
    let fixture = seed_page_glob_equivalence_fixture(&pool).await;
    let title_of =
        |id: &str| -> &'static str { fixture.iter().find(|(pid, _)| *pid == id).unwrap().1 };

    const FOO: &str = "01HQPGFOO00000000000000PG01"; // "Foo Notes"
    const BAR: &str = "01HQPGBAR00000000000000PG02"; // "Bar Tasks"
    const BAZ: &str = "01HQPGBAZ00000000000000PG03"; // "Baz Ideas"
    const QUX: &str = "01HQPGQUX00000000000000PG04"; // "Qux Log"
    const AFOO: &str = "01HQPGAFOO0000000000000PG05"; // "afoo bracket"
    const BFOO: &str = "01HQPGBFOO0000000000000PG06"; // "bfoo bracket"
    const CFOO: &str = "01HQPGCFOO0000000000000PG07"; // "cfoo bracket"

    let set = |ids: &[&str]| -> std::collections::BTreeSet<String> {
        ids.iter().map(ToString::to_string).collect()
    };

    // (label, raw glob inputs, negate, expected matching block ids)
    let cases: &[(&str, Vec<String>, bool, std::collections::BTreeSet<String>)] = &[
        (
            "plain substring foo (INCLUDE)",
            vec!["foo".to_string()],
            false,
            // bare word → substring `*foo*`; matches "Foo Notes" + the three
            // "?foo bracket" pages (case-insensitive ASCII fold).
            set(&[FOO, AFOO, BFOO, CFOO]),
        ),
        (
            "brace {bar,baz} (INCLUDE — either)",
            vec!["{bar,baz}".to_string()],
            false,
            // brace-expands to *bar* / *baz* → "Bar Tasks" + "Baz Ideas".
            set(&[BAR, BAZ]),
        ),
        (
            "bracket *[ab]foo* (INCLUDE — GLOB class)",
            // A `[class]` token is NOT bare, so `prepare_globs` does NOT
            // substring-wrap it — the user supplies the wildcards. `[ab]foo`
            // matches "afoo"/"bfoo" but NOT "cfoo": a `[class]` GLOB the
            // Pages `COLLATE NOCASE LIKE` form could never express, proving
            // the legacy GLOB dialect is preserved.
            vec!["*[ab]foo*".to_string()],
            false,
            set(&[AFOO, BFOO]),
        ),
        (
            "exclude foo (EXCLUDE — set difference)",
            vec!["foo".to_string()],
            true,
            // NOT-IN(*foo*): everything except the four *foo* titles.
            set(&[BAR, BAZ, QUX]),
        ),
        (
            "multi-pattern include foo + bar (OR / union)",
            vec!["foo".to_string(), "bar".to_string()],
            false,
            // OR-join: *foo* ∪ *bar* = the four foo pages + "Bar Tasks".
            set(&[FOO, AFOO, BFOO, CFOO, BAR]),
        ),
    ];

    const PREFIX: &str = " AND ";
    for (label, raw, negate, expected) in cases {
        // Both paths consume the SAME prepared patterns — the single
        // `prepare_globs` preprocessing the production pipeline runs upstream.
        let prepared = crate::fts::glob_filter::prepare_globs(raw).unwrap();

        // #1320 the legacy `add_page_globs` /
        // `append_page_glob_subselect` path was retired, so there is no live
        // Legacy builder to diff against. proved the row-set equivalence;
        // this test now pins the routed path against the hand-computed oracle
        // (the durable zero-behaviour-change correctness invariant — including
        // the `[class]` bracket case LIKE could never express, proving the
        // GLOB dialect is preserved).
        let projected = page_glob_filter_ids(&pool, |fb| {
            fb.add_page_globs_via_projection(PREFIX, *negate, &prepared);
        })
        .await;

        assert_eq!(
            &projected,
            expected,
            "[{label}] routed row set must equal the hand-computed expectation \
             (got titles {:?})",
            projected.iter().map(|id| title_of(id)).collect::<Vec<_>>(),
        );
    }
}

// ======================================================================
// #1280 B2 — search metadata (state / block-type / due / scheduled)
// routed through `SearchProjection`. The legacy `append_metadata_sql`
// fragments are the result oracle; these DB tests prove the SEARCH path is
// wired to the canonical A2 SQL and the row sets match the hand-computed
// legacy semantics — covering the NULL-state and exclude+none 3-valued
// traps specifically.
// ======================================================================

/// Run an arbitrary `populate` against a bare `SELECT b.id FROM blocks b
/// WHERE 1=1 <fragment>`, returning the matched ids. Same lightweight
/// harness as [`tag_filter_ids`] / [`page_glob_filter_ids`]: it tests the
/// builder's WHERE fragment directly against seeded `blocks` rows, with no
/// FTS join in the way.
async fn metadata_filter_ids<F>(
    pool: &SqlitePool,
    populate: F,
) -> std::collections::BTreeSet<String>
where
    F: FnOnce(&mut crate::fts::filter_builder::StructuralFilterBuilder),
{
    let mut fb = crate::fts::filter_builder::StructuralFilterBuilder::new(1);
    populate(&mut fb);
    let sql = format!("SELECT b.id FROM blocks b WHERE 1=1{}", fb.sql());
    let query = sqlx::query_as::<_, (String,)>(sqlx::AssertSqlSafe(sql.as_str()));
    let query = fb.apply(query);
    let rows = query.fetch_all(pool).await.unwrap();
    rows.into_iter().map(|(id,)| id).collect()
}

/// Insert a block carrying explicit metadata columns (`todo_state`,
/// `block_type`, `due_date`, `scheduled_date`). `NULL`s are passed as
/// `None`. Bypasses [`insert_block`] (which leaves the metadata columns at
/// their defaults) so the fixture can exercise the NULL-state / NULL-date
/// branches the projection's `IS NULL` clauses key on.
#[allow(clippy::too_many_arguments)]
async fn insert_meta_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    todo_state: Option<&str>,
    due_date: Option<&str>,
    scheduled_date: Option<&str>,
    position: i64,
) {
    sqlx::query(
        "INSERT INTO blocks \
         (id, block_type, content, parent_id, position, page_id, todo_state, due_date, scheduled_date) \
         VALUES (?, ?, 'body', NULL, ?, NULL, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(position)
    .bind(todo_state)
    .bind(due_date)
    .bind(scheduled_date)
    .execute(pool)
    .await
    .unwrap();
}

// Distinct 26-char uppercase ULID-style ids for the metadata fixture.
const META_TODO: &str = "01HQMETATODO00000000000T01"; // TODO,  due 2026-05-18, sched 2026-05-20, content
const META_DONE: &str = "01HQMETADONE00000000000D01"; // DONE,  due 2026-05-25, sched NULL,       content
const META_DOING: &str = "01HQMETADOING0000000000G01"; // DOING, due NULL,       sched 2026-05-10, content
const META_NULLST: &str = "01HQMETANULL00000000000N01"; // NULL,  due 2026-05-18, sched NULL,       content
const META_PAGE: &str = "01HQMETAPAGE00000000000P01"; // NULL todo_state, page-typed, dates NULL

/// Seed a fixed fixture exercising the metadata-filter matrix:
/// - varied `todo_state` (TODO / DONE / DOING / NULL ×2)
/// - varied `block_type` (content ×4, page ×1)
/// - varied `due_date` / `scheduled_date` (incl. NULLs)
async fn seed_metadata_fixture(pool: &SqlitePool) {
    insert_meta_block(
        pool,
        META_TODO,
        "content",
        Some("TODO"),
        Some("2026-05-18"),
        Some("2026-05-20"),
        0,
    )
    .await;
    insert_meta_block(
        pool,
        META_DONE,
        "content",
        Some("DONE"),
        Some("2026-05-25"),
        None,
        1,
    )
    .await;
    insert_meta_block(
        pool,
        META_DOING,
        "content",
        Some("DOING"),
        None,
        Some("2026-05-10"),
        2,
    )
    .await;
    insert_meta_block(
        pool,
        META_NULLST,
        "content",
        None,
        Some("2026-05-18"),
        None,
        3,
    )
    .await;
    insert_meta_block(pool, META_PAGE, "page", None, None, None, 4).await;
}

fn id_set(ids: &[&str]) -> std::collections::BTreeSet<String> {
    ids.iter().map(|s| (*s).to_string()).collect()
}

const META_PREFIX: &str = "\n           AND ";

/// State INCLUDE: `state:TODO,DOING` → rows whose `todo_state IN (…)`.
/// (NULL-state and other states excluded.)
#[tokio::test]
async fn b2_state_include_matches_legacy() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(
            META_PREFIX,
            &["TODO".to_string(), "DOING".to_string()],
            false,
            false,
        );
    })
    .await;
    assert_eq!(
        got,
        id_set(&[META_TODO, META_DOING]),
        "state include must match exactly the IN-set rows"
    );
}

/// State INCLUDE + `none`: `state:TODO,none` → `todo_state IN ('TODO') OR
/// todo_state IS NULL`. Covers the include-side NULL branch.
#[tokio::test]
async fn b2_state_include_with_none_matches_legacy() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(META_PREFIX, &["TODO".to_string()], true, false);
    })
    .await;
    // TODO (in-set) + the two NULL-state rows (content + page).
    assert_eq!(
        got,
        id_set(&[META_TODO, META_NULLST, META_PAGE]),
        "state include with `none` must add the IS NULL rows"
    );
}

/// State EXCLUDE: `not-state:DONE` → `todo_state IS NULL OR todo_state NOT
/// IN ('DONE')`. The NULL-state rows are INCLUDED (legacy design:
/// the `IS NULL` branch lives outside the `NOT IN` list, sidestepping the
/// 3-valued `NOT IN (…, NULL)` trap). Only DONE is dropped.
#[tokio::test]
async fn b2_state_exclude_includes_null_rows_matches_legacy() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(META_PREFIX, &["DONE".to_string()], false, true);
    })
    .await;
    assert_eq!(
        got,
        id_set(&[META_TODO, META_DOING, META_NULLST, META_PAGE]),
        "exclude DONE must keep every non-DONE row INCLUDING the NULL-state rows"
    );
}

/// State EXCLUDE + `none` sentinel: `not-state:DONE,none` → exclude the
/// listed values AND the NULL bucket. The corrected SQL AND-joins
/// `todo_state IS NOT NULL AND todo_state NOT IN ('DONE')` (#2019), so a
/// DONE row is dropped by the `NOT IN`, and a NULL-state row is dropped by
/// the `IS NOT NULL` guard. Only the non-NULL, non-DONE rows survive.
///
/// Before #2019 this OR-joined to `(todo_state IS NULL OR todo_state NOT IN
/// ('DONE')) OR todo_state IS NOT NULL`, a tautology that matched every row.
#[tokio::test]
async fn b2_state_exclude_with_none_sentinel_excludes_values_and_null() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(META_PREFIX, &["DONE".to_string()], true, true);
    })
    .await;
    assert_eq!(
        got,
        id_set(&[META_TODO, META_DOING]),
        "not-state:DONE,none must exclude both DONE rows and NULL-state rows, \
         keeping only the non-NULL non-DONE rows (#2019)"
    );
}

/// Pure `state:none` include → only the NULL-state rows.
#[tokio::test]
async fn b2_state_pure_none_matches_only_null_rows() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(META_PREFIX, &[], true, false);
    })
    .await;
    assert_eq!(
        got,
        id_set(&[META_NULLST, META_PAGE]),
        "pure `state:none` must match only the IS NULL rows"
    );
}

/// Empty state include (no values, not null) is a no-op → all rows pass.
#[tokio::test]
async fn b2_state_empty_is_noop() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_state_via_projection(META_PREFIX, &[], false, false);
    })
    .await;
    assert_eq!(
        got,
        id_set(&[META_TODO, META_DONE, META_DOING, META_NULLST, META_PAGE]),
        "empty state include must emit no clause — every row passes"
    );
}

/// `block-type:page` → only the page-typed row. The projection emits
/// `b.block_type IN (?)`, result-equivalent to the legacy single-value
/// `b.block_type = ?` fragment; the concrete row set pins that invariant.
#[tokio::test]
async fn b2_block_type_matches_legacy() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let routed = metadata_filter_ids(&pool, |fb| {
        fb.add_block_type_via_projection(META_PREFIX, Some("page"));
    })
    .await;
    assert_eq!(
        routed,
        id_set(&[META_PAGE]),
        "block-type:page must match only the page-typed row"
    );
}

/// `block-type:None` is a no-op — a `None` block-type filters no row.
#[tokio::test]
async fn b2_block_type_none_is_noop() {
    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    let got = metadata_filter_ids(&pool, |fb| {
        fb.add_block_type_via_projection(META_PREFIX, None);
    })
    .await;
    assert_eq!(got.len(), 5, "None block-type must not filter any row");
}

/// Due-date predicate matrix. Each `DatePredicate` variant compiles to the
/// canonical A2 SQL over `b.due_date`, result-equivalent to the legacy
/// `append_date_predicate` fragment (guarded `IS NOT NULL`; `On` = exact
/// `=`; `IsNull` matches the unset rows).
#[tokio::test]
async fn b2_due_date_predicate_matrix_matches_legacy() {
    use crate::fts::metadata_filter::DatePredicate;
    use crate::search_types::DateOp;

    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    // due_date values: TODO=2026-05-18, DONE=2026-05-25, NULLST=2026-05-18,
    // DOING=NULL, PAGE=NULL.
    let cases: &[(DatePredicate, std::collections::BTreeSet<String>, &str)] = &[
        (
            DatePredicate::Op {
                op: DateOp::Eq,
                date: "2026-05-18".into(),
            },
            id_set(&[META_TODO, META_NULLST]),
            "On 2026-05-18",
        ),
        (
            DatePredicate::Op {
                op: DateOp::Lt,
                date: "2026-05-20".into(),
            },
            id_set(&[META_TODO, META_NULLST]),
            "Before 2026-05-20",
        ),
        (
            DatePredicate::Op {
                op: DateOp::Gte,
                date: "2026-05-20".into(),
            },
            id_set(&[META_DONE]),
            "OnOrAfter 2026-05-20",
        ),
        (
            DatePredicate::Range {
                from: "2026-05-18".into(),
                to: "2026-05-25".into(),
            },
            id_set(&[META_TODO, META_DONE, META_NULLST]),
            "Between 18..25",
        ),
        (
            DatePredicate::IsNull,
            id_set(&[META_DOING, META_PAGE]),
            "IsNull (due unset)",
        ),
    ];

    for (pred, expected, label) in cases {
        let got = metadata_filter_ids(&pool, |fb| {
            fb.add_due_date_via_projection(META_PREFIX, pred);
        })
        .await;
        assert_eq!(&got, expected, "[due {label}] row set mismatch");
    }
}

/// Scheduled-date predicate routed through `compile_scheduled` over
/// `b.scheduled_date`. scheduled values: TODO=2026-05-20, DOING=2026-05-10,
/// others NULL.
#[tokio::test]
async fn b2_scheduled_predicate_matches_legacy() {
    use crate::fts::metadata_filter::DatePredicate;

    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;

    // Between 2026-05-10..2026-05-15 → only DOING.
    let between = metadata_filter_ids(&pool, |fb| {
        fb.add_scheduled_via_projection(
            META_PREFIX,
            &DatePredicate::Range {
                from: "2026-05-10".into(),
                to: "2026-05-15".into(),
            },
        );
    })
    .await;
    assert_eq!(
        between,
        id_set(&[META_DOING]),
        "scheduled Between must match only DOING"
    );

    // IsNull → the three rows with no scheduled_date.
    let is_null = metadata_filter_ids(&pool, |fb| {
        fb.add_scheduled_via_projection(META_PREFIX, &DatePredicate::IsNull);
    })
    .await;
    assert_eq!(
        is_null,
        id_set(&[META_DONE, META_NULLST, META_PAGE]),
        "scheduled IsNull must match the unset rows"
    );
}

/// End-to-end: `search_fts` with a `SearchFilter` carrying state + due +
/// block-type returns the expected rows — proving the production search
/// surface (not just the builder) is correctly wired to the routed path.
#[tokio::test]
async fn b2_search_fts_end_to_end_state_due_block_type() {
    use crate::search_types::{DateFilter, DateOp, SearchFilter};

    let (pool, _dir) = test_pool().await;
    seed_metadata_fixture(&pool).await;
    // Make every fixture block discoverable via FTS MATCH ("body").
    for id in [META_TODO, META_DONE, META_DOING, META_NULLST, META_PAGE] {
        update_fts_for_block(&pool, id).await.unwrap();
    }

    let today = chrono::NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();

    // state:TODO,DOING — expect the TODO + DOING content rows.
    let f = SearchFilter {
        state_filter: vec!["TODO".into(), "DOING".into()],
        ..Default::default()
    };
    let meta = crate::fts::metadata_filter::prepare_metadata_with_today(&f, today).unwrap();
    let page = PageRequest::new(None, Some(50)).unwrap();
    let res = search_fts(
        &pool,
        "body",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &meta,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::BTreeSet<String> = res
        .items
        .iter()
        .map(|r| r.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        id_set(&[META_TODO, META_DOING]),
        "search_fts state:TODO,DOING must return the TODO+DOING rows"
    );

    // due:=2026-05-18 (exact) — expect TODO + NULLST.
    let f = SearchFilter {
        due_filter: Some(DateFilter::Op {
            op: DateOp::Eq,
            date: "2026-05-18".into(),
        }),
        ..Default::default()
    };
    let meta = crate::fts::metadata_filter::prepare_metadata_with_today(&f, today).unwrap();
    let res = search_fts(
        &pool,
        "body",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &meta,
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::BTreeSet<String> = res
        .items
        .iter()
        .map(|r| r.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        id_set(&[META_TODO, META_NULLST]),
        "search_fts due:=2026-05-18 must return the two due-on-that-day rows"
    );

    // block_type=page via the dedicated param — expect only the page row.
    let res = search_fts(
        &pool,
        "body",
        &page,
        None,
        None,
        None,
        &[],
        &[],
        Some("page"),
        &crate::fts::metadata_filter::MetadataPredicates::default(),
        None,
    )
    .await
    .unwrap();
    let ids: std::collections::BTreeSet<String> = res
        .items
        .iter()
        .map(|r| r.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        id_set(&[META_PAGE]),
        "search_fts block_type=page must return only the page row"
    );
}
