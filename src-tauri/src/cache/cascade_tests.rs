//! H7 (sql-audit-2026-05-09): tests that prove the `ON DELETE CASCADE`
//! / `ON DELETE SET NULL` foreign keys added by migration 0061 actually
//! fire on a hard `DELETE FROM blocks` — without involving the Rust-side
//! cascade in `commands/blocks/crud.rs`. These guard against future
//! migrations accidentally dropping the cascade clause when rebuilding
//! one of the ten legacy tables.
//!
//! Each table-specific test seeds the parent block + child row(s),
//! issues a single `DELETE FROM blocks WHERE id = ?`, and asserts the
//! child row(s) are gone. `block_properties.value_ref` is the only
//! SET-NULL column; the rest cascade-delete.
//!
//! There is also an end-to-end test (`hard_delete_block_cascades_to_all_child_tables`)
//! that fans out across `block_tags`, `block_properties`, and
//! `block_links` to verify the FKs are simultaneously enforced by one
//! statement.

use crate::db::init_pool;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// --- Helpers -------------------------------------------------------------

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

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

async fn hard_delete_block(pool: &SqlitePool, id: &str) {
    let rows = sqlx::query("DELETE FROM blocks WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(rows, 1, "DELETE must remove exactly the seeded blocks row");
}

async fn count_where(pool: &SqlitePool, table: &str, where_clause: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE {where_clause}");
    let (count,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .fetch_one(pool)
        .await
        .unwrap();
    count
}

// --- 1. block_tags -------------------------------------------------------

#[tokio::test]
async fn cascade_block_tags_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK01", "content", "tagged").await;
    insert_block(&pool, "TAG01", "tag", "urgent").await;
    sqlx::query!(
        "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        "BLK01",
        "TAG01"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK01").await;

    assert_eq!(
        count_where(&pool, "block_tags", "block_id = 'BLK01'").await,
        0,
        "block_tags row must cascade-delete when parent block_id row is hard-deleted",
    );
}

#[tokio::test]
async fn cascade_block_tags_tag_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK02", "content", "tagged").await;
    insert_block(&pool, "TAG02", "tag", "urgent").await;
    sqlx::query!(
        "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        "BLK02",
        "TAG02"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "TAG02").await;

    assert_eq!(
        count_where(&pool, "block_tags", "tag_id = 'TAG02'").await,
        0,
        "block_tags row must cascade-delete when tag_id parent is hard-deleted",
    );
}

// --- 2. block_properties (block_id CASCADE, value_ref SET NULL) ----------

#[tokio::test]
async fn cascade_block_properties_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK03", "content", "with props").await;
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
        "BLK03",
        "color",
        "blue"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK03").await;

    assert_eq!(
        count_where(&pool, "block_properties", "block_id = 'BLK03'").await,
        0,
        "block_properties row must cascade-delete when its owning block is hard-deleted",
    );
}

/// Migration 0062 (sql-review-2026-05-14, B-1) flipped the `value_ref`
/// FK from `ON DELETE SET NULL` to `ON DELETE CASCADE` to keep the new
/// exactly-one-value CHECK satisfiable when the referenced block is
/// hard-deleted.  A row that only carried `value_ref` has no other
/// typed value to fall back on, so cascade-deleting the row (vs.
/// nulling out the only value column and producing an all-NULL,
/// CHECK-violating row) is the only schema-consistent choice.  This
/// supersedes the prior `SET NULL` behaviour pinned by 0061.
#[tokio::test]
async fn cascade_block_properties_value_ref_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK04", "content", "with ref").await;
    insert_block(&pool, "REF04", "page", "target page").await;
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)",
        "BLK04",
        "space",
        "REF04"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "REF04").await;

    // Property row must be GONE — the row's only typed value pointed at
    // REF04, so hard-deleting REF04 cascades through `value_ref`.
    assert_eq!(
        count_where(
            &pool,
            "block_properties",
            "block_id = 'BLK04' AND key = 'space'",
        )
        .await,
        0,
        "block_properties row must cascade-delete when its sole typed value (value_ref) \
         is hard-deleted (migration 0062 alignment for exactly_one_value CHECK)",
    );
}

// --- 3. block_links ------------------------------------------------------

#[tokio::test]
async fn cascade_block_links_source_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "SRC05", "content", "source").await;
    insert_block(&pool, "TGT05", "page", "target").await;
    sqlx::query!(
        "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
        "SRC05",
        "TGT05"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "SRC05").await;

    assert_eq!(
        count_where(&pool, "block_links", "source_id = 'SRC05'").await,
        0,
        "block_links row must cascade-delete when its source block is hard-deleted",
    );
}

