//! `db` — pure, sqlx-free SQLite pool primitives for the layered-workspace
//! split (#2621).
//!
//! Holds the connection-pool value types (`DbPools`, `WritePool`, `ReadPool`),
//! the slow-acquire/begin logging helpers, the shared connect-options builder +
//! its platform-gated pragma constants, and the two epoch-ms clocks (`now_ms`,
//! `next_delete_ms`). These have **zero** `sqlx::query!` macros, so they carry
//! no `.sqlx` offline-cache dependency. The app-only wiring that couples to
//! `recovery` / `device` / `materializer` (`WriteCtx`, `init_pools`,
//! `init_pool`, `clear_leaked_bypass_sentinel`) stays in the `agaric` crate,
//! which re-exports this module (`pub use agaric_store::db::*;`) so every
//! existing `crate::db::…` path resolves unchanged.

use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Sqlite, SqlitePool};
use std::path::Path;

/// Threshold (ms) above which [`acquire_logged`] emits a `warn` log.
///
/// A `busy_timeout` of 5000ms on the SqlitePool can make callers
/// wait silently on write contention. 100ms is a generous floor that ignores
/// normal cold-start acquires but surfaces anything pathological.
pub const SLOW_ACQUIRE_WARN_MS: u128 = 100;

/// Threshold (ms) above which [`search_pool_acquire_logged`]
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
///   `agaric_core::time::now_rfc3339` documents in its own header comment.
/// - SQLite INTEGER columns sort and range-scan natively without
///   relying on every writer producing the same `YYYY-MM-DDTHH:MM:SS.sssZ`
///   shape.
///   The tables (`loro_doc_state.updated_at` and
///   `app_settings.updated_at`, migrations 0052 / 0053) already use
///   this encoding; this helper formalises what was previously a
///   per-callsite `chrono::Utc::now().timestamp_millis()` open-code.
///
/// The former TEXT ISO-8601 columns (`materializer_retry_queue.created_at`,
/// `op_log.created_at`, `blocks.deleted_at`) have now been migrated to
/// INTEGER ms and write via this helper (migrations 0077 / 0079 / 0080,
/// Phase 2 of #109). `agaric_core::time::now_rfc3339` remains only for columns
/// that were never milliseconds-encoded (e.g. genuinely TEXT/display uses).
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

/// Read-pool sibling of [`acquire_logged`] with a tighter
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

/// Per-connection page-cache pragma value (negative = KB).
///
/// #420 — SQLite's page cache is **per-connection** heap, not shared. With up
/// to 6 pooled connections (2 write + 4 read) the desktop 64 MB cache can peak
/// near 384 MB, which risks an Android OOM-kill (the app does not request
/// `largeHeap`). Mobile therefore uses a much smaller per-connection cache and
/// leans on the file-backed mmap region instead; desktop keeps the larger cache
/// that 100k+ block databases benefit from.
#[cfg(target_os = "android")]
pub const CACHE_SIZE_PRAGMA: &str = "-8192"; // 8 MB / connection
#[cfg(not(target_os = "android"))]
pub const CACHE_SIZE_PRAGMA: &str = "-65536"; // 64 MB / connection

/// Memory-mapped read-region pragma value (bytes).
///
/// #420 — the mmap region is clean, file-backed, shared address space (much
/// cheaper than the page cache), but on a memory-constrained Android device a
/// 256 MB mapping is still worth trimming. Desktop keeps 256 MB; mobile uses
/// 64 MB.
#[cfg(target_os = "android")]
pub const MMAP_SIZE_PRAGMA: &str = "67108864"; // 64 MB
#[cfg(not(target_os = "android"))]
pub const MMAP_SIZE_PRAGMA: &str = "268435456"; // 256 MB

/// Common connection options shared between read and write pools.
pub fn base_connect_options(db_path: &Path) -> SqliteConnectOptions {
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
