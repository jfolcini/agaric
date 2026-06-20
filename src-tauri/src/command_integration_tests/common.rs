//! Shared helpers for command integration tests.

pub use crate::commands::*;
pub use crate::db::ReadPool;
pub use crate::db::init_pool;
pub use crate::error::AppError;
pub use crate::materializer::Materializer;
pub use crate::space::{SpaceId, SpaceScope};
pub use sqlx::SqlitePool;
pub use std::path::PathBuf;
pub use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/// Device ID used across all command integration tests.
pub const DEV: &str = "cmd-test-device-001";

/// Creates a temporary SQLite database with all migrations applied.
pub async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Create a Materializer backed by the given pool.
pub fn test_materializer(pool: &SqlitePool) -> Materializer {
    Materializer::new(pool.clone())
}

/// Insert a block directly into the blocks table (bypasses command layer).
///
/// SQL-review §5.3 — stamps `page_id` per post-migration-0066 invariant.
pub async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    let page_id: Option<String> = if block_type == "page" {
        Some(id.to_string())
    } else {
        Some(parent_id.unwrap_or(id).to_string())
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

/// Synthetic space ULID for integration tests that need to satisfy the
/// Phase 7 space-scoped query path (e.g. `batch_resolve_inner`,
/// `get_page_inner`) without going through the full `bootstrap_spaces`
/// flow.
pub const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

/// Insert the synthetic [`TEST_SPACE_ID`] block (idempotent). The
/// `block_properties.value_ref → blocks(id)` FK requires this row to
/// exist before any `assign_to_test_space` call lands.
pub async fn ensure_test_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'TestSpace', NULL, NULL, ?)",
    )
    .bind(TEST_SPACE_ID)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    // #708: register in the `spaces` table — `blocks.space_id` REFERENCES
    // spaces(id) since migration 0089 (production registers via the
    // `is_space = 'true'` property write → 0089 trigger).
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
}

/// Assign a block to [`TEST_SPACE_ID`] by stamping the denormalized
/// `blocks.space_id` column directly. Bypasses `set_property_in_tx` — the
/// query layer reads `blocks.space_id` regardless of how it got set.
pub async fn assign_to_test_space(pool: &SqlitePool, block_id: &str) {
    ensure_test_space(pool).await;
    // #533: `blocks.space_id` is the sole source of truth — every block
    // whose owning page is `block_id` (pages carry `page_id = id`) belongs
    // to this space. Equivalent to the old `b.page_id IN (...)` filter.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(TEST_SPACE_ID)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Bulk-assign every block currently in the DB (excluding the
/// space block itself and any block whose owning page already carries a
/// `space_id`) to [`TEST_SPACE_ID`]. Use this at the end of a test's seed
/// Phase so the hard-filter paths (`list_blocks_inner`,
/// `search_blocks_inner`) return everything the test set up. Idempotent —
/// the page-`space_id` guard skips blocks already assigned to any space
/// (so cross-space tests still work).
pub async fn assign_all_to_test_space(pool: &SqlitePool) {
    ensure_test_space(pool).await;
    // SQL-review §5.3 — stamp page_id on any block that's still NULL,
    // so the `space_id` derivation below resolves to the owning page.
    sqlx::query("UPDATE blocks SET page_id = id WHERE page_id IS NULL")
        .execute(pool)
        .await
        .unwrap();
    // #533: `blocks.space_id` is the sole source of truth. Derive each
    // block's membership from its owning page (pages carry `page_id = id`),
    // in two stable steps that mirror the previous "seed `space` property →
    // derive column from the page's property":
    //   1. Default any page block still missing a `space_id` to
    //      TEST_SPACE_ID (preserves cross-space seeds that already set one).
    //   2. Propagate each page's `space_id` to every block paged to it.
    // Excludes the space block itself.
    sqlx::query(
        "UPDATE blocks SET space_id = ? \
         WHERE id <> ? AND id = page_id AND space_id IS NULL",
    )
    .bind(TEST_SPACE_ID)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE blocks SET space_id = ( \
             SELECT pg.space_id FROM blocks pg WHERE pg.id = blocks.page_id \
         ) \
         WHERE id <> ? AND id <> page_id",
    )
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// Allow materializer background tasks to settle before the next write.
///
/// Uses the deterministic barrier-flush mechanism so tests are not
/// race-condition-prone on slow CI.
pub async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

/// Test helper: create a single space and return its ULID.
/// Tests that exercise the per-space journal lookup (and any other
/// per-space command surface) need a live `is_space = 'true'` block
/// to scope under; this helper emits the same atomic CreateBlock +
/// SetProperty(is_space) op pair as the production
/// `create_space` command.
pub async fn test_space(pool: &SqlitePool, name: &str) -> String {
    let materializer = crate::materializer::Materializer::new(pool.clone());
    create_space_inner(pool, DEV, &materializer, name.into(), None)
        .await
        .expect("create_space must succeed")
        .into_string()
}
