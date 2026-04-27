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

/// Maximum number of SQL bind parameters per statement for chunked
/// multi-row INSERTs.
///
/// SQLite raised the compile-time default from 999 to 32766 in 3.32.0
/// (2020-05-22), but the conservative 999 bound keeps us compatible with
/// the lowest-version libsqlite that any platform might ship and matches
/// the value the snapshot/restore path has used since launch. Callers
/// derive a per-table chunk size as `MAX_SQL_PARAMS / num_columns`.
///
/// I-Cache-3: lifted from `cache/block_tag_refs.rs` and `snapshot/restore.rs`
/// so the chunking constant has a single source of truth.
pub const MAX_SQL_PARAMS: usize = 999;

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

/// Command-layer transaction wrapper that couples a `BEGIN IMMEDIATE`
/// SQLite transaction to the materializer-dispatch calls that must fire
/// after it commits.
///
/// MAINT-112 (phase A): every write-path command previously repeated the
/// same three-step dance —
///
/// ```text
/// let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
/// // ... work ...
/// tx.commit().await?;
/// materializer.dispatch_background_or_warn(&op_record);
/// ```
///
/// This pattern appears in ~54 command-layer sites (35 raw
/// `begin_with("BEGIN IMMEDIATE")` + 19 already using
/// [`begin_immediate_logged`]) and pairs with 22 post-commit
/// `dispatch_background_or_warn` calls. Two failure modes are easy to
/// introduce and hard to review for:
///
/// 1. **Pre-commit dispatch.** Firing the background task before
///    `tx.commit().await?` can expose the not-yet-committed op-record to
///    the materializer. A follow-up commit failure then leaves the
///    materializer chasing an op that never lands.
/// 2. **Missing dispatch.** Forgetting the `dispatch_background_or_warn`
///    call leaves caches (`tags_cache`, `pages_cache`, FTS, block_links,
///    block_tag_inherited) stale until the next touch. Session 495's
///    H-5 / H-6 fixes were both in this class.
///
/// `CommandTx` closes both by construction:
///
/// - Opening a transaction is a single call — [`CommandTx::begin_immediate`]
///   — that also takes the [`SLOW_ACQUIRE_WARN_MS`] timing log for free.
/// - Callers [`enqueue_background`](CommandTx::enqueue_background) the op
///   records that need post-commit dispatch *during* the transaction.
///   The records are held on the `CommandTx` value, not sent to the
///   materializer yet.
/// - The only way to commit is via [`commit_and_dispatch`](
///   CommandTx::commit_and_dispatch) or the explicit
///   [`commit_without_dispatch`](CommandTx::commit_without_dispatch)
///   escape hatch. Both commit the inner `sqlx::Transaction` first, and
///   only then (if the commit succeeded) drain the pending queue into
///   `Materializer::dispatch_background_or_warn` in enqueue order.
/// - Dropping the `CommandTx` without calling either commit method
///   rolls back the transaction (via `sqlx::Transaction`'s own `Drop`)
///   and discards the pending queue. No dispatches fire on rollback.
///
/// Existing `*_in_tx` helpers that take `&mut sqlx::Transaction<'_,
/// Sqlite>` do **not** need signature changes: `CommandTx` implements
/// [`Deref`] and [`DerefMut`] to the inner transaction, so Rust's
/// deref-coercion-on-reborrow rule lets callers keep writing
/// `append_local_op_in_tx(&mut cmd_tx, ...)` at the function-call site —
/// the `&mut CommandTx` → `&mut sqlx::Transaction<'_, Sqlite>` coercion
/// applies automatically. (Explicit `&mut *cmd_tx` also works if
/// the reader wants the coercion to be visible.) The `_in_tx` suffix is
/// preserved deliberately — it is load-bearing for grep + code review
/// and every call site keeps its familiar shape.
///
/// MAINT-112 phase B added a second dispatch variant —
/// [`CommandTx::enqueue_edit_background`] — for the one `edit_block`
/// caller (`crud::edit_block_inner`) that needs the `block_type` hint.
/// `dispatch_op` (foreground + background) is not yet wrapped; the
/// single in-tree caller is in a different context (remote-op apply)
/// and does not pair with a `CommandTx` transaction.
///
/// A post-commit dispatch queued by [`CommandTx::enqueue_background`]
/// or [`CommandTx::enqueue_edit_background`]. Drained by
/// [`CommandTx::commit_and_dispatch`] in FIFO order. Dispatch failures
/// follow the `_or_warn` convention — logged via
/// `dispatch_background_or_warn` / a direct `logger.warn` path for the
/// `Edit` variant, never propagated to the caller.
enum PendingDispatch {
    /// Plain op dispatch — invokes [`Materializer::dispatch_background_or_warn`].
    Background(crate::op_log::OpRecord),
    /// Edit-op dispatch with a `block_type` hint — invokes
    /// [`Materializer::dispatch_edit_background`] and warns on error.
    /// The materializer uses the hint to pick a narrower cache-rebuild
    /// fan-out for content vs. tag vs. page edits.
    EditBackground {
        record: crate::op_log::OpRecord,
        block_type: String,
    },
}

