//! Tests for cache materializer functions — tags, pages, agenda, and block
//! links.  Covers basic rebuilds, exclusion filters (deleted, conflict, NULL
//! content), idempotency, boundary conditions on date-tag length, and the
//! incremental diff logic in `reindex_block_links`.

use super::*;
use sqlx::SqlitePool;
use tempfile::TempDir;

// -- Deterministic test fixtures ------------------------------------------

const FIXED_DELETED_AT: i64 = 1_736_942_400_000;

// -- Helpers --------------------------------------------------------------

/// Create a fresh SQLite pool with migrations applied (temp directory).
async fn test_pool() -> (SqlitePool, TempDir) {
    crate::test_support::test_pool().await
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
///
/// When `value_date` is `Some`, the row carries exactly one non-NULL value
/// column (`value_date`), satisfying migration-0062's `exactly_one_value`
/// CHECK constraint.  When `value_date` is `None` the helper would otherwise
/// insert an all-NULL value row that violates the same CHECK; in that case
/// we store `value_text = 'placeholder'` as a sentinel so the row is still
/// schema-valid (issue #547).
async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: Option<&str>) {
    if let Some(date) = value_date {
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            block_id,
            key,
            date,
        )
        .execute(pool)
        .await
        .unwrap();
    } else {
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) VALUES (?, ?, 'placeholder')",
            block_id,
            key,
        )
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Count rows in a table (test-only convenience).
async fn count_rows(pool: &SqlitePool, table: &str) -> i64 {
    let query = format!("SELECT COUNT(*) FROM {table}");
    let (count,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(query.as_str()))
        .fetch_one(pool)
        .await
        .unwrap();
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
// Chunked DELETE/INSERT via json_each
// ====================================================================
//
// Replaces the previous per-target DELETE/INSERT loops (2N round-trips
// per reindex) with one DELETE and one INSERT bound by a JSON-encoded
// vec via `json_each(?)`. These tests lock down the contract: same
// end-state regardless of how many targets change in a single reindex.

/// Build a 26-char ULID-shape ID with a 3-digit numeric suffix —
/// matches `[0-9A-Z]{26}` so the inline-link regex captures it.
fn link_target_id(i: usize) -> String {
    let id = format!("01HZ0000000000000000000{i:03}");
    debug_assert_eq!(id.len(), 26, "link_target_id must produce a 26-char ULID");
    id
}

/// Count `block_links` rows for a single source (avoids cross-test
/// contamination if the table ever holds rows from another source).
async fn count_block_links_for(pool: &SqlitePool, source_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
        .bind(source_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reindex_block_links_chunks_removals() {
    let (pool, _dir) = test_pool().await;

    let source_id = "01HZ0000000000000000000SRC";

    // 50 target blocks
    let target_ids: Vec<String> = (0..50).map(link_target_id).collect();
    for tid in &target_ids {
        insert_block(&pool, tid, "content", "target").await;
    }

    // Source links to all 50
    let initial_content = target_ids
        .iter()
        .map(|t| format!("[[{t}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    insert_block(&pool, source_id, "content", &initial_content).await;

    reindex_block_links(&pool, source_id).await.unwrap();
    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        50,
        "baseline: all 50 links indexed before removal"
    );

    // Update source to have zero links
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        "no links",
        source_id,
    )
    .execute(&pool)
    .await
    .unwrap();

    // Re-reindex: chunked DELETE side runs once via json_each; INSERT
    // side is empty so no INSERT executes.
    reindex_block_links(&pool, source_id).await.unwrap();

    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        0,
        "all 50 links must be removed by the single chunked DELETE"
    );
}

#[tokio::test]
async fn reindex_block_links_chunks_additions() {
    let (pool, _dir) = test_pool().await;

    let source_id = "01HZ0000000000000000000SRC";

    let target_ids: Vec<String> = (0..50).map(link_target_id).collect();
    for tid in &target_ids {
        insert_block(&pool, tid, "content", "target").await;
    }

    // Source starts with no link tokens
    insert_block(&pool, source_id, "content", "no links yet").await;
    reindex_block_links(&pool, source_id).await.unwrap();
    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        0,
        "baseline: no links before additions"
    );

    // Update source to reference all 50 targets
    let new_content = target_ids
        .iter()
        .map(|t| format!("[[{t}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        new_content,
        source_id,
    )
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links(&pool, source_id).await.unwrap();

    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        50,
        "all 50 links must be inserted by the single chunked INSERT"
    );

    // Verify each target landed exactly once and matches the requested set.
    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        source_id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = target_ids.clone();
    expected.sort();
    let actual: Vec<String> = rows.into_iter().map(|r| r.target_id).collect();
    assert_eq!(
        actual, expected,
        "every requested target landed exactly once"
    );
}

#[tokio::test]
async fn reindex_block_links_mixed_chunked_diff() {
    let (pool, _dir) = test_pool().await;

    let source_id = "01HZ0000000000000000000SRC";

    // Indices 0..30 = old set; indices 15..45 = new set.
    // Overlap = 15..30 (15 ids), removed = 0..15 (15 ids), added = 30..45 (15 ids).
    let all_ids: Vec<String> = (0..45).map(link_target_id).collect();
    for tid in &all_ids {
        insert_block(&pool, tid, "content", "target").await;
    }

    let initial_content = all_ids[0..30]
        .iter()
        .map(|t| format!("[[{t}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    insert_block(&pool, source_id, "content", &initial_content).await;

    reindex_block_links(&pool, source_id).await.unwrap();
    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        30,
        "baseline: 30 links before diff"
    );

    let new_content = all_ids[15..45]
        .iter()
        .map(|t| format!("[[{t}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ?",
        new_content,
        source_id,
    )
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links(&pool, source_id).await.unwrap();

    let rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
        source_id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        rows.len(),
        30,
        "exactly 30 links after mixed diff (15 kept + 15 added, 15 removed)"
    );

    let actual: Vec<String> = rows.into_iter().map(|r| r.target_id).collect();
    let mut expected: Vec<String> = all_ids[15..45].to_vec();
    expected.sort();
    assert_eq!(
        actual, expected,
        "end state must equal exactly the new target set — no stale rows, no duplicates"
    );
}

/// Stress test: 600 links far exceeds SQLite's default
/// `SQLITE_MAX_VARIABLE_NUMBER` (999 in older builds, often lower on
/// some Linux distros). The `json_each(?)` path passes the full target
/// list as one TEXT bind, so this should succeed regardless.
#[tokio::test]
async fn reindex_block_links_stress_600_via_json_each() {
    let (pool, _dir) = test_pool().await;

    let source_id = "01HZ0000000000000000000SRC";

    let target_ids: Vec<String> = (0..600).map(link_target_id).collect();
    for tid in &target_ids {
        insert_block(&pool, tid, "content", "target").await;
    }

    let content = target_ids
        .iter()
        .map(|t| format!("[[{t}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    insert_block(&pool, source_id, "content", &content).await;

    reindex_block_links(&pool, source_id).await.unwrap();
    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        600,
        "all 600 links must be inserted via the json_each chunked path"
    );

    // Round-trip: clear all 600 in a single chunked DELETE.
    sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", "", source_id,)
        .execute(&pool)
        .await
        .unwrap();

    reindex_block_links(&pool, source_id).await.unwrap();
    assert_eq!(
        count_block_links_for(&pool, source_id).await,
        0,
        "all 600 links removed by the single chunked DELETE"
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

    // Set a repeat rule so projected cache has something to compute.
    // Use a single INSERT with value_text populated; the prior two-step
    // (INSERT with all-NULL values, then UPDATE) violated migration
    // 0062's exactly_one_value CHECK on the intermediate row.
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'repeat', 'daily')",
    )
    .bind("BLK_DONE3")
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
    // #2601: the fixed 365-day calendar window was replaced by a fixed
    // occurrence count. An unbounded weekly series is now capped at
    // `HORIZON_OCCURRENCES` (91) materialized occurrences regardless of
    // cadence, so the count is exact and — unlike the old calendar-window
    // derivation — completely independent of the wall clock.
    //
    // Derivation: due = today - 3 days, weekly (+7 days), max_emitted = 91.
    // The impl seeds `current = due`, shifts +7 each iteration and emits when
    // `current >= today`:
    //   Iter 1: today + 4, Iter 2: today + 11, … Iter k: today + 4 + 7*(k-1),
    // stopping once 91 occurrences have been EMITTED ⇒ count = 91, spanning
    // today+4 .. today + 4 + 7*90 = today + 634.
    let expected = i64::try_from(crate::cache::HORIZON_OCCURRENCES).unwrap();
    assert_eq!(
        count, expected,
        "unbounded weekly series must be capped at HORIZON_OCCURRENCES (got {count})"
    );

    // Every projected date must be >= today (no past occurrences materialized)
    // and within the count-bounded reach (today + 7 * HORIZON_OCCURRENCES is a
    // comfortable upper bound for a weekly cadence, robust to a midnight
    // rollover between the test's and the impl's `chrono::Local::now()`).
    let reach_days = i64::try_from(7 * crate::cache::HORIZON_OCCURRENCES).unwrap();
    let upper = (today + chrono::Duration::days(reach_days))
        .format("%Y-%m-%d")
        .to_string();
    let today_str = today.format("%Y-%m-%d").to_string();

    let invalid_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache \
         WHERE projected_date < ?1 OR projected_date > ?2",
    )
    .bind(&today_str)
    .bind(&upper)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        invalid_count, 0,
        "all projected dates must be >= today and within the count-bounded reach"
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
    use std::collections::BTreeSet;

    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    insert_repeating_block(&pool, "RPT05", &due, None, "weekly", None, None, None).await;

    rebuild_projected_agenda_cache(&pool).await.unwrap();
    let first_rows: BTreeSet<(String, String, String)> =
        sqlx::query_as("SELECT block_id, projected_date, source FROM projected_agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .collect();

    rebuild_projected_agenda_cache(&pool).await.unwrap();
    let second_rows: BTreeSet<(String, String, String)> =
        sqlx::query_as("SELECT block_id, projected_date, source FROM projected_agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .collect();

    assert_eq!(
        first_rows, second_rows,
        "consecutive rebuilds must produce identical (block_id, projected_date, source) row sets"
    );
}

/// True differential: runs both [`rebuild_projected_agenda_cache_split`] and
/// [`rebuild_projected_agenda_cache`] on identical fixtures in separate pools
/// and asserts that the resulting `(block_id, projected_date, source)` row
/// sets are byte-identical, confirming the split path is not a no-op and
/// both paths share the same projection logic.
#[tokio::test]
async fn projected_agenda_cache_split_matches_single_pool() {
    use std::collections::BTreeSet;

    let today = chrono::Local::now().date_naive();
    let due = (today - chrono::Duration::days(5))
        .format("%Y-%m-%d")
        .to_string();

    // Two independent pools with identical fixture data.
    let (pool_split, _dir_split) = test_pool().await;
    let (pool_single, _dir_single) = test_pool().await;

    for pool in [&pool_split, &pool_single] {
        insert_repeating_block(pool, "RPT06", &due, None, "daily", None, None, None).await;
    }

    rebuild_projected_agenda_cache_split(&pool_split, &pool_split)
        .await
        .unwrap();
    rebuild_projected_agenda_cache(&pool_single).await.unwrap();

    let split_rows: BTreeSet<(String, String, String)> =
        sqlx::query_as("SELECT block_id, projected_date, source FROM projected_agenda_cache")
            .fetch_all(&pool_split)
            .await
            .unwrap()
            .into_iter()
            .collect();

    let single_rows: BTreeSet<(String, String, String)> =
        sqlx::query_as("SELECT block_id, projected_date, source FROM projected_agenda_cache")
            .fetch_all(&pool_single)
            .await
            .unwrap()
            .into_iter()
            .collect();

    // Sanity: the fixture must produce non-empty output.
    assert!(
        !split_rows.is_empty(),
        "split rebuild must produce projections for a daily-repeating block"
    );

    assert_eq!(
        split_rows, single_rows,
        "split and single-pool rebuilds must produce identical \
         (block_id, projected_date, source) row sets"
    );
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
// Projected_agenda_cache — chunked-INSERT regression
// ====================================================================

/// Forces the chunked `INSERT OR IGNORE` path in
/// [`rebuild_projected_agenda_cache`] by creating enough projections to
/// span multiple `MAX_SQL_PARAMS / 3 = 333`-row chunks. Pre-M-18 the
/// rebuild emitted one INSERT per row; this test asserts the post-fix
/// chunked code lands every projection correctly.
#[tokio::test]
async fn projected_agenda_cache_chunked_rebuild_handles_large_diff() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    // 10 daily-repeating blocks → HORIZON_OCCURRENCES (91) projections each
    // ⇒ 910 rows, well above the 333-row chunk size, so the chunked code must
    // run multiple INSERT statements within the same transaction.
    const N_BLOCKS: usize = 10;
    for i in 0..N_BLOCKS {
        let id = format!("RPTBIG{i:02}");
        insert_repeating_block(&pool, &id, &due, None, "daily", None, None, None).await;
    }

    rebuild_projected_agenda_cache(&pool).await.unwrap();

    let total = count_rows(&pool, "projected_agenda_cache").await;
    assert!(
        total > 500,
        "expected > 500 projected rows to exercise multi-chunk INSERT, got {total}"
    );

    // Every block contributes the same number of projections — assert
    // the per-block count matches `total / N_BLOCKS` so a partial-write
    // bug in the chunked path can't slip through.
    let per_block: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'RPTBIG00'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        total,
        per_block * i64::try_from(N_BLOCKS).expect("test constant N_BLOCKS fits i64"),
        "every block must contribute identical projection counts"
    );
}

/// Forces the chunked `INSERT OR IGNORE` path in the **split-pool**
/// Variant [`rebuild_projected_agenda_cache_split`]. Pre-fix
/// the split function delegated to the single-pool variant on
/// `write_pool`, ignoring the read pool entirely; this test asserts the
/// post-fix split path actually runs the SELECT on `read_pool`,
/// computes the projection set in Rust outside the writer lock, and
/// lands every row through the chunked INSERT on `write_pool`.
///
/// Seeds 10 daily-repeating blocks — HORIZON_OCCURRENCES (91) projections
/// each ⇒ 910 rows, well over `MAX_SQL_PARAMS / 3 = 333`, forcing multiple
/// chunks of the multi-row INSERT.  Asserts per-block parity (no chunk loses
/// rows) and end-to-end parity with the single-pool variant on
/// `(block_id, projected_date, source)`.
#[tokio::test]
async fn projected_agenda_cache_split_chunked_rebuild_handles_large_input() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();
    let due = today.format("%Y-%m-%d").to_string();

    // 10 daily-repeating blocks → HORIZON_OCCURRENCES (91) projections each
    // ⇒ 910 rows, well above the 333-row chunk size, so the chunked code must
    // run multiple INSERT statements within the same transaction.
    const N_BLOCKS: usize = 10;
    for i in 0..N_BLOCKS {
        let id = format!("RPTSPLIT{i:02}");
        insert_repeating_block(&pool, &id, &due, None, "daily", None, None, None).await;
    }

    rebuild_projected_agenda_cache_split(&pool, &pool)
        .await
        .unwrap();

    let total = count_rows(&pool, "projected_agenda_cache").await;
    assert!(
        total > 500,
        "expected > 500 projected rows to exercise multi-chunk INSERT, got {total}"
    );

    // Every block contributes the same number of projections — assert
    // the per-block count matches `total / N_BLOCKS` so a partial-write
    // bug in the chunked path can't slip through.
    let per_block: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'RPTSPLIT00'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        total,
        per_block * i64::try_from(N_BLOCKS).expect("test constant N_BLOCKS fits i64"),
        "every block must contribute identical projection counts"
    );

    // Parity check: split-rebuild rows must match single-pool rebuild
    // rows on (block_id, projected_date, source). Both paths share the
    // `compute_projection_entries` helper, so identical inputs must
    // produce byte-identical outputs.
    let split_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, projected_date, source FROM projected_agenda_cache \
         ORDER BY block_id, projected_date, source",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    rebuild_projected_agenda_cache(&pool).await.unwrap();
    let single_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, projected_date, source FROM projected_agenda_cache \
         ORDER BY block_id, projected_date, source",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        split_rows, single_rows,
        "split and single-pool rebuilds must produce identical \
         (block_id, projected_date, source) rows"
    );
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
// Agenda_cache — chunked diff regression
// ====================================================================

