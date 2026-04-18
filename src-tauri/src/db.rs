use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqlitePool};
use std::path::Path;

/// Threshold (ms) above which [`acquire_logged`] emits a `warn` log.
///
/// MAINT-30: a `busy_timeout` of 5000ms on the SqlitePool can make callers
/// wait silently on write contention. 100ms is a generous floor that ignores
/// normal cold-start acquires but surfaces anything pathological.
pub const SLOW_ACQUIRE_WARN_MS: u128 = 100;

/// Acquire a connection from the pool, logging at `warn` if the acquire
/// itself took longer than [`SLOW_ACQUIRE_WARN_MS`].
///
/// Migrate call sites gradually — wrap this around `pool.acquire()` only on
/// hot paths where lock contention is operationally interesting
/// (materializer foreground/background batches, large command handlers).
/// A spammy warn log on every acquire is exactly what this helper avoids.
///
/// The `label` argument is a stable, human-readable tag (`"mat_fg"`,
/// `"mat_bg"`, `"sync_merge"`, …) so the operator can filter per-subsystem.
pub async fn acquire_logged(
    pool: &SqlitePool,
    label: &'static str,
) -> Result<PoolConnection<Sqlite>, sqlx::Error> {
    let start = std::time::Instant::now();
    let conn = pool.acquire().await?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > SLOW_ACQUIRE_WARN_MS {
        tracing::warn!(
            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            label,
            "slow pool acquire"
        );
    }
    Ok(conn)
}

/// Start a `BEGIN IMMEDIATE` transaction, logging at `warn` if the
/// underlying connection acquire + begin took longer than
/// [`SLOW_ACQUIRE_WARN_MS`].
///
/// Command handlers that write through a `BEGIN IMMEDIATE` transaction use
/// this helper instead of `pool.begin_with("BEGIN IMMEDIATE")` on hot
/// paths. The timing measures the combined wait for the pool slot *and*
/// the SQLite write lock, which is what actually matters operationally
/// when the app appears to freeze.
///
/// The `label` argument mirrors [`acquire_logged`] — use a stable tag
/// like `"cmd_delete_block"` so per-command slow writes can be filtered.
pub async fn begin_immediate_logged(
    pool: &SqlitePool,
    label: &'static str,
) -> Result<sqlx::Transaction<'static, Sqlite>, sqlx::Error> {
    let start = std::time::Instant::now();
    let tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > SLOW_ACQUIRE_WARN_MS {
        tracing::warn!(
            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            label,
            "slow BEGIN IMMEDIATE"
        );
    }
    Ok(tx)
}