pub struct CommandTx {
    /// The live `BEGIN IMMEDIATE` transaction. `'static` because
    /// `pool.begin_with(...)` internally clones the pool handle.
    inner: sqlx::Transaction<'static, Sqlite>,
    /// Op records to dispatch to the materializer once the transaction
    /// commits successfully. FIFO order — `commit_and_dispatch` drains
    /// them in enqueue order.
    pending: Vec<PendingDispatch>,
    /// Label used by [`begin_immediate_logged`] for slow-acquire logs.
    /// Stored here only so diagnostic code (future: a debug-assert on
    /// Drop with a pending queue) can name the originating command.
    #[allow(dead_code)]
    label: &'static str,
}

impl CommandTx {
    /// Open a new `BEGIN IMMEDIATE` transaction with slow-acquire logging.
    ///
    /// `label` mirrors [`begin_immediate_logged`] — a stable,
    /// human-readable tag like `"undo_page_op"` so slow writes can be
    /// filtered per-command in the tracing output.
    pub async fn begin_immediate(
        pool: &SqlitePool,
        label: &'static str,
    ) -> Result<Self, sqlx::Error> {
        let inner = begin_immediate_logged(pool, label).await?;
        Ok(Self {
            inner,
            pending: Vec::new(),
            label,
        })
    }

    /// Queue an op record for post-commit background dispatch.
    ///
    /// The record is held on the `CommandTx` value and forwarded to
    /// `Materializer::dispatch_background_or_warn` only if
    /// [`commit_and_dispatch`](Self::commit_and_dispatch) succeeds. If
    /// the transaction is rolled back or committed via
    /// [`commit_without_dispatch`](Self::commit_without_dispatch), the
    /// queued records are discarded.
    ///
    /// Multiple records may be enqueued from the same transaction —
    /// typical for batch operations such as [`crate::commands::history::revert_ops_inner`].
    pub fn enqueue_background(&mut self, record: crate::op_log::OpRecord) {
        self.pending.push(PendingDispatch::Background(record));
    }

    /// Queue an `edit_block` op record with a `block_type` hint for
    /// post-commit dispatch.
    ///
    /// Invokes [`Materializer::dispatch_edit_background`] during
    /// `commit_and_dispatch`. Dispatch failures are logged at warn level
    /// (matching the `_or_warn` convention used for the plain
    /// [`enqueue_background`](Self::enqueue_background) variant) rather
    /// than propagated — the op itself has already committed, so a
    /// missed cache rebuild is recoverable and non-fatal.
    ///
    /// `block_type` is the post-edit type ("content" / "page" / "tag")
    /// the materializer uses to pick a narrower rebuild fan-out.
    pub fn enqueue_edit_background(
        &mut self,
        record: crate::op_log::OpRecord,
        block_type: impl Into<String>,
    ) {
        self.pending.push(PendingDispatch::EditBackground {
            record,
            block_type: block_type.into(),
        });
    }

    /// Commit the transaction, then drain the pending queue into the
    /// materializer in enqueue order.
    ///
    /// If `commit()` fails, no dispatches fire and the error is
    /// propagated. This is the desired behaviour — a failed commit means
    /// the op records never landed in `op_log`, so the materializer must
    /// not be told about them.
    ///
    /// Returns the number of dispatches that fired. Dispatch failures
    /// are logged at warn level and do not surface here.
    pub async fn commit_and_dispatch(
        mut self,
        materializer: &crate::materializer::Materializer,
    ) -> Result<usize, sqlx::Error> {
        self.inner.commit().await?;
        let drained = std::mem::take(&mut self.pending);
        let count = drained.len();
        for entry in drained {
            match entry {
                PendingDispatch::Background(record) => {
                    materializer.dispatch_background_or_warn(&record);
                }
                PendingDispatch::EditBackground { record, block_type } => {
                    if let Err(e) = materializer.dispatch_edit_background(&record, &block_type) {
                        tracing::warn!(
                            op_type = %record.op_type,
                            seq = record.seq,
                            device_id = %record.device_id,
                            block_type = %block_type,
                            error = %e,
                            "failed to dispatch edit background cache task"
                        );
                    }
                }
            }
        }
        Ok(count)
    }

