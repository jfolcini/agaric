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

/// [`test_pool`] at a caller-chosen path — the same recovery-free stand-in
/// for the app's `init_pool`, with its signature, so the materializer tests
/// that moved down with #4502 keep their `init_pool(&db_path)` call shape.
pub async fn init_pool(
    db_path: &std::path::Path,
) -> Result<SqlitePool, agaric_core::error::AppError> {
    seed_from_migrated_template(db_path).await;
    migrate_at(db_path).await
}

async fn migrate_at(db_path: &std::path::Path) -> Result<SqlitePool, agaric_core::error::AppError> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(crate::db::base_connect_options(db_path))
        .await?;
    sqlx::migrate!("../migrations").run(&pool).await?;
    Ok(pool)
}

/// Give a database that does not exist yet the migrated schema by copying it,
/// instead of running every migration. Migrating is most of what a fresh test
/// database costs, and nextest runs each test in its own process, so the
/// migrated copy lives on disk, named for the migrations' checksums: a changed
/// migration names a new copy. The migrator still runs on the result and
/// applies anything missing. A path that exists, or whose directory does not,
/// is left alone for the caller's own open to handle.
pub async fn seed_from_migrated_template(db_path: &std::path::Path) {
    if db_path.exists() || !db_path.parent().is_some_and(std::path::Path::is_dir) {
        return;
    }
    let template = migrated_template().await;
    std::fs::copy(&template, db_path).unwrap_or_else(|e| {
        panic!(
            "copying the migrated template {} to {}: {e}",
            template.display(),
            db_path.display()
        )
    });
}

async fn migrated_template() -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for migration in sqlx::migrate!("../migrations").iter() {
        migration.version.hash(&mut hasher);
        migration.checksum.hash(&mut hasher);
    }
    let template =
        std::env::temp_dir().join(format!("agaric-migrated-{:016x}.db", hasher.finish()));
    if template.exists() {
        return template;
    }
    // Processes racing here each build their own copy and rename it into place;
    // the rename is atomic and every copy is the same schema.
    let dir = TempDir::new().unwrap();
    let pool = migrate_at(&dir.path().join("build.db")).await.unwrap();
    // `VACUUM INTO`, not a file copy: migrated pages may still sit in the WAL.
    let staged = template.with_extension(format!("{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&staged);
    sqlx::query("VACUUM INTO ?")
        .bind(staged.to_str().expect("temp path is UTF-8"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    std::fs::rename(&staged, &template).unwrap();
    template
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
    async fn test_pool_gives_each_caller_its_own_database() {
        const BLOCK: &str = "01HZ0000000000000000000001";
        let (first, _first_dir) = test_pool().await;
        insert_block(&first, BLOCK, "page", "first", None, None).await;

        let (second, _second_dir) = test_pool().await;
        let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK)
            .fetch_one(&second)
            .await
            .unwrap();
        assert_eq!(seen, 0);
    }

    /// A new path gets every migration without the migrator running on it.
    #[tokio::test]
    async fn seeding_a_new_path_applies_every_migration() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("seeded.db");
        seed_from_migrated_template(&db_path).await;

        let raw = sqlx::SqlitePool::connect_with(crate::db::base_connect_options(&db_path))
            .await
            .unwrap();
        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&raw)
            .await
            .unwrap();
        let embedded = i64::try_from(sqlx::migrate!("../migrations").iter().count()).unwrap();
        assert_eq!(applied, embedded);
    }

    /// A file already at the path is the caller's database: seeding keeps it.
    #[tokio::test]
    async fn seeding_leaves_an_existing_file_alone() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("existing.db");
        std::fs::write(&db_path, b"not a template").unwrap();
        seed_from_migrated_template(&db_path).await;
        assert_eq!(std::fs::read(&db_path).unwrap(), b"not a template");
    }
}
