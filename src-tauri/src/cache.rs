//! Cache materializer functions (ADR-08).
//!
//! Full-recompute rebuilds for the three read-path caches (`tags_cache`,
//! `pages_cache`, `agenda_cache`) and incremental diff-based reindexing of
//! `block_links`.
//!
//! Every function takes a shared `&SqlitePool` reference and wraps its
//! DELETE + INSERT cycle in a transaction for atomicity.

#![allow(dead_code)]

use chrono::Utc;
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Regex for [[ULID]] tokens (Crockford base32, 26 uppercase chars)
// ---------------------------------------------------------------------------

static ULID_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([0-9A-Z]{26})\]\]").expect("invalid ULID link regex"));

// ---------------------------------------------------------------------------
// rebuild_tags_cache (p1-t18)
// ---------------------------------------------------------------------------

/// Full recompute of `tags_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` (type = `tag`)
/// left-joined with `block_tags` usage counts. Tags with zero usage are
/// included.
pub async fn rebuild_tags_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at)
         SELECT b.id, b.content, COALESCE(t.cnt, 0), ?
         FROM blocks b
         LEFT JOIN (
             SELECT tag_id, COUNT(*) AS cnt FROM block_tags GROUP BY tag_id
         ) t ON t.tag_id = b.id
         WHERE b.block_type = 'tag' AND b.deleted_at IS NULL",
    )
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_pages_cache (p1-t19)
// ---------------------------------------------------------------------------

/// Full recompute of `pages_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` where
/// `block_type = 'page'` and not soft-deleted.
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO pages_cache (page_id, title, updated_at)
         SELECT id, content, ?
         FROM blocks
         WHERE block_type = 'page' AND deleted_at IS NULL",
    )
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_agenda_cache (p1-t20)
// ---------------------------------------------------------------------------