    /// Commit the transaction without firing any dispatches.
    ///
    /// Escape hatch for test fixtures and maintenance commands that
    /// don't participate in the materializer pipeline (e.g., direct
    /// SQLite PRAGMA writes, migration markers). Pending records are
    /// discarded silently.
    pub async fn commit_without_dispatch(mut self) -> Result<(), sqlx::Error> {
        self.inner.commit().await?;
        self.pending.clear();
        Ok(())
    }

    /// Explicitly roll back the transaction and discard pending
    /// dispatches.
    ///
    /// Identical in effect to dropping the `CommandTx` without
    /// committing, but surfaces any rollback error to the caller.
    pub async fn rollback(mut self) -> Result<(), sqlx::Error> {
        self.pending.clear();
        self.inner.rollback().await
    }

    /// Number of op records currently queued for post-commit dispatch.
    ///
    /// Useful in tests that want to assert exactly how many cache
    /// rebuilds a command will schedule. Counts both
    /// [`enqueue_background`](Self::enqueue_background) and
    /// [`enqueue_edit_background`](Self::enqueue_edit_background)
    /// entries.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

impl std::ops::Deref for CommandTx {
    type Target = sqlx::Transaction<'static, Sqlite>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl std::ops::DerefMut for CommandTx {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
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

/// Initialize a single combined pool — **test/bench-only fixture**.
///
/// ## When to use which
///
/// | Use case | API |
/// |----------|-----|
/// | Production app startup (`lib.rs::setup`) | [`init_pools`] |
/// | Anything that needs the production split-pool semantics — `query_only = ON` reader, dedicated writer | [`init_pools`] |
/// | Unit tests / benches that just need a working migrated DB and don't care about reader/writer separation | `init_pool` (this fn) |
///
/// This creates one pool with `max_connections(5)` — the legacy
/// pre-pool-split behaviour, retained because the vast majority of
/// tests and benches don't need a `query_only` reader pool to
/// exercise their unit under test.  Tests that *do* need to verify
/// behaviour under split-pool wiring (e.g. M-82-style pool-mismatch
/// regressions, MCP read-only tooling) must call [`init_pools`]
/// instead — see the `tools_ro::tests_m82` module for a worked
/// example.
///
/// **Do not use `init_pool` from production code paths.**  All
/// non-test/bench callers should use [`init_pools`] so the
/// `query_only` pragma rejects accidental writes through the read
/// pool at the SQLite engine level.
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
            let sleep_ms = u64::try_from(SLOW_ACQUIRE_WARN_MS)
                .expect("invariant: SLOW_ACQUIRE_WARN_MS = 100 fits in u64")
                + 150;
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

    // ======================================================================
    // MAINT-112: CommandTx newtype tests
    // ======================================================================

    use crate::op_log::OpRecord;

    /// Build a non-roundtrippable but structurally-valid `OpRecord` for
    /// tests that only care about whether dispatch *fires* (the
    /// materializer's internal payload parse will fail and emit a
    /// `warn`, which is exactly what `dispatch_background_or_warn`
    /// promises to do). No real op-log row is written.
    fn fake_op_record(device_id: &str, seq: i64, op_type: &str) -> OpRecord {
        OpRecord {
            device_id: device_id.to_string(),
            seq,
            parent_seqs: None,
            hash: "0".repeat(64),
            op_type: op_type.to_string(),
            payload: "{}".to_string(),
            created_at: "1970-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[tokio::test]
    async fn command_tx_begin_immediate_opens_write_tx() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_cmd_tx_open")
            .await
            .expect("begin_immediate should succeed");

        // Writes via Deref should work exactly like a plain Transaction.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_OPEN",
            "content",
            "hello"
        )
        .execute(&mut **tx)
        .await
        .expect("write through CommandTx should succeed");

        tx.commit_without_dispatch()
            .await
            .expect("commit without dispatch should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_OPEN")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "commit_without_dispatch should persist the write");
    }

