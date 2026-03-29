use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;

/// Initialize the SQLite database with WAL mode and appropriate pool settings.
/// 5 connections; WAL mode allows concurrent reads + 1 write at a time.
///
/// Enables `PRAGMA foreign_keys = ON` on every connection — SQLite does NOT
/// enforce FK constraints by default, so this is mandatory.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, crate::error::AppError> {
    let connect_options = SqliteConnectOptions::new()
        .filename(db_path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON")
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5) // WAL: concurrent readers + 1 writer
        .connect_with(connect_options)
        .await?;

    // Run migrations
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[tokio::test]
    async fn init_pool_sets_wal_journal_mode() {
        let (pool, _dir) = test_pool().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0.to_lowercase(), "wal", "journal_mode should be WAL");
    }

    #[tokio::test]
    async fn init_pool_enables_foreign_keys() {
        let (pool, _dir) = test_pool().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "foreign_keys should be enabled (1)");
    }

    #[tokio::test]
    async fn init_pool_enforces_foreign_key_constraint() {
        let (pool, _dir) = test_pool().await;
        // Attempt to insert a block with a non-existent parent_id should fail
        // because of the FK constraint on blocks.parent_id -> blocks.id.
        let result = sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES ('CHILD', 'content', 'hi', 'NONEXISTENT_PARENT')",
        )
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "inserting a block with invalid parent_id should fail due to FK constraint"
        );
    }

    #[tokio::test]
    async fn init_pool_runs_migrations_creating_blocks_table() {
        let (pool, _dir) = test_pool().await;
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 0, "blocks table should exist and be empty");
    }

    #[tokio::test]
    async fn init_pool_with_invalid_path_returns_error() {
        let result = init_pool(Path::new("/nonexistent/path/to/db.sqlite")).await;
        assert!(
            result.is_err(),
            "init_pool with invalid path should return an error"
        );
    }
}