/// Exercises the chunked DELETE / `INSERT OR IGNORE` path in
/// [`rebuild_agenda_cache`] with a diff large enough to span multiple
/// chunks (`MAX_SQL_PARAMS / 2 = 499` for DELETE,
/// `MAX_SQL_PARAMS / 3 = 333` for INSERT). Pre-M-18 the rebuild emitted
/// one statement per row — this test would still pass on the loop, but
/// asserts the post-fix chunked path produces the same observable diff
/// across two rebuilds (initial fill + mutation).
#[tokio::test]
async fn agenda_cache_chunked_rebuild_handles_large_diff() {
    let (pool, _dir) = test_pool().await;

    const N_BLOCKS: usize = 1000;

    // Fill phase: 1000 blocks each with a unique `due_date` column —
    // forces ≥ 4 INSERT chunks (1000 / 333) on the first rebuild.
    let mut tx = pool.begin().await.unwrap();
    for i in 0..N_BLOCKS {
        let id = format!("BLK{i:04}");
        // Stay in valid date space (months 1–12, days 1–28). Multiple
        // blocks may share a date but every (date, block_id) is unique.
        let month = (i / 28) % 12 + 1;
        let day = (i % 28) + 1;
        let due = format!("2025-{month:02}-{day:02}");
        sqlx::query("INSERT INTO blocks (id, block_type, due_date) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(&due)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        i64::try_from(N_BLOCKS).expect("test constant N_BLOCKS fits i64"),
        "all {N_BLOCKS} blocks must be present in agenda_cache after first rebuild"
    );

    // Mutation phase: re-date the first 500 blocks. The diff path must
    // run a chunked DELETE (500 / 499 ⇒ 2 chunks) and a chunked INSERT
    // (500 / 333 ⇒ 2 chunks) inside one transaction.
    const N_MUTATED: usize = 500;
    let mut tx = pool.begin().await.unwrap();
    for i in 0..N_MUTATED {
        let id = format!("BLK{i:04}");
        sqlx::query("UPDATE blocks SET due_date = '2030-01-01' WHERE id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    rebuild_agenda_cache(&pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "agenda_cache").await,
        i64::try_from(N_BLOCKS).expect("test constant N_BLOCKS fits i64"),
        "cache size remains {N_BLOCKS} after mutating {N_MUTATED} dates"
    );

    let on_new_date: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agenda_cache WHERE date = '2030-01-01'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        on_new_date,
        i64::try_from(N_MUTATED).expect("test constant N_MUTATED fits i64"),
        "exactly {N_MUTATED} blocks must land on the new date after the diff rebuild"
    );

    // Untouched blocks retain their original date — no rows reference a
    // date that no longer matches the live block's `due_date` column.
    let stale_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agenda_cache ac \
         JOIN blocks b ON b.id = ac.block_id \
         WHERE b.due_date IS NOT NULL AND b.due_date != ac.date",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        stale_count, 0,
        "no rows should reference a stale date after the chunked diff rebuild"
    );
}

// ====================================================================
// _split variants — chunked-INSERT regression
// ====================================================================

/// Forces the chunked `INSERT OR IGNORE` path in
/// [`rebuild_tags_cache_split`] by seeding more tag blocks than fit in
/// a single statement (`MAX_SQL_PARAMS / 4 = 249` rows per chunk). Pre-
/// The split variant delegated to the single-pool implementation,
/// so this test would still pass on the old code; post-fix it asserts
/// the chunked code lands every row correctly and the result matches
/// the single-pool variant for parity.
#[tokio::test]
async fn tags_cache_split_chunked_rebuild_handles_large_input() {
    let (pool, _dir) = test_pool().await;

    // 251 > 249 so the multi-chunk INSERT path runs at least 2 chunks.
    const N_TAGS: usize = 251;

    // Seed the tag blocks in one transaction for speed.
    let mut tx = pool.begin().await.unwrap();
    for i in 0..N_TAGS {
        let id = format!("TAGCHUNK{i:05}AAAAAAAAAAAAA");
        let name = format!("tag-{i:05}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', ?)")
            .bind(&id)
            .bind(&name)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    rebuild_tags_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "tags_cache").await,
        i64::try_from(N_TAGS).expect("test constant N_TAGS fits i64"),
        "all {N_TAGS} tags must be present after chunked split rebuild"
    );

    // Parity check: capture (tag_id, name, usage_count) tuples from the
    // split rebuild, then re-run the single-pool variant and compare.
    // The `updated_at` column is captured per-rebuild from `now_rfc3339`
    // and excluded from the parity tuple — its sole purpose is to share
    // a single timestamp across all rows of one rebuild.
    let split_rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    rebuild_tags_cache(&pool).await.unwrap();
    let single_rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        split_rows, single_rows,
        "split and single-pool rebuilds must produce identical (tag_id, name, usage_count) rows"
    );

    // Sanity: every row's updated_at is non-empty (single timestamp
    // captured before the read tx, bound on every chunked INSERT row).
    let any_empty: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE updated_at = ''")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(any_empty, 0, "every row must have a non-empty updated_at");
}

/// Forces the chunked `INSERT OR IGNORE` path in
/// [`rebuild_pages_cache_split`] by seeding more page blocks than fit
/// in a single statement (`MAX_SQL_PARAMS / 3 = 333` rows per chunk).
/// Asserts the chunked code lands every row correctly and matches the
/// single-pool variant for parity.
#[tokio::test]
async fn pages_cache_split_chunked_rebuild_handles_large_input() {
    let (pool, _dir) = test_pool().await;

    // 401 > 333 so the multi-chunk INSERT path runs at least 2 chunks.
    const N_PAGES: usize = 401;

    let mut tx = pool.begin().await.unwrap();
    for i in 0..N_PAGES {
        let id = format!("PAGECHUNK{i:05}AAAAAAAAAAAA");
        let title = format!("Page {i:05}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)")
            .bind(&id)
            .bind(&title)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    rebuild_pages_cache_split(&pool, &pool).await.unwrap();

    assert_eq!(
        count_rows(&pool, "pages_cache").await,
        i64::try_from(N_PAGES).expect("test constant N_PAGES fits i64"),
        "all {N_PAGES} pages must be present after chunked split rebuild"
    );

    // Parity check: split-rebuild rows must match single-pool rebuild
    // rows on (page_id, title). `updated_at` is per-rebuild and excluded.
    let split_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY page_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    rebuild_pages_cache(&pool).await.unwrap();
    let single_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY page_id")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        split_rows, single_rows,
        "split and single-pool rebuilds must produce identical (page_id, title) rows"
    );

    let any_empty: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE updated_at = ''")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(any_empty, 0, "every row must have a non-empty updated_at");
}