/// Separated read/write connection pools for SQLite.
///
/// WAL mode allows concurrent readers alongside a single writer.
/// Splitting into two pools enforces this at the connection level:
///
/// - **`write`**: `max_connections(2)` — used for all INSERT/UPDATE/DELETE
///   operations.  SQLite WAL mode serialises writers at the engine level;
///   the second connection allows a queued writer to wait behind the first
///   (avoiding pool-level timeouts) while the lock is held.
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
        // WAL autocheckpoint: 5000 pages (~20 MB).  The default (1000) triggers
        // checkpoints too frequently during bursty write workloads (e.g. bulk
        // import or sync merges), stalling readers.  5000 pages lets the WAL
        // grow larger between checkpoints, improving write throughput while
        // journal_size_limit caps the on-disk WAL at 50 MB to prevent unbounded growth.
        .pragma("wal_autocheckpoint", "5000")
        .pragma("journal_size_limit", "52428800") // 50 MB WAL size cap
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
    // --- Write pool: 2 connections — SQLite serialises at engine level ---
    let write_opts = base_connect_options(db_path);
    let write_pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(write_opts)
        .await?;

    // Run migrations on the write pool (needs write access)
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&write_pool).await?;
    tracing::info!("database migrations complete");

    // T-5: Update query planner statistics after migrations.
    // PRAGMA optimize analyzes tables whose stats may be stale and runs
    // ANALYZE only where beneficial. Safe, idempotent, runs in <100ms
    // for typical personal databases.
    sqlx::query("PRAGMA optimize").execute(&write_pool).await?;

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
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    // Run migrations
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("database migrations complete");

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
        assert_eq!(row, Some(5000), "wal_autocheckpoint should be 5000 pages");
    }

    #[tokio::test]
    async fn init_pools_wal_autocheckpoint_configured() {
        let (pools, _dir) = test_pools().await;

        // Verify write pool has wal_autocheckpoint = 5000
        let write_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(
            write_val,
            Some(5000),
            "write pool wal_autocheckpoint should be 5000 pages"
        );

        // Verify read pool has wal_autocheckpoint = 5000
        let read_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            read_val,
            Some(5000),
            "read pool wal_autocheckpoint should be 5000 pages"
        );
    }

    // ======================================================================
    // P-1: Index existence test
    // ======================================================================

    #[tokio::test]
    async fn block_links_source_index_exists() {
        let (pool, _dir) = test_pool().await;
        let row = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_block_links_source'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row, 1,
            "idx_block_links_source index should exist after migrations"
        );
    }

    // ======================================================================
    // T-5: PRAGMA optimize test
    // ======================================================================

    #[tokio::test]
    async fn pragma_optimize_runs_without_error() {
        let (pool, _dir) = test_pool().await;
        let result = sqlx::query("PRAGMA optimize").execute(&pool).await;
        assert!(result.is_ok(), "PRAGMA optimize should succeed");
    }

    // ======================================================================
    // P-7: Write pool allows two connections
    // ======================================================================

    #[tokio::test]
    async fn init_pools_write_pool_allows_two_connections() {
        let (pools, _dir) = test_pools().await;
        // Acquire two write connections concurrently — should not deadlock
        // or timeout with max_connections(2).
        let conn1 = pools.write.acquire().await;
        assert!(conn1.is_ok(), "first write connection should succeed");
        let conn2 = pools.write.acquire().await;
        assert!(conn2.is_ok(), "second write connection should succeed");
    }

    // ======================================================================
    // MAINT-30: Slow pool acquire logging
    // ======================================================================

    /// Thread-safe buffered writer usable as a `tracing_subscriber::fmt`
    /// writer so we can capture emitted log lines in-process.
    #[derive(Clone, Default)]
    struct BufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    impl BufWriter {
        fn contents(&self) -> String {
            let bytes = self.0.lock().unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    #[tokio::test]
    async fn acquire_logged_fast_path_emits_no_warn() {
        use tracing_subscriber::layer::SubscriberExt;

        let (pool, _dir) = test_pool().await;

        let writer = BufWriter::default();
        // Install a scoped subscriber that only captures `warn` and above
        // via a BufWriter so we can inspect emitted events without racing
        // with the global subscriber.
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false),
            );
        let _guard = tracing::subscriber::set_default(subscriber);

        let result = acquire_logged(&pool, "test_fast").await;
        assert!(result.is_ok(), "fast acquire should succeed");
        drop(result);

        let contents = writer.contents();
        assert!(
            !contents.contains("slow pool acquire"),
            "fast pool acquire must not emit the slow-acquire warn, got log output: {contents:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_immediate_logged_emits_warn_on_slow_acquire() {
        use tracing_subscriber::layer::SubscriberExt;

        // Build a dedicated pool with max_connections = 1 so that two
        // concurrent BEGIN IMMEDIATE callers force the second caller to
        // wait behind the first. The first caller sleeps for > SLOW_ACQUIRE
        // threshold while holding the connection, guaranteeing the second
        // caller's timed acquire crosses the threshold.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("slow_acquire.db");
        let opts = base_connect_options(&db_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let writer = BufWriter::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false)
                    .with_target(true),
            );
        let _guard = tracing::subscriber::set_default(subscriber);

        // Hold the single pool slot for longer than SLOW_ACQUIRE_WARN_MS.
        let holder_pool = pool.clone();
        let holder = tokio::spawn(async move {
            let _conn = holder_pool.acquire().await.unwrap();
            #[allow(clippy::cast_possible_truncation)]
            let sleep_ms = (SLOW_ACQUIRE_WARN_MS as u64) + 150;
            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            // Drop releases the slot.
        });

        // Let the holder task actually start acquiring before we race.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // This call must wait for the holder to release the slot, so the
        // acquire crosses the threshold and should emit a warn log.
        let tx = begin_immediate_logged(&pool, "test_slow").await;
        assert!(
            tx.is_ok(),
            "begin_immediate_logged should eventually succeed"
        );
        drop(tx);

        holder.await.unwrap();

        let contents = writer.contents();
        assert!(
            contents.contains("slow BEGIN IMMEDIATE"),
            "slow BEGIN IMMEDIATE must emit a warn log when acquire exceeds \
             SLOW_ACQUIRE_WARN_MS, got log output: {contents:?}"
        );
        assert!(
            contents.contains("test_slow"),
            "slow-acquire warn must include the caller-supplied label, got: {contents:?}"
        );
    }
}
