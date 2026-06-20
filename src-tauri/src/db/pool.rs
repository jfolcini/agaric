use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqlitePool};
use std::path::Path;

use super::recovery::{ensure_blocks_table_exists, recover_derived_state_from_op_log};

/// Threshold (ms) above which [`acquire_logged`] emits a `warn` log.
///
/// MAINT-30: a `busy_timeout` of 5000ms on the SqlitePool can make callers
/// wait silently on write contention. 100ms is a generous floor that ignores
/// normal cold-start acquires but surfaces anything pathological.
pub const SLOW_ACQUIRE_WARN_MS: u128 = 100;

/// PEND-70 — threshold (ms) above which [`search_pool_acquire_logged`]
/// emits a `warn` log on the **read** pool. Lower than
/// [`SLOW_ACQUIRE_WARN_MS`] (100 ms) because the read pool's
/// `max_connections(4)` ceiling is smaller and saturation surfaces
/// faster — under bursty typing the palette can queue 4-5 sequential
/// IPCs, and we want to see the first contender to cross 50 ms in the
/// log so operators can correlate slowness with the burst pattern.
/// 50 ms is also the upper bound of the cancellation acceptance
/// criterion (≤ 50 ms typical), so the two budgets compose: if a
/// search waits > 50 ms for a pool slot, we either log it as slow OR
/// we cancel it.
pub const SLOW_SEARCH_ACQUIRE_WARN_MS: u128 = 50;

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

/// Issue #109 Phase 1 — return the current UTC time as milliseconds
/// since the Unix epoch.
///
/// This is the **canonical timestamp encoding for new tables** in
/// Agaric's SQLite schema. Going forward, every new timestamp column
/// must be declared `<col_name>_ms INTEGER NOT NULL CHECK (<col_name>_ms >= 0)`
/// and every writer must source the value from this helper.
///
/// **Rationale:**
/// - Range scans on staleness windows are direct integer comparisons
///   (`WHERE col_ms <= ?`) — no `strftime` parsing, no string-collation
///   surprises around the `Z` vs `+00:00` lex-monotonicity hazard that
///   [`crate::now_rfc3339`] documents in its own header comment.
/// - SQLite INTEGER columns sort and range-scan natively without
///   relying on every writer producing the same `YYYY-MM-DDTHH:MM:SS.sssZ`
///   shape.
/// - The PEND-09 tables (`loro_doc_state.updated_at` and
///   `app_settings.updated_at`, migrations 0052 / 0053) already use
///   this encoding; this helper formalises what was previously a
///   per-callsite `chrono::Utc::now().timestamp_millis()` open-code.
///
/// The former TEXT ISO-8601 columns (`materializer_retry_queue.created_at`,
/// `op_log.created_at`, `blocks.deleted_at`) have now been migrated to
/// INTEGER ms and write via this helper (migrations 0077 / 0079 / 0080,
/// Phase 2 of #109). [`crate::now_rfc3339`] remains only for columns that
/// were never milliseconds-encoded (e.g. genuinely TEXT/display uses).
///
/// Returns `i64` so the value lands directly in `sqlx`'s `INTEGER`
/// binding without a `try_from` step. `i64` covers ±292M years around
/// 1970, well past any horizon that matters.
///
/// **Not OS-monotonic.** This is `chrono::Utc::now().timestamp_millis()`,
/// i.e. wall-clock epoch-ms. It can step *backward* (NTP adjustments,
/// manual clock changes) and two successive calls may even return the
/// same value. `created_at` is therefore not a monotonic ordering key on
/// its own — total ordering of writes is established by the composite
/// `(created_at, seq)` key the query layer implements (`seq` being the
/// per-device monotonic sequence number that breaks ties / repairs
/// backward steps).
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Process-global monotonic source for the **delete timestamp** that a
/// soft-delete stamps into `blocks.deleted_at` (and the matching
/// `delete_block` op's `created_at`).
///
/// **Why a dedicated clock and not [`now_ms`]?** A soft-delete uses its
/// `deleted_at` value as the *cohort identity* for restore: a restore walks
/// the deleted subtree and clears only rows whose `deleted_at` equals the
/// seed's (`descendants_cte_standard!()` / `WHERE deleted_at = ?`), and
/// `restore_all_deleted_inner` keys cascade-root detection on
/// `op.created_at = blocks.deleted_at`. [`now_ms`] is wall-clock and **not
/// monotonic**: two independent deletes that land in the same millisecond
/// (or a backward NTP step) collide on `deleted_at`, which makes a
/// separately-deleted nested subtree structurally indistinguishable from the
/// outer cohort. Restoring the outer cohort then over-restores the inner,
/// independently-deleted subtree (#1549).
///
/// This accessor returns `max(now_ms(), last + 1)` under a compare-and-swap
/// loop, so successive calls are **strictly increasing within a process**
/// even when the wall clock repeats or steps backward, giving every distinct
/// delete a distinct `deleted_at`. When the wall clock advances normally the
/// value tracks it (the stored high-water mark is just `now_ms()` again); it
/// only diverges by a few ms under same-millisecond bursts. Across process
/// restarts the clock reseeds from [`now_ms`] on first use — collisions only
/// matter within a single live session (deletes that share a process), so a
/// fresh seed is fine.
///
/// [`now_ms`] itself is deliberately left wall-clock for all other callers
/// (op `created_at` ordering relies on the composite `(created_at, seq)` key,
/// staleness windows, display, etc.).
pub fn next_delete_ms() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};

    /// High-water mark of the last delete timestamp handed out, per process.
    /// `0` means "never seeded" — the first call below seeds it from
    /// [`now_ms`] (epoch-ms is always far above 0, so `0` is an unambiguous
    /// sentinel).
    static DELETE_CLOCK: AtomicI64 = AtomicI64::new(0);

    let mut last = DELETE_CLOCK.load(Ordering::Relaxed);
    loop {
        // Strictly greater than the last value we handed out, and never
        // behind wall-clock. `last + 1` cannot overflow in practice (i64
        // epoch-ms covers ±292M years), but saturate defensively.
        let candidate = now_ms().max(last.saturating_add(1));
        match DELETE_CLOCK.compare_exchange_weak(
            last,
            candidate,
            Ordering::SeqCst,
            Ordering::Relaxed,
        ) {
            Ok(_) => return candidate,
            // Another thread advanced the clock between our load and CAS;
            // retry against the value it observed (no torn reads — the CAS
            // is the single linearization point).
            Err(observed) => last = observed,
        }
    }
}

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

