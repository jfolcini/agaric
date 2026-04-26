// Shared test helpers for command tests
#![allow(unused_imports)]
use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// -- Deterministic test fixtures --

pub const DEV: &str = "test-device-001";
pub const FIXED_TS: &str = "2025-01-01T00:00:00Z";

/// Synthetic space ULID for tests that need to satisfy the FEAT-3 Phase 7
/// space-scoped query path (e.g. `batch_resolve_inner`, `get_page_inner`)
/// without going through the full `bootstrap_spaces` flow. Tests that care
/// about real Personal/Work semantics should use the constants in
/// `crate::spaces` instead.
pub const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

// -- Helpers --

/// Wait for background materializer tasks to finish so assertions see
/// fully-consistent state.
pub async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

/// Creates a temporary SQLite database with all migrations applied.
pub async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
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

/// Insert the synthetic [`TEST_SPACE_ID`] block (idempotent). The
/// `block_properties.value_ref → blocks(id)` FK requires this row to
/// exist before any `assign_to_test_space` call lands. Tests that need
/// the full Personal/Work seed should call `bootstrap_spaces` instead.
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
/// Bypasses `set_property_in_tx` intentionally — the FEAT-3 Phase 7 query
/// layer reads `block_properties` regardless of how the row got there.
pub async fn assign_to_test_space(pool: &SqlitePool, block_id: &str) {
    ensure_test_space(pool).await;
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)")
        .bind(block_id)
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
}