// ====================================================================
// Block_tag_refs (inline #[ULID] tag reference cache)
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
// Rebuild_tags_cache UNION counting
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

/// Parity oracle: `rebuild_agenda_cache` (single-pool) and
/// `rebuild_agenda_cache_split` (read/write-split) must produce
/// **byte-identical** `agenda_cache` row sets when run on the same
/// fixture. Both bind the shared `DESIRED_AGENDA_SQL` constant, so any
/// future divergence (e.g. accidental edit to one branch only) fails
/// this test instead of silently shipping.
#[tokio::test]
async fn agenda_rebuild_single_and_split_produce_identical_cache() {
    use std::collections::BTreeSet;

    // Helper: snapshot the current `agenda_cache` rows as a BTreeSet so
    // ordering does not affect equality.
    async fn snapshot(pool: &SqlitePool) -> BTreeSet<(String, String, String)> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT date, block_id, source FROM agenda_cache",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
    }

    // Build a fixture that exercises every desired-state source: a
    // date-property hit, a date-tag hit, a `due_date` column hit, and a
    // `scheduled_date` column hit — plus a deleted block and a
    // template-page block (each must be excluded by the shared SQL).
    let (pool_single, _dir_a) = test_pool().await;
    let (pool_split, _dir_b) = test_pool().await;

    for pool in [&pool_single, &pool_split] {
        // Source 1: date-property
        insert_block(pool, "BLK01", "content", "task with property due").await;
        set_property(pool, "BLK01", "due", Some("2025-04-01")).await;

        // Source 2: date-tag
        insert_block(pool, "DTAG2", "tag", "date/2025-05-02").await;
        insert_block(pool, "BLK02", "content", "tagged for may").await;
        add_tag(pool, "BLK02", "DTAG2").await;

        // Source 3: due_date column
        insert_block(pool, "BLK03", "content", "due column hit").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-06-03' WHERE id = 'BLK03'")
            .execute(pool)
            .await
            .unwrap();

        // Source 4: scheduled_date column
        insert_block(pool, "BLK04", "content", "scheduled column hit").await;
        sqlx::query("UPDATE blocks SET scheduled_date = '2025-07-04' WHERE id = 'BLK04'")
            .execute(pool)
            .await
            .unwrap();

        // Excluded: soft-deleted block (must not appear).
        insert_block(pool, "BLK05", "content", "deleted").await;
        set_property(pool, "BLK05", "due", Some("2025-08-05")).await;
        soft_delete_block(pool, "BLK05").await;

        // Excluded: content block whose page has a `template` property
        // (template-page exclusion: `NOT EXISTS (... tp.block_id =
        // b.page_id AND tp.key = 'template')`).
        //
        // BLK06_PAGE is a page block marked as a template; BLK06 is a
        // content block that lives on that page (page_id = BLK06_PAGE).
        // The due_date on BLK06 must not appear in agenda_cache.
        insert_block(pool, "BLK06_PAGE", "page", "template page").await;
        // `set_property` only handles value_date; use raw SQL so value_text is
        // populated (the exactly_one_value CHECK requires exactly one non-NULL
        // value column).
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('BLK06_PAGE', 'template', 'true')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id, due_date) \
             VALUES ('BLK06', 'content', 'task on template page', 'BLK06_PAGE', '2025-09-06')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    rebuild_agenda_cache(&pool_single).await.unwrap();
    rebuild_agenda_cache_split(&pool_split, &pool_split)
        .await
        .unwrap();

    let single = snapshot(&pool_single).await;
    let split = snapshot(&pool_split).await;

    assert_eq!(
        single, split,
        "rebuild_agenda_cache and rebuild_agenda_cache_split must produce \
         byte-identical agenda_cache row sets — `DESIRED_AGENDA_SQL` is the \
         single source of truth",
    );

    // Sanity: the fixture must produce non-empty output, otherwise the
    // equality check is vacuously true.
    assert!(!single.is_empty(), "fixture must populate agenda_cache");
}

/// Regression: forces the chunked CASE-expression UPDATE path in
/// [`rebuild_page_ids_split`] by seeding more non-page blocks than
/// fit in a single statement (`MAX_SQL_PARAMS / 3 = 333` rows per
/// chunk). Pre-fix the split variant delegated to the single-pool
/// implementation and ignored `read_pool`; post-fix it asserts the
/// chunked code lands every row's `page_id` correctly AND matches the
/// single-pool variant for parity on a separate test pool.
#[tokio::test]
async fn page_id_split_chunked_rebuild_handles_large_input() {
    // 400 > 333 so the multi-chunk UPDATE path runs at least 2 chunks.
    const N_PAGES: usize = 4;
    const PER_PAGE: usize = 100; // 4 * 100 = 400 non-page blocks
    const N_BLOCKS: usize = N_PAGES * PER_PAGE;

    fn page_id(p: usize) -> String {
        format!("PAGECHUNK{p:05}AAAAAAAAAAAA")
    }
    fn block_id(p: usize, j: usize) -> String {
        format!("BLKCHUNK{p:03}{j:05}AAAAAAAAAA")
    }

    async fn seed(pool: &SqlitePool) {
        let mut tx = pool.begin().await.unwrap();
        for p in 0..N_PAGES {
            let pid = page_id(p);
            sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)")
                .bind(&pid)
                .bind(format!("Page {p}"))
                .execute(&mut *tx)
                .await
                .unwrap();
            for j in 0..PER_PAGE {
                let bid = block_id(p, j);
                sqlx::query(
                    "INSERT INTO blocks (id, block_type, content, parent_id) \
                     VALUES (?, 'content', ?, ?)",
                )
                .bind(&bid)
                .bind(format!("Content {p}-{j}"))
                .bind(&pid)
                .execute(&mut *tx)
                .await
                .unwrap();
            }
        }
        tx.commit().await.unwrap();
    }

    // Pool A: split rebuild.
    let (pool_split, _dir_split) = test_pool().await;
    seed(&pool_split).await;
    rebuild_page_ids_split(&pool_split, &pool_split)
        .await
        .unwrap();

    let split_rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, page_id FROM blocks ORDER BY id")
            .fetch_all(&pool_split)
            .await
            .unwrap();

    assert_eq!(
        split_rows.len(),
        N_PAGES + N_BLOCKS,
        "fixture row count must match pages + non-page blocks"
    );

    // Per-row correctness: every page → page_id = self; every non-page
    // child → page_id = its page parent.
    for p in 0..N_PAGES {
        let pid = page_id(p);
        let actual_page = split_rows
            .iter()
            .find(|(id, _)| *id == pid)
            .and_then(|(_, p)| p.as_deref());
        assert_eq!(
            actual_page,
            Some(pid.as_str()),
            "page block {pid} must have page_id = self after split rebuild",
        );
        for j in 0..PER_PAGE {
            let bid = block_id(p, j);
            let actual_page = split_rows
                .iter()
                .find(|(id, _)| *id == bid)
                .and_then(|(_, p)| p.as_deref());
            assert_eq!(
                actual_page,
                Some(pid.as_str()),
                "non-page block {bid} must point to page {pid} after split rebuild",
            );
        }
    }

    // Pool B: single-pool rebuild on identical fixture; parity check.
    let (pool_single, _dir_single) = test_pool().await;
    seed(&pool_single).await;
    rebuild_page_ids(&pool_single).await.unwrap();

    let single_rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, page_id FROM blocks ORDER BY id")
            .fetch_all(&pool_single)
            .await
            .unwrap();

    assert_eq!(
        split_rows, single_rows,
        "split and single-pool rebuilds must produce identical (id, page_id) rows"
    );
}

// ====================================================================
// page_link_cache (SQL-review §H-2)
// ====================================================================

async fn seed_page_link_fixture(
    pool: &SqlitePool,
    page_a: &str,
    page_b: &str,
    edges: i64,
) -> Vec<String> {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Page A')")
        .bind(page_a)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Page B')")
        .bind(page_b)
        .execute(pool)
        .await
        .unwrap();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mut children: Vec<String> = Vec::with_capacity(edges as usize);
    for i in 0..edges {
        let child_id = format!("C{i:025}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&child_id)
        .bind(format!("link [[{page_b}]]"))
        .bind(page_a)
        .bind(i + 1)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&child_id)
            .bind(page_b)
            .execute(pool)
            .await
            .unwrap();
        children.push(child_id);
    }
    children
}

#[tokio::test]
async fn page_link_cache_full_rebuild_rolls_up_edges() {
    let (pool, _dir) = test_pool().await;
    seed_page_link_fixture(
        &pool,
        "PA000000000000000000000000",
        "PB000000000000000000000000",
        5,
    )
    .await;
    rebuild_page_link_cache(&pool).await.unwrap();
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT source_page_id, target_page_id, edge_count FROM page_link_cache")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![(
            "PA000000000000000000000000".to_string(),
            "PB000000000000000000000000".to_string(),
            5,
        )],
        "rebuild must roll up 5 block_links rows into one cache row with edge_count=5"
    );
}

#[tokio::test]
async fn reindex_page_link_cache_for_block_inserts_pair() {
    let (pool, _dir) = test_pool().await;
    let children = seed_page_link_fixture(
        &pool,
        "PA000000000000000000000000",
        "PB000000000000000000000000",
        3,
    )
    .await;
    reindex_page_link_cache_for_block(&pool, &children[0])
        .await
        .unwrap();
    let row: (String, String, i64) =
        sqlx::query_as("SELECT source_page_id, target_page_id, edge_count FROM page_link_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row,
        (
            "PA000000000000000000000000".to_string(),
            "PB000000000000000000000000".to_string(),
            3,
        ),
        "per-block reindex must roll up every block_links row sharing the source page"
    );
}

#[tokio::test]
async fn reindex_page_link_cache_for_block_drops_zero_count_row() {
    let (pool, _dir) = test_pool().await;
    let children = seed_page_link_fixture(
        &pool,
        "PA000000000000000000000000",
        "PB000000000000000000000000",
        1,
    )
    .await;
    let child = &children[0];
    reindex_page_link_cache_for_block(&pool, child)
        .await
        .unwrap();
    let pre = count_rows(&pool, "page_link_cache").await;
    assert_eq!(pre, 1, "baseline: cache must hold one row before delete");

    sqlx::query("DELETE FROM block_links WHERE source_id = ?")
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    reindex_page_link_cache_for_block(&pool, child)
        .await
        .unwrap();
    let post = count_rows(&pool, "page_link_cache").await;
    assert_eq!(post, 0, "edge_count == 0 must DELETE the cache row");
}

// ---------------------------------------------------------------------------
// Issue #103: contention-mode regression guard for the
// `pool.begin()` → `begin_immediate_logged` migration. A cache rebuild
// must wait (up to `busy_timeout`) for a competing writer, not fail with
// `SQLITE_BUSY_SNAPSHOT` mid-tx the way the DEFERRED form would.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reindex_block_links_waits_for_competing_writer() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "S", "content", "[[T]]").await;
    insert_block(&pool, "T", "page", "target").await;

    let pool = Arc::new(pool);

    // Readiness handshake: the holder signals only after it provably
    // owns the writer lock, so the contender never has to guess a
    // scheduling window (a fixed pre-sleep can lose the race under
    // CPU saturation and false-red this test).
    let (lock_held_tx, lock_held_rx) = tokio::sync::oneshot::channel();

    // Holder: take a writer lock for ~100 ms, then release.
    let holder = {
        let pool = Arc::clone(&pool);
        tokio::spawn(async move {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            // Force the writer lock to be acquired now, not lazily.
            sqlx::query("SELECT 1").execute(&mut *tx).await.unwrap();
            // Lock is now provably held — signal the contender.
            let _ = lock_held_tx.send(());
            tokio::time::sleep(Duration::from_millis(100)).await;
            tx.commit().await.unwrap();
        })
    };

    // Wait for the holder to actually acquire the lock before racing.
    lock_held_rx.await.unwrap();

    // Contender: the rebuild must wait for the holder, not fail.
    let start = Instant::now();
    let result = super::block_links::reindex_block_links(&pool, "S").await;
    let waited = start.elapsed();

    holder.await.unwrap();

    result.expect(
        "reindex_block_links must wait for the competing writer (busy_timeout), \
         not fail with SQLITE_BUSY_SNAPSHOT — see issue #105",
    );
    assert!(
        waited >= Duration::from_millis(50),
        "rebuild should have waited for the holder (>=50ms); waited {waited:?}"
    );
}