    #[tokio::test]
    async fn command_tx_deref_passes_through_to_in_tx_helpers() {
        // Prove that an existing `&mut sqlx::Transaction<'_, Sqlite>`
        // helper accepts `&mut *cmd_tx` unchanged. This is the
        // load-bearing invariant for the MAINT-112 migration strategy.
        async fn in_tx_style_helper(
            tx: &mut sqlx::Transaction<'_, Sqlite>,
            id: &str,
        ) -> Result<(), sqlx::Error> {
            sqlx::query!(
                "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
                id,
                "content",
                "from_helper"
            )
            .execute(&mut **tx)
            .await?;
            Ok(())
        }

        let (pool, _dir) = test_pool().await;
        let mut cmd_tx = CommandTx::begin_immediate(&pool, "test_deref_passthrough")
            .await
            .unwrap();

        // The helper signature is unchanged from the pre-MAINT-112
        // codebase — the Deref/DerefMut impls on CommandTx are what
        // makes `&mut *cmd_tx` match its expected `&mut Transaction`.
        in_tx_style_helper(&mut cmd_tx, "CMDTX_DEREF")
            .await
            .expect("in-tx helper should accept &mut *cmd_tx");

        cmd_tx.commit_without_dispatch().await.unwrap();

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_DEREF")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "helper-written row should be committed");
    }

    #[tokio::test]
    async fn command_tx_drop_rolls_back_writes() {
        let (pool, _dir) = test_pool().await;
        {
            let mut tx = CommandTx::begin_immediate(&pool, "test_drop_rollback")
                .await
                .unwrap();
            sqlx::query!(
                "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
                "CMDTX_DROP",
                "content",
                "x"
            )
            .execute(&mut **tx)
            .await
            .unwrap();
            // Drop without commit — sqlx::Transaction's Drop impl rolls
            // back implicitly. CommandTx adds no new guarantee here; we
            // assert the behaviour is preserved.
        }
        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_DROP")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 0, "drop without commit must roll back the write");
    }

    #[tokio::test]
    async fn command_tx_explicit_rollback_discards_pending() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_explicit_rollback")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_RB",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2, "enqueue should grow pending");

        tx.rollback().await.expect("rollback should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_RB")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 0, "rollback must discard the write");
    }

    #[tokio::test]
    async fn command_tx_commit_and_dispatch_returns_pending_count_and_persists_writes() {
        use crate::materializer::Materializer;

        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut tx = CommandTx::begin_immediate(&pool, "test_commit_dispatch")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_C1",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_C2",
            "content",
            "y"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 3, "create_block"));

        let dispatched = tx
            .commit_and_dispatch(&materializer)
            .await
            .expect("commit_and_dispatch should succeed");
        assert_eq!(
            dispatched, 3,
            "commit_and_dispatch must return the pre-commit pending count"
        );

        let row = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM blocks WHERE id IN (?, ?)",
            "CMDTX_C1",
            "CMDTX_C2"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, 2, "commit must persist both writes");
    }

    #[tokio::test]
    async fn command_tx_commit_and_dispatch_with_no_pending_returns_zero() {
        use crate::materializer::Materializer;

        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut tx = CommandTx::begin_immediate(&pool, "test_zero_pending")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_ZERO",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        assert_eq!(tx.pending_len(), 0, "no enqueue, no pending");

        let dispatched = tx.commit_and_dispatch(&materializer).await.unwrap();
        assert_eq!(
            dispatched, 0,
            "commit_and_dispatch with nothing enqueued must still commit and return 0"
        );

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_ZERO")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "commit must have happened even with no dispatch");
    }

    #[tokio::test]
    async fn command_tx_pending_len_reflects_enqueues() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_pending_len")
            .await
            .unwrap();

        assert_eq!(tx.pending_len(), 0);
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        assert_eq!(tx.pending_len(), 1);
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2);
        tx.enqueue_background(fake_op_record("DEV", 3, "delete_block"));
        assert_eq!(tx.pending_len(), 3);

        // Cleanup (tx.rollback() also clears).
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn command_tx_commit_without_dispatch_clears_pending() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_commit_no_dispatch")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_ND",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2);

        // Escape hatch — commits the tx but explicitly skips dispatch.
        // The queued records are discarded.
        tx.commit_without_dispatch()
            .await
            .expect("commit_without_dispatch should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_ND")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row, 1,
            "commit_without_dispatch must still commit the transaction"
        );
    }
}
