use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;

/// Maximum number of connections in the SQLite pool.
/// WAL mode allows concurrent readers plus one writer.
const MAX_POOL_CONNECTIONS: u32 = 5;

/// Separated read/write connection pools for SQLite (ADR-04).
///
/// WAL mode allows concurrent readers alongside a single writer.
/// Splitting into two pools enforces this at the connection level:
///
/// - **`write`**: `max_connections(1)` — used for all INSERT/UPDATE/DELETE
///   operations.  Only one writer can hold the WAL write lock at a time,
///   so a single-connection pool eliminates write contention.
/// - **`read`**: `max_connections(4)` with `PRAGMA query_only = ON` —
///   used for all SELECT-only queries.  The `query_only` pragma causes
///   SQLite to reject any writes attempted through these connections,
///   providing a hard guarantee that read paths cannot accidentally
///   take write locks or waste `busy_timeout`.
///
/// Both pools share the same WAL journal, FK enforcement, and busy_timeout.
pub struct DbPools {
    pub write: SqlitePool,
    pub read: SqlitePool,
}

/// Newtype wrapper for the write pool, enabling type-safe Tauri state extraction.
///
/// Commands that perform INSERT/UPDATE/DELETE should extract `State<'_, WritePool>`.
pub struct WritePool(pub SqlitePool);

/// Newtype wrapper for the read pool, enabling type-safe Tauri state extraction.
///
/// Commands that perform SELECT-only queries should extract `State<'_, ReadPool>`.
pub struct ReadPool(pub SqlitePool);

