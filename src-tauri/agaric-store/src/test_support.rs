//! Recovery-free test scaffolding for the store crate (#2621, wave S4a).
//!
//! Mirrors the app's `src/commands/tests/common.rs` BUT drops every helper
//! that couples to the app-only `recovery` / `materializer` layers. The moved
//! S4a tests (`space`, `block_descendants`, `peer_refs`, `tag_inheritance`)
//! call these in place of `crate::db::init_pool` /
//! `crate::commands::tests::common::…`, which cannot move down into the store.
//!
//! `test_pool` reproduces `init_pool`'s pool shape minus recovery: a temp-file
//! WAL pool via [`crate::db::base_connect_options`] with the workspace
//! migrations applied — the same working pattern the op_log tests use
//! (`op_log/tests/mod.rs`). A real file + WAL journalling is load-bearing for
//! the cross-connection snapshot semantics the moved DB tests rely on.

use sqlx::SqlitePool;
use tempfile::TempDir;

/// Synthetic space ULID mirroring `commands::tests::common::TEST_SPACE_ID`.
pub const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

/// Create a temp-file-backed SQLite pool with the workspace migrations
/// applied — a store-local, recovery-free stand-in for the app's `init_pool`.
///
/// Returns `(pool, TempDir)`; keep the `TempDir` alive for the pool's lifetime
/// (dropping it deletes the backing DB file).
pub async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(crate::db::base_connect_options(&db_path))
        .await
        .unwrap();
    sqlx::migrate!("../migrations").run(&pool).await.unwrap();
    (pool, dir)
}

/// Insert a block directly into the `blocks` table (bypasses the command
/// layer). Stamps `page_id` per the post-migration-0066 invariant: pages →
/// self, non-pages → parent or self (matches `create_block_in_tx`).
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

/// Insert the synthetic [`TEST_SPACE_ID`] block + register it in `spaces`
/// (idempotent). The `block_properties.value_ref → blocks(id)` and
/// `blocks.space_id → spaces(id)` FKs require both rows to exist before any
/// space assignment lands.
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
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
}