/// PEND-70 — read-pool sibling of [`acquire_logged`] with a tighter
/// 50 ms threshold (see [`SLOW_SEARCH_ACQUIRE_WARN_MS`]). The search
/// surface (`search_blocks` / `search_blocks_partitioned`) competes
/// with the page browser and backlinks queries for the read pool's
/// 4 connections; slow acquires here are the operational signal
/// that bursty typing has saturated the pool.
///
/// `label` mirrors [`acquire_logged`] — a stable, human-readable tag
/// like `"search_partitioned"` so per-surface slow reads can be
/// filtered.
pub async fn search_pool_acquire_logged(
    pool: &SqlitePool,
    label: &'static str,
) -> Result<PoolConnection<Sqlite>, sqlx::Error> {
    let start = std::time::Instant::now();
    let conn = pool.acquire().await?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > SLOW_SEARCH_ACQUIRE_WARN_MS {
        tracing::warn!(
            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            label,
            "slow read-pool acquire"
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

/// #1056 — bundled write-path context for the IPC arg ceiling.
///
/// Write commands previously threaded the same three Tauri `State` args —
/// `pool: State<'_, WritePool>` + `device_id: State<'_, DeviceId>` +
/// `materializer: State<'_, Materializer>` — which permanently burned 3 of
/// tauri-specta's hard 10-argument IPC ceiling (see
/// `commands/AGENTS.md` §`tauri-specta` 10-argument ceiling). Bundling the
/// triple into one managed `WriteCtx` collapses those 3 slots to 1, raising
/// the usable user-arg budget from 7 to ~9 and letting the
/// `#[allow(clippy::too_many_arguments)]` attributed to the base params be
/// removed.
///
/// Every field is cheaply cloneable (the pool and [`Materializer`] are
/// `Arc`-backed; [`DeviceId`] wraps a small `String`), so `WriteCtx` is
/// constructed once at boot from the same values that back the standalone
/// `WritePool` / `DeviceId` / `Materializer` managed states (which are kept
/// for the read-only / partial-triple consumers — e.g. `get_device_id`,
/// `sync_cmds`, `link_metadata`).
///
/// The accessors return exactly the borrow shapes the `*_inner` cores expect
/// (`&SqlitePool`, `&str`, `&Materializer`), so wrappers forward
/// `ctx.pool()` / `ctx.device_id()` / `ctx.materializer()` with no behaviour
/// change.
pub struct WriteCtx {
    write: SqlitePool,
    device_id: crate::device::DeviceId,
    materializer: crate::materializer::Materializer,
}

impl WriteCtx {
    /// Construct from the same values backing the standalone managed states.
    pub fn new(
        write: SqlitePool,
        device_id: crate::device::DeviceId,
        materializer: crate::materializer::Materializer,
    ) -> Self {
        Self {
            write,
            device_id,
            materializer,
        }
    }

    /// The write-capable pool (matches the `&SqlitePool` an `*_inner` takes).
    pub fn pool(&self) -> &SqlitePool {
        &self.write
    }

    /// The device UUID string (matches the `&str` an `*_inner` takes).
    pub fn device_id(&self) -> &str {
        self.device_id.as_str()
    }

    /// The materializer handle (matches the `&Materializer` an `*_inner` takes).
    pub fn materializer(&self) -> &crate::materializer::Materializer {
        &self.materializer
    }
}

/// Per-connection page-cache pragma value (negative = KB).
///
/// #420 — SQLite's page cache is **per-connection** heap, not shared. With up
/// to 6 pooled connections (2 write + 4 read) the desktop 64 MB cache can peak
/// near 384 MB, which risks an Android OOM-kill (the app does not request
/// `largeHeap`). Mobile therefore uses a much smaller per-connection cache and
/// leans on the file-backed mmap region instead; desktop keeps the larger cache
/// that 100k+ block databases benefit from.
#[cfg(target_os = "android")]
pub(crate) const CACHE_SIZE_PRAGMA: &str = "-8192"; // 8 MB / connection
#[cfg(not(target_os = "android"))]
pub(crate) const CACHE_SIZE_PRAGMA: &str = "-65536"; // 64 MB / connection

/// Memory-mapped read-region pragma value (bytes).
///
/// #420 — the mmap region is clean, file-backed, shared address space (much
/// cheaper than the page cache), but on a memory-constrained Android device a
/// 256 MB mapping is still worth trimming. Desktop keeps 256 MB; mobile uses
/// 64 MB.
#[cfg(target_os = "android")]
pub(crate) const MMAP_SIZE_PRAGMA: &str = "67108864"; // 64 MB
#[cfg(not(target_os = "android"))]
pub(crate) const MMAP_SIZE_PRAGMA: &str = "268435456"; // 256 MB

/// Common connection options shared between read and write pools.
pub(crate) fn base_connect_options(db_path: &Path) -> SqliteConnectOptions {
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
        // Page cache (negative value = KB per SQLite docs). Default 2000 pages
        // (~8 MB) thrashes on 100k+ block databases. Per-connection heap, so
        // platform-gated to avoid Android OOM-kill — see CACHE_SIZE_PRAGMA (#420).
        .pragma("cache_size", CACHE_SIZE_PRAGMA)
        // Memory-mapped read region. Default is 0 (disabled). Cuts hot-query
        // latency 2-10x on multi-hundred-MB DBs. Platform-gated — see
        // MMAP_SIZE_PRAGMA (#420).
        .pragma("mmap_size", MMAP_SIZE_PRAGMA)
        // Keep temp B-trees in RAM during large sorts/distinct/groupby
        // instead of spilling to disk. Default is FILE.
        .pragma("temp_store", "MEMORY")
        .busy_timeout(std::time::Duration::from_secs(5))
}

/// #1575 — clear any leaked op-log bypass sentinel at write-pool boot.
///
/// `_op_log_mutation_allowed` is a shared (non-temp) table and the op_log
/// immutability triggers (migration 0036) gate on a global
/// `WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)` predicate.
/// Isolation relies entirely on the transactional discipline in
/// `op_log::bypass` always removing the sentinel before the bypass
/// transaction commits. If any caller ever commits with the sentinel still
/// present (e.g. a crash mid-bypass, or a future bug), append-only
/// enforcement is silently and permanently OFF for the whole database.
///
/// As a defense-in-depth backstop, delete any sentinel rows at boot after
/// migrations run and before the pool serves traffic. Finding a row here
/// means a latent bug leaked the sentinel, so surface it with a `warn`.
async fn clear_leaked_bypass_sentinel(
    write_pool: &SqlitePool,
) -> Result<(), crate::error::AppError> {
    let cleared = sqlx::query!("DELETE FROM _op_log_mutation_allowed")
        .execute(write_pool)
        .await?
        .rows_affected();
    if cleared > 0 {
        tracing::warn!(
            rows = cleared,
            "cleared leaked op-log bypass sentinel at boot: a prior bypass \
             transaction committed (or crashed) without removing the sentinel \
             row, which had silently disabled op_log append-only enforcement \
             DB-wide until now"
        );
    }
    Ok(())
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
        // #434 — cap pool-acquire wait at 10s. sqlx defaults acquire_timeout
        // to 30s, but busy_timeout is 5s; a saturated pool would otherwise
        // freeze the UI for 30s before surfacing an error. 10s gives the
        // pool enough time to recover from a momentary write-heavy burst
        // while still returning an error well within the UI response budget.
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(write_opts)
        .await?;

    // BUG-73 recovery: if a prior crash left blocks missing, recreate it
    // from op_log so migrations have a target table to rebuild.
    let blocks_recovered = ensure_blocks_table_exists(&write_pool).await?;

    // Run migrations on the write pool (needs write access)
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&write_pool).await?;
    tracing::info!("database migrations complete");

    // BUG-73 recovery part 2: restore properties and tags that migration 73's
    // DROP TABLE would have CASCADE-deleted. #616: gated on the positive
    // corruption signal from `ensure_blocks_table_exists` (this boot's flag
    // or the persisted pending marker), never on empty-table inference.
    recover_derived_state_from_op_log(&write_pool, blocks_recovered).await?;

    // T-5: Update query planner statistics after migrations.
    // PRAGMA optimize analyzes tables whose stats may be stale and runs
    // ANALYZE only where beneficial. Safe, idempotent, runs in <100ms
    // for typical personal databases.
    sqlx::query("PRAGMA optimize").execute(&write_pool).await?;

    // #1575: defense-in-depth — clear any leaked op-log bypass sentinel that
    // a prior bypass transaction may have committed without removing. Must
    // run after migrations (the table exists) and before serving traffic.
    clear_leaked_bypass_sentinel(&write_pool).await?;

    // --- Read pool: 4 concurrent readers, query_only enforced ---
    let read_opts = base_connect_options(db_path).pragma("query_only", "ON");
    let read_pool = SqlitePoolOptions::new()
        .max_connections(4)
        // #434 — see write pool: align acquire_timeout with the UX freeze budget
        // instead of sqlx's 30s default.
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(read_opts)
        .await?;

    // R2 (#347): assert the read pool actually came up `query_only`. The
    // `.pragma("query_only", "ON")` above is the structural guard against
    // an accidental write through a read connection (C1's bug class), but a
    // mis-wired connect-options builder or a future sqlx change could
    // silently drop the pragma. Acquire one read connection and confirm
    // `PRAGMA query_only == 1` at boot rather than discovering it on the
    // first errant write at runtime.
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&read_pool)
        .await?;
    if query_only != 1 {
        // #655: this is a read-pool *configuration* failure, not a snapshot
        // failure — surface it in the database domain so logs and the IPC
        // `kind` attribute the failure correctly. Route through
        // `sqlx::Error::Configuration` → `From<sqlx::Error>` so we honour the
        // "never construct `AppError::Database` directly" invariant on the
        // enum and the failure lands as `kind: "database"`.
        return Err(crate::error::AppError::from(sqlx::Error::Configuration(
            format!(
                "read pool failed query_only assertion at boot: PRAGMA query_only = {query_only} \
                 (expected 1); the read pool is not write-protected"
            )
            .into(),
        )));
    }

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

    // BUG-73 recovery
    let blocks_recovered = ensure_blocks_table_exists(&pool).await?;

    // Run migrations
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("database migrations complete");

    // BUG-73 recovery part 2 (#616: see `init_pools` for the gate rationale)
    recover_derived_state_from_op_log(&pool, blocks_recovered).await?;

    // L-8: match `init_pools` — refresh planner stats after migrations.
    sqlx::query("PRAGMA optimize").execute(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// #1575 — the boot cleanup helper deletes a leaked bypass sentinel so
    /// op_log append-only enforcement is restored. Revert-sensitive: if the
    /// `DELETE FROM _op_log_mutation_allowed` is removed, the row survives and
    /// this assertion fails.
    #[tokio::test]
    async fn clear_leaked_bypass_sentinel_deletes_leaked_row() {
        let (pool, _dir) = test_pool().await;

        // Simulate a leaked sentinel: a prior bypass transaction committed
        // (or crashed) without removing its row, disabling enforcement DB-wide.
        sqlx::query("INSERT INTO _op_log_mutation_allowed (token) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before, 1, "sentinel row should be present before cleanup");

        clear_leaked_bypass_sentinel(&pool).await.unwrap();

        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, 0, "boot cleanup must clear the leaked sentinel");
    }

    /// No-op when there is nothing to clear — the common (healthy) case must
    /// not error and must leave the table empty.
    #[tokio::test]
    async fn clear_leaked_bypass_sentinel_is_noop_when_absent() {
        let (pool, _dir) = test_pool().await;

        clear_leaked_bypass_sentinel(&pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
