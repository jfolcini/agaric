//! Tests for cache materializer functions — tags, pages, agenda, and block
//! links.  Covers basic rebuilds, exclusion filters (deleted, conflict, NULL
//! content), idempotency, boundary conditions on date-tag length, and the
//! incremental diff logic in `reindex_block_links`.

use super::*;
use crate::db::init_pool;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// -- Deterministic test fixtures ------------------------------------------

const FIXED_DELETED_AT: &str = "2025-01-15T12:00:00+00:00";

// -- Helpers --------------------------------------------------------------

/// Create a fresh SQLite pool with migrations applied (temp directory).
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a block with the given type and content.
async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
        id,
        block_type,
        content,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a block with NULL content (content column omitted).
async fn insert_block_null_content(pool: &SqlitePool, id: &str, block_type: &str) {
    sqlx::query!(
        "INSERT INTO blocks (id, block_type) VALUES (?, ?)",
        id,
        block_type,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Soft-delete a block using a fixed, deterministic timestamp.
async fn soft_delete_block(pool: &SqlitePool, id: &str) {
    sqlx::query!(
        "UPDATE blocks SET deleted_at = ? WHERE id = ?",
        FIXED_DELETED_AT,
        id,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Mark a block as a conflict (is_conflict = 1).
async fn mark_conflict(pool: &SqlitePool, id: &str) {
    sqlx::query!("UPDATE blocks SET is_conflict = 1 WHERE id = ?", id)
        .execute(pool)
        .await
        .unwrap();
}

/// Associate a block with a tag via `block_tags`.
async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query!(
        "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        block_id,
        tag_id,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Set a date property on a block.
async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: Option<&str>) {
    sqlx::query!(
        "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
        block_id,
        key,
        value_date,
    )
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

    let rows = sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(rows.len(), 2, "both tags must appear in cache");
    assert_eq!(
        (&rows[0].tag_id, rows[0].name.as_str(), rows[0].usage_count),
        (&"TAG02".to_string(), "low-priority", 0),
        "unused tag must have count 0"
    );
    assert_eq!(
        (&rows[1].tag_id, rows[1].name.as_str(), rows[1].usage_count),
        (&"TAG01".to_string(), "urgent", 1),
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

    let rows = sqlx::query!("SELECT tag_id, usage_count FROM tags_cache")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(rows.len(), 1, "exactly one tag should be in cache");
    assert_eq!(
        (&rows[0].tag_id, rows[0].usage_count),
        (&"TAG01".to_string(), 0),
        "unused tag must appear with count 0"
    );
}

#[tokio::test]
async fn tags_cache_full_recompute_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "first").await;
    rebuild_tags_cache(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        1,
        "baseline: one tag in cache before delete"
    );

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

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'HTAG'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 5,
        "usage count must aggregate all tagged blocks"
    );
}

#[tokio::test]
async fn tags_cache_rebuild_is_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "alpha").await;
    insert_block(&pool, "BLK01", "content", "note").await;
    add_tag(&pool, "BLK01", "TAG01").await;

    rebuild_tags_cache(&pool).await.unwrap();
    let first: Vec<_> =
        sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    rebuild_tags_cache(&pool).await.unwrap();
    let second: Vec<_> =
        sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        first.len(),
        second.len(),
        "consecutive rebuilds must produce identical results"
    );
    for (a, b) in first.iter().zip(second.iter()) {
        assert_eq!(a.tag_id, b.tag_id, "tag_id must be stable across rebuilds");
        assert_eq!(a.name, b.name, "tag name must be stable across rebuilds");
        assert_eq!(
            a.usage_count, b.usage_count,
            "usage_count must be stable across rebuilds"
        );
    }
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

    let rows = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY title")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(rows.len(), 2, "only page-type blocks must appear");
    assert_eq!(
        (rows[0].page_id.as_str(), rows[0].title.as_str()),
        ("PAGE01", "My First Page"),
        "first page must match expected id and title"
    );
    assert_eq!(
        (rows[1].page_id.as_str(), rows[1].title.as_str()),
        ("PAGE02", "My Second Page"),
        "second page must match expected id and title"
    );
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
    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        1,
        "baseline: one page in cache before delete"
    );

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
    let first: Vec<_> = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY page_id")
        .fetch_all(&pool)
        .await
        .unwrap();

    rebuild_pages_cache(&pool).await.unwrap();
    let second: Vec<_> = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY page_id")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        first.len(),
        second.len(),
        "consecutive rebuilds must produce identical results"
    );
    for (a, b) in first.iter().zip(second.iter()) {
        assert_eq!(
            a.page_id, b.page_id,
            "page_id must be stable across rebuilds"
        );
        assert_eq!(
            a.title, b.title,
            "page title must be stable across rebuilds"
        );
    }
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

    let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "exactly one agenda entry should exist from date property"
    );
    assert_eq!(
        rows[0].date.as_str(),
        "2025-01-15",
        "date must match property value"
    );
    assert_eq!(
        rows[0].block_id, "BLK01",
        "block_id must match source block"
    );
    assert_eq!(
        rows[0].source.as_str(),
        "property:due",
        "source must be property:<key>"
    );
}

#[tokio::test]
async fn agenda_cache_populates_from_date_tags() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
    insert_block(&pool, "BLK01", "content", "meeting notes").await;
    add_tag(&pool, "BLK01", "DTAG1").await;

    rebuild_agenda_cache(&pool).await.unwrap();

    let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "exactly one agenda entry should exist from date tag"
    );
    assert_eq!(
        rows[0].date.as_str(),
        "2025-03-20",
        "date must be extracted from tag content"
    );
    assert_eq!(
        rows[0].block_id, "BLK01",
        "block_id must match tagged block"
    );
    assert_eq!(
        rows[0].source.as_str(),
        "tag:DTAG1",
        "source must be tag:<tag_id>"
    );
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
    assert_eq!(
        exact.len(),
        15,
        "test precondition: exact date tag must be 15 chars"
    );

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
    assert_eq!(
        short.len(),
        14,
        "test precondition: short date tag must be 14 chars"
    );

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
    assert_eq!(
        long.len(),
        16,
        "test precondition: long date tag must be 16 chars"
    );

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

#[tokio::test]
async fn agenda_cache_non_date_15_char_string_excluded() {
    let (pool, _dir) = test_pool().await;

    // 15 chars but not a valid date pattern — e.g. "date/ABCDEFGHIJ"
    let fake = "date/ABCDEFGHIJ";
    assert_eq!(
        fake.len(),
        15,
        "test precondition: fake date tag must be 15 chars"
    );

    insert_block(&pool, "DTAG1", "tag", fake).await;
    insert_block(&pool, "BLK01", "content", "note").await;
    add_tag(&pool, "BLK01", "DTAG1").await;

    rebuild_agenda_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        0,
        "15-char non-date string must be excluded by GLOB validation"
    );
}

