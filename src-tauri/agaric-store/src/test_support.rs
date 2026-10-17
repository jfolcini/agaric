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
// Test harness: exempt from the 70-code-line ceiling (AGENTS.md item 6).
#![allow(clippy::too_many_lines)]

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
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    (pool, dir)
}

/// [`test_pool`] for a test that builds many pools, such as a proptest with
/// one per case: migrating is most of what a pool costs, so this process
/// migrates once and every call starts from a copy of that. [`init_pool`]
/// still runs on the copy and applies anything missing.
pub async fn test_pool_from_template() -> (SqlitePool, TempDir) {
    static MIGRATED: tokio::sync::OnceCell<Vec<u8>> = tokio::sync::OnceCell::const_new();
    let template = MIGRATED
        .get_or_init(|| async {
            let (pool, dir) = test_pool().await;
            // Not a copy of `test.db`: migrated pages may still sit in its WAL.
            let snapshot = dir.path().join("snapshot.db");
            sqlx::query("VACUUM INTO ?")
                .bind(snapshot.to_str().expect("temp path is UTF-8"))
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
            std::fs::read(&snapshot).unwrap()
        })
        .await;
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    std::fs::write(&db_path, template).unwrap();
    (init_pool(&db_path).await.unwrap(), dir)
}

/// [`test_pool`] at a caller-chosen path — the same recovery-free stand-in
/// for the app's `init_pool`, with its signature, so the materializer tests
/// that moved down with #4502 keep their `init_pool(&db_path)` call shape.
pub async fn init_pool(
    db_path: &std::path::Path,
) -> Result<SqlitePool, agaric_core::error::AppError> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(crate::db::base_connect_options(db_path))
        .await?;
    sqlx::migrate!("../migrations").run(&pool).await?;
    Ok(pool)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A row written through one caller's pool, before the next caller's pool
    /// exists, is absent from it: no two callers share a database.
    #[tokio::test]
    async fn test_pool_from_template_gives_each_caller_its_own_database() {
        const BLOCK: &str = "01HZ0000000000000000000001";
        let (first, _first_dir) = test_pool_from_template().await;
        insert_block(&first, BLOCK, "page", "first", None, None).await;

        let (second, _second_dir) = test_pool_from_template().await;
        let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK)
            .fetch_one(&second)
            .await
            .unwrap();
        assert_eq!(seen, 0);
    }
}