// ---------------------------------------------------------------------------
// Issue #108 B-C3: aggregate UPSERT + NOT EXISTS DELETE rewrite must
// produce the same end state as the original per-target loop across the
// full mix of {insert / update / delete} operations in one call.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reindex_page_link_cache_for_block_multi_target_full_lifecycle() {
    let (pool, _dir) = test_pool().await;

    // Source page PA + three target pages PB, PC, PD.
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('PA00000000000000000000000A', 'page', 'A')")
        .execute(&pool).await.unwrap();
    for tgt in [
        "PB00000000000000000000000B",
        "PC00000000000000000000000C",
        "PD00000000000000000000000D",
    ] {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'target')")
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Two content blocks under PA: one links to PB twice (count=2),
    // another links to PC once (count=1). PD will appear only as a
    // stale cache row.
    for (cid, target, pos) in [
        (
            "CB100000000000000000000000",
            "PB00000000000000000000000B",
            1,
        ),
        (
            "CB200000000000000000000000",
            "PB00000000000000000000000B",
            2,
        ),
        (
            "CC100000000000000000000000",
            "PC00000000000000000000000C",
            3,
        ),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, 'content', '', ?, ?)",
        )
        .bind(cid).bind("PA00000000000000000000000A").bind(pos)
        .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(cid)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Seed a stale cache row for PD (the "now zero" target the DELETE must sweep).
    sqlx::query(
        "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
         VALUES ('PA00000000000000000000000A', 'PD00000000000000000000000D', 7)",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Seed a stale cache row for PC with the wrong count (the UPSERT must update it).
    sqlx::query(
        "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
         VALUES ('PA00000000000000000000000A', 'PC00000000000000000000000C', 99)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Single reindex from one of the source page's blocks should drive
    // INSERT (PB), UPDATE (PC: 99→1), and DELETE (PD: zero edges left).
    reindex_page_link_cache_for_block(&pool, "CB100000000000000000000000")
        .await
        .unwrap();

    let mut rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
         WHERE source_page_id = 'PA00000000000000000000000A' ORDER BY target_page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    rows.sort();
    assert_eq!(
        rows,
        vec![
            (
                "PA00000000000000000000000A".to_string(),
                "PB00000000000000000000000B".to_string(),
                2
            ),
            (
                "PA00000000000000000000000A".to_string(),
                "PC00000000000000000000000C".to_string(),
                1
            ),
        ],
        "aggregate UPSERT + NOT EXISTS DELETE must produce {{PB:2, PC:1}} and sweep PD's stale row"
    );
}

/// P6 (#346): `reindex_block_links` pushes the per-target
/// `resolve_block_space` filter into the INSERT's correlated subquery
/// (was an N+1 Rust loop). This test verifies (a) a same-space target is
/// inserted, (b) a cross-space target is filtered out, and (c) the
/// soft-delete guards the subquery carries are preserved: a target whose
/// space-holding page is soft-deleted resolves to no space and is dropped
/// (invariant #9).
#[tokio::test]
async fn reindex_block_links_cross_space_pushdown_preserves_soft_delete_p6() {
    let (pool, _dir) = test_pool().await;

    // Two space marker pages (the `value_ref` FK target).
    async fn insert_page_with_pid(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(id)
        .bind(id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }
    async fn set_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
        // #708: register the space (blocks.space_id REFERENCES spaces(id)).
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(space_id)
            .execute(pool)
            .await
            .unwrap();
        // Phase 2 (#533): space membership is read from `blocks.space_id`.
        // Set the denormalized column on the block and any block paged to it.
        sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
            .bind(space_id)
            .bind(block_id)
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
    }

    let space1 = "01SPACE0000000000000000001";
    let space2 = "01SPACE0000000000000000002";
    insert_page_with_pid(&pool, space1).await;
    insert_page_with_pid(&pool, space2).await;

    // Source page in space1.
    let src_page = "01SRCPAGE000000000000000AA";
    insert_page_with_pid(&pool, src_page).await;
    set_space(&pool, src_page, space1).await;

    // Same-space target page (space1) and cross-space target page (space2).
    let tgt_same = "01TGTSAME000000000000000BB";
    let tgt_cross = "01TGTCROS000000000000000CC";
    let tgt_deleted_holder = "01TGTDELS000000000000000DD";
    insert_page_with_pid(&pool, tgt_same).await;
    set_space(&pool, tgt_same, space1).await;
    insert_page_with_pid(&pool, tgt_cross).await;
    set_space(&pool, tgt_cross, space2).await;
    // Same-space target, but soft-delete the holder so its space resolves
    // to None → must be dropped by the preserved soft-delete guard.
    insert_page_with_pid(&pool, tgt_deleted_holder).await;
    set_space(&pool, tgt_deleted_holder, space1).await;
    soft_delete_block(&pool, tgt_deleted_holder).await;

    // Source content block under src_page links to all three targets.
    let src_block = "01SRCBLOK000000000000000EE";
    // Phase 2 (#533): `resolve_block_space` reads the SOURCE block's own
    // `blocks.space_id`, so set it directly here (production sets the
    // denormalized column on content blocks in a space).
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) VALUES (?, 'content', ?, ?, ?, ?)")
        .bind(src_block)
        .bind(format!("[[{tgt_same}]] [[{tgt_cross}]] [[{tgt_deleted_holder}]]"))
        .bind(src_page)
        .bind(src_page)
        .bind(space1)
        .execute(&pool)
        .await
        .unwrap();

    reindex_block_links(&pool, src_block).await.unwrap();

    let mut targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(src_block)
            .fetch_all(&pool)
            .await
            .unwrap();
    targets.sort();
    assert_eq!(
        targets,
        vec![tgt_same.to_string()],
        "only the same-space, live-holder target may be linked; cross-space \
         and soft-deleted-holder targets must be dropped by the pushed-down filter"
    );
}

/// #3903: the pushed-down cross-space filter must resolve the TARGET's space
/// the same way it resolves the SOURCE's — `COALESCE(own space_id, owning
/// page's space_id)`, per `space::resolve_block_space`.
///
/// The comment on the filter claimed the target subquery was "a verbatim copy
/// of `space::resolve_block_space`'s SQL". It was not: it read only
/// `blocks.space_id` and omitted the owning-page fallback, while the source
/// side got the fallback for free by calling `resolve_block_space` directly.
/// `blocks.space_id` on a freshly created content block is NULL until the
/// post-commit `SetBlockPageId` task stamps it, so inside that window a
/// SAME-space target resolved to NULL, `NULL = ?3` was falsy, and a legitimate
/// link was silently dropped. Reachable through the in-tx edit hook, where the
/// source's `space_id` is long since stamped.
///
/// Both targets below sit on pages in the source's space. Only the one whose
/// own `space_id` column happens to be materialised survived the old filter.
///
/// Filed as its own issue (#3903) rather than riding the #3842/#3839 rollup
/// PR's closing keywords, so a bisect that lands here finds a title about THIS
/// defect. The fix is strictly widening — see the filter's comment.
#[tokio::test]
async fn reindex_block_links_target_space_falls_back_to_owning_page_3903() {
    let (pool, _dir) = test_pool().await;
    let space1 = "01SPACE0000000000000000001";
    cs375_insert_page(&pool, space1).await;

    // Source page + source block, both stamped with space1.
    let src_page = "01SRCPAGE3894000000000000A";
    cs375_insert_page(&pool, src_page).await;
    cs375_set_space(&pool, src_page, space1).await;

    // The target's owning page, in space1. `cs375_set_space` stamps the page
    // AND everything paged to it, so insert the children AFTER it to leave
    // their own `space_id` NULL — the pre-`SetBlockPageId` state.
    let tgt_page = "01TGTPAGE3894000000000000B";
    cs375_insert_page(&pool, tgt_page).await;
    cs375_set_space(&pool, tgt_page, space1).await;

    // Target A: `space_id` not yet materialised, but its page is in space1.
    let tgt_pending = "01TGTPEND3894000000000000C";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
         VALUES (?, 'content', 'pending', ?, ?)",
    )
    .bind(tgt_pending)
    .bind(tgt_page)
    .bind(tgt_page)
    .execute(&pool)
    .await
    .unwrap();
    // Target B: same page, `space_id` already stamped — the control.
    let tgt_stamped = "01TGTSTMP3894000000000000D";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
         VALUES (?, 'content', 'stamped', ?, ?, ?)",
    )
    .bind(tgt_stamped)
    .bind(tgt_page)
    .bind(tgt_page)
    .bind(space1)
    .execute(&pool)
    .await
    .unwrap();

    let src_block = "01SRCBLOK3894000000000000E";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
         VALUES (?, 'content', ?, ?, ?, ?)",
    )
    .bind(src_block)
    .bind(format!("(({tgt_pending})) (({tgt_stamped}))"))
    .bind(src_page)
    .bind(src_page)
    .bind(space1)
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links(&pool, src_block).await.unwrap();

    let mut targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(src_block)
            .fetch_all(&pool)
            .await
            .unwrap();
    targets.sort();
    assert_eq!(
        targets,
        vec![tgt_pending.to_string(), tgt_stamped.to_string()],
        "a target whose own space_id is not yet materialised must resolve through its \
         owning page, exactly as resolve_block_space does for the source — dropping it \
         loses a same-space link permanently (#3903)"
    );
}

/// #375 helpers: a space-marker page (its own `page_id`) and a
/// `blocks.space_id` stamp on a block.
async fn cs375_insert_page(pool: &SqlitePool, id: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)")
        .bind(id)
        .bind(id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}
async fn cs375_set_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
    // #708: register the space (blocks.space_id REFERENCES spaces(id)).
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    // Phase 2 (#533): space membership is read from `blocks.space_id`.
    // Set the denormalized column on the block and any block paged to it.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(space_id)
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// #375: the production `reindex_block_links_split` path (read_pool present)
/// must apply the same cross-space exclusion as the single-pool variant.
/// Regression — the split INSERT previously omitted the cross-space filter.
#[tokio::test]
async fn reindex_block_links_split_excludes_cross_space_375() {
    let (pool, _dir) = test_pool().await;
    let space1 = "01SPACE0000000000000000001";
    let space2 = "01SPACE0000000000000000002";
    cs375_insert_page(&pool, space1).await;
    cs375_insert_page(&pool, space2).await;

    let src_page = "01SRCPAGE000000000000000AA";
    cs375_insert_page(&pool, src_page).await;
    cs375_set_space(&pool, src_page, space1).await;

    let tgt_same = "01TGTSAME000000000000000BB";
    let tgt_cross = "01TGTCROS000000000000000CC";
    cs375_insert_page(&pool, tgt_same).await;
    cs375_set_space(&pool, tgt_same, space1).await;
    cs375_insert_page(&pool, tgt_cross).await;
    cs375_set_space(&pool, tgt_cross, space2).await;

    let src_block = "01SRCBLOK000000000000000EE";
    // Phase 2 (#533): `resolve_block_space` reads the SOURCE block's own
    // `blocks.space_id`, so set it directly here.
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) VALUES (?, 'content', ?, ?, ?, ?)")
        .bind(src_block)
        .bind(format!("[[{tgt_same}]] [[{tgt_cross}]]"))
        .bind(src_page)
        .bind(src_page)
        .bind(space1)
        .execute(&pool)
        .await
        .unwrap();

    reindex_block_links_split(&pool, &pool, src_block)
        .await
        .unwrap();

    let mut targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(src_block)
            .fetch_all(&pool)
            .await
            .unwrap();
    targets.sort();
    assert_eq!(
        targets,
        vec![tgt_same.to_string()],
        "the split path must exclude the cross-space target, like single-pool"
    );
}