#[tokio::test]
async fn agenda_cache_date_tag_with_bad_separator_excluded() {
    let (pool, _dir) = test_pool().await;

    // 15 chars, starts with date/, but uses dots instead of dashes
    let bad_sep = "date/2025.03.20";
    assert_eq!(
        bad_sep.len(),
        15,
        "test precondition: bad-separator date tag must be 15 chars"
    );

    insert_block(&pool, "DTAG1", "tag", bad_sep).await;
    insert_block(&pool, "BLK01", "content", "note").await;
    add_tag(&pool, "BLK01", "DTAG1").await;

    rebuild_agenda_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        0,
        "date tag with bad separators must be excluded"
    );
}

// ====================================================================
// agenda_cache — incremental rebuild behaviour
// ====================================================================

#[tokio::test]
async fn rebuild_agenda_incremental_inserts_new_entries() {
    let (pool, _dir) = test_pool().await;

    // Establish baseline with one entry.
    insert_block(&pool, "BLK01", "content", "first task").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();
    assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

    // Add a second block with a due_date.
    insert_block(&pool, "BLK02", "content", "second task").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-09-15' WHERE id = 'BLK02'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        2,
        "incremental rebuild must insert the new entry"
    );

    // Verify both entries are present.
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT date, block_id FROM agenda_cache ORDER BY date")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows[0],
        ("2025-08-01".to_string(), "BLK01".to_string()),
        "first entry must be BLK01 on 2025-08-01"
    );
    assert_eq!(
        rows[1],
        ("2025-09-15".to_string(), "BLK02".to_string()),
        "second entry must be BLK02 on 2025-09-15"
    );
}

#[tokio::test]
async fn rebuild_agenda_incremental_removes_stale_entries() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK01", "content", "will be deleted").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();
    assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

    // Soft-delete the block — its cache entry becomes stale.
    soft_delete_block(&pool, "BLK01").await;

    rebuild_agenda_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        0,
        "incremental rebuild must delete the stale entry"
    );
}

#[tokio::test]
async fn rebuild_agenda_incremental_preserves_unchanged() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK01", "content", "stable task").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    // Record the rowid of the cached entry. A DELETE + re-INSERT would
    // allocate a new rowid; the incremental approach must keep it.
    let (original_rowid,): (i64,) = sqlx::query_as(
        "SELECT rowid FROM agenda_cache WHERE date = '2025-08-01' AND block_id = 'BLK01'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // Rebuild again with no changes to source data.
    rebuild_agenda_cache(&pool).await.unwrap();

    let (rowid_after,): (i64,) = sqlx::query_as(
        "SELECT rowid FROM agenda_cache WHERE date = '2025-08-01' AND block_id = 'BLK01'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        original_rowid, rowid_after,
        "unchanged entry must preserve its rowid (not deleted + re-inserted)"
    );
    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        1,
        "entry count must remain the same"
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

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2, "both link targets must be indexed");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "first target must be AB"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000CD",
        "second target must be CD"
    );
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
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000EF]]",
        "01HZ0000000000000000000SRC",
    )
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links(&pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "target A must be kept after diff"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000EF",
        "target C must be added after diff"
    );
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
    assert_eq!(
        count_rows(&pool, "block_links").await,
        1,
        "baseline: one link before soft-delete"
    );

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

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2, "adjacent links must both be parsed");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "first adjacent target must be AB"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000CD",
        "second adjacent target must be CD"
    );
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

    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        0,
        "tags_cache must be empty on empty tables"
    );
    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        0,
        "pages_cache must be empty on empty tables"
    );
    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        0,
        "agenda_cache must be empty on empty tables"
    );
    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "block_links must be empty on empty tables"
    );
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

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG01'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 1,
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

// ====================================================================
// reindex_block_links — dangling target and NULL-content edge cases
// ====================================================================

/// A block whose content references a `[[ULID]]` that does NOT exist in
/// the blocks table must not crash `reindex_block_links`. The INSERT uses
/// `WHERE EXISTS` to skip dangling references.
#[tokio::test]
async fn reindex_block_links_with_dangling_target_ulid() {
    let (pool, _dir) = test_pool().await;

    // Insert a source block whose content links to a ULID that has no
    // corresponding row in the blocks table.
    let nonexistent_ulid = "01HZ00000000000000NONEXIST";
    insert_block(
        &pool,
        "01HZ0000000000000000000SRC",
        "content",
        &format!("see [[{nonexistent_ulid}]] for details"),
    )
    .await;

    // Must not panic or return an error
    reindex_block_links(&pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    // No link row should be created because the target doesn't exist
    let count = count_rows(&pool, "block_links").await;
    assert_eq!(
        count, 0,
        "dangling [[ULID]] must not produce a block_links row (FK guard)"
    );
}

/// A block with NULL content must not crash `reindex_block_links`.
/// The function should treat NULL content as empty (no links to extract).
#[tokio::test]
async fn reindex_block_links_on_null_content_block() {
    let (pool, _dir) = test_pool().await;

    // Insert a block with NULL content
    insert_block_null_content(&pool, "01HZ0000000000000NULLCONT", "content").await;

    // Must not panic or return an error
    reindex_block_links(&pool, "01HZ0000000000000NULLCONT")
        .await
        .unwrap();

    // No links should be created
    let count = count_rows(&pool, "block_links").await;
    assert_eq!(
        count, 0,
        "NULL-content block must produce zero block_links rows"
    );
}

// ====================================================================
// agenda_cache — blocks.due_date column source
// ====================================================================

#[tokio::test]
async fn rebuild_agenda_cache_includes_due_date_from_blocks_column() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK_DUE1", "content", "has due date").await;

    // Set blocks.due_date directly via SQL UPDATE
    sqlx::query("UPDATE blocks SET due_date = '2026-06-15' WHERE id = 'BLK_DUE1'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    let rows =
        sqlx::query!("SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'BLK_DUE1'")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "agenda_cache should contain one entry for the block with due_date"
    );
    assert_eq!(rows[0].date, "2026-06-15", "date should match due_date");
    assert_eq!(
        rows[0].block_id, "BLK_DUE1",
        "block_id must match the due_date block"
    );
    assert_eq!(
        rows[0].source, "column:due_date",
        "source should be column:due_date"
    );
}

#[tokio::test]
async fn rebuild_agenda_cache_excludes_null_due_date_from_blocks_column() {
    let (pool, _dir) = test_pool().await;

    // Create a content block with NULL due_date (the default)
    insert_block(&pool, "BLK_NULL", "content", "no due date").await;

    rebuild_agenda_cache(&pool).await.unwrap();

    // Check that no agenda entry exists from the column:due_date source
    let rows = sqlx::query!(
        "SELECT COUNT(*) as cnt FROM agenda_cache WHERE block_id = 'BLK_NULL' AND source = 'column:due_date'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        rows.cnt, 0,
        "NULL due_date should NOT produce an agenda_cache entry from column:due_date"
    );
}

// ====================================================================
// agenda_cache — DONE blocks must still appear (B-50)
// ====================================================================

