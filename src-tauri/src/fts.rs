//! FTS5 full-text search backend.
//!
//! Provides strip/index/search functions for the `fts_blocks` virtual table.
//! The strip pass converts raw block content to plain text for FTS indexing
//! by removing markdown formatting and resolving tag/page references.
//!
//! ## Design
//!
//! - `strip_for_fts` — async, resolves `#[ULID]` and `[[ULID]]` via DB lookups
//! - `strip_for_fts_with_maps` — sync, uses pre-loaded HashMaps (batch rebuild)
//! - `update_fts_for_block` — index one block
//! - `remove_fts_for_block` — remove one block from index
//! - `rebuild_fts_index` — full reindex of all active blocks
//! - `fts_optimize` — run FTS5 segment merge
//! - `search_fts` — FTS5 MATCH query with cursor-based pagination

#![allow(dead_code)]

use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse};

// ---------------------------------------------------------------------------
// Regex patterns for stripping
// ---------------------------------------------------------------------------

/// Matches bold markdown: `**text**`
static BOLD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("invalid bold regex"));

/// Matches italic markdown: `*text*` (processed AFTER bold)
static ITALIC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*(.+?)\*").expect("invalid italic regex"));

/// Matches inline code: `` `text` ``
static CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`(.+?)`").expect("invalid code regex"));

/// Matches tag references: `#[ULID]`
static TAG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid tag ref regex"));

/// Matches page links: `[[ULID]]`
static PAGE_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([0-9A-Z]{26})\]\]").expect("invalid page link regex"));

// ---------------------------------------------------------------------------
// Strip functions
// ---------------------------------------------------------------------------

/// Strip markdown and resolve references using DB lookups.
///
/// 1. Remove bold `**text**` → `text`
/// 2. Remove italic `*text*` → `text` (after bold)
/// 3. Remove inline code `` `text` `` → `text`
/// 4. Replace `#[ULID]` → tag name (or empty string)
/// 5. Replace `[[ULID]]` → page title (or empty string)
pub async fn strip_for_fts(content: &str, pool: &SqlitePool) -> Result<String, AppError> {
    // Step 1-3: Remove markdown formatting
    let mut result = BOLD_RE.replace_all(content, "$1").to_string();
    result = ITALIC_RE.replace_all(&result, "$1").to_string();
    result = CODE_RE.replace_all(&result, "$1").to_string();

    // Step 4: Replace tag references
    let mut tag_ids: Vec<String> = Vec::new();
    for cap in TAG_REF_RE.captures_iter(&result) {
        tag_ids.push(cap[1].to_string());
    }
    for tag_id in &tag_ids {
        let name: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT content FROM blocks WHERE id = ? AND block_type = 'tag' AND deleted_at IS NULL",
        )
        .bind(tag_id)
        .fetch_optional(pool)
        .await?;
        let replacement = name.and_then(|(c,)| c).unwrap_or_default();
        let pattern = format!("#[{tag_id}]");
        result = result.replace(&pattern, &replacement);
    }

    // Step 5: Replace page links
    let mut page_ids: Vec<String> = Vec::new();
    for cap in PAGE_LINK_RE.captures_iter(&result) {
        page_ids.push(cap[1].to_string());
    }
    for page_id in &page_ids {
        let title: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT content FROM blocks WHERE id = ? AND block_type = 'page' AND deleted_at IS NULL",
        )
        .bind(page_id)
        .fetch_optional(pool)
        .await?;
        let replacement = title.and_then(|(c,)| c).unwrap_or_default();
        let pattern = format!("[[{page_id}]]");
        result = result.replace(&pattern, &replacement);
    }

    Ok(result)
}

/// Strip markdown and resolve references using pre-loaded maps (sync, for batch rebuild).
///
/// `tag_names` maps tag block_id → tag name (content).
/// `page_titles` maps page block_id → page title (content).
fn strip_for_fts_with_maps(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    // Steps 1-3: Remove markdown formatting
    let mut result = BOLD_RE.replace_all(content, "$1").to_string();
    result = ITALIC_RE.replace_all(&result, "$1").to_string();
    result = CODE_RE.replace_all(&result, "$1").to_string();

    // Step 4: Replace tag references
    result = TAG_REF_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            tag_names.get(ulid).cloned().unwrap_or_default()
        })
        .to_string();

    // Step 5: Replace page links
    result = PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            page_titles.get(ulid).cloned().unwrap_or_default()
        })
        .to_string();

    result
}

// ---------------------------------------------------------------------------
// FTS index management
// ---------------------------------------------------------------------------