/// #3903, split arm: the owning-page fallback in the pushed-down cross-space
/// filter must hold on `reindex_block_links_split` too.
///
/// The two `INSERT … SELECT` statements are textual twins — `_split`'s comment
/// says so outright ("a verbatim copy of the single-pool variant's SQL") — but
/// only the single-pool arm had a #3903 regression test, so nothing held the
/// split copy to it. That is the half of the pair that could silently rot: the
/// split path is the one the materializer actually takes whenever a read pool
/// is configured (`task_handlers::run_reindex_block_links` picks `_split` when
/// `read_pool` is `Some`, `reindex_block_links` otherwise), so a regression
/// here would hit the production configuration while the covered arm stayed
/// green.
///
/// Same fixture as `reindex_block_links_target_space_falls_back_to_owning_page_3903`:
/// both targets sit on a page in the source's space, but only one has its own
/// `blocks.space_id` materialised. The other is in the window before
/// `SetBlockPageId`'s `set_block_space_id_from_parent` stamps it, and must
/// still resolve — through its owning page — as same-space.
#[tokio::test]
async fn reindex_block_links_split_target_space_falls_back_to_owning_page_3903() {
    let (pool, _dir) = test_pool().await;
    let space1 = "01SPACE0000000000000000001";
    cs375_insert_page(&pool, space1).await;

    let src_page = "01SRCPAGE3903SPT000000000A";
    cs375_insert_page(&pool, src_page).await;
    cs375_set_space(&pool, src_page, space1).await;

    // The target's owning page, in space1. `cs375_set_space` stamps the page
    // AND everything already paged to it, so the children are inserted AFTER
    // it to leave their own `space_id` NULL — the pre-`SetBlockPageId` state.
    let tgt_page = "01TGTPAGE3903SPT000000000B";
    cs375_insert_page(&pool, tgt_page).await;
    cs375_set_space(&pool, tgt_page, space1).await;

    // Target A: `space_id` not yet materialised, but its page is in space1.
    let tgt_pending = "01TGTPEND3903SPT000000000C";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
         VALUES (?, 'content', 'pending', ?, ?)",
    )
    .bind(tgt_pending)
    .bind(tgt_page)
    .bind(tgt_page)
    .execute(&pool)
    .await
    .unwrap();
    // Target B: same page, `space_id` already stamped — the control.
    let tgt_stamped = "01TGTSTMP3903SPT000000000D";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
         VALUES (?, 'content', 'stamped', ?, ?, ?)",
    )
    .bind(tgt_stamped)
    .bind(tgt_page)
    .bind(tgt_page)
    .bind(space1)
    .execute(&pool)
    .await
    .unwrap();

    let src_block = "01SRCBLOK3903SPT000000000E";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
         VALUES (?, 'content', ?, ?, ?, ?)",
    )
    .bind(src_block)
    .bind(format!("(({tgt_pending})) (({tgt_stamped}))"))
    .bind(src_page)
    .bind(src_page)
    .bind(space1)
    .execute(&pool)
    .await
    .unwrap();

    reindex_block_links_split(&pool, &pool, src_block)
        .await
        .unwrap();

    let mut targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(src_block)
            .fetch_all(&pool)
            .await
            .unwrap();
    targets.sort();
    assert_eq!(
        targets,
        vec![tgt_pending.to_string(), tgt_stamped.to_string()],
        "the split path must resolve an unstamped target's space through its owning \
         page, exactly as the single-pool path does — otherwise the same-space link is \
         dropped permanently on the very path production takes when a read pool is \
         configured (#3903)"
    );
}

/// #375: the production `reindex_block_tag_refs_split` path must exclude
/// cross-space tags AND soft-deleted tags. Regression — the split INSERT
/// previously dropped both the cross-space filter and the `deleted_at IS NULL`
/// guard on the tag-existence EXISTS.
#[tokio::test]
async fn reindex_block_tag_refs_split_excludes_cross_space_and_deleted_tag_375() {
    let (pool, _dir) = test_pool().await;
    let space1 = "01SPACE0000000000000000001";
    let space2 = "01SPACE0000000000000000002";
    cs375_insert_page(&pool, space1).await;
    cs375_insert_page(&pool, space2).await;

    let src_page = "01SRCPAGE000000000000000AA";
    cs375_insert_page(&pool, src_page).await;
    cs375_set_space(&pool, src_page, space1).await;

    let tag_same = "01TAGSAME000000000000000T1";
    let tag_cross = "01TAGCROS000000000000000T2";
    let tag_deleted = "01TAGDELT000000000000000T3";
    insert_block(&pool, tag_same, "tag", "same").await;
    cs375_set_space(&pool, tag_same, space1).await;
    insert_block(&pool, tag_cross, "tag", "cross").await;
    cs375_set_space(&pool, tag_cross, space2).await;
    insert_block(&pool, tag_deleted, "tag", "deleted").await;
    cs375_set_space(&pool, tag_deleted, space1).await;
    soft_delete_block(&pool, tag_deleted).await;

    let src_block = "01SRCBLOK000000000000000E2";
    // Phase 2 (#533): `resolve_block_space` reads the SOURCE block's own
    // `blocks.space_id`, so set it directly here.
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) VALUES (?, 'content', ?, ?, ?, ?)")
        .bind(src_block)
        .bind(format!("{} {} {}", inline(tag_same), inline(tag_cross), inline(tag_deleted)))
        .bind(src_page)
        .bind(src_page)
        .bind(space1)
        .execute(&pool)
        .await
        .unwrap();

    reindex_block_tag_refs_split(&pool, &pool, src_block)
        .await
        .unwrap();

    let mut tags: Vec<String> =
        sqlx::query_scalar("SELECT tag_id FROM block_tag_refs WHERE source_id = ?")
            .bind(src_block)
            .fetch_all(&pool)
            .await
            .unwrap();
    tags.sort();
    assert_eq!(
        tags,
        vec![tag_same.to_string()],
        "split path must keep only the same-space, live tag; the cross-space \
         and soft-deleted tags must be dropped"
    );
}

/// #375: the full rebuild (`compute_desired_pairs`) must apply the same
/// cross-space exclusion the incremental path does — otherwise a snapshot
/// restore / boot fallback / explicit rebuild re-admits cross-space tag-refs.
#[tokio::test]
async fn rebuild_block_tag_refs_cache_excludes_cross_space_375() {
    let (pool, _dir) = test_pool().await;
    let space1 = "01SPACE0000000000000000001";
    let space2 = "01SPACE0000000000000000002";
    cs375_insert_page(&pool, space1).await;
    cs375_insert_page(&pool, space2).await;

    let src_page = "01SRCPAGE000000000000000AA";
    cs375_insert_page(&pool, src_page).await;
    cs375_set_space(&pool, src_page, space1).await;

    let tag_same = "01TAGSAME000000000000000T1";
    let tag_cross = "01TAGCROS000000000000000T2";
    insert_block(&pool, tag_same, "tag", "same").await;
    cs375_set_space(&pool, tag_same, space1).await;
    insert_block(&pool, tag_cross, "tag", "cross").await;
    cs375_set_space(&pool, tag_cross, space2).await;

    let src_block = "01SRCBLOK000000000000000E3";
    // Phase 2 (#533): the full rebuild reads each block's own
    // `blocks.space_id`, so set the SOURCE block's column directly here.
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) VALUES (?, 'content', ?, ?, ?, ?)")
        .bind(src_block)
        .bind(format!("{} {}", inline(tag_same), inline(tag_cross)))
        .bind(src_page)
        .bind(src_page)
        .bind(space1)
        .execute(&pool)
        .await
        .unwrap();

    super::rebuild_block_tag_refs_cache(&pool).await.unwrap();

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id, tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![(src_block.to_string(), tag_same.to_string())],
        "the full rebuild must exclude the cross-space tag-ref"
    );
}

/// SQL/C9(b) (#345): the page-link rollup keys edges by the OWNING PAGE
/// (`blocks.page_id`), not the immediate parent. A link inside a block
/// nested two levels under a page must roll up to the page, not the
/// intermediate block. This test seeds page → mid block → leaf block
/// (link), reindexes, and asserts the `page_link_cache` source is the
/// page id.
#[tokio::test]
async fn reindex_page_link_cache_rolls_up_to_owning_page_c9b() {
    let (pool, _dir) = test_pool().await;

    async fn insert_node(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        page_id: &str,
    ) {
        sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, page_id) VALUES (?, ?, ?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .bind(parent_id)
            .bind(page_id)
            .execute(pool)
            .await
            .unwrap();
    }

    let page = "01PAGEOWN000000000000000AA";
    let target = "01PAGETGT000000000000000BB";
    let mid = "01MIDBLOK000000000000000CC";
    let leaf = "01LEAFBLK000000000000000DD";
    insert_node(&pool, page, "page", "Owner", None, page).await;
    insert_node(&pool, target, "page", "Target", None, target).await;
    // mid is a child of the page; leaf is a child of mid (2 levels deep).
    // Both have page_id = page (the denormalised owner).
    insert_node(&pool, mid, "content", "mid", Some(page), page).await;
    insert_node(
        &pool,
        leaf,
        "content",
        &format!("deep [[{target}]]"),
        Some(mid),
        page,
    )
    .await;

    // The leaf's block_links edge (written by reindex_block_links).
    reindex_block_links(&pool, leaf).await.unwrap();
    // Roll up into page_link_cache.
    reindex_page_link_cache_for_block(&pool, leaf)
        .await
        .unwrap();

    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT source_page_id, target_page_id, edge_count FROM page_link_cache")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![(page.to_string(), target.to_string(), 1)],
        "edge from a 2-level-nested block must roll up to the owning page \
         (blocks.page_id), NOT the immediate parent block"
    );
}