#[tokio::test]
async fn agenda_cache_includes_done_blocks_with_scheduled_date() {
    let (pool, _dir) = test_pool().await;

    // Create a block with scheduled_date and todo_state = DONE
    insert_block(&pool, "BLK_DONE", "content", "completed task").await;
    sqlx::query("UPDATE blocks SET scheduled_date = '2025-06-15', todo_state = 'DONE' WHERE id = 'BLK_DONE'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'BLK_DONE'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "DONE block with scheduled_date must be in agenda_cache"
    );
    assert_eq!(rows[0].0, "2025-06-15");
    assert_eq!(rows[0].2, "column:scheduled_date");
}

#[tokio::test]
async fn agenda_cache_includes_done_blocks_with_due_date() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK_DONE2", "content", "completed due task").await;
    sqlx::query(
        "UPDATE blocks SET due_date = '2025-06-15', todo_state = 'DONE' WHERE id = 'BLK_DONE2'",
    )
    .execute(&pool)
    .await
    .unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'BLK_DONE2'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "DONE block with due_date must be in agenda_cache"
    );
    assert_eq!(rows[0].0, "2025-06-15");
    assert_eq!(rows[0].2, "column:due_date");
}

#[tokio::test]
async fn projected_cache_excludes_done_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK_DONE3", "content", "done repeating task").await;
    sqlx::query("UPDATE blocks SET scheduled_date = '2025-06-15', todo_state = 'DONE' WHERE id = 'BLK_DONE3'")
        .execute(&pool)
        .await
        .unwrap();

    // Set a repeat rule so projected cache has something to compute
    set_property(&pool, "BLK_DONE3", "repeat", None).await;
    sqlx::query("UPDATE block_properties SET value_text = 'daily' WHERE block_id = 'BLK_DONE3' AND key = 'repeat'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count = count_rows(&pool, "projected_agenda_cache").await;
    assert_eq!(
        count, 0,
        "DONE block must be excluded from projected agenda cache"
    );
}

// ====================================================================
// reindex_block_links — ((ULID)) block references (F-4)
// ====================================================================

/// `((ULID))` block-reference tokens must be extracted and tracked in
/// `block_links` just like `[[ULID]]` page-link tokens.
#[tokio::test]
async fn reindex_block_links_tracks_block_refs() {
    let (pool, _dir) = test_pool().await;

    insert_block(
        &pool,
        "01HZ00000000000000000000AB",
        "content",
        "target block",
    )
    .await;
    insert_block(
        &pool,
        "01HZ0000000000000000000SRC",
        "content",
        "refer to ((01HZ00000000000000000000AB)) here",
    )
    .await;

    reindex_block_links(&pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 1, "(( )) block ref must be tracked");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "block ref target must match"
    );
}

/// Content containing both `[[ULID]]` page links and `((ULID))` block
/// references must produce one `block_links` row per distinct target.
#[tokio::test]
async fn reindex_block_links_tracks_both_link_types() {
    let (pool, _dir) = test_pool().await;

    insert_block(
        &pool,
        "01HZ00000000000000000000AB",
        "content",
        "page target",
    )
    .await;
    insert_block(
        &pool,
        "01HZ00000000000000000000CD",
        "content",
        "block target",
    )
    .await;
    insert_block(
        &pool,
        "01HZ0000000000000000000SRC",
        "content",
        "see [[01HZ00000000000000000000AB]] and ((01HZ00000000000000000000CD))",
    )
    .await;

    reindex_block_links(&pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        rows.len(),
        2,
        "both [[ ]] and (( )) targets must be tracked"
    );
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "page link target must be AB"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000CD",
        "block ref target must be CD"
    );
}

// ====================================================================
// _split variants — read/write pool separation
// ====================================================================

#[tokio::test]
async fn tags_cache_split_basic_rebuild() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "urgent").await;
    insert_block(&pool, "TAG02", "tag", "low-priority").await;
    insert_block(&pool, "BLK01", "content", "some note").await;
    add_tag(&pool, "BLK01", "TAG01").await;

    rebuild_tags_cache_split(&pool, &pool).await.unwrap();

    let rows = sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(rows.len(), 2, "both tags must appear in cache");
    assert_eq!(
        (&rows[0].tag_id, rows[0].name.as_str(), rows[0].usage_count),
        (&"TAG02".to_string(), "low-priority", 0),
        "unused tag must have count 0"
    );
    assert_eq!(
        (&rows[1].tag_id, rows[1].name.as_str(), rows[1].usage_count),
        (&"TAG01".to_string(), "urgent", 1),
        "tagged-once tag must have count 1"
    );
}

#[tokio::test]
async fn tags_cache_split_excludes_deleted_and_conflict() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "active").await;
    insert_block(&pool, "TAG02", "tag", "deleted-tag").await;
    insert_block(&pool, "TAG03", "tag", "conflict-tag").await;
    soft_delete_block(&pool, "TAG02").await;
    mark_conflict(&pool, "TAG03").await;

    rebuild_tags_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        1,
        "soft-deleted and conflict tags must be excluded"
    );
}

#[tokio::test]
async fn tags_cache_split_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "alpha").await;
    insert_block(&pool, "BLK01", "content", "note").await;
    add_tag(&pool, "BLK01", "TAG01").await;

    rebuild_tags_cache_split(&pool, &pool).await.unwrap();
    let first = count_rows(&pool, "tags_cache").await;

    rebuild_tags_cache_split(&pool, &pool).await.unwrap();
    let second = count_rows(&pool, "tags_cache").await;

    assert_eq!(first, second, "consecutive rebuilds must be idempotent");
}

#[tokio::test]
async fn tags_cache_split_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG01", "tag", "first").await;
    rebuild_tags_cache_split(&pool, &pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        1,
        "baseline: one tag in cache before delete"
    );

    soft_delete_block(&pool, "TAG01").await;
    rebuild_tags_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        0,
        "stale entry must be cleared after rebuild"
    );
}

#[tokio::test]
async fn pages_cache_split_basic_rebuild() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE01", "page", "My First Page").await;
    insert_block(&pool, "PAGE02", "page", "My Second Page").await;
    insert_block(&pool, "BLK01", "content", "just content").await;

    rebuild_pages_cache_split(&pool, &pool).await.unwrap();

    let rows = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY title")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(rows.len(), 2, "only page-type blocks must appear");
    assert_eq!(
        (rows[0].page_id.as_str(), rows[0].title.as_str()),
        ("PAGE01", "My First Page"),
        "first page must match expected id and title"
    );
    assert_eq!(
        (rows[1].page_id.as_str(), rows[1].title.as_str()),
        ("PAGE02", "My Second Page"),
        "second page must match expected id and title"
    );
}

#[tokio::test]
async fn pages_cache_split_excludes_deleted_and_conflict() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE01", "page", "Active Page").await;
    insert_block(&pool, "PAGE02", "page", "Deleted Page").await;
    insert_block(&pool, "PAGE03", "page", "Conflict Page").await;
    soft_delete_block(&pool, "PAGE02").await;
    mark_conflict(&pool, "PAGE03").await;

    rebuild_pages_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        1,
        "soft-deleted and conflict pages must be excluded"
    );
}