/// Common connection options shared between read and write pools.
fn base_connect_options(db_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(db_path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON")
        .pragma("wal_autocheckpoint", "1000") // checkpoint every 1000 pages (~4MB)
        .busy_timeout(std::time::Duration::from_secs(5))
}

/// Initialize separated read/write SQLite pools with WAL mode.
///
/// The write pool runs migrations on creation.  The read pool sets
/// `PRAGMA query_only = ON` so any accidental write through a read
/// connection is rejected by SQLite.
///
/// Enables `PRAGMA foreign_keys = ON` on every connection in both pools —
/// SQLite does NOT enforce FK constraints by default, so this is mandatory.
pub async fn init_pools(db_path: &Path) -> Result<DbPools, crate::error::AppError> {
    // --- Write pool: single connection for serialised writes ---
    let write_opts = base_connect_options(db_path);
    let write_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(write_opts)
        .await?;

    // Run migrations on the write pool (needs write access)
    sqlx::migrate!("./migrations").run(&write_pool).await?;

    // --- Read pool: 4 concurrent readers, query_only enforced ---
    let read_opts = base_connect_options(db_path).pragma("query_only", "ON");
    let read_pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(read_opts)
        .await?;

    Ok(DbPools {
        write: write_pool,
        read: read_pool,
    })
}

/// Initialize a single combined pool (legacy API, kept for backward compatibility
/// in tests that don't need pool separation).
///
/// This creates a single pool with `max_connections(5)` — the old behavior.
/// Prefer [`init_pools`] for production use.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, crate::error::AppError> {
    let connect_options = base_connect_options(db_path);

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
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

    async fn test_pools() -> (DbPools, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pools = init_pools(&db_path).await.unwrap();
        (pools, dir)
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
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES (?, ?, ?, ?)",
            "CHILD",
            "content",
            "hi",
            "NONEXISTENT_PARENT",
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
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "blocks table should exist and be empty");
    }

    #[tokio::test]
    async fn init_pool_with_invalid_path_returns_error() {
        let result = init_pool(Path::new("/nonexistent/path/to/db.sqlite")).await;
        assert!(
            result.is_err(),
            "init_pool with invalid path should return an error"
        );
    }

    // ======================================================================
    // DbPools tests
    // ======================================================================

    #[tokio::test]
    async fn init_pools_write_pool_sets_wal() {
        let (pools, _dir) = test_pools().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(
            row.0.to_lowercase(),
            "wal",
            "write pool journal_mode should be WAL"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_sets_wal() {
        let (pools, _dir) = test_pools().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        // Read pool opens in WAL mode (shared journal with write pool)
        assert_eq!(
            row.0.to_lowercase(),
            "wal",
            "read pool journal_mode should be WAL"
        );
    }

    #[tokio::test]
    async fn init_pools_write_pool_enables_foreign_keys() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "write pool foreign_keys should be enabled");
    }

    #[tokio::test]
    async fn init_pools_read_pool_enables_foreign_keys() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "read pool foreign_keys should be enabled");
    }

    #[tokio::test]
    async fn init_pools_write_pool_can_write() {
        let (pools, _dir) = test_pools().await;
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "W1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await;
        assert!(result.is_ok(), "write pool should accept writes");
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_writes() {
        let (pools, _dir) = test_pools().await;
        // The read pool has PRAGMA query_only = ON, so writes should fail
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "R1",
            "content",
            "hello",
        )
        .execute(&pools.read)
        .await;
        assert!(
            result.is_err(),
            "read pool should reject INSERT due to query_only pragma"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_update() {
        let (pools, _dir) = test_pools().await;
        // First insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RU1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Attempt UPDATE via read pool should fail
        let result = sqlx::query!(
            "UPDATE blocks SET content = ? WHERE id = ?",
            "modified",
            "RU1",
        )
        .execute(&pools.read)
        .await;
        assert!(
            result.is_err(),
            "read pool should reject UPDATE due to query_only pragma"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_delete() {
        let (pools, _dir) = test_pools().await;
        // First insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RD1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Attempt DELETE via read pool should fail
        let result = sqlx::query!("DELETE FROM blocks WHERE id = ?", "RD1")
            .execute(&pools.read)
            .await;
        assert!(
            result.is_err(),
            "read pool should reject DELETE due to query_only pragma"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_allows_select() {
        let (pools, _dir) = test_pools().await;
        // Insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RS1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // SELECT via read pool should work
        let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", "RS1")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            row.content.as_deref(),
            Some("hello"),
            "read pool should allow SELECT queries"
        );
    }

    #[tokio::test]
    async fn init_pools_read_sees_write_pool_data() {
        let (pools, _dir) = test_pools().await;
        // Write through write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "VIS1",
            "content",
            "visible",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Read pool should see the committed data (WAL mode)
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "VIS1")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "read pool should see data committed by write pool"
        );
    }

    #[tokio::test]
    async fn init_pools_migrations_ran_on_write_pool() {
        let (pools, _dir) = test_pools().await;
        // Verify migrations ran by checking blocks table exists (via read pool)
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "blocks table should exist (migrations ran on write pool)"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_query_only_pragma_is_set() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA query_only")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "read pool should have query_only = ON (1)");
    }

    #[tokio::test]
    async fn init_pools_write_pool_query_only_is_off() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA query_only")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(row.0, 0, "write pool should have query_only = OFF (0)");
    }

    #[tokio::test]
    async fn init_pools_with_invalid_path_returns_error() {
        let result = init_pools(Path::new("/nonexistent/path/to/db.sqlite")).await;
        assert!(
            result.is_err(),
            "init_pools with invalid path should return an error"
        );
    }

    #[tokio::test]
    async fn wal_autocheckpoint_is_configured() {
        let (pool, _dir) = test_pool().await;
        let row = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, Some(1000), "wal_autocheckpoint should be 1000 pages");
    }

    #[tokio::test]
    async fn init_pools_wal_autocheckpoint_configured() {
        let (pools, _dir) = test_pools().await;

        // Verify write pool has wal_autocheckpoint = 1000
        let write_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(
            write_val,
            Some(1000),
            "write pool wal_autocheckpoint should be 1000 pages"
        );

        // Verify read pool has wal_autocheckpoint = 1000
        let read_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            read_val,
            Some(1000),
            "read pool wal_autocheckpoint should be 1000 pages"
        );
    }
}