/// SQL/C2 (#342): the full `pages_cache` rebuild UPSERTs only
/// `(page_id, title, updated_at)`; before the fix the two aggregate
/// columns fell to DEFAULT 0 on every fresh insert, so after a
/// snapshot/sync RESET (which wipes `pages_cache` then re-inserts) every
/// page read count = 0 until an unrelated per-op edit touched it. This
/// test seeds links + child blocks, runs the full rebuild from an EMPTY
/// cache (the RESET state), and asserts both counts equal a
/// from-first-principles recompute (NOT a copy of the production SQL —
/// the child count walks the tree, the inbound count is pinned with a
/// literal too).
#[tokio::test]
async fn rebuild_pages_cache_recomputes_counts_c2() {
    let (pool, _dir) = test_pool().await;

    // Helper: insert a block with an explicit page_id (the rebuild's
    // count subqueries read the denormalised `blocks.page_id`).
    async fn insert_with_page(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        page_id: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    }

    // Two pages. PAGE-A owns two content children; a block on PAGE-B
    // links into PAGE-A (one inbound link, cross-page so it counts).
    insert_with_page(&pool, "PAGEAAAA", "page", "Page A", None, Some("PAGEAAAA")).await;
    insert_with_page(&pool, "PAGEBBBB", "page", "Page B", None, Some("PAGEBBBB")).await;
    insert_with_page(
        &pool,
        "CHILDAA1",
        "content",
        "child one",
        Some("PAGEAAAA"),
        Some("PAGEAAAA"),
    )
    .await;
    insert_with_page(
        &pool,
        "CHILDAA2",
        "content",
        "child two [[PAGEAAAA]]",
        Some("PAGEAAAA"),
        Some("PAGEAAAA"),
    )
    .await;
    insert_with_page(
        &pool,
        "CHILDBB1",
        "content",
        "see [[PAGEAAAA]]",
        Some("PAGEBBBB"),
        Some("PAGEBBBB"),
    )
    .await;

    // block_links: CHILDBB1 (on PAGE-B) → PAGE-A is a cross-page inbound
    // edge for PAGE-A. CHILDAA2 (on PAGE-A) → PAGE-A is a same-page link
    // and must be EXCLUDED from PAGE-A's inbound count.
    for (src, tgt) in [("CHILDBB1", "PAGEAAAA"), ("CHILDAA2", "PAGEAAAA")] {
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }

    // RESET state: cache is empty before the full rebuild.
    let pre: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pre, 0, "cache must start empty (RESET state)");

    // #417: the title/orphan rebuild now only inserts the page rows with
    // DEFAULT-0 counts; the count recompute moved to the dedicated
    // RESET-path entry point. Mirror the production snapshot ordering:
    // RebuildPagesCache (rows) THEN RebuildPagesCacheCounts (counts).
    rebuild_pages_cache(&pool).await.unwrap();
    rebuild_pages_cache_counts(&pool).await.unwrap();

    // From-first-principles canonical counts (independent of the
    // production recompute SQL). child_block_count walks the parent tree;
    // inbound_link_count is asserted both structurally and with literals.
    async fn canonical(pool: &SqlitePool, page_id: &str) -> (i64, i64) {
        let child: i64 = sqlx::query_scalar(
            "WITH RECURSIVE owned(id, block_type, depth) AS ( \
                 SELECT b.id, b.block_type, 0 FROM blocks b \
                 WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
                 UNION ALL \
                 SELECT b.id, b.block_type, o.depth + 1 FROM blocks b \
                 JOIN owned o ON b.parent_id = o.id \
                 WHERE b.deleted_at IS NULL AND o.block_type != 'page' AND o.depth < 100 \
             ) SELECT COUNT(*) FROM owned WHERE block_type != 'page'",
        )
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let inbound: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                 JOIN blocks descendant ON bl.target_id = descendant.id \
                 JOIN blocks src ON src.id = bl.source_id \
             WHERE descendant.page_id = ?1 AND descendant.deleted_at IS NULL \
               AND src.deleted_at IS NULL AND src.page_id IS NOT NULL \
               AND src.page_id != ?1",
        )
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap();
        (inbound, child)
    }

    let cached = |page_id: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (i64, i64)>(
                "SELECT inbound_link_count, child_block_count FROM pages_cache WHERE page_id = ?",
            )
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    // PAGE-A: 2 children, 1 cross-page inbound link (same-page excluded).
    let canon_a = canonical(&pool, "PAGEAAAA").await;
    assert_eq!(canon_a, (1, 2), "canonical PAGE-A counts pinned by literal");
    assert_eq!(
        cached("PAGEAAAA").await,
        canon_a,
        "rebuild must recompute PAGE-A counts, not leave them DEFAULT 0"
    );

    // PAGE-B: 1 child, 0 inbound links.
    let canon_b = canonical(&pool, "PAGEBBBB").await;
    assert_eq!(canon_b, (0, 1), "canonical PAGE-B counts pinned by literal");
    assert_eq!(
        cached("PAGEBBBB").await,
        canon_b,
        "rebuild must recompute PAGE-B counts"
    );
}

/// #3891, the gate's SKIP branch: a stale key with no cached row is not
/// recomputed — and that is observable, so it is pinned rather than assumed.
///
/// The gate's rationale reads "a key with no cached row has nothing stranded
/// to sweep". True, but it is worth being exact about the boundary, because
/// the skip is NOT a literal no-op: with no row under the key the zero-edge
/// DELETE matches nothing, yet the UPSERT could still ADD rows for targets
/// rolling up to that key from a DIFFERENT live block. This fixture is that
/// state, and the ungated form converges on it where the gated form does not
/// — so "no observable difference" would be the wrong reason to leave the
/// branch untested.
///
/// `k` is a top-level content block (no parent, no page), so its own roll-up
/// key is itself, and it links to `t`. `b` is its child but has `page_id`
/// stamped to `p`, so `b`'s current key is `p` and its stale keys are
/// `[k, b]`. `page_link_cache` starts EMPTY, modelling `k`'s own
/// `ReindexBlockLinks` never having run (or having failed and still being
/// pending retry) — i.e. a cache that was already divergent before this call.
///
/// Reindexing `b` must write `b`'s own key and leave `k` alone. The row under
/// `k` is owed by `k`'s own ungated reindex or by the full rebuild, not by a
/// sibling's stale-key sweep. Asserting it here means a future removal of the
/// gate turns this red and sends the reader to the rationale, while making the
/// skip UNCONDITIONAL turns the three #3842 tests red instead — the branch is
/// pinned from both sides.
#[tokio::test]
async fn reindex_page_link_cache_for_block_skips_an_unstranded_stale_key_3891() {
    let (pool, _dir) = test_pool().await;
    let p = "PP000000000000000000000000";
    let t = "TT000000000000000000000000";
    let k = "KK000000000000000000000000";
    let b = "BB000000000000000000000000";

    for id in [p, t] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', '', ?)",
        )
        .bind(id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
        .bind(k)
        .bind(format!("[[{t}]]"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
         VALUES (?, 'content', ?, ?, ?)",
    )
    .bind(b)
    .bind(format!("[[{t}]]"))
    .bind(k)
    .bind(p)
    .execute(&pool)
    .await
    .unwrap();

    for src in [k, b] {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(t)
            .execute(&pool)
            .await
            .unwrap();
    }

    reindex_page_link_cache_for_block(&pool, b).await.unwrap();

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache ORDER BY 1, 2",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(p.to_owned(), t.to_owned(), 1)],
        "the gated sweep must write only the block's CURRENT key; the stale key `k` \
         carries no cached row, so there is nothing stranded under it to drop, and the \
         row `k` itself supports is owed by `k`'s own ungated reindex or the full \
         rebuild — not by a sibling's stale-key sweep (#3891)"
    );

    // The gate is what produces that state, not the fixture: the full rebuild
    // — the definition both paths must converge on eventually — does hold the
    // `k` row. Pinning the difference keeps the trade-off honest rather than
    // letting it read as agreement.
    rebuild_page_link_cache(&pool).await.unwrap();
    let rebuilt: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache ORDER BY 1, 2",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rebuilt,
        vec![
            (k.to_owned(), t.to_owned(), 1),
            (p.to_owned(), t.to_owned(), 1),
        ],
        "the full rebuild defines the `k` row as belonging in the cache, so the gate \
         forgoes an OPPORTUNISTIC repair of an already-divergent cache — it does not \
         drop a repair the reindexed block itself owes (#3891)"
    );
}

// ====================================================================
// block_links_unresolved (#4118)
// ====================================================================

/// Read the unresolved link tokens recorded for `source_id`.
async fn unresolved_targets(pool: &SqlitePool, source_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT target_id FROM block_links_unresolved WHERE source_id = ? ORDER BY target_id",
    )
    .bind(source_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// #4118 — a token whose target does not exist yet is DROPPED from
/// `block_links` (the INSERT's `WHERE EXISTS` guard) and, before this issue,
/// was forgotten with it. The reindexer's only trigger is a change to the
/// SOURCE's content, so once the target arrived nothing re-ran it and the edge
/// was gone permanently.
///
/// The drop itself is correct — `block_links.target_id REFERENCES blocks(id)`,
/// so a dangling edge is not storable. What must not happen is losing the
/// *knowledge* that the edge is owed. This pins the whole life-cycle of that
/// knowledge on the store side: recorded on the drop, and gone the moment the
/// edge exists.
#[tokio::test]
async fn block_links_records_a_token_whose_target_does_not_exist_yet_4118() {
    let (pool, _dir) = test_pool().await;

    let src = "01HZ0000000000000000000SRC";
    let tgt = "01HZ00000000000000000000AB";
    insert_block(&pool, src, "content", &format!("see [[{tgt}]]")).await;

    reindex_block_links(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "a token whose target is not in `blocks` cannot become an edge — the FK on \
         target_id makes it unstorable"
    );
    assert_eq!(
        unresolved_targets(&pool, src).await,
        vec![tgt.to_owned()],
        "#4118: the dropped token must be RECORDED, keyed for lookup by target — that \
         record is the only thing that can re-link the edge later, because the \
         reindexer is triggered by the SOURCE's content and the source never changes"
    );

    // The target arrives. A reindex of the source now admits the edge, and the
    // record of the debt goes with it.
    insert_block(&pool, tgt, "content", "target").await;
    reindex_block_links(&pool, src).await.unwrap();

    let edges: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(src)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        edges,
        vec![tgt.to_owned()],
        "once the target exists the same content must produce the edge"
    );
    assert!(
        unresolved_targets(&pool, src).await.is_empty(),
        "a resolved token must stop being recorded as unresolved — otherwise every \
         future arrival of any block would re-drive a repair that is already done"
    );
}

/// #4118 — a token that leaves the content while it is STILL unresolved must
/// drop its record.
///
/// This is the case the pre-#4118 `to_delete.is_empty() && to_insert.is_empty()`
/// early return would have skipped, and it is not reachable by either arm of
/// the diff: such a token never had a `block_links` row (so it is not in
/// `to_delete`) and is no longer in the content (so it is not in `to_insert`).
/// Its record would have survived every subsequent reindex of the source and
/// kept re-driving a repair for a reference that no longer exists — a slow
/// leak of permanent work.
#[tokio::test]
async fn block_links_forgets_an_unresolved_token_removed_from_content_4118() {
    let (pool, _dir) = test_pool().await;

    let src = "01HZ0000000000000000000SRC";
    let ghost = "01HZ00000000000000000000AB";
    insert_block(&pool, src, "content", &format!("see [[{ghost}]]")).await;
    reindex_block_links(&pool, src).await.unwrap();
    assert_eq!(
        unresolved_targets(&pool, src).await,
        vec![ghost.to_owned()],
        "seed: the token to the absent target is recorded"
    );

    sqlx::query("UPDATE blocks SET content = 'no links here' WHERE id = ?")
        .bind(src)
        .execute(&pool)
        .await
        .unwrap();
    reindex_block_links(&pool, src).await.unwrap();

    assert!(
        unresolved_targets(&pool, src).await.is_empty(),
        "#4118: an unresolved token the content no longer names is owed by nobody; \
         leaving the row behind would make the target's eventual arrival re-link an \
         edge the source has since deleted"
    );
}