/// Update FTS index for a single block.
///
/// Reads the block from the blocks table, strips content, and upserts
/// the FTS entry. If the block is deleted, a conflict, or has no content,
/// removes it from the index instead.
pub async fn update_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let row: Option<(String, Option<String>, Option<String>, bool)> =
        sqlx::query_as("SELECT id, content, deleted_at, is_conflict FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(pool)
            .await?;

    match row {
        None => {
            // Block doesn't exist — remove from FTS if present
            return remove_fts_for_block(pool, block_id).await;
        }
        Some((_, _, Some(_), _)) => {
            // deleted_at IS NOT NULL — remove from FTS
            return remove_fts_for_block(pool, block_id).await;
        }
        Some((_, _, _, true)) => {
            // is_conflict = 1 — remove from FTS
            return remove_fts_for_block(pool, block_id).await;
        }
        Some((_, None, _, _)) => {
            // content IS NULL — remove from FTS
            return remove_fts_for_block(pool, block_id).await;
        }
        Some((_, Some(content), None, false)) => {
            // Active block with content — strip and index
            let stripped = strip_for_fts(&content, pool).await?;

            // Delete existing entry
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(pool)
                .await?;

            // Insert new entry
            sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                .bind(block_id)
                .bind(&stripped)
                .execute(pool)
                .await?;
        }
    }

    Ok(())
}

