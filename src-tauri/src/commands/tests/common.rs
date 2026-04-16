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