/// #4118 — the same recording on the READ/WRITE-SPLIT writer.
///
/// The split variant is a second, hand-maintained copy of the same diff (that
/// duplication is what #375 and #3903 were both about), so it gets its own
/// pin: the production materializer picks it whenever a read pool is
/// configured, and a fix that landed only in the single-pool copy would leave
/// exactly the deployments that carry the most sync traffic still losing edges.
#[tokio::test]
async fn block_links_split_records_and_clears_unresolved_tokens_4118() {
    let (pool, _dir) = test_pool().await;

    let src = "01HZ0000000000000000000SRC";
    let tgt = "01HZ00000000000000000000AB";
    insert_block(&pool, src, "content", &format!("see [[{tgt}]]")).await;

    reindex_block_links_split(&pool, &pool, src).await.unwrap();
    assert_eq!(
        unresolved_targets(&pool, src).await,
        vec![tgt.to_owned()],
        "#4118: the split writer must record the dropped token too"
    );

    insert_block(&pool, tgt, "content", "target").await;
    reindex_block_links_split(&pool, &pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        1,
        "the split writer must admit the edge once the target exists"
    );
    assert!(
        unresolved_targets(&pool, src).await.is_empty(),
        "and clear the record it wrote"
    );
}

/// #4118 case 2 — the cross-space filter's drop is recorded too.
///
/// This is the residual window #3903/#3894 left behind: the filter itself is
/// now correct, but a target whose `space_id` has not been stamped yet still
/// resolves to NULL, `NULL = ?3` is still falsy, and the edge is still
/// dropped. `space_id` is stamped POST-COMMIT by `SetBlockPageId`, so this is
/// not an exotic race — it is the ordinary shape of a create.
#[tokio::test]
async fn block_links_records_a_target_whose_space_is_not_stamped_yet_4118() {
    let (pool, _dir) = test_pool().await;

    let space = "01HZ0000000000000000000SPC";
    let src = "01HZ0000000000000000000SRC";
    let tgt = "01HZ00000000000000000000AB";

    insert_block(&pool, space, "page", "space root").await;
    sqlx::query("UPDATE blocks SET page_id = id WHERE id = ?")
        .bind(space)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(space)
        .execute(&pool)
        .await
        .unwrap();

    insert_block(&pool, src, "content", &format!("see [[{tgt}]]")).await;
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ?")
        .bind(space)
        .bind(src)
        .execute(&pool)
        .await
        .unwrap();
    // The target exists and is live, but carries neither its own `space_id`
    // nor a `page_id` to inherit one through — the state a block is in between
    // its create commit and the deferred `SetBlockPageId`.
    insert_block(&pool, tgt, "content", "target").await;

    reindex_block_links(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        0,
        "seed: an unresolvable target space is falsy against the source's, so the \
         cross-space filter drops the edge"
    );
    assert_eq!(
        unresolved_targets(&pool, src).await,
        vec![tgt.to_owned()],
        "#4118: a drop by the SPACE filter is owed exactly as much as a drop by the \
         existence guard — the target becomes linkable when its space is stamped"
    );

    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ?")
        .bind(space)
        .bind(tgt)
        .execute(&pool)
        .await
        .unwrap();
    reindex_block_links(&pool, src).await.unwrap();

    assert_eq!(
        count_rows(&pool, "block_links").await,
        1,
        "once the space is stamped the same content must produce the edge"
    );
    assert!(
        unresolved_targets(&pool, src).await.is_empty(),
        "and the record must clear"
    );
}

// ====================================================================
// rebuild_block_links_unresolved (#4218)
// ====================================================================

/// Every `(source, target)` obligation in the vault, sorted.
async fn all_unresolved(pool: &SqlitePool) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> =
        sqlx::query_as("SELECT source_id, target_id FROM block_links_unresolved")
            .fetch_all(pool)
            .await
            .unwrap();
    rows.sort();
    rows
}

/// Plant an obligation row the writers would never have produced.
async fn plant_unresolved(pool: &SqlitePool, source: &str, target: &str) {
    sqlx::query("INSERT INTO block_links_unresolved (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .unwrap();
}

/// #4218 — the vault-wide recompute, which the snapshot RESET runs in its own
/// transaction after wiping the table.
///
/// It must reproduce, for every source at once, exactly what
/// `sync_unresolved_links` produces for one: a live source owes a target when
/// its content names the token and no `block_links` row carries the edge.
///
/// The fixture puts one block in each equivalence class the rule distinguishes,
/// so an implementation that dropped any single clause changes the answer:
///
/// * a token whose target does not exist — OWED (the #4118 case);
/// * a token that IS an edge — NOT owed (the `NOT EXISTS block_links` clause);
/// * a token under a TOMBSTONED source — NOT owed (a reindex of a tombstone
///   clears its rows, so a rebuild must not resurrect them);
/// * a stale row naming a token nobody writes any more — WIPED, which is what
///   makes this a recompute rather than a top-up.
#[tokio::test]
async fn rebuild_block_links_unresolved_recomputes_the_whole_vault_4218() {
    let (pool, _dir) = test_pool().await;

    let owing = "01HZ00000000000000000OWING";
    let linked = "01HZ0000000000000000LINKED";
    let dead = "01HZ00000000000000000DEAD1";
    let absent = "01HZ0000000000000000ABSENT";
    let present = "01HZ000000000000000PRESENT";

    insert_block(&pool, present, "content", "the target").await;
    insert_block(&pool, owing, "content", &format!("see [[{absent}]]")).await;
    insert_block(&pool, linked, "content", &format!("see (({present}))")).await;
    insert_block(&pool, dead, "content", &format!("see [[{absent}]]")).await;
    soft_delete_block(&pool, dead).await;

    // The edge for `linked` really exists — the discharged case has to be a
    // real discharge, not an absent token.
    reindex_block_links(&pool, linked).await.unwrap();
    assert_eq!(
        count_rows(&pool, "block_links").await,
        1,
        "seed: the resolvable token must have become an edge"
    );

    // A row from the PREVIOUS vault, which is the state a snapshot RESET is
    // recovering from: the wipe empties the table, and anything that survived
    // would describe content this vault does not have.
    plant_unresolved(&pool, present, absent).await;

    rebuild_block_links_unresolved(&pool).await.unwrap();

    assert_eq!(
        all_unresolved(&pool).await,
        vec![(owing.to_owned(), absent.to_owned())],
        "#4218: exactly the live source whose token is not an edge owes anything — the \
         discharged token must not be re-owed, the tombstone must not be resurrected, \
         and the stale row must be gone"
    );

    // Idempotent: the rebuild is a recompute, so running it again on the state
    // it just produced must be a fixed point.
    rebuild_block_links_unresolved(&pool).await.unwrap();
    assert_eq!(
        all_unresolved(&pool).await,
        vec![(owing.to_owned(), absent.to_owned())],
        "a second rebuild must neither duplicate nor drop the obligation"
    );
}

/// #4218 — the degenerate vault. A rebuild with nothing to derive from must
/// write nothing and, in particular, must not fail: the snapshot RESET calls
/// it inside the restore transaction, so an error here would abort an
/// otherwise-valid restore, and an empty snapshot is a legal one.
#[tokio::test]
async fn rebuild_block_links_unresolved_on_an_empty_vault_writes_nothing_4218() {
    let (pool, _dir) = test_pool().await;

    rebuild_block_links_unresolved(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "block_links_unresolved").await,
        0,
        "a vault with no blocks owes nothing"
    );

    // A vault with blocks but no link syntax at all takes the same path
    // through the content pre-filter and must also come out empty.
    insert_block(&pool, "01HZ00000000000000000PLAIN", "content", "no links").await;
    insert_block_null_content(&pool, "01HZ0000000000000000000NUL", "content").await;
    rebuild_block_links_unresolved(&pool).await.unwrap();
    assert_eq!(
        count_rows(&pool, "block_links_unresolved").await,
        0,
        "content with no tokens — and NULL content — owe nothing"
    );
}

// ====================================================================
// #4242 — the residency measurement behind the `fetch_all` -> streaming
// change in `rebuild_block_links_unresolved_conn`
// ====================================================================
//
// The change was justified by a `/proc/self/status` diagnostic that was then
// THROWN AWAY, so its numbers could never be re-verified and a future
// regression in the same function had nothing to measure against. This is
// that diagnostic, landed instead of deleted, in the same `#[ignore]`d
// deep-checks shape the reconciliation-oracle scale sweeps use
// (`scheduled-deep-checks.yml`'s `bench-slo` job runs
// `cargo nextest run --workspace --run-ignored=only`, so `--workspace` picks
// these up from this crate).
//
// It pins NO memory threshold. A byte budget for peak RSS would be a number
// invented rather than measured — it moves with the allocator, the libc, the
// SQLite page cache and the runner — and a red weekly lane on allocator noise
// teaches people to ignore the lane. What it DOES pin is the equivalence the
// rewrite has to preserve: the streamed fold and the old buffered fold must
// derive byte-identical obligations from the same vault. The residency
// numbers are printed for a human (or a future bisect) to read.
//
// # One variable
//
// The discarded diagnostic compared two vault SHAPES that differed in block
// count, content size AND link density at once, so "grows with vault size"
// was not something it could actually separate out. Here content size and
// link-bearing share are HELD FIXED (`RSS_CONTENT_BYTES`,
// `RSS_LINK_BEARING_PERCENT`) and only the block count moves, across the
// three `_4242` tests below. Whatever the three printed gaps do as a
// function of block count is therefore a statement about block count alone.
//
// # Method, and its known bias
//
// Each test runs in its OWN process (nextest executes every test in a
// separate process), so its baseline is not polluted by a sibling's heap.
// Within a process each arm resets the kernel's peak-RSS watermark
// (`/proc/self/clear_refs`, mode 5 — Linux 4.0+) so `VmHWM` afterwards is the
// peak reached DURING that arm rather than over the process's whole life,
// which the 100k-row seeding would otherwise dominate.
//
// There are TWO known biases, and both point the same way — DOWNWARD, so the
// buffered arm's true footprint is at least what is printed, never less. That
// is the conservative direction for a claim of the form "buffering costs
// memory", which is why the arrangement is left as it is.
//
// 1. ARENA WARMTH. The two arms share one heap and the STREAMING arm runs
//    first, so its peak is measured against a cold-ish arena while the
//    BUFFERED arm runs second and can satisfy part of its demand from what
//    the first arm just freed. Running them in the other order would flatter
//    the change and is deliberately not what happens here.
//
// 2. ARM ASYMMETRY. Arm 1 is the whole production function, INCLUDING the
//    chunked INSERT of the obligation rows; arm 2 replicates only the
//    pre-#4242 read and fold, not the write that followed it. So the streamed
//    arm's peak carries write-path residency the buffered arm never pays,
//    which shrinks the measured gap by however much that write costs. This is
//    a bias in the measurement, not a flaw in the comparison — the read+fold
//    is the part #4242 changed — but it is a second reason the printed gap
//    understates the difference, and the doc would be misleading if it named
//    only the first.
//
// Linux-only: the whole apparatus reads `/proc/self`. `bench-slo` runs on
// `ubuntu-24.04`, and on any other host these tests simply do not exist.
//
// # Observed when this landed
//
// One unloaded dev box, debug profile, glibc malloc — a REFERENCE POINT for a
// future bisect, not a budget and not something any assertion below reads:
//
//   blocks | streamed kB | buffered kB |  gap kB | gap % | wall
//   -------+-------------+-------------+---------+-------+------
//     20k  |      20,460 |      20,980 |     520 |  2.5% | 1.0s
//     50k  |      47,992 |      56,104 |   8,112 | 14.5% | 2.0s
//    100k  |      96,520 |     112,136 |  15,616 | 13.9% | 4.0s
//
// The 100k point reproduces the discarded diagnostic's headline (it reported
// 14.64% at 100k) closely enough to believe the original was measuring what
// it said it was. What the three points add, and the original could not, is
// that the ABSOLUTE gap grows with block count — with content size and link
// density pinned, so that growth is attributable to block count and nothing
// else.
//
// The 20k point is the one NOT to read as a measurement of anything. Repeat
// runs put it at 520 kB and at 0 kB, and 0 kB is what the method predicts
// there: the whole buffered content vector is only ~6 MB, which fits inside
// the arena the streaming arm's transaction had just released, so `VmHWM`
// never has to move. It is kept as the low end of the sweep — a point where
// the effect is genuinely too small to see through the bias is worth showing
// — but the two larger points are the ones carrying the claim. The 50k and
// 100k gaps have been stable across runs to within a few hundred kB.
//
// Total weekly cost of all three: ~7s.