#[tokio::test]
async fn pages_cache_split_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE01", "page", "Stable Page").await;

    rebuild_pages_cache_split(&pool, &pool).await.unwrap();
    let first = count_rows(&pool, "pages_cache").await;

    rebuild_pages_cache_split(&pool, &pool).await.unwrap();
    let second = count_rows(&pool, "pages_cache").await;

    assert_eq!(first, second, "consecutive rebuilds must be idempotent");
}

#[tokio::test]
async fn pages_cache_split_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE01", "page", "Will be deleted").await;
    rebuild_pages_cache_split(&pool, &pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        1,
        "baseline: one page in cache before delete"
    );

    soft_delete_block(&pool, "PAGE01").await;
    rebuild_pages_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        0,
        "stale entry must be cleared after rebuild"
    );
}

#[tokio::test]
async fn agenda_cache_split_populates_from_date_properties() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK01", "content", "task with due date").await;
    set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;

    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

    let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "exactly one agenda entry should exist from date property"
    );
    assert_eq!(
        rows[0].date.as_str(),
        "2025-01-15",
        "split date must match property value"
    );
    assert_eq!(
        rows[0].block_id, "BLK01",
        "split block_id must match source block"
    );
    assert_eq!(
        rows[0].source.as_str(),
        "property:due",
        "split source must be property:due"
    );
}

#[tokio::test]
async fn agenda_cache_split_populates_from_date_tags() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
    insert_block(&pool, "BLK01", "content", "meeting notes").await;
    add_tag(&pool, "BLK01", "DTAG1").await;

    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

    let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "exactly one agenda entry should exist from date tag"
    );
    assert_eq!(
        rows[0].date.as_str(),
        "2025-03-20",
        "split date must be extracted from tag content"
    );
    assert_eq!(
        rows[0].block_id, "BLK01",
        "split block_id must match tagged block"
    );
    assert_eq!(
        rows[0].source.as_str(),
        "tag:DTAG1",
        "split source must be tag:DTAG1"
    );
}

#[tokio::test]
async fn agenda_cache_split_excludes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK01", "content", "deleted task").await;
    set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;
    soft_delete_block(&pool, "BLK01").await;

    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        0,
        "soft-deleted block must be excluded"
    );
}

#[tokio::test]
async fn agenda_cache_split_incremental_inserts_and_deletes() {
    let (pool, _dir) = test_pool().await;

    // Establish baseline with one entry.
    insert_block(&pool, "BLK01", "content", "first task").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();
    assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

    // Add a second block with a due_date.
    insert_block(&pool, "BLK02", "content", "second task").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-09-15' WHERE id = 'BLK02'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        2,
        "incremental rebuild must insert the new entry"
    );

    // Soft-delete the first block — its cache entry becomes stale.
    soft_delete_block(&pool, "BLK01").await;
    rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        1,
        "incremental rebuild must delete the stale entry"
    );
}

#[tokio::test]
async fn block_links_split_basic_reindex() {
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

    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2, "both link targets must be indexed");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "split first target must be AB"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000CD",
        "split second target must be CD"
    );
}

#[tokio::test]
async fn block_links_split_incremental_diff() {
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

    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();
    assert_eq!(count_rows(&pool, "block_links").await, 2, "initial: A + B");

    // Update content: remove B, add C
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000EF]]",
        "01HZ0000000000000000000SRC",
    )
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        "01HZ0000000000000000000SRC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
    assert_eq!(
        rows[0].target_id, "01HZ00000000000000000000AB",
        "split target A must be kept after diff"
    );
    assert_eq!(
        rows[1].target_id, "01HZ00000000000000000000EF",
        "split target C must be added after diff"
    );
}

#[tokio::test]
async fn block_links_split_deleted_source_clears_all() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
    insert_block(
        &pool,
        "01HZ0000000000000000000SRC",
        "content",
        "[[01HZ00000000000000000000AB]]",
    )
    .await;

    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();
    assert_eq!(
        count_rows(&pool, "block_links").await,
        1,
        "split baseline: one link before soft-delete"
    );

    soft_delete_block(&pool, "01HZ0000000000000000000SRC").await;
    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "all links must be removed when source is soft-deleted"
    );
}

#[tokio::test]
async fn block_links_split_nonexistent_source_is_noop() {
    let (pool, _dir) = test_pool().await;

    reindex_block_links_split(&pool, &pool, "NONEXISTENT0000000000000000")
        .await
        .unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "reindexing nonexistent block must not create links"
    );
}

#[tokio::test]
async fn block_links_split_dangling_target_skipped() {
    let (pool, _dir) = test_pool().await;

    let nonexistent_ulid = "01HZ00000000000000NONEXIST";
    insert_block(
        &pool,
        "01HZ0000000000000000000SRC",
        "content",
        &format!("see [[{nonexistent_ulid}]] for details"),
    )
    .await;

    reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
        .await
        .unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "dangling [[ULID]] must not produce a block_links row"
    );
}

// ====================================================================
// projected_agenda_cache (P-16) — CTE oracle test
// ====================================================================

/// Helper: insert a repeating block with a due_date and repeat property.
#[allow(clippy::too_many_arguments)] // test helper aggregating all repeat-related columns
async fn insert_repeating_block(
    pool: &SqlitePool,
    id: &str,
    due_date: &str,
    scheduled_date: Option<&str>,
    repeat_rule: &str,
    repeat_until: Option<&str>,
    repeat_count: Option<f64>,
    repeat_seq: Option<f64>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, due_date, scheduled_date) \
         VALUES (?1, 'content', 'repeating task', ?2, ?3)",
    )
    .bind(id)
    .bind(due_date)
    .bind(scheduled_date)
    .execute(pool)
    .await
    .unwrap();

    // repeat property
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?1, 'repeat', ?2)",
    )
    .bind(id)
    .bind(repeat_rule)
    .execute(pool)
    .await
    .unwrap();

    // repeat-until
    if let Some(until) = repeat_until {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?1, 'repeat-until', ?2)",
        )
        .bind(id)
        .bind(until)
        .execute(pool)
        .await
        .unwrap();
    }

    // repeat-count
    if let Some(count) = repeat_count {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?1, 'repeat-count', ?2)",
        )
        .bind(id)
        .bind(count)
        .execute(pool)
        .await
        .unwrap();
    }

    // repeat-seq
    if let Some(seq) = repeat_seq {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?1, 'repeat-seq', ?2)",
        )
        .bind(id)
        .bind(seq)
        .execute(pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn projected_agenda_cache_basic_rebuild() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = (today - chrono::Duration::days(3))
        .format("%Y-%m-%d")
        .to_string();

    // Weekly repeating task, due 3 days ago
    insert_repeating_block(&pool, "RPT01", &due, None, "weekly", None, None, None).await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count = count_rows(&pool, "projected_agenda_cache").await;
    assert!(
        count > 0,
        "projected cache must contain entries after rebuild (got {count})"
    );

    // All projected dates should be >= today and within 365 days
    let horizon = (today + chrono::Duration::days(365))
        .format("%Y-%m-%d")
        .to_string();
    let today_str = today.format("%Y-%m-%d").to_string();

    let invalid_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache \
         WHERE projected_date < ?1 OR projected_date > ?2",
    )
    .bind(&today_str)
    .bind(&horizon)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        invalid_count, 0,
        "all projected dates must be in [today, today+365]"
    );
}

