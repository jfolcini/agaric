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
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse};

// ---------------------------------------------------------------------------
// Regex patterns for stripping
// ---------------------------------------------------------------------------

// Hardcoded regex patterns — compilation cannot fail for these constant strings.

/// Matches bold markdown: `**text**`
static BOLD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("invalid bold regex"));

/// Matches italic markdown: `*text*` (processed AFTER bold)
static ITALIC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*(.+?)\*").expect("invalid italic regex"));

/// Matches inline code: `` `text` ``
static CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`(.+?)`").expect("invalid code regex"));

/// Matches strikethrough markdown: `~~text~~`
static STRIKE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"~~(.+?)~~").expect("invalid strikethrough regex"));

/// Matches highlight markdown: `==text==`
static HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"==(.+?)==").expect("invalid highlight regex"));

/// Matches tag references: `#[ULID]`
pub(crate) static TAG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid tag ref regex"));

/// Matches page links: `[[ULID]]`
pub(crate) static PAGE_LINK_RE: LazyLock<Regex> =
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
/// 6. Unescape backslash sequences: `\*` → `*`, `` \` `` → `` ` ``
pub async fn strip_for_fts(content: &str, pool: &SqlitePool) -> Result<String, AppError> {
    // Steps 1-3: Remove markdown formatting
    let mut result = BOLD_RE.replace_all(content, "$1").to_string();
    result = ITALIC_RE.replace_all(&result, "$1").to_string();
    result = CODE_RE.replace_all(&result, "$1").to_string();
    result = STRIKE_RE.replace_all(&result, "$1").to_string();
    result = HIGHLIGHT_RE.replace_all(&result, "$1").to_string();

    // Step 4: Batch-fetch tag names and replace
    let tag_ids: Vec<String> = TAG_REF_RE
        .captures_iter(&result)
        .map(|cap| cap[1].to_string())
        .collect();

    if !tag_ids.is_empty() {
        let ids_json = serde_json::to_string(&tag_ids)?;
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'tag' AND deleted_at IS NULL",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?;
        let tag_names: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|(id, content)| content.map(|c| (id, c)))
            .collect();
        result = TAG_REF_RE
            .replace_all(&result, |caps: &regex::Captures| {
                let ulid = &caps[1];
                tag_names.get(ulid).cloned().unwrap_or_default()
            })
            .to_string();
    }

    // Step 5: Batch-fetch page titles and replace
    let page_ids: Vec<String> = PAGE_LINK_RE
        .captures_iter(&result)
        .map(|cap| cap[1].to_string())
        .collect();

    if !page_ids.is_empty() {
        let ids_json = serde_json::to_string(&page_ids)?;
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'page' AND deleted_at IS NULL",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?;
        let page_titles: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|(id, content)| content.map(|c| (id, c)))
            .collect();
        result = PAGE_LINK_RE
            .replace_all(&result, |caps: &regex::Captures| {
                let ulid = &caps[1];
                page_titles.get(ulid).cloned().unwrap_or_default()
            })
            .to_string();
    }

    // Step 6: Unescape backslash sequences (\* -> *, \` -> `, \~ -> ~, \= -> =)
    result = result
        .replace("\\*", "*")
        .replace("\\`", "`")
        .replace("\\~", "~")
        .replace("\\=", "=");

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
    result = STRIKE_RE.replace_all(&result, "$1").to_string();
    result = HIGHLIGHT_RE.replace_all(&result, "$1").to_string();

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

    // Step 6: Unescape backslash sequences (\* -> *, \` -> `, \~ -> ~, \= -> =)
    result = result
        .replace("\\*", "*")
        .replace("\\`", "`")
        .replace("\\~", "~")
        .replace("\\=", "=");

    result
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Load tag name map and page title map for batch FTS processing.
///
/// Returns `(tag_names, page_titles)` HashMaps mapping block_id → content
/// for all active (non-deleted, non-conflict) tag and page blocks.
async fn load_ref_maps(
    pool: &SqlitePool,
) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let tag_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    let page_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    Ok((tag_names, page_titles))
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
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        r#"SELECT id, content, deleted_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    match row {
        None => {
            // Block doesn't exist — remove from FTS if present
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.deleted_at.is_some() => {
            // deleted_at IS NOT NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.is_conflict => {
            // is_conflict = 1 — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.content.is_none() => {
            // content IS NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(r) => {
            // Active block with content — strip and index
            let content = r.content.unwrap();
            let stripped = strip_for_fts(&content, pool).await?;

            // Delete existing entry
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;

            // Insert new entry
            sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                .bind(block_id)
                .bind(&stripped)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;
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

/// Reindex FTS for all blocks that reference the given tag or page block.
///
/// When a tag/page is renamed (edited), the FTS entries for every block that
/// references it become stale because `strip_for_fts` resolves `#[ULID]` /
/// `[[ULID]]` tokens to human-readable names. This function finds all
/// referencing blocks and re-runs FTS indexing for each.
///
/// ## Performance
///
/// Pre-loads tag/page name maps once (2 queries) and processes all affected
/// blocks in a single transaction, reducing from O(N × 3) queries to
/// O(2 + N) — 2 map loads + N DELETE/INSERT pairs in one tx.
pub async fn reindex_fts_references(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    // Find blocks referencing this ID via block_tags (for tags)
    let tag_refs: Vec<String> =
        sqlx::query_scalar!("SELECT block_id FROM block_tags WHERE tag_id = ?", block_id)
            .fetch_all(pool)
            .await?;

    // Find blocks referencing this ID via block_links (for pages)
    let link_refs: Vec<String> = sqlx::query_scalar!(
        "SELECT source_id FROM block_links WHERE target_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    // Collect unique block IDs
    let mut seen = std::collections::HashSet::new();
    let unique_ids: Vec<String> = tag_refs
        .into_iter()
        .chain(link_refs.into_iter())
        .filter(|bid| seen.insert(bid.clone()))
        .collect();

    if unique_ids.is_empty() {
        return Ok(());
    }

    // Pre-load tag/page name maps (2 queries instead of 2*N)
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    // Single transaction for all updates
    let mut tx = pool.begin().await?;

    for bid in &unique_ids {
        // Fetch block metadata + content
        let row = sqlx::query!(
            r#"SELECT content, deleted_at, is_conflict as "is_conflict: bool"
               FROM blocks WHERE id = ?"#,
            bid
        )
        .fetch_optional(&mut *tx)
        .await?;

        // Always delete the old FTS entry
        sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
            .bind(bid)
            .execute(&mut *tx)
            .await?;

        // Re-insert only if block is active with content
        if let Some(r) = row {
            if r.deleted_at.is_none() && !r.is_conflict {
                if let Some(ref content) = r.content {
                    let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
                    sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                        .bind(bid)
                        .bind(&stripped)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Full rebuild: clear fts_blocks, re-index all non-deleted, non-conflict blocks with content.
///
/// Batches tag/page lookups by loading all names/titles into HashMaps first.
///
/// ## Performance
///
/// This is an O(n) operation over all active blocks — it loads every block's
/// content into memory, strips it, and re-inserts into the FTS table inside a
/// single transaction.  This is **expected and intentional**: the function is
/// only called at application boot and on explicit user request (e.g. "rebuild
/// search index"), never incrementally.  Single-block updates go through
/// [`update_fts_for_block`] instead.
pub async fn rebuild_fts_index(pool: &SqlitePool) -> Result<(), AppError> {
    // Pre-load tag/page name maps (shared helper)
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    // Start transaction
    let mut tx = pool.begin().await?;

    // Clear all FTS entries
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;

    // Select all active blocks with content
    let blocks = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
    )
    .fetch_all(&mut *tx)
    .await?;

    // Strip and insert each block
    for row in &blocks {
        let content = row.content.as_deref().unwrap_or("");
        let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
        sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
            .bind(&row.id)
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

/// Maximum number of results returned from a single search query, regardless
/// of the client-supplied page limit.  Prevents unbounded result sets.
const MAX_SEARCH_RESULTS: i64 = 100;

/// Sanitize a raw user query for safe use in an FTS5 MATCH expression.
///
/// Each whitespace-delimited token is wrapped in double quotes with any
/// internal double quotes escaped by doubling (`"` → `""`).  This prevents
/// FTS5 operators (`OR`, `AND`, `NOT`, `*`, `NEAR`, column filters, etc.)
/// from being interpreted as query syntax while still allowing multi-term
/// implicit-AND matching.
#[must_use]
pub(crate) fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| {
            let escaped = term.replace('"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

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
    is_conflict: bool,
    conflict_type: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    // FTS ranking field (for cursor)
    search_rank: f64,
}

/// Search blocks via FTS5 MATCH with cursor-based pagination.
///
/// Results are ordered by FTS5 rank (best match first) with `block_id` as
/// tiebreaker.  The cursor is a composite `(rank, id)` pair.  Rank comparison
/// uses an epsilon of 1e-9 (`ABS(rank - cursor_rank) < 1e-9`) instead of exact
/// float equality, which avoids potential duplicate or missing results caused by
/// floating-point precision drift between cursor serialization and SQLite
/// re-computation of the FTS5 rank.
///
/// Empty/whitespace queries return an empty response (no error).
///
/// The search limit is capped at [`MAX_SEARCH_RESULTS`] (100) per page,
/// regardless of the client-supplied limit.
///
/// ## Query sanitization
///
/// User input is sanitized before passing to FTS5 MATCH: each whitespace-
/// delimited term is wrapped in double quotes with internal quotes escaped.
/// This prevents FTS5 operators from being interpreted as query syntax.
///
/// ## Known limitation: CJK tokenization
///
/// The FTS5 table uses the default `unicode61` tokenizer, which splits tokens
/// on Unicode-defined word boundaries.  This works well for Latin, Cyrillic,
/// and most scripts, but may split CJK (Chinese/Japanese/Korean) text
/// incorrectly — individual characters may become separate tokens instead of
/// multi-character words.  Proper CJK support requires a dedicated tokenizer
/// (e.g., ICU or jieba) and is planned for a future phase.
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

    // Sanitize user input for safe FTS5 MATCH (F01: prevent operator injection)
    let sanitized = sanitize_fts_query(query);

    // Cap page limit to MAX_SEARCH_RESULTS
    let effective_limit = page.limit.min(MAX_SEARCH_RESULTS);
    let fetch_limit = effective_limit + 1;

    // Composite cursor: (rank, block_id).  Block ID is a deterministic
    // tiebreaker that avoids reliance on exact float equality for rank.
    let (cursor_flag, cursor_rank, cursor_id): (Option<i64>, f64, String) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.rank.unwrap_or(0.0), c.id.clone()),
            None => (None, 0.0, String::new()),
        };

    let rows = sqlx::query_as::<_, FtsSearchRow>(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict, b.conflict_type,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                fts.rank as search_rank
         FROM fts_blocks fts
         JOIN blocks b ON b.id = fts.block_id
         WHERE fts_blocks MATCH ?1
           AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?2 IS NULL OR fts.rank > ?3
                OR (ABS(fts.rank - ?3) < 1e-9 AND b.id > ?4))
         ORDER BY fts.rank, b.id
         LIMIT ?5"#,
    )
    .bind(&sanitized) // ?1 -- sanitized FTS5 query
    .bind(cursor_flag) // ?2
    .bind(cursor_rank) // ?3
    .bind(&cursor_id) // ?4
    .bind(fetch_limit) // ?5
    .fetch_all(pool)
    .await
    .map_err(|e| {
        // Map any SQLite error from the MATCH query to a validation error.
        // With query sanitization this should be rare, but acts as defense-in-depth.
        let msg = e.to_string();
        if msg.contains("fts5:") || msg.contains("parse error") {
            AppError::Validation(format!(
                "Invalid search query: check for unmatched quotes or special characters. \
                 Details: {msg}"
            ))
        } else {
            AppError::Database(e)
        }
    })?;

    let has_more = rows.len() as i64 > effective_limit;
    let cursor_data = if has_more {
        let last = &rows[effective_limit as usize - 1];
        Some((last.id.clone(), last.search_rank))
    } else {
        None
    };
    let mut block_rows: Vec<BlockRow> = rows
        .into_iter()
        .map(|r| BlockRow {
            id: r.id,
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
            position: r.position,
            deleted_at: r.deleted_at,
            is_conflict: r.is_conflict,
            conflict_type: r.conflict_type,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
        })
        .collect();

    if has_more {
        block_rows.truncate(effective_limit as usize);
    }

    let next_cursor = if has_more {
        let (cursor_id, cursor_rank) = cursor_data.unwrap();
        Some(
            Cursor {
                id: cursor_id,
                position: None,
                deleted_at: None,
                seq: None,
                rank: Some(cursor_rank),
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
    async fn strip_strikethrough() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("~~deleted~~", &pool).await.unwrap();
        assert_eq!(result, "deleted");
    }

    #[tokio::test]
    async fn strip_highlight() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("==important==", &pool).await.unwrap();
        assert_eq!(result, "important");
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
    async fn strip_mixed_with_strike_and_highlight() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("**bold** and ~~deleted~~ and ==highlighted==", &pool)
            .await
            .unwrap();
        assert_eq!(result, "bold and deleted and highlighted");
    }

    #[tokio::test]
    async fn strip_tag_ref_resolved() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;

        let input = format!("task #[{TAG_ULID}]");
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
        let input = format!("task #[{UNKNOWN_ULID}]");
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

    #[tokio::test]
    async fn strip_multiple_refs_batched() {
        let (pool, _dir) = test_pool().await;
        let tag_id = "01AAAAAAAAAAAAAAAAAAAAATAG";
        let page_id = "01AAAAAAAAAAAAAAAAAAAAPGE1";
        insert_block(&pool, tag_id, "tag", "urgent", None, None).await;
        insert_block(&pool, page_id, "page", "My Page", None, None).await;

        let input = format!("task #[{tag_id}] and #[{tag_id}] see [[{page_id}]] and [[{page_id}]]");
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "task urgent and urgent see My Page and My Page");
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

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
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
            !tag_results.items.is_empty(),
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
        // With query sanitization, unmatched quotes are escaped and no longer
        // produce syntax errors.  The query succeeds (returns 0 results since
        // the literal token does not match any content).
        let result = search_fts(&pool, "\"unclosed quote", &page).await;
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
        let both = search_fts(&pool, "programming", &page).await.unwrap();
        assert_eq!(both.items.len(), 2);

        // Only BLOCK_A matches "rust"
        let rust_only = search_fts(&pool, "rust", &page).await.unwrap();
        assert_eq!(rust_only.items.len(), 1);
        assert_eq!(rust_only.items[0].id, BLOCK_A);
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
            let result = search_fts(&pool, injection, &page).await;
            assert!(
                result.is_ok(),
                "SQL injection attempt should not crash: {injection}"
            );
        }

        // Verify the database is intact
        let check = search_fts(&pool, "normal", &page).await.unwrap();
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

        // "OR" should be treated as a literal word, not an FTS5 boolean operator.
        let result = search_fts(&pool, "OR", &page).await;
        assert!(result.is_ok(), "OR as query should not crash");

        // "NOT" should be treated as a literal word
        let not_result = search_fts(&pool, "NOT hello", &page).await;
        assert!(not_result.is_ok(), "NOT as query should not crash");

        // NEAR() should be treated as a literal word
        let near_result = search_fts(&pool, "NEAR(hello world)", &page).await;
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
            let result = search_fts(&pool, q, &page).await;
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
        let result = search_fts(&pool, "\"unclosed quote", &page).await;
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
        assert_eq!(result, "use *args");
    }

    #[tokio::test]
    async fn strip_escaped_backtick() {
        let (pool, _dir) = test_pool().await;
        // A single (unpaired) escaped backtick is not matched by CODE_RE,
        // so it passes through to the unescape step.
        // Paired `\`...\`` would be consumed by CODE_RE first (known limitation).
        let result = strip_for_fts("it costs 5\\` USD", &pool).await.unwrap();
        assert_eq!(result, "it costs 5` USD");
    }

    #[tokio::test]
    async fn strip_complex_nested_markup() {
        let (pool, _dir) = test_pool().await;
        let result = strip_for_fts("**bold *nested*** rest", &pool)
            .await
            .unwrap();
        assert_eq!(result, "bold nested rest");
    }

    #[tokio::test]
    async fn strip_mixed_formatting_and_refs() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, TAG_ULID, "tag", "urgent", None, None).await;

        let input = format!("**bold** and `code` with #[{TAG_ULID}]");
        let result = strip_for_fts(&input, &pool).await.unwrap();
        assert_eq!(result, "bold and code with urgent");
    }

    #[test]
    fn strip_with_maps_handles_formatting() {
        let tag_names = HashMap::new();
        let page_titles = HashMap::new();

        // Verify the sync batch path handles markdown + unescape.
        // Use a single \* (unpaired) so ITALIC_RE doesn't consume it.
        let result = strip_for_fts_with_maps(r"**bold** `code` \*args", &tag_names, &page_titles);
        assert_eq!(result, "bold code *args");
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
        assert_eq!(result, "bold and deleted and highlighted");
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
        let results = search_fts(&pool, "unique", &page).await.unwrap();
        assert_eq!(
            results.items.len(),
            1,
            "deleted block should be excluded by JOIN filter"
        );
        assert_eq!(results.items[0].id, BLOCK_A);
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
        let results = search_fts(&pool, "capped", &page).await.unwrap();

        // Should still find the result (not broken by capping)
        assert_eq!(results.items.len(), 1);
        assert_eq!(results.items[0].id, BLOCK_A);
    }

    // ======================================================================
    // sanitize_fts_query unit tests
    // ======================================================================

    #[test]
    fn sanitize_simple_terms() {
        assert_eq!(sanitize_fts_query("hello world"), "\"hello\" \"world\"");
    }

    #[test]
    fn sanitize_preserves_empty_after_trim() {
        // split_whitespace on empty string yields no tokens
        assert_eq!(sanitize_fts_query(""), "");
        assert_eq!(sanitize_fts_query("   "), "");
    }

    #[test]
    fn sanitize_escapes_internal_quotes() {
        assert_eq!(sanitize_fts_query("say\"hello"), "\"say\"\"hello\"");
    }

    #[test]
    fn sanitize_fts5_operators() {
        assert_eq!(
            sanitize_fts_query("hello OR world"),
            "\"hello\" \"OR\" \"world\""
        );
        assert_eq!(sanitize_fts_query("NOT test"), "\"NOT\" \"test\"");
    }

    #[test]
    fn sanitize_special_chars() {
        assert_eq!(sanitize_fts_query("test*"), "\"test*\"");
        assert_eq!(sanitize_fts_query("(group)"), "\"(group)\"");
        assert_eq!(sanitize_fts_query("col:value"), "\"col:value\"");
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
                Some(i as i64),
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
            let result = search_fts(&pool, "identical", &page).await.unwrap();

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
        let unique: std::collections::HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
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
        let result1 = search_fts(&pool, "apple", &page1).await.unwrap();
        assert_eq!(result1.items.len(), 1);
        assert!(result1.has_more);
        assert!(result1.next_cursor.is_some());

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
        let result2 = search_fts(&pool, "apple", &page2).await.unwrap();
        assert_eq!(result2.items.len(), 1);

        // Verify no duplicate between page 1 and page 2
        assert_ne!(
            result1.items[0].id, result2.items[0].id,
            "consecutive pages should not return the same block"
        );

        // Third page
        let page3 = PageRequest::new(result2.next_cursor, Some(1)).unwrap();
        let result3 = search_fts(&pool, "apple", &page3).await.unwrap();
        assert_eq!(result3.items.len(), 1);
        assert!(!result3.has_more);

        // Collect all IDs and verify completeness
        let all_ids: Vec<&str> = vec![
            &result1.items[0].id,
            &result2.items[0].id,
            &result3.items[0].id,
        ]
        .into_iter()
        .map(|s| s.as_str())
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
            let result = search_fts(&pool, "pagination", &page).await.unwrap();

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

        let unique: std::collections::HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
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
            let result = search_fts(&pool, dangerous_query, &page).await;
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
                Some(i as i64 + 1),
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
        let before = search_fts(&pool, "meeting", &page).await.unwrap();
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
        let after = search_fts(&pool, "standup", &page).await.unwrap();
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
        let old = search_fts(&pool, "meeting", &page).await.unwrap();
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
}
