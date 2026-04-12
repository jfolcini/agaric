//! Shared helpers for command integration tests.

pub use crate::commands::*;
pub use crate::db::init_pool;
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

/// Allow materializer background tasks to settle before the next write.
///
/// Uses the deterministic barrier-flush mechanism so tests are not
/// race-condition-prone on slow CI.
pub async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}