#[tokio::test]
async fn projected_agenda_cache_respects_repeat_until() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();
    let until = (today + chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();

    insert_repeating_block(
        &pool,
        "RPT02",
        &due,
        None,
        "weekly",
        Some(&until),
        None,
        None,
    )
    .await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let past_until: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache \
         WHERE block_id = 'RPT02' AND projected_date > ?1",
    )
    .bind(&until)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        past_until, 0,
        "no projected dates should exceed repeat-until"
    );
}

#[tokio::test]
async fn projected_agenda_cache_respects_repeat_count() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    // Allow only 3 more occurrences (count=5, seq=2 -> remaining=3)
    insert_repeating_block(
        &pool,
        "RPT03",
        &due,
        None,
        "daily",
        None,
        Some(5.0),
        Some(2.0),
    )
    .await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'RPT03'")
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        count, 3,
        "should produce exactly 3 projected entries (5 count - 2 seq = 3 remaining)"
    );
}

#[tokio::test]
async fn projected_agenda_cache_excludes_done_blocks() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    insert_repeating_block(&pool, "RPT04", &due, None, "daily", None, None, None).await;

    // Mark as DONE
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = 'RPT04'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count = count_rows(&pool, "projected_agenda_cache").await;
    assert_eq!(count, 0, "DONE blocks must not generate projections");
}

#[tokio::test]
async fn projected_agenda_cache_idempotent_rebuild() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    insert_repeating_block(&pool, "RPT05", &due, None, "weekly", None, None, None).await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();
    let first_count = count_rows(&pool, "projected_agenda_cache").await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();
    let second_count = count_rows(&pool, "projected_agenda_cache").await;

    assert_eq!(
        first_count, second_count,
        "consecutive rebuilds must produce identical results"
    );
}

#[tokio::test]
async fn projected_agenda_cache_split_variant_matches_single_pool() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = (today - chrono::Duration::days(5))
        .format("%Y-%m-%d")
        .to_string();

    insert_repeating_block(&pool, "RPT06", &due, None, "daily", None, None, None).await;

    rebuild_projected_agenda_cache_split(&pool, &pool)
        .await
        .unwrap();

    let count = count_rows(&pool, "projected_agenda_cache").await;
    assert!(
        count > 0,
        "split variant must produce entries (got {count})"
    );
}

/// CTE oracle test: verifies that the cache produces identical entries
/// to the on-the-fly computation for the same date range.
#[tokio::test]
async fn projected_agenda_cache_oracle_matches_on_the_fly() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();

    // Create several repeating blocks with various rules
    let due1 = (today - chrono::Duration::days(10))
        .format("%Y-%m-%d")
        .to_string();
    let due2 = today.format("%Y-%m-%d").to_string();
    let due3 = (today + chrono::Duration::days(5))
        .format("%Y-%m-%d")
        .to_string();
    let sched3 = (today + chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();
    let until4 = (today + chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();

    // Block 1: weekly repeat, due in the past
    insert_repeating_block(&pool, "ORC01", &due1, None, "weekly", None, None, None).await;

    // Block 2: daily repeat, due today
    insert_repeating_block(&pool, "ORC02", &due2, None, "daily", None, None, None).await;

    // Block 3: monthly repeat with both due_date and scheduled_date
    insert_repeating_block(
        &pool,
        "ORC03",
        &due3,
        Some(&sched3),
        "monthly",
        None,
        None,
        None,
    )
    .await;

    // Block 4: 3d repeat with repeat-until
    insert_repeating_block(&pool, "ORC04", &due2, None, "3d", Some(&until4), None, None).await;

    // Block 5: daily repeat with count limit (5 remaining = 8 count - 3 seq)
    insert_repeating_block(
        &pool,
        "ORC05",
        &due2,
        None,
        "daily",
        None,
        Some(8.0),
        Some(3.0),
    )
    .await;

    // Block 6: .+weekly (from-completion mode) — due today, projects weekly from today
    insert_repeating_block(&pool, "ORC06", &due2, None, ".+weekly", None, None, None).await;

    // Block 7: ++monthly (catch-up mode) — due 30 days ago, catches up to next future occurrence
    let due7 = (today - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();
    insert_repeating_block(&pool, "ORC07", &due7, None, "++monthly", None, None, None).await;

    // Block 8: +5d (custom Nd) — due 2 days ago, projects every 5 days
    let due8 = (today - chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();
    insert_repeating_block(&pool, "ORC08", &due8, None, "+5d", None, None, None).await;

    // Block 9: +2w (custom Nw) — due today, projects every 14 days
    insert_repeating_block(&pool, "ORC09", &due2, None, "+2w", None, None, None).await;

    // Step 1: Rebuild the cache
    rebuild_projected_agenda_cache(&pool).await.unwrap();

    // Step 2: Query the cache for a 90-day window
    let start = today.format("%Y-%m-%d").to_string();
    let end_date = today + chrono::Duration::days(90);
    let end = end_date.format("%Y-%m-%d").to_string();

    let cached_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, projected_date, source FROM projected_agenda_cache \
         WHERE projected_date >= ?1 AND projected_date <= ?2 \
         ORDER BY projected_date, block_id, source",
    )
    .bind(&start)
    .bind(&end)
    .fetch_all(&pool)
    .await
    .unwrap();

    // Step 3: Compute on-the-fly for the same range
    let on_the_fly =
        crate::commands::list_projected_agenda_inner(&pool, start.clone(), end.clone(), Some(500))
            .await
            .unwrap();

    // Convert on-the-fly results to comparable tuples, sorted
    let mut on_the_fly_tuples: Vec<(String, String, String)> = on_the_fly
        .iter()
        .map(|e| {
            (
                e.block.id.clone(),
                e.projected_date.clone(),
                e.source.clone(),
            )
        })
        .collect();
    on_the_fly_tuples.sort();

    let mut cached_sorted = cached_rows.clone();
    cached_sorted.sort();

    // Step 4: Verify they produce identical entries
    assert_eq!(
        cached_sorted.len(),
        on_the_fly_tuples.len(),
        "cache ({}) and on-the-fly ({}) must produce the same number of entries",
        cached_sorted.len(),
        on_the_fly_tuples.len()
    );

    for (i, (cached, on_fly)) in cached_sorted
        .iter()
        .zip(on_the_fly_tuples.iter())
        .enumerate()
    {
        assert_eq!(
            cached, on_fly,
            "entry {i} differs: cache={cached:?} vs on-the-fly={on_fly:?}"
        );
    }
}

// ====================================================================
// projected_agenda_cache — error-path tests
// ====================================================================

#[tokio::test]
async fn projected_cache_skips_malformed_repeat_rule() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    insert_repeating_block(
        &pool,
        "ERRRPT01",
        &due,
        None,
        "invalid_rule",
        None,
        None,
        None,
    )
    .await;

    // Must not panic
    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'ERRRPT01'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        count, 0,
        "malformed repeat rule must produce 0 projected entries"
    );
}