#[tokio::test]
async fn cascade_block_links_target_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "SRC06", "content", "source").await;
    insert_block(&pool, "TGT06", "page", "target").await;
    sqlx::query!(
        "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
        "SRC06",
        "TGT06"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "TGT06").await;

    assert_eq!(
        count_where(&pool, "block_links", "target_id = 'TGT06'").await,
        0,
        "block_links row must cascade-delete when its target block is hard-deleted",
    );
}

// --- 4. attachments ------------------------------------------------------

#[tokio::test]
async fn cascade_attachments_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK07", "content", "with attachment").await;
    sqlx::query(
        "INSERT INTO attachments \
         (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATT07")
    .bind("BLK07")
    .bind("image/png")
    .bind("foo.png")
    .bind(100_i64)
    .bind("attachments/ATT07.png")
    .bind(1_735_689_600_000_i64)
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK07").await;

    assert_eq!(
        count_where(&pool, "attachments", "id = 'ATT07'").await,
        0,
        "attachments row must cascade-delete when its parent block is hard-deleted",
    );
}

// --- 5. tags_cache -------------------------------------------------------

#[tokio::test]
async fn cascade_tags_cache_tag_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TAG08", "tag", "popular").await;
    sqlx::query!(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES (?, ?, ?, ?)",
        "TAG08",
        "popular",
        0_i64,
        "2025-01-01T00:00:00Z"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "TAG08").await;

    assert_eq!(
        count_where(&pool, "tags_cache", "tag_id = 'TAG08'").await,
        0,
        "tags_cache row must cascade-delete when the tag block is hard-deleted",
    );
}

// --- 6. pages_cache ------------------------------------------------------

#[tokio::test]
async fn cascade_pages_cache_page_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "PG09", "page", "a page").await;
    sqlx::query!(
        "INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, ?)",
        "PG09",
        "a page",
        1_735_689_600_000_i64
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "PG09").await;

    assert_eq!(
        count_where(&pool, "pages_cache", "page_id = 'PG09'").await,
        0,
        "pages_cache row must cascade-delete when the page block is hard-deleted",
    );
}

// --- 7. agenda_cache -----------------------------------------------------

#[tokio::test]
async fn cascade_agenda_cache_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK10", "content", "scheduled").await;
    sqlx::query!(
        "INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)",
        "2025-06-01",
        "BLK10",
        "property:due"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK10").await;

    assert_eq!(
        count_where(&pool, "agenda_cache", "block_id = 'BLK10'").await,
        0,
        "agenda_cache row must cascade-delete when its block is hard-deleted",
    );
}

// --- 8. page_aliases -----------------------------------------------------

#[tokio::test]
async fn cascade_page_aliases_page_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "PG11", "page", "My Page").await;
    sqlx::query!(
        "INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)",
        "PG11",
        "mp"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "PG11").await;

    assert_eq!(
        count_where(&pool, "page_aliases", "page_id = 'PG11'").await,
        0,
        "page_aliases row must cascade-delete when the page block is hard-deleted",
    );
}

// --- 9. block_tag_inherited ---------------------------------------------

#[tokio::test]
async fn cascade_block_tag_inherited_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK12", "content", "child").await;
    insert_block(&pool, "TAG12", "tag", "inherited").await;
    insert_block(&pool, "ANC12", "page", "ancestor").await;
    sqlx::query!(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
        "BLK12",
        "TAG12",
        "ANC12"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK12").await;

    assert_eq!(
        count_where(&pool, "block_tag_inherited", "block_id = 'BLK12'").await,
        0,
        "block_tag_inherited row must cascade-delete when the inheriting block is hard-deleted",
    );
}

#[tokio::test]
async fn cascade_block_tag_inherited_inherited_from_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK13", "content", "child").await;
    insert_block(&pool, "TAG13", "tag", "inherited").await;
    insert_block(&pool, "ANC13", "page", "ancestor").await;
    sqlx::query!(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
        "BLK13",
        "TAG13",
        "ANC13"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "ANC13").await;

    assert_eq!(
        count_where(&pool, "block_tag_inherited", "inherited_from = 'ANC13'").await,
        0,
        "block_tag_inherited row must cascade-delete when the ancestor it inherits from is hard-deleted",
    );
}

// --- 10. projected_agenda_cache -----------------------------------------