/// Full recompute of `agenda_cache`.
///
/// Two data sources:
/// 1. `block_properties` rows with a non-null `value_date` -> source = `property:<key>`
/// 2. `block_tags` referencing tag blocks whose name matches `date/YYYY-MM-DD`
///    (exactly 15 chars) -> source = `tag:<tag_id>`
pub async fn rebuild_agenda_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM agenda_cache")
        .execute(&mut *tx)
        .await?;

    // Source 1: date properties
    // OR IGNORE: the PK is (date, block_id), so a block with multiple date
    // properties sharing the same date value would violate the constraint
    // without it — first-writer-wins is acceptable here.
    sqlx::query(
        "INSERT OR IGNORE INTO agenda_cache (date, block_id, source)
         SELECT bp.value_date, bp.block_id, 'property:' || bp.key
         FROM block_properties bp
         JOIN blocks b ON b.id = bp.block_id
         WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL",
    )
    .execute(&mut *tx)
    .await?;

    // Source 2: date-pattern tags
    sqlx::query(
        "INSERT OR IGNORE INTO agenda_cache (date, block_id, source)
         SELECT SUBSTR(t.content, 6), bt.block_id, 'tag:' || bt.tag_id
         FROM block_tags bt
         JOIN blocks t ON t.id = bt.tag_id
         JOIN blocks b ON b.id = bt.block_id
         WHERE t.block_type = 'tag'
           AND t.content LIKE 'date/%'
           AND LENGTH(t.content) = 15
           AND b.deleted_at IS NULL
           AND t.deleted_at IS NULL",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// reindex_block_links (p1-t21)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_links` for a single block.
///
/// 1. Reads the block's current `content`.
/// 2. Parses all `[[ULID]]` tokens via regex.
/// 3. Loads existing outbound links for this block.
/// 4. Diffs: deletes removed links, inserts added links.
pub async fn reindex_block_links(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    // 1. Get current content
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(block_id)
            .fetch_optional(pool)
            .await?;

    let content = match row {
        Some((Some(c),)) => c,
        // Block not found or deleted or content is NULL — remove all links
        _ => String::new(),
    };

    // 2. Parse [[ULID]] tokens
    let new_targets: HashSet<String> = ULID_LINK_RE
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links
    let existing_rows: Vec<(String,)> =
        sqlx::query_as("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(block_id)
            .fetch_all(pool)
            .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|(t,)| t).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await?;

    for target in &to_delete {
        sqlx::query("DELETE FROM block_links WHERE source_id = ? AND target_id = ?")
            .bind(block_id)
            .bind(*target)
            .execute(&mut *tx)
            .await?;
    }

    for target in &to_insert {
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(*target)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    // -- helpers -----------------------------------------------------------

    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_block_with_parent(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: &str,
    ) {
        sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .bind(parent_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn soft_delete_block(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(Utc::now().to_rfc3339())
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: Option<&str>) {
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
        )
        .bind(block_id)
        .bind(key)
        .bind(value_date)
        .execute(pool)
        .await
        .unwrap();
    }

    // ======================================================================
    // tags_cache tests
    // ======================================================================

    #[tokio::test]
    async fn tags_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        // Create two tag blocks
        insert_block(&pool, "TAG01", "tag", "urgent").await;
        insert_block(&pool, "TAG02", "tag", "low-priority").await;

        // Create a content block and tag it with TAG01
        insert_block(&pool, "BLK01", "content", "some note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache(&pool).await.unwrap();

        // Verify cache contents
        let rows: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 2);
        // low-priority has zero usage
        assert_eq!(rows[0], ("TAG02".into(), "low-priority".into(), 0));
        // urgent has 1 usage
        assert_eq!(rows[1], ("TAG01".into(), "urgent".into(), 1));
    }

    #[tokio::test]
    async fn tags_cache_excludes_deleted_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "active").await;
        insert_block(&pool, "TAG02", "tag", "deleted-tag").await;
        soft_delete_block(&pool, "TAG02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn tags_cache_includes_zero_usage_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "unused-tag").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT tag_id, usage_count FROM tags_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], ("TAG01".into(), 0));
    }

    #[tokio::test]
    async fn tags_cache_full_recompute_clears_stale() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "first").await;
        rebuild_tags_cache(&pool).await.unwrap();

        // Delete the tag and rebuild — cache should be empty
        soft_delete_block(&pool, "TAG01").await;
        rebuild_tags_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    // ======================================================================
    // pages_cache tests
    // ======================================================================

    #[tokio::test]
    async fn pages_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "My First Page").await;
        insert_block(&pool, "PAGE02", "page", "My Second Page").await;
        // Non-page block should not appear
        insert_block(&pool, "BLK01", "content", "just content").await;

        rebuild_pages_cache(&pool).await.unwrap();

        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY title")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("PAGE01".into(), "My First Page".into()));
        assert_eq!(rows[1], ("PAGE02".into(), "My Second Page".into()));
    }

    #[tokio::test]
    async fn pages_cache_excludes_deleted_pages() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Active Page").await;
        insert_block(&pool, "PAGE02", "page", "Deleted Page").await;
        soft_delete_block(&pool, "PAGE02").await;

        rebuild_pages_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn pages_cache_full_recompute_clears_stale() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Will be deleted").await;
        rebuild_pages_cache(&pool).await.unwrap();

        soft_delete_block(&pool, "PAGE01").await;
        rebuild_pages_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    // ======================================================================
    // agenda_cache tests
    // ======================================================================

    #[tokio::test]
    async fn agenda_cache_from_date_properties() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task with due date").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT date, block_id, source FROM agenda_cache")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "2025-01-15");
        assert_eq!(rows[0].1, "BLK01");
        assert_eq!(rows[0].2, "property:due");
    }

    #[tokio::test]
    async fn agenda_cache_from_date_tags() {
        let (pool, _dir) = test_pool().await;

        // Create a date-pattern tag
        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        // Create a content block and tag it
        insert_block(&pool, "BLK01", "content", "meeting notes").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT date, block_id, source FROM agenda_cache")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "2025-03-20");
        assert_eq!(rows[0].1, "BLK01");
        assert_eq!(rows[0].2, "tag:DTAG1");
    }

    #[tokio::test]
    async fn agenda_cache_both_sources() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task").await;
        // Property source
        set_property(&pool, "BLK01", "deadline", Some("2025-06-01")).await;
        // Tag source
        insert_block(&pool, "DTAG1", "tag", "date/2025-06-01").await;
        insert_block(&pool, "BLK02", "content", "event").await;
        add_tag(&pool, "BLK02", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2);
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "deleted task").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;
        soft_delete_block(&pool, "BLK01").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn agenda_cache_ignores_non_date_tags() {
        let (pool, _dir) = test_pool().await;

        // Tag that looks like date but is too short
        insert_block(&pool, "TAG01", "tag", "date/short").await;
        // Tag that has wrong prefix
        insert_block(&pool, "TAG02", "tag", "notdate/2025-01-01").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;
        add_tag(&pool, "BLK01", "TAG02").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting").await;
        add_tag(&pool, "BLK01", "DTAG1").await;
        // Soft-delete the tag
        soft_delete_block(&pool, "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn agenda_cache_multiple_date_props_same_date() {
        let (pool, _dir) = test_pool().await;

        // Block with two date properties that share the same date value.
        // PK is (date, block_id), so only one row should survive via OR IGNORE.
        insert_block(&pool, "BLK01", "content", "busy day").await;
        set_property(&pool, "BLK01", "due", Some("2025-06-01")).await;
        set_property(&pool, "BLK01", "scheduled", Some("2025-06-01")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        // Only 1 row because PK is (date, block_id) — OR IGNORE drops the dup
        assert_eq!(count.0, 1);
    }

    // ======================================================================
    // block_links tests
    // ======================================================================

    #[tokio::test]
    async fn block_links_basic_reindex() {
        let (pool, _dir) = test_pool().await;

        // Need target blocks to exist for FK constraints
        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;

        // Source block references both targets
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "See [[01HZ00000000000000000000AB]] and [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        )
        .bind("01HZ0000000000000000000SRC")
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].0, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_diff_add_and_remove() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(&pool, "01HZ00000000000000000000EF", "content", "target C").await;

        // Initial content references A and B
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        // Verify initial state
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2);

        // Update content: remove B, add C
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind("[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000EF]]")
            .bind("01HZ0000000000000000000SRC")
            .execute(&pool)
            .await
            .unwrap();

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        )
        .bind("01HZ0000000000000000000SRC")
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "01HZ00000000000000000000AB"); // kept
        assert_eq!(rows[1].0, "01HZ00000000000000000000EF"); // added
    }

    #[tokio::test]
    async fn block_links_deleted_block_clears_links() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);

        // Soft-delete the source block
        soft_delete_block(&pool, "01HZ0000000000000000000SRC").await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn block_links_no_links_in_content() {
        let (pool, _dir) = test_pool().await;

        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "plain text with no links",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn block_links_nonexistent_block() {
        let (pool, _dir) = test_pool().await;

        // Reindexing a block that doesn't exist should succeed (no-op)
        reindex_block_links(&pool, "NONEXISTENT0000000000000000")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("NONEXISTENT0000000000000000")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn block_links_duplicate_refs_deduplicated() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        // Same ULID referenced twice in content
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]] and again [[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        // Should be 1, not 2 — deduplicated by HashSet
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn block_links_noop_when_unchanged() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        // Call again with same content — should be a no-op
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("01HZ0000000000000000000SRC")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }
}