#[tokio::test]
async fn projected_cache_zero_repeat_count_produces_no_entries() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    // repeat-count = 0, repeat-seq = 0 -> remaining = 0
    insert_repeating_block(
        &pool,
        "ERRRPT02",
        &due,
        None,
        "daily",
        None,
        Some(0.0),
        Some(0.0),
    )
    .await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'ERRRPT02'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        count, 0,
        "zero repeat-count must produce 0 projected entries"
    );
}

#[tokio::test]
async fn projected_cache_repeat_until_in_past_produces_no_entries() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();
    let yesterday = (today - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();

    insert_repeating_block(
        &pool,
        "ERRRPT03",
        &due,
        None,
        "daily",
        Some(&yesterday),
        None,
        None,
    )
    .await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'ERRRPT03'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        count, 0,
        "repeat-until in the past must produce 0 projected entries"
    );
}

#[tokio::test]
async fn projected_cache_done_blocks_excluded() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    insert_repeating_block(&pool, "ERRRPT04", &due, None, "daily", None, None, None).await;

    // Mark as DONE
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = 'ERRRPT04'")
        .execute(&pool)
        .await
        .unwrap();

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'ERRRPT04'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(count, 0, "DONE blocks must produce 0 projected entries");
}

// ====================================================================
// agenda_cache — source UPDATE path (T-12)
// ====================================================================

/// The incremental rebuild has an UPDATE path for when a `(date, block_id)`
/// PK exists in agenda_cache but the `source` value has changed. This test
/// verifies the UPDATE path is exercised (not just INSERT OR IGNORE).
#[tokio::test]
async fn agenda_cache_source_update_path() {
    let (pool, _dir) = test_pool().await;

    // Step 1: Insert a block with a due_date column (source = 'column:due_date')
    insert_block(&pool, "UPD_BLK", "content", "update test block").await;
    sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'UPD_BLK'")
        .execute(&pool)
        .await
        .unwrap();

    // Step 2: Trigger agenda cache rebuild → creates entry with source = 'column:due_date'
    rebuild_agenda_cache(&pool).await.unwrap();

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'UPD_BLK'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "baseline: one agenda entry for UPD_BLK");
    assert_eq!(rows[0].0, "2025-08-01", "baseline date must be 2025-08-01");
    assert_eq!(
        rows[0].2, "column:due_date",
        "baseline source must be column:due_date"
    );

    // Step 3: Add a block_property with the SAME date. Properties appear
    // first in the UNION ALL query, so `property:scheduled` will win
    // deduplication (first-wins via .or_insert) over `column:due_date`.
    set_property(&pool, "UPD_BLK", "scheduled", Some("2025-08-01")).await;

    // Step 4: Trigger rebuild again → the PK (2025-08-01, UPD_BLK) already
    // exists but source should UPDATE from 'column:due_date' to 'property:scheduled'.
    rebuild_agenda_cache(&pool).await.unwrap();

    let rows_after: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'UPD_BLK'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    // PK deduplication means only 1 row for (2025-08-01, UPD_BLK)
    assert_eq!(
        rows_after.len(),
        1,
        "still exactly one entry for (2025-08-01, UPD_BLK) after source change"
    );
    assert_eq!(
        rows_after[0].2, "property:scheduled",
        "source must be UPDATED to property:scheduled (not stale column:due_date)"
    );
}

/// Verify the UPDATE path also works when source changes within the
/// same category (e.g., from one property key to another).
#[tokio::test]
async fn agenda_cache_source_update_property_key_change() {
    let (pool, _dir) = test_pool().await;

    // Block with a 'due' property
    insert_block(&pool, "UPD_BLK2", "content", "prop key change").await;
    set_property(&pool, "UPD_BLK2", "due", Some("2025-09-15")).await;

    rebuild_agenda_cache(&pool).await.unwrap();

    let source_before: String = sqlx::query_scalar(
        "SELECT source FROM agenda_cache WHERE block_id = 'UPD_BLK2' AND date = '2025-09-15'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        source_before, "property:due",
        "baseline source must be property:due"
    );

    // Remove the 'due' property and add 'deadline' for the same date.
    // Properties are ordered by UNION ALL position (properties first),
    // and within properties by insertion order. We delete 'due' and add
    // 'deadline' so that 'deadline' is the only property source.
    sqlx::query("DELETE FROM block_properties WHERE block_id = 'UPD_BLK2' AND key = 'due'")
        .execute(&pool)
        .await
        .unwrap();
    set_property(&pool, "UPD_BLK2", "deadline", Some("2025-09-15")).await;

    rebuild_agenda_cache(&pool).await.unwrap();

    let source_after: String = sqlx::query_scalar(
        "SELECT source FROM agenda_cache WHERE block_id = 'UPD_BLK2' AND date = '2025-09-15'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        source_after, "property:deadline",
        "source must be UPDATED from property:due to property:deadline"
    );

    // Still exactly one row
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agenda_cache WHERE block_id = 'UPD_BLK2' AND date = '2025-09-15'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "PK dedup: still exactly one row");
}

// ====================================================================
// UX-250 — block_tag_refs (inline #[ULID] tag reference cache)
// ====================================================================

// Helper: insert a bare row into block_tag_refs for tests that want to
// assert UNION semantics in rebuild_tags_cache / resolve_expr without
// round-tripping through the full reindex path.
async fn insert_tag_ref(pool: &SqlitePool, source_id: &str, tag_id: &str) {
    sqlx::query!(
        "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
        source_id,
        tag_id,
    )
    .execute(pool)
    .await
    .unwrap();
}

// Short helper for `#[ULID]` inline content — used throughout the
// block_tag_refs tests.
fn inline(tag_id: &str) -> String {
    format!("#[{tag_id}]")
}

#[tokio::test]
async fn reindex_block_tag_refs_zero_inline_tags() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "01HBTRBLK00000000000000SRC", "content", "plain text").await;
    reindex_block_tag_refs(&pool, "01HBTRBLK00000000000000SRC")
        .await
        .unwrap();
    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "no inline refs in content means no rows"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_single_inline_tag() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000AA";
    let src = "01HBTRBLK000000000000000AA";
    insert_block(&pool, tag, "tag", "alpha").await;
    insert_block(&pool, src, "content", &inline(tag)).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();

    let rows = sqlx::query!(
        "SELECT source_id, tag_id FROM block_tag_refs WHERE source_id = ?",
        src
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "single inline ref should produce one row");
    assert_eq!(rows[0].source_id, src);
    assert_eq!(rows[0].tag_id, tag);
}

