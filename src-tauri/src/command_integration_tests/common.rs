//! Shared helpers for command integration tests.

pub use crate::commands::*;
pub use crate::db::init_pool;
pub use crate::db::ReadPool;
pub use crate::error::AppError;
pub use crate::materializer::Materializer;
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
pub async fn insert_block(
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

/// Synthetic space ULID for integration tests that need to satisfy the
/// FEAT-3 Phase 7 space-scoped query path (e.g. `batch_resolve_inner`,
/// `get_page_inner`) without going through the full `bootstrap_spaces`
/// flow.
pub const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

/// Insert the synthetic [`TEST_SPACE_ID`] block (idempotent). The
/// `block_properties.value_ref → blocks(id)` FK requires this row to
/// exist before any `assign_to_test_space` call lands.
pub async fn ensure_test_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'page', 'TestSpace', NULL, NULL)",
    )
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// Assign a block to [`TEST_SPACE_ID`] by writing the materialised
/// `block_properties(key='space', value_ref=TEST_SPACE_ID)` row directly.
/// Bypasses `set_property_in_tx` — the FEAT-3 Phase 7 query layer reads
/// `block_properties` regardless of how the row got there.
pub async fn assign_to_test_space(pool: &SqlitePool, block_id: &str) {
    ensure_test_space(pool).await;
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)")
        .bind(block_id)
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

/// FEAT-3p5 test helper: create a single space and return its ULID.
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
