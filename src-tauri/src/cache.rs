//! Cache materializer functions (ADR-08).
//!
//! Full-recompute rebuilds for the three read-path caches (`tags_cache`,
//! `pages_cache`, `agenda_cache`) and incremental diff-based reindexing of
//! `block_links`.
//!
//! Every function takes a shared `&SqlitePool` reference and wraps its
//! DELETE + INSERT cycle in a transaction for atomicity.
//!
//! **Phase 2 optimisation (not yet implemented):** the three `rebuild_*`
//! functions currently do a full DELETE + INSERT on every call.  For large
//! datasets an incremental diff approach (similar to `reindex_block_links`)
//! would reduce write amplification.

#![allow(dead_code)]

use chrono::Utc;
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Regex for [[ULID]] tokens
// ---------------------------------------------------------------------------
//
// ULIDs are encoded in Crockford base-32: exactly 26 uppercase alphanumeric
// characters (digits 0-9 and letters A-Z).  The regex captures the inner
// ULID from wiki-style `[[ULID]]` link tokens.
//
// Lowercase characters are intentionally excluded — ULIDs are always
// uppercase in canonical form.

static ULID_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([0-9A-Z]{26})\]\]").expect("invalid ULID link regex"));

/// Returns a reference to the lazily-compiled ULID-link regex.
#[inline]
fn ulid_link_re() -> &'static Regex {
    &ULID_LINK_RE
}

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
        "INSERT OR IGNORE INTO tags_cache (tag_id, name, usage_count, updated_at)
         SELECT b.id, b.content, COALESCE(t.cnt, 0), ?
         FROM blocks b
         LEFT JOIN (
             SELECT bt.tag_id, COUNT(*) AS cnt
             FROM block_tags bt
             JOIN blocks blk ON blk.id = bt.block_id
             WHERE blk.deleted_at IS NULL
             GROUP BY bt.tag_id
         ) t ON t.tag_id = b.id
         WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL
           AND b.is_conflict = 0
         ORDER BY b.id",
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
         WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL
           AND is_conflict = 0",
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

    // Both sources combined in a single INSERT via UNION ALL to reduce
    // round-trips.  Properties appear first so they win on PK conflicts
    // (INSERT OR IGNORE keeps the first row for a given (date, block_id)).
    sqlx::query(
        "INSERT OR IGNORE INTO agenda_cache (date, block_id, source)
         SELECT bp.value_date, bp.block_id, 'property:' || bp.key
         FROM block_properties bp
         JOIN blocks b ON b.id = bp.block_id
         WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
           AND b.is_conflict = 0
         UNION ALL
         SELECT SUBSTR(t.content, 6), bt.block_id, 'tag:' || bt.tag_id
         FROM block_tags bt
         JOIN blocks t ON t.id = bt.tag_id
         JOIN blocks b ON b.id = bt.block_id
         WHERE t.block_type = 'tag'
           AND t.content LIKE 'date/%'
           AND LENGTH(t.content) = 15
           AND b.deleted_at IS NULL
           AND t.deleted_at IS NULL
           AND b.is_conflict = 0",
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
/// 1. Opens a transaction for a consistent read snapshot.
/// 2. Reads the block's current `content` and its existing outbound links.
/// 3. Parses all `[[ULID]]` tokens via regex.
/// 4. Diffs: deletes removed links, inserts added links within the same tx.
pub async fn reindex_block_links(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // 1. Get current content (combined with step 2 in the same tx to avoid
    //    an extra connection round-trip).
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(block_id)
            .fetch_optional(&mut *tx)
            .await?;

    let content = match row {
        Some((Some(c),)) => c,
        // Block not found or deleted or content is NULL — remove all links
        _ => String::new(),
    };

    // 2. Parse [[ULID]] tokens
    let new_targets: HashSet<String> = ulid_link_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links (same tx — consistent snapshot)
    let existing_rows: Vec<(String,)> =
        sqlx::query_as("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(block_id)
            .fetch_all(&mut *tx)
            .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|(t,)| t).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — transaction is rolled back on drop (no commit needed).
        return Ok(());
    }

    for target in &to_delete {
        sqlx::query("DELETE FROM block_links WHERE source_id = ? AND target_id = ?")
            .bind(block_id)
            .bind(*target)
            .execute(&mut *tx)
            .await?;
    }

    for target in &to_insert {
        // Use INSERT ... SELECT ... WHERE EXISTS to skip targets that don't
        // exist in the blocks table. INSERT OR IGNORE does NOT suppress FK
        // violations in SQLite — only PK/UNIQUE/NOT NULL/CHECK conflicts.
        sqlx::query(
            "INSERT OR IGNORE INTO block_links (source_id, target_id) \
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
        )
        .bind(block_id)
        .bind(*target)
        .bind(*target)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_all_caches — convenience wrapper
// ---------------------------------------------------------------------------

/// Rebuilds all three read-path caches in sequence.
///
/// Calls [`rebuild_tags_cache`], [`rebuild_pages_cache`], and
/// [`rebuild_agenda_cache`].  Each runs in its own transaction so a failure
/// in a later cache does not roll back earlier ones.
///
/// Note: `reindex_block_links` is *not* included because it operates on a
/// single block and is called per-block during materialisation.
pub async fn rebuild_all_caches(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_tags_cache(pool).await?;
    rebuild_pages_cache(pool).await?;
    rebuild_agenda_cache(pool).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for cache materializer functions — tags, pages, agenda, and block
    //! links.  Covers basic rebuilds, exclusion filters (deleted, conflict, NULL
    //! content), idempotency, boundary conditions on date-tag length, and the
    //! incremental diff logic in `reindex_block_links`.

    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Deterministic test fixtures ─────────────────────────────────────

    const FIXED_DELETED_AT: &str = "2025-01-15T12:00:00+00:00";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block with the given type and content.
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a block with NULL content (content column omitted).
    async fn insert_block_null_content(pool: &SqlitePool, id: &str, block_type: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type) VALUES (?, ?)")
            .bind(id)
            .bind(block_type)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Soft-delete a block using a fixed, deterministic timestamp.
    async fn soft_delete_block(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Mark a block as a conflict (is_conflict = 1).
    async fn mark_conflict(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Associate a block with a tag via `block_tags`.
    async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Set a date property on a block.
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

    /// Count rows in a table (test-only convenience).
    async fn count_rows(pool: &SqlitePool, table: &str) -> i64 {
        let query = format!("SELECT COUNT(*) FROM {table}");
        let (count,): (i64,) = sqlx::query_as(&query).fetch_one(pool).await.unwrap();
        count
    }

    // ====================================================================
    // tags_cache
    // ====================================================================

    #[tokio::test]
    async fn tags_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "urgent").await;
        insert_block(&pool, "TAG02", "tag", "low-priority").await;
        insert_block(&pool, "BLK01", "content", "some note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let rows: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 2, "both tags must appear in cache");
        assert_eq!(
            rows[0],
            ("TAG02".into(), "low-priority".into(), 0),
            "unused tag must have count 0"
        );
        assert_eq!(
            rows[1],
            ("TAG01".into(), "urgent".into(), 1),
            "tagged-once tag must have count 1"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_deleted_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "active").await;
        insert_block(&pool, "TAG02", "tag", "deleted-tag").await;
        soft_delete_block(&pool, "TAG02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "soft-deleted tag must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_conflict_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "normal").await;
        insert_block(&pool, "TAG02", "tag", "conflict").await;
        mark_conflict(&pool, "TAG02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "conflict tag (is_conflict = 1) must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_null_content_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "has-content").await;
        insert_block_null_content(&pool, "TAG02", "tag").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "NULL-content tag must be excluded"
        );
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
        assert_eq!(
            rows[0],
            ("TAG01".into(), 0),
            "unused tag must appear with count 0"
        );
    }

    #[tokio::test]
    async fn tags_cache_full_recompute_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "first").await;
        rebuild_tags_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "tags_cache").await, 1);

        soft_delete_block(&pool, "TAG01").await;
        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn tags_cache_aggregates_high_usage_count() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "HTAG", "tag", "popular").await;

        for i in 0..5 {
            let blk = format!("HB{i:04}");
            insert_block(&pool, &blk, "content", &format!("note {i}")).await;
            add_tag(&pool, &blk, "HTAG").await;
        }

        rebuild_tags_cache(&pool).await.unwrap();

        let row: (i64,) =
            sqlx::query_as("SELECT usage_count FROM tags_cache WHERE tag_id = 'HTAG'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, 5, "usage count must aggregate all tagged blocks");
    }

    #[tokio::test]
    async fn tags_cache_rebuild_is_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "alpha").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache(&pool).await.unwrap();
        let first: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        rebuild_tags_cache(&pool).await.unwrap();
        let second: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(
            first, second,
            "consecutive rebuilds must produce identical results"
        );
    }

    // ====================================================================
    // pages_cache
    // ====================================================================

    #[tokio::test]
    async fn pages_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "My First Page").await;
        insert_block(&pool, "PAGE02", "page", "My Second Page").await;
        insert_block(&pool, "BLK01", "content", "just content").await;

        rebuild_pages_cache(&pool).await.unwrap();

        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY title")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 2, "only page-type blocks must appear");
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

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "soft-deleted page must be excluded"
        );
    }

    #[tokio::test]
    async fn pages_cache_full_recompute_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Will be deleted").await;
        rebuild_pages_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "pages_cache").await, 1);

        soft_delete_block(&pool, "PAGE01").await;
        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn pages_cache_excludes_null_content() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Real Page").await;
        insert_block_null_content(&pool, "PAGE02", "page").await;

        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "NULL-content page must be excluded"
        );
    }

    #[tokio::test]
    async fn pages_cache_rebuild_is_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Stable Page").await;

        rebuild_pages_cache(&pool).await.unwrap();
        let first: Vec<(String, String)> =
            sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY page_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        rebuild_pages_cache(&pool).await.unwrap();
        let second: Vec<(String, String)> =
            sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY page_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(
            first, second,
            "consecutive rebuilds must produce identical results"
        );
    }

    // ====================================================================
    // agenda_cache
    // ====================================================================

    #[tokio::test]
    async fn agenda_cache_populates_from_date_properties() {
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
        assert_eq!(rows[0].0, "2025-01-15", "date must match property value");
        assert_eq!(rows[0].1, "BLK01");
        assert_eq!(rows[0].2, "property:due", "source must be property:<key>");
    }

    #[tokio::test]
    async fn agenda_cache_populates_from_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting notes").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT date, block_id, source FROM agenda_cache")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].0, "2025-03-20",
            "date must be extracted from tag content"
        );
        assert_eq!(rows[0].1, "BLK01");
        assert_eq!(rows[0].2, "tag:DTAG1", "source must be tag:<tag_id>");
    }

    #[tokio::test]
    async fn agenda_cache_combines_property_and_tag_sources() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task").await;
        set_property(&pool, "BLK01", "deadline", Some("2025-06-01")).await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-06-01").await;
        insert_block(&pool, "BLK02", "content", "event").await;
        add_tag(&pool, "BLK02", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            2,
            "both property and tag sources must be included"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "deleted task").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;
        soft_delete_block(&pool, "BLK01").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "soft-deleted block must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting").await;
        add_tag(&pool, "BLK01", "DTAG1").await;
        soft_delete_block(&pool, "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "deleted date-tag must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_ignores_non_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "date/short").await;
        insert_block(&pool, "TAG02", "tag", "notdate/2025-01-01").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;
        add_tag(&pool, "BLK01", "TAG02").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "tags not matching date/YYYY-MM-DD (15 chars) must be ignored"
        );
    }

    #[tokio::test]
    async fn agenda_cache_deduplicates_same_date_block_pair() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "busy day").await;
        set_property(&pool, "BLK01", "due", Some("2025-06-01")).await;
        set_property(&pool, "BLK01", "scheduled", Some("2025-06-01")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "PK (date, block_id) must deduplicate via OR IGNORE"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_exactly_15_chars() {
        let (pool, _dir) = test_pool().await;

        let exact = "date/2025-03-20"; // 15 chars
        assert_eq!(exact.len(), 15);

        insert_block(&pool, "DTAG1", "tag", exact).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "exactly 15-char date tag must match"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_14_chars_excluded() {
        let (pool, _dir) = test_pool().await;

        let short = "date/2025-3-20"; // 14 chars
        assert_eq!(short.len(), 14);

        insert_block(&pool, "DTAG1", "tag", short).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "14-char date tag must NOT match"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_16_chars_excluded() {
        let (pool, _dir) = test_pool().await;

        let long = "date/2025-03-20X"; // 16 chars
        assert_eq!(long.len(), 16);

        insert_block(&pool, "DTAG1", "tag", long).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "16-char date tag must NOT match"
        );
    }

    // ====================================================================
    // block_links
    // ====================================================================

    #[tokio::test]
    async fn block_links_basic_reindex() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
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

        assert_eq!(rows.len(), 2, "both link targets must be indexed");
        assert_eq!(rows[0].0, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].0, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_incremental_diff_adds_and_removes() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(&pool, "01HZ00000000000000000000EF", "content", "target C").await;

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
        assert_eq!(count_rows(&pool, "block_links").await, 2, "initial: A + B");

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

        assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
        assert_eq!(rows[0].0, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].0, "01HZ00000000000000000000EF");
    }

    #[tokio::test]
    async fn block_links_deleted_source_clears_all_links() {
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
        assert_eq!(count_rows(&pool, "block_links").await, 1);

        soft_delete_block(&pool, "01HZ0000000000000000000SRC").await;
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "all links must be removed when source is soft-deleted"
        );
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

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "no links must be created for plain text"
        );
    }

    #[tokio::test]
    async fn block_links_nonexistent_source_is_noop() {
        let (pool, _dir) = test_pool().await;

        reindex_block_links(&pool, "NONEXISTENT0000000000000000")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "reindexing nonexistent block must not create links"
        );
    }

    #[tokio::test]
    async fn block_links_deduplicates_repeated_references() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
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

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "duplicate references must be deduplicated by HashSet"
        );
    }

    #[tokio::test]
    async fn block_links_noop_when_content_unchanged() {
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

        // Second call with same content — no-op (early return)
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "idempotent reindex must not duplicate links"
        );
    }

    #[tokio::test]
    async fn block_links_ignores_lowercase_ulids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01hz00000000000000000000ab]]", // lowercase — must not match
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "lowercase ULIDs must not be matched by the regex"
        );
    }

    #[tokio::test]
    async fn block_links_ignores_malformed_ulid_lengths() {
        let (pool, _dir) = test_pool().await;

        // 10-char (too short) and 28-char (too long) must not match
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "short: [[ABCDEFGHIJ]] long: [[01HZ00000000000000000000ABCD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "malformed ULIDs (wrong length) must not be matched"
        );
    }

    #[tokio::test]
    async fn block_links_parses_adjacent_links() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "B").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]][[01HZ00000000000000000000CD]]",
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

        assert_eq!(rows.len(), 2, "adjacent links must both be parsed");
        assert_eq!(rows[0].0, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].0, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_extracts_links_inside_code_fences() {
        let (pool, _dir) = test_pool().await;

        // The regex is context-unaware by design — links inside code fences
        // are still extracted and indexed.
        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "```\n[[01HZ00000000000000000000AB]]\n```",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "regex is context-unaware — code fence links are extracted"
        );
    }

    // ====================================================================
    // rebuild_all_caches & empty tables
    // ====================================================================

    #[tokio::test]
    async fn rebuild_all_succeeds_on_empty_tables() {
        let (pool, _dir) = test_pool().await;

        rebuild_tags_cache(&pool).await.unwrap();
        rebuild_pages_cache(&pool).await.unwrap();
        rebuild_agenda_cache(&pool).await.unwrap();
        reindex_block_links(&pool, "DOESNOTEXIST00000000000000")
            .await
            .unwrap();

        assert_eq!(count_rows(&pool, "tags_cache").await, 0);
        assert_eq!(count_rows(&pool, "pages_cache").await, 0);
        assert_eq!(count_rows(&pool, "agenda_cache").await, 0);
        assert_eq!(count_rows(&pool, "block_links").await, 0);
    }

    #[tokio::test]
    async fn rebuild_all_caches_populates_all_three() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "work").await;
        insert_block(&pool, "PAGE01", "page", "Home").await;
        insert_block(&pool, "BLK01", "content", "task").await;
        set_property(&pool, "BLK01", "due", Some("2025-07-01")).await;

        rebuild_all_caches(&pool).await.unwrap();

        assert_eq!(count_rows(&pool, "tags_cache").await, 1, "tags populated");
        assert_eq!(count_rows(&pool, "pages_cache").await, 1, "pages populated");
        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "agenda populated"
        );
    }

    // ====================================================================
    // Audit findings: F03, F04, F05, F23
    // ====================================================================

    #[tokio::test]
    async fn tags_cache_usage_excludes_deleted_tagged_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "popular").await;
        insert_block(&pool, "BLK01", "content", "alive note").await;
        insert_block(&pool, "BLK02", "content", "deleted note").await;
        add_tag(&pool, "BLK01", "TAG01").await;
        add_tag(&pool, "BLK02", "TAG01").await;
        soft_delete_block(&pool, "BLK02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let row: (i64,) =
            sqlx::query_as("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG01'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            row.0, 1,
            "usage_count should exclude soft-deleted tagged blocks"
        );
    }

    #[tokio::test]
    async fn tags_cache_handles_duplicate_tag_names() {
        let (pool, _dir) = test_pool().await;

        // Two tag blocks with the same content (name). INSERT OR IGNORE
        // should keep the first and skip the duplicate.
        insert_block(&pool, "TAG01", "tag", "duplicate-name").await;
        insert_block(&pool, "TAG02", "tag", "duplicate-name").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let count = count_rows(&pool, "tags_cache").await;
        assert_eq!(
            count, 1,
            "INSERT OR IGNORE should handle duplicate tag names"
        );
    }

    #[tokio::test]
    async fn pages_cache_excludes_conflict_pages() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Normal Page").await;
        insert_block(&pool, "PAGE02", "page", "Conflict Page").await;
        mark_conflict(&pool, "PAGE02").await;

        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "conflict page (is_conflict = 1) must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_conflict_blocks_property_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "conflict task").await;
        mark_conflict(&pool, "BLK01").await;
        set_property(&pool, "BLK01", "due", Some("2025-06-01")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "conflict block must be excluded from agenda (property source)"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_conflict_blocks_tag_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-06-01").await;
        insert_block(&pool, "BLK01", "content", "conflict event").await;
        mark_conflict(&pool, "BLK01").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "conflict block must be excluded from agenda (tag source)"
        );
    }
}