#[tokio::test]
async fn reindex_block_tag_refs_many_inline_tags() {
    let (pool, _dir) = test_pool().await;
    let tag_a = "01HBTRTAG000000000000000BA";
    let tag_b = "01HBTRTAG000000000000000BB";
    let tag_c = "01HBTRTAG000000000000000BC";
    let src = "01HBTRBLK000000000000000BM";
    insert_block(&pool, tag_a, "tag", "a").await;
    insert_block(&pool, tag_b, "tag", "b").await;
    insert_block(&pool, tag_c, "tag", "c").await;
    let content = format!(
        "see {} and {} plus {} again {}",
        inline(tag_a),
        inline(tag_b),
        inline(tag_c),
        inline(tag_a), // duplicate — must dedup via HashSet + PK
    );
    insert_block(&pool, src, "content", &content).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        3,
        "three distinct inline tags must produce exactly three rows"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_skips_non_tag_candidates() {
    let (pool, _dir) = test_pool().await;
    // A content block (not a tag) that happens to match the regex.
    let content_id = "01HBTRCONT00000000000000AA";
    let page_id = "01HBTRPAGE00000000000000AA";
    let actual_tag = "01HBTRTAG000000000000000CA";
    let src = "01HBTRBLK000000000000000CA";

    insert_block(&pool, content_id, "content", "not a tag").await;
    insert_block(&pool, page_id, "page", "a page").await;
    insert_block(&pool, actual_tag, "tag", "real-tag").await;
    let content = format!(
        "{} {} {}",
        inline(content_id),
        inline(page_id),
        inline(actual_tag),
    );
    insert_block(&pool, src, "content", &content).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();

    let rows = sqlx::query!("SELECT tag_id FROM block_tag_refs WHERE source_id = ?", src)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "only the real tag block must be inserted; content / page candidates skipped"
    );
    assert_eq!(rows[0].tag_id, actual_tag);
}

#[tokio::test]
async fn reindex_block_tag_refs_skips_dangling_target() {
    let (pool, _dir) = test_pool().await;
    // The `#[ULID]` points at a block that does not exist.
    let src = "01HBTRBLK000000000000000DA";
    let dangling = "01HBTRDANG00000000000000AA";
    insert_block(&pool, src, "content", &inline(dangling)).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "dangling #[ULID] must not insert a row (target must be a tag block)"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_diff_adds_and_removes() {
    let (pool, _dir) = test_pool().await;
    let tag_a = "01HBTRTAG000000000000000EA";
    let tag_b = "01HBTRTAG000000000000000EB";
    let tag_c = "01HBTRTAG000000000000000EC";
    let src = "01HBTRBLK000000000000000EE";
    insert_block(&pool, tag_a, "tag", "a").await;
    insert_block(&pool, tag_b, "tag", "b").await;
    insert_block(&pool, tag_c, "tag", "c").await;
    insert_block(
        &pool,
        src,
        "content",
        &format!("{} {}", inline(tag_a), inline(tag_b)),
    )
    .await;

    reindex_block_tag_refs(&pool, src).await.unwrap();
    assert_eq!(count_rows(&pool, "block_tag_refs").await, 2, "initial: A+B");

    // Edit: drop B, add C.
    let new_content = format!("{} {}", inline(tag_a), inline(tag_c));
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        new_content,
        src,
    )
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_tag_refs(&pool, src).await.unwrap();

    let rows = sqlx::query!(
        "SELECT tag_id FROM block_tag_refs WHERE source_id = ? ORDER BY tag_id",
        src
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
    assert_eq!(rows[0].tag_id, tag_a);
    assert_eq!(rows[1].tag_id, tag_c);
}

#[tokio::test]
async fn reindex_block_tag_refs_soft_deleted_source_clears_rows() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000FA";
    let src = "01HBTRBLK000000000000000FA";
    insert_block(&pool, tag, "tag", "f").await;
    insert_block(&pool, src, "content", &inline(tag)).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();
    assert_eq!(count_rows(&pool, "block_tag_refs").await, 1, "baseline");

    soft_delete_block(&pool, src).await;
    reindex_block_tag_refs(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "reindex after soft-delete must clear every row for the source"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_skips_conflict_source() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000GA";
    let src = "01HBTRBLK000000000000000GA";
    insert_block(&pool, tag, "tag", "g").await;
    insert_block(&pool, src, "content", &inline(tag)).await;
    // Pre-seed a row so the post-reindex clear is observable.
    insert_tag_ref(&pool, src, tag).await;
    mark_conflict(&pool, src).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "reindex must treat is_conflict = 1 sources as empty (rows cleared)"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_noop_when_content_unchanged() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000HA";
    let src = "01HBTRBLK000000000000000HA";
    insert_block(&pool, tag, "tag", "h").await;
    insert_block(&pool, src, "content", &inline(tag)).await;

    reindex_block_tag_refs(&pool, src).await.unwrap();
    reindex_block_tag_refs(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        1,
        "second reindex with unchanged content must be a no-op"
    );
}

#[tokio::test]
async fn reindex_block_tag_refs_split_mirrors_single_pool() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000IA";
    let src = "01HBTRBLK000000000000000IA";
    insert_block(&pool, tag, "tag", "i").await;
    insert_block(&pool, src, "content", &inline(tag)).await;

    reindex_block_tag_refs_split(&pool, &pool, src)
        .await
        .unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        1,
        "split variant must produce identical rows"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_empty_db() {
    let (pool, _dir) = test_pool().await;
    rebuild_block_tag_refs_cache(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "empty DB produces empty cache"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_single_tag_vault() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000JA";
    insert_block(&pool, tag, "tag", "j").await;
    insert_block(&pool, "01HBTRBLK000000000000000JA", "content", &inline(tag)).await;
    insert_block(&pool, "01HBTRBLK000000000000000JB", "content", &inline(tag)).await;
    insert_block(
        &pool,
        "01HBTRBLK000000000000000JC",
        "content",
        "no inline ref here",
    )
    .await;

    rebuild_block_tag_refs_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        2,
        "two blocks reference the single tag inline"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_many_blocks_many_tags() {
    let (pool, _dir) = test_pool().await;
    let tag_a = "01HBTRTAG000000000000000KA";
    let tag_b = "01HBTRTAG000000000000000KB";
    insert_block(&pool, tag_a, "tag", "ka").await;
    insert_block(&pool, tag_b, "tag", "kb").await;

    // Three blocks: one refs A, one refs B, one refs both.
    insert_block(
        &pool,
        "01HBTRBLK000000000000000KA",
        "content",
        &inline(tag_a),
    )
    .await;
    insert_block(
        &pool,
        "01HBTRBLK000000000000000KB",
        "content",
        &inline(tag_b),
    )
    .await;
    insert_block(
        &pool,
        "01HBTRBLK000000000000000KM",
        "content",
        &format!("{} {}", inline(tag_a), inline(tag_b)),
    )
    .await;

    rebuild_block_tag_refs_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        4,
        "2 single-ref + 1 dual-ref block = 4 rows total"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_large_vault_exact_count() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000LA";
    insert_block(&pool, tag, "tag", "large").await;

    // Create 150 content blocks, each referencing the tag inline. Verify
    // exact count (tests chunked INSERT path since 150 > REBUILD_CHUNK
    // only at 499 — but still covers the loop). IDs must be exactly
    // 26 uppercase alphanumeric chars so the `#[ULID]` regex matches.
    for i in 0..150u64 {
        // "01HBTRLV" (8) + 18-digit zero-padded index = 26 chars.
        let id = format!("01HBTRLV{i:018}");
        assert_eq!(id.len(), 26, "generated test id must be 26 chars");
        insert_block(&pool, &id, "content", &inline(tag)).await;
    }

    rebuild_block_tag_refs_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        150,
        "every one of the 150 content blocks must produce exactly one row"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_excludes_deleted_and_conflict() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000MA";
    let alive = "01HBTRBLK000000000000000MA";
    let deleted = "01HBTRBLK000000000000000MB";
    let conflict = "01HBTRBLK000000000000000MC";
    insert_block(&pool, tag, "tag", "m").await;
    insert_block(&pool, alive, "content", &inline(tag)).await;
    insert_block(&pool, deleted, "content", &inline(tag)).await;
    insert_block(&pool, conflict, "content", &inline(tag)).await;
    soft_delete_block(&pool, deleted).await;
    mark_conflict(&pool, conflict).await;

    rebuild_block_tag_refs_cache(&pool).await.unwrap();

    let rows = sqlx::query!("SELECT source_id FROM block_tag_refs")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "only the alive, non-conflict block should have a row"
    );
    assert_eq!(rows[0].source_id, alive);
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_clears_stale_entries() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000NA";
    let src = "01HBTRBLK000000000000000NA";
    insert_block(&pool, tag, "tag", "n").await;
    insert_block(&pool, src, "content", &inline(tag)).await;

    rebuild_block_tag_refs_cache(&pool).await.unwrap();
    assert_eq!(count_rows(&pool, "block_tag_refs").await, 1, "baseline");

    // Overwrite content to remove the inline ref.
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        "no refs anymore",
        src,
    )
    .execute(&pool)
    .await
    .unwrap();

    rebuild_block_tag_refs_cache(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        0,
        "full rebuild must drop rows whose source no longer contains the token"
    );
}

#[tokio::test]
async fn rebuild_block_tag_refs_cache_split_matches_single_pool() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAG000000000000000OA";
    insert_block(&pool, tag, "tag", "o").await;
    insert_block(&pool, "01HBTRBLK000000000000000OA", "content", &inline(tag)).await;

    rebuild_block_tag_refs_cache_split(&pool, &pool)
        .await
        .unwrap();

    assert_eq!(
        count_rows(&pool, "block_tag_refs").await,
        1,
        "split variant must produce the same row count"
    );
}