/// Bytes of `content` on every seeded block — HELD FIXED across the three
/// measurement points so block count is the only variable that moves.
#[cfg(target_os = "linux")]
const RSS_CONTENT_BYTES: usize = 425;

/// Percentage of seeded blocks carrying a link token — HELD FIXED, same
/// reason. Every link-bearing block carries exactly ONE token, so the
/// obligation count is exactly this share of the vault.
#[cfg(target_os = "linux")]
const RSS_LINK_BEARING_PERCENT: usize = 70;

/// Rows per seeding INSERT. `flush_rss_seed` binds three values per row (id,
/// block_type, content), so a chunk of 250 is 750 bind parameters per
/// statement — comfortably under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`, but
/// note the rate when raising it: the older 999 limit is crossed at 334 rows,
/// not 500. The seeder's own live buffer (`chunk * RSS_CONTENT_BYTES` bytes,
/// ~100 kB) stays three orders of magnitude below anything the arms measure.
#[cfg(target_os = "linux")]
const RSS_SEED_CHUNK: usize = 250;

/// Read one `kB`-valued field out of `/proc/self/status`.
#[cfg(target_os = "linux")]
fn proc_status_kb(field: &str) -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(field).and_then(|r| r.strip_prefix(':')) {
            return rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .expect("kB value");
        }
    }
    panic!("{field} missing from /proc/self/status");
}

/// Reset `VmHWM` to the current `VmRSS` (procfs `clear_refs` mode 5).
///
/// Returns false when the write is refused — some sandboxes mount `/proc`
/// restricted. The caller then falls back to sampling `VmRSS` at the arm's
/// end, which is a point-in-time reading rather than a peak, and says so in
/// its output rather than silently printing a different quantity under the
/// same label.
#[cfg(target_os = "linux")]
fn reset_peak_rss() -> bool {
    std::fs::write("/proc/self/clear_refs", "5").is_ok()
}

/// One arm's peak-over-baseline residency, in kB.
#[cfg(target_os = "linux")]
struct ArmResidency {
    peak_over_baseline_kb: u64,
    /// False when `clear_refs` was refused and `VmRSS` was sampled instead.
    is_true_peak: bool,
}

/// Seed `blocks` blocks at the fixed content size and link density.
///
/// Returns how many of them carry a token. Every link-bearing block names one
/// EXISTING block, so nothing here depends on the dangling-target case.
#[cfg(target_os = "linux")]
async fn seed_rss_vault(pool: &SqlitePool, blocks: usize) -> usize {
    assert_eq!(
        blocks % 100,
        0,
        "block count must be a multiple of 100 so the link density is exact"
    );
    let mut pending: Vec<(String, String)> = Vec::with_capacity(RSS_SEED_CHUNK);
    let mut link_bearing = 0usize;
    for i in 0..blocks {
        let id = format!("01BLK{i:021}");
        assert_eq!(id.len(), 26, "seed ids must be token-shaped");
        let content = if i % 100 < RSS_LINK_BEARING_PERCENT {
            link_bearing += 1;
            let target = format!("01BLK{:021}", (i + 1) % blocks);
            let mut c = format!("[[{target}]] ");
            c.push_str(&"x".repeat(RSS_CONTENT_BYTES - c.len()));
            c
        } else {
            // No `[[` and no `((`, so production's LIKE pre-filter drops these
            // before they are ever decoded — which is part of what the arms
            // are measuring.
            "y".repeat(RSS_CONTENT_BYTES)
        };
        assert_eq!(content.len(), RSS_CONTENT_BYTES);
        pending.push((id, content));
        if pending.len() == RSS_SEED_CHUNK {
            flush_rss_seed(pool, &mut pending).await;
        }
    }
    flush_rss_seed(pool, &mut pending).await;
    link_bearing
}

/// Insert one seeding chunk and clear it.
#[cfg(target_os = "linux")]
async fn flush_rss_seed(pool: &SqlitePool, pending: &mut Vec<(String, String)>) {
    if pending.is_empty() {
        return;
    }
    // Multi-row INSERT via `QueryBuilder`: the only dynamic part is how many
    // `VALUES` tuples the statement carries, every value is still a bind.
    let mut qb: sqlx::QueryBuilder<sqlx::Sqlite> =
        sqlx::QueryBuilder::new("INSERT INTO blocks (id, block_type, content) ");
    qb.push_values(pending.iter(), |mut row, (id, content)| {
        row.push_bind(id.as_str())
            .push_bind("content")
            .push_bind(content.as_str());
    });
    qb.build().execute(pool).await.unwrap();
    pending.clear();
}

/// Run one arm with the peak watermark reset around it.
#[cfg(target_os = "linux")]
async fn measure_arm<F, Fut, T>(arm: F) -> (T, ArmResidency)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let is_true_peak = reset_peak_rss();
    let baseline = proc_status_kb("VmRSS");
    let value = arm().await;
    let peak = proc_status_kb(if is_true_peak { "VmHWM" } else { "VmRSS" });
    (
        value,
        ArmResidency {
            peak_over_baseline_kb: peak.saturating_sub(baseline),
            is_true_peak,
        },
    )
}

/// The measurement itself, shared by the three block-count points.
///
/// Arm 1 is production (`rebuild_block_links_unresolved_conn`, streamed since
/// #4242), end to end — including the chunked INSERT of the obligation rows.
/// The `_conn` form is the one measured, not the pool wrapper: the wrapper
/// returns `Result<(), AppError>` through `rebuild_with_timing` and so cannot
/// return the `inserted` count the assertion below uses.
/// Arm 2 replicates the pre-#4242 READ AND FOLD only, not the write that
/// followed it: `fetch_all` the matched rows into a `Vec` and fold that, with
/// the row buffer still alive while the pair vector is built — the
/// simultaneity that was the whole cost.
///
/// The arms are therefore not symmetric, and deliberately so: the read+fold is
/// the part #4242 changed. But it means arm 1 pays a write-path peak arm 2
/// never does, which is the second of the two downward biases described in the
/// module comment above. Do not read arm 2 as "the whole pre-#4242 function".
#[cfg(target_os = "linux")]
#[allow(clippy::cast_precision_loss)]
async fn measure_unresolved_rebuild_residency(blocks: usize) {
    let (pool, _dir) = test_pool().await;
    let link_bearing = seed_rss_vault(&pool, blocks).await;
    assert!(link_bearing > 0, "the fixture must own some obligations");

    // Arm 1 — production, streamed, in a transaction of its own, which is the
    // shape the snapshot restore calls it in (`agaric-sync`'s
    // `snapshot/restore.rs` runs it inside the restore's own transaction).
    let (inserted, streamed) = measure_arm(|| async {
        let mut tx = pool.begin().await.expect("begin");
        let inserted = rebuild_block_links_unresolved_conn(&mut tx)
            .await
            .expect("streamed rebuild");
        tx.commit().await.expect("commit");
        inserted
    })
    .await;

    // Arm 2 — the pre-#4242 buffered shape, same SQL, same regex, same dedup.
    let (buffered_pairs, buffered) = measure_arm(|| async {
        // dynamic-sql: test-only replica of the pre-#4242 production read.
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, content FROM blocks \
             WHERE deleted_at IS NULL AND content IS NOT NULL \
               AND (content LIKE '%[[%' OR content LIKE '%((%')",
        )
        .fetch_all(&pool)
        .await
        .expect("buffered read");
        let mut pairs: Vec<(String, String)> = Vec::new();
        for (id, content) in &rows {
            let content = content.clone().unwrap_or_default();
            for cap in super::ulid_link_re().captures_iter(&content) {
                pairs.push((id.clone(), cap[1].to_owned()));
            }
        }
        // `rows` is deliberately still alive here: holding the whole content
        // buffer while the pairs are built is exactly what #4242 removed.
        assert_eq!(
            rows.len(),
            link_bearing,
            "the LIKE pre-filter must match \
             every link-bearing block and nothing else"
        );
        pairs.sort_unstable();
        pairs.dedup();
        pairs
    })
    .await;

    // THE PIN: the rewrite is an allocation change, not a semantic one.
    // `block_links` is empty in this fixture, so production's `NOT EXISTS`
    // clause discharges nothing and the two folds must agree exactly.
    assert_eq!(
        inserted,
        u64::try_from(buffered_pairs.len()).unwrap(),
        "the streamed fold and the pre-#4242 buffered fold must derive the same obligations"
    );
    assert_eq!(
        inserted,
        u64::try_from(link_bearing).unwrap(),
        "one token per link-bearing block, none of them already an edge"
    );
    assert_eq!(
        all_unresolved(&pool).await,
        buffered_pairs,
        "and the rows production wrote must BE that set, not merely count the same"
    );

    let gap = buffered
        .peak_over_baseline_kb
        .saturating_sub(streamed.peak_over_baseline_kb);
    let share = if buffered.peak_over_baseline_kb == 0 {
        0.0
    } else {
        100.0 * gap as f64 / buffered.peak_over_baseline_kb as f64
    };
    let quantity = if streamed.is_true_peak && buffered.is_true_peak {
        "peak-over-baseline RSS (VmHWM, watermark reset per arm)"
    } else {
        "END-OF-ARM RSS (VmRSS) — clear_refs was refused, so these are NOT peaks"
    };
    println!(
        "#4242 rebuild_block_links_unresolved residency @ {blocks} blocks \
         ({RSS_CONTENT_BYTES} B content/block, {RSS_LINK_BEARING_PERCENT}% link-bearing, \
         {link_bearing} obligations — content size and density HELD FIXED across points)\n  \
         quantity: {quantity}\n  \
         streamed (production, post-#4242): {} kB\n  \
         buffered (pre-#4242 fetch_all):    {} kB\n  \
         gap: {gap} kB = {share:.2}% of the buffered arm's peak \
         (a LOWER bound — the buffered arm runs second, on a warm arena)",
        streamed.peak_over_baseline_kb, buffered.peak_over_baseline_kb,
    );
}

/// #4242 point 1 of 3 — 20k blocks. See the module section above for method.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "deep-checks lane: seeds a 20k-block vault to measure rebuild peak residency"]
async fn rebuild_block_links_unresolved_residency_at_20k_blocks_4242() {
    measure_unresolved_rebuild_residency(20_000).await;
}

/// #4242 point 2 of 3 — 50k blocks, same content size and link density.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "deep-checks lane: seeds a 50k-block vault to measure rebuild peak residency"]
async fn rebuild_block_links_unresolved_residency_at_50k_blocks_4242() {
    measure_unresolved_rebuild_residency(50_000).await;
}

/// #4242 point 3 of 3 — 100k blocks, same content size and link density.
/// The largest of the three, and the one the discarded diagnostic quoted.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "deep-checks lane: seeds a 100k-block vault to measure rebuild peak residency"]
async fn rebuild_block_links_unresolved_residency_at_100k_blocks_4242() {
    measure_unresolved_rebuild_residency(100_000).await;
}