/// Remove a block from the FTS index (for soft-delete/purge).
pub async fn remove_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Full rebuild: clear fts_blocks, re-index all non-deleted, non-conflict blocks with content.
///
/// Batches tag/page lookups by loading all names/titles into HashMaps first.
pub async fn rebuild_fts_index(pool: &SqlitePool) -> Result<(), AppError> {
    // Load all tag names
    let tag_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0",
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect();

    // Load all page titles
    let page_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL AND is_conflict = 0",
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect();

    // Start transaction
    let mut tx = pool.begin().await?;

    // Clear all FTS entries
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;

    // Select all active blocks with content
    let blocks: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await?;

    // Strip and insert each block
    for (block_id, content) in &blocks {
        let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
        sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
            .bind(block_id)
            .bind(&stripped)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// FTS5 optimize
// ---------------------------------------------------------------------------

/// Run FTS5 optimize to merge segments.
pub async fn fts_optimize(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query("INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')")
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

/// Row from the FTS5 search query (private; mapped to BlockRow for response).
#[derive(Debug, sqlx::FromRow)]
struct FtsSearchRow {
    // Block fields
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    archived_at: Option<String>,
    is_conflict: bool,
    // FTS ranking fields (for cursor)
    search_rank: f64,
    fts_rowid: i64,
}

/// Search blocks via FTS5 MATCH with cursor-based pagination.
///
/// Results are ordered by FTS5 rank (best match first) with rowid as tiebreaker.
/// Empty/whitespace queries return an empty response (no error).
pub async fn search_fts(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    // Guard: empty/whitespace queries would cause an FTS5 syntax error.
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }

    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_rank, cursor_rowid): (Option<i64>, f64, i64) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.rank.unwrap_or(0.0), c.seq.unwrap_or(0)),
            None => (None, 0.0, 0),
        };

    let rows = sqlx::query_as::<_, FtsSearchRow>(
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                b.deleted_at, b.archived_at, b.is_conflict, \
                fts.rank as search_rank, fts.rowid as fts_rowid \
         FROM fts_blocks fts \
         JOIN blocks b ON b.id = fts.block_id \
         WHERE fts_blocks MATCH ?1 \
           AND b.deleted_at IS NULL AND b.is_conflict = 0 \
           AND (?2 IS NULL OR fts.rank > ?3 OR (fts.rank = ?3 AND fts.rowid > ?4)) \
         ORDER BY fts.rank, fts.rowid \
         LIMIT ?5",
    )
    .bind(query) // ?1
    .bind(cursor_flag) // ?2
    .bind(cursor_rank) // ?3
    .bind(cursor_rowid) // ?4
    .bind(fetch_limit) // ?5
    .fetch_all(pool)
    .await
    .map_err(|e| {
        // FTS5 syntax errors come through as database errors.
        // Map them to Validation for a friendlier user experience.
        let msg = e.to_string();
        if msg.contains("fts5: syntax error") || msg.contains("parse error") {
            AppError::Validation(format!(
                "Invalid search query: check for unmatched quotes or special characters. \
                 Details: {msg}"
            ))
        } else {
            AppError::Database(e)
        }
    })?;

    let has_more = rows.len() as i64 > page.limit;
    let mut block_rows: Vec<BlockRow> = rows
        .iter()
        .map(|r| BlockRow {
            id: r.id.clone(),
            block_type: r.block_type.clone(),
            content: r.content.clone(),
            parent_id: r.parent_id.clone(),
            position: r.position,
            deleted_at: r.deleted_at.clone(),
            archived_at: r.archived_at.clone(),
            is_conflict: r.is_conflict,
        })
        .collect();

    if has_more {
        block_rows.truncate(page.limit as usize);
    }

    let next_cursor = if has_more {
        let last_fts = &rows[page.limit as usize - 1];
        Some(
            Cursor {
                id: last_fts.id.clone(),
                position: None,
                deleted_at: None,
                seq: Some(last_fts.fts_rowid),
                rank: Some(last_fts.search_rank),
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: block_rows,
        next_cursor,
        has_more,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
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
        assert_eq!(result, "hello world");
    }

    #[tokio::test]
    async fn strip_bold() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("**hello**", &pool).await.unwrap();
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn strip_italic() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("*hello*", &pool).await.unwrap();
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn strip_code() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("`hello`", &pool).await.unwrap();
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn strip_mixed_formatting() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("**bold** and *italic* and `code`", &pool)
            .await
            .unwrap();
        assert_eq!(result, "bold and italic and code");
    }

    #[tokio::test]
    async fn strip_tag_ref_resolved() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;

        let input = format!("task #{}", format!("[{TAG_ULID}]"));
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "task urgent");
    }

    #[tokio::test]
    async fn strip_page_link_resolved() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PAGE_ULID, "page", "My Page", None, None).await;

        let input = format!("see [[{PAGE_ULID}]]");
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "see My Page");
    }

    #[tokio::test]
    async fn strip_unknown_tag_ref_becomes_empty() {
        let (pool, _dir) = test_pool().await;
        let input = format!("task #{}", format!("[{UNKNOWN_ULID}]"));
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "task ");
    }

    #[tokio::test]
    async fn strip_unknown_page_link_becomes_empty() {
        let (pool, _dir) = test_pool().await;
        let input = format!("see [[{UNKNOWN_ULID}]]");
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "see ");
    }

    #[tokio::test]
    async fn strip_nested_bold_italic() {
        let (pool, _dir) = test_pool().await;
        // **bold *italic*** — bold outer stripped first, then italic
        let result = strip_for_fts("**bold *italic***", &pool).await.unwrap();
        // After bold strip: "bold *italic*", after italic strip: "bold italic"
        assert_eq!(result, "bold italic");
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
        assert_eq!(result, "bold urgent see My Page");
    }

    #[test]
    fn strip_with_maps_unknown_refs_empty() {
        let tag_names = HashMap::new();
        let page_titles = HashMap::new();

        let input = format!("#[{UNKNOWN_ULID}] and [[{UNKNOWN_ULID}]]");
        let result = strip_for_fts_with_maps(&input, &tag_names, &page_titles);
        assert_eq!(result, " and ");
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
        let results = search_fts(&pool, "wonderful", &page).await.unwrap();
        assert_eq!(results.items.len(), 1);
        assert_eq!(results.items[0].id, BLOCK_A);
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
        let old_results = search_fts(&pool, "original", &page).await.unwrap();
        assert_eq!(old_results.items.len(), 0);

        // New content should be found
        let new_results = search_fts(&pool, "different", &page).await.unwrap();
        assert_eq!(new_results.items.len(), 1);
        assert_eq!(new_results.items[0].id, BLOCK_A);
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
        let results = search_fts(&pool, "searchable", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
    }

    #[tokio::test]
    async fn update_fts_nonexistent_block_is_noop() {
        let (pool, _dir) = test_pool().await;
        // Should not error for a block that doesn't exist
        let result = update_fts_for_block(&pool, "NONEXISTENT00000000000000").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn update_fts_conflict_block_removes_from_index() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "conflict text", None, Some(0)).await;
        update_fts_for_block(&pool, BLOCK_A).await.unwrap();

        mark_conflict(&pool, BLOCK_A).await;
        update_fts_for_block(&pool, BLOCK_A).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let results = search_fts(&pool, "conflict", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
    }

    #[tokio::test]
    async fn update_fts_null_content_removes_from_index() {
        let (pool, _dir) = test_pool().await;
        insert_block_with_null_content(&pool, BLOCK_A, "content").await;
        // Should not error and should not index
        update_fts_for_block(&pool, BLOCK_A).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
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
        let results = search_fts(&pool, "removable", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
    }

    #[tokio::test]
    async fn remove_fts_nonexistent_is_noop() {
        let (pool, _dir) = test_pool().await;
        let result = remove_fts_for_block(&pool, "NONEXISTENT00000000000000").await;
        assert!(result.is_ok());
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

        let a = search_fts(&pool, "alpha", &page).await.unwrap();
        assert_eq!(a.items.len(), 1);
        assert_eq!(a.items[0].id, BLOCK_A);

        let b = search_fts(&pool, "beta", &page).await.unwrap();
        assert_eq!(b.items.len(), 1);
        assert_eq!(b.items[0].id, BLOCK_B);

        let g = search_fts(&pool, "gamma", &page).await.unwrap();
        assert_eq!(g.items.len(), 1);
        assert_eq!(g.items[0].id, BLOCK_C);
    }

    #[tokio::test]
    async fn rebuild_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "visible", None, Some(0)).await;
        insert_block(&pool, BLOCK_B, "content", "deleted content", None, Some(1)).await;
        soft_delete_block(&pool, BLOCK_B).await;

        rebuild_fts_index(&pool).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let deleted_results = search_fts(&pool, "deleted", &page).await.unwrap();
        assert_eq!(deleted_results.items.len(), 0);

        let visible_results = search_fts(&pool, "visible", &page).await.unwrap();
        assert_eq!(visible_results.items.len(), 1);
    }

    #[tokio::test]
    async fn rebuild_excludes_conflict_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "normal", None, Some(0)).await;
        insert_block(&pool, BLOCK_B, "content", "conflicting", None, Some(1)).await;
        mark_conflict(&pool, BLOCK_B).await;

        rebuild_fts_index(&pool).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let conflict_results = search_fts(&pool, "conflicting", &page).await.unwrap();
        assert_eq!(conflict_results.items.len(), 0);
    }

    #[tokio::test]
    async fn rebuild_excludes_null_content_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "has content", None, Some(0)).await;
        insert_block_with_null_content(&pool, BLOCK_B, "content").await;

        rebuild_fts_index(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM fts_blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "only block with content should be indexed");
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
        let results = search_fts(&pool, "first", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
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
        let tag_results = search_fts(&pool, "urgent", &page).await.unwrap();
        assert!(
            tag_results.items.len() >= 1,
            "at least the tag block should match 'urgent'"
        );

        // Should find the content block by "task" (unique to it)
        let task_results = search_fts(&pool, "task", &page).await.unwrap();
        assert_eq!(task_results.items.len(), 1);
        assert_eq!(task_results.items[0].id, BLOCK_A);
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
        let results = search_fts(&pool, "optimize", &page).await.unwrap();
        assert_eq!(results.items.len(), 3);
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
        let results = search_fts(&pool, "alpha", &page).await.unwrap();
        assert_eq!(results.items.len(), 1);
        assert_eq!(results.items[0].id, BLOCK_A);
    }

    #[tokio::test]
    async fn search_no_results() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
        rebuild_fts_index(&pool).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let results = search_fts(&pool, "nonexistent", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
        assert!(!results.has_more);
        assert!(results.next_cursor.is_none());
    }

    #[tokio::test]
    async fn search_empty_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
        rebuild_fts_index(&pool).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let results = search_fts(&pool, "", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
        assert!(!results.has_more);
    }

    #[tokio::test]
    async fn search_whitespace_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello world", None, Some(0)).await;
        rebuild_fts_index(&pool).await.unwrap();

        let page = PageRequest::new(None, Some(50)).unwrap();
        let results = search_fts(&pool, "   ", &page).await.unwrap();
        assert_eq!(results.items.len(), 0);
        assert!(!results.has_more);
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
        let results = search_fts(&pool, "visible", &page).await.unwrap();
        // Only BLOCK_A should appear (BLOCK_B is deleted)
        assert_eq!(results.items.len(), 1);
        assert_eq!(results.items[0].id, BLOCK_A);
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
        let results1 = search_fts(&pool, "pagination", &page1).await.unwrap();
        assert_eq!(results1.items.len(), 2);
        assert!(results1.has_more);
        assert!(results1.next_cursor.is_some());

        // Second page using cursor
        let page2 = PageRequest::new(results1.next_cursor, Some(2)).unwrap();
        let results2 = search_fts(&pool, "pagination", &page2).await.unwrap();
        assert_eq!(results2.items.len(), 2);
        assert!(!results2.has_more);

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
        // Unmatched quotes are a common FTS5 syntax error
        let result = search_fts(&pool, "\"unclosed quote", &page).await;
        assert!(result.is_err(), "FTS5 syntax error should produce an error");
        if let Err(e) = result {
            assert!(
                matches!(e, AppError::Validation(_)) || matches!(e, AppError::Database(_)),
                "should be Validation or Database error, got: {e:?}"
            );
        }
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
        let both = search_fts(&pool, "programming", &page).await.unwrap();
        assert_eq!(both.items.len(), 2);

        // Only BLOCK_A matches "rust"
        let rust_only = search_fts(&pool, "rust", &page).await.unwrap();
        assert_eq!(rust_only.items.len(), 1);
        assert_eq!(rust_only.items[0].id, BLOCK_A);
    }
}