// ====================================================================
// UX-250 — rebuild_tags_cache UNION counting
// ====================================================================

#[tokio::test]
async fn tags_cache_union_only_explicit_block_tags() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_ONLY_EX", "tag", "explicit-only").await;
    insert_block(&pool, "BLK_EX1", "content", "one").await;
    insert_block(&pool, "BLK_EX2", "content", "two").await;
    add_tag(&pool, "BLK_EX1", "TAG_ONLY_EX").await;
    add_tag(&pool, "BLK_EX2", "TAG_ONLY_EX").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_ONLY_EX'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.usage_count, 2, "two explicit tags → count 2");
}

#[tokio::test]
async fn tags_cache_union_only_inline_block_tag_refs() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_ONLY_IN", "tag", "inline-only").await;
    insert_block(&pool, "BLK_IN1", "content", "one").await;
    insert_block(&pool, "BLK_IN2", "content", "two").await;
    insert_tag_ref(&pool, "BLK_IN1", "TAG_ONLY_IN").await;
    insert_tag_ref(&pool, "BLK_IN2", "TAG_ONLY_IN").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_ONLY_IN'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 2,
        "inline-only refs should count toward usage_count"
    );
}

#[tokio::test]
async fn tags_cache_union_mixed_same_block_counts_once() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_MIX", "tag", "mixed").await;
    // One block has BOTH an explicit tag AND an inline ref to the same
    // tag. Usage must count the block once.
    insert_block(&pool, "BLK_BOTH", "content", "both").await;
    insert_block(&pool, "BLK_EX_ONLY", "content", "explicit only").await;
    insert_block(&pool, "BLK_IN_ONLY", "content", "inline only").await;
    add_tag(&pool, "BLK_BOTH", "TAG_MIX").await;
    insert_tag_ref(&pool, "BLK_BOTH", "TAG_MIX").await;
    add_tag(&pool, "BLK_EX_ONLY", "TAG_MIX").await;
    insert_tag_ref(&pool, "BLK_IN_ONLY", "TAG_MIX").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_MIX'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 3,
        "BLK_BOTH counted once (UNION dedups), plus BLK_EX_ONLY and BLK_IN_ONLY"
    );
}

#[tokio::test]
async fn tags_cache_union_excludes_deleted_inline_ref_source() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_DEL_IN", "tag", "deleted-inline").await;
    insert_block(&pool, "BLK_ALIVE", "content", "alive").await;
    insert_block(&pool, "BLK_DEAD", "content", "deleted").await;
    insert_tag_ref(&pool, "BLK_ALIVE", "TAG_DEL_IN").await;
    insert_tag_ref(&pool, "BLK_DEAD", "TAG_DEL_IN").await;
    soft_delete_block(&pool, "BLK_DEAD").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_DEL_IN'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 1,
        "soft-deleted inline-ref source must not count toward usage"
    );
}

#[tokio::test]
async fn tags_cache_union_excludes_conflict_inline_ref_source() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_CF_IN", "tag", "conflict-inline").await;
    insert_block(&pool, "BLK_NORMAL", "content", "normal").await;
    insert_block(&pool, "BLK_CF", "content", "conflict").await;
    insert_tag_ref(&pool, "BLK_NORMAL", "TAG_CF_IN").await;
    insert_tag_ref(&pool, "BLK_CF", "TAG_CF_IN").await;
    mark_conflict(&pool, "BLK_CF").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_CF_IN'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 1,
        "conflict-copy inline-ref source must not count toward usage"
    );
}

#[tokio::test]
async fn tags_cache_union_preserves_zero_usage_tags() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG_UNUSED_UN", "tag", "nobody-ref").await;

    rebuild_tags_cache(&pool).await.unwrap();

    let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_UNUSED_UN'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.usage_count, 0,
        "unused tag must still appear with count 0"
    );
}