#[tokio::test]
async fn cascade_projected_agenda_cache_block_id_on_hard_delete() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK14", "content", "repeating").await;
    sqlx::query!(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
        "BLK14",
        "2025-07-01",
        "due_date"
    )
    .execute(&pool)
    .await
    .unwrap();

    hard_delete_block(&pool, "BLK14").await;

    assert_eq!(
        count_where(&pool, "projected_agenda_cache", "block_id = 'BLK14'").await,
        0,
        "projected_agenda_cache row must cascade-delete when its block is hard-deleted",
    );
}

// --- End-to-end fan-out test --------------------------------------------

#[tokio::test]
async fn hard_delete_block_cascades_to_all_child_tables() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "OWNERX", "content", "owner").await;
    insert_block(&pool, "TAGX", "tag", "shared-tag").await;
    insert_block(&pool, "LINKTX", "page", "link target").await;
    insert_block(&pool, "REFX", "page", "ref target").await;
    insert_block(&pool, "ANCX", "page", "ancestor").await;
    insert_block(&pool, "OTHERX", "content", "other").await;

    // block_tags row
    sqlx::query!(
        "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        "OWNERX",
        "TAGX"
    )
    .execute(&pool)
    .await
    .unwrap();

    // block_properties: one ON the owner (cascade), one REFERENCING the
    // owner from another block (also CASCADE post migration 0062 — the
    // exactly_one_value CHECK makes a SET-NULL on the sole value column
    // produce an invariant-violating all-NULL row).
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
        "OWNERX",
        "color",
        "red"
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)",
        "OTHERX",
        "space",
        "OWNERX"
    )
    .execute(&pool)
    .await
    .unwrap();

    // block_links: owner is both source and target of distinct edges.
    sqlx::query!(
        "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
        "OWNERX",
        "LINKTX"
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query!(
        "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
        "OTHERX",
        "OWNERX"
    )
    .execute(&pool)
    .await
    .unwrap();

    // attachments
    sqlx::query(
        "INSERT INTO attachments \
         (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATTX")
    .bind("OWNERX")
    .bind("image/png")
    .bind("foo.png")
    .bind(100_i64)
    .bind("attachments/ATTX.png")
    .bind(1_735_689_600_000_i64)
    .execute(&pool)
    .await
    .unwrap();

    // agenda_cache + projected_agenda_cache
    sqlx::query!(
        "INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)",
        "2025-06-01",
        "OWNERX",
        "property:due"
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query!(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
        "OWNERX",
        "2025-07-01",
        "due_date"
    )
    .execute(&pool)
    .await
    .unwrap();

    // block_tag_inherited (owner as the inheriting block)
    sqlx::query!(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
        "OWNERX",
        "TAGX",
        "ANCX"
    )
    .execute(&pool)
    .await
    .unwrap();

    // One `DELETE FROM blocks` — no Rust-side cascade involved.
    hard_delete_block(&pool, "OWNERX").await;

    assert_eq!(
        count_where(&pool, "block_tags", "block_id = 'OWNERX'").await,
        0,
        "block_tags must cascade",
    );
    assert_eq!(
        count_where(&pool, "block_properties", "block_id = 'OWNERX'").await,
        0,
        "block_properties (owned) must cascade",
    );
    // Property row pointing at the deleted block via value_ref must be
    // cascade-deleted (migration 0062 alignment with the new
    // exactly_one_value CHECK; previously the FK was SET NULL).
    assert_eq!(
        count_where(
            &pool,
            "block_properties",
            "block_id = 'OTHERX' AND key = 'space'",
        )
        .await,
        0,
        "block_properties row whose only typed value was value_ref pointing at the \
         deleted block must cascade-delete (post migration 0062)",
    );
    assert_eq!(
        count_where(
            &pool,
            "block_links",
            "source_id = 'OWNERX' OR target_id = 'OWNERX'"
        )
        .await,
        0,
        "block_links must cascade on both source_id and target_id",
    );
    assert_eq!(
        count_where(&pool, "attachments", "block_id = 'OWNERX'").await,
        0,
        "attachments must cascade",
    );
    assert_eq!(
        count_where(&pool, "agenda_cache", "block_id = 'OWNERX'").await,
        0,
        "agenda_cache must cascade",
    );
    assert_eq!(
        count_where(&pool, "projected_agenda_cache", "block_id = 'OWNERX'").await,
        0,
        "projected_agenda_cache must cascade",
    );
    assert_eq!(
        count_where(&pool, "block_tag_inherited", "block_id = 'OWNERX'").await,
        0,
        "block_tag_inherited must cascade",
    );
}
