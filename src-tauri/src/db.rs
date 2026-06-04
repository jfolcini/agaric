use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, Sqlite, SqlitePool};
use std::path::Path;
use std::sync::Arc;

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
/// The legacy TEXT ISO-8601 tables (`blocks.deleted_at`, `op_log.created_at`,
/// `materializer_retry_queue.created_at`, etc.) keep
/// [`crate::now_rfc3339`] for their writes — migrating those columns to
/// INTEGER ms is Phase 2 of #109 and ships per-table.
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
///
/// PEND-25 L2 + L9: the inner `OpRecord` is held as `Arc<OpRecord>` so
/// command sites that need both the dispatch queue and a post-commit
/// `notify_gcal_for_op` borrow can share one record via refcount
/// instead of deep-cloning. The enqueue methods accept
/// `impl Into<Arc<OpRecord>>` so the existing call sites that hand off
/// a freshly-built `OpRecord` by value continue to compile unchanged
/// (the blanket `impl<T> From<T> for Arc<T>` makes the conversion
/// transparent).
enum PendingDispatch {
    /// Plain op dispatch — invokes [`Materializer::dispatch_background_or_warn`].
    Background(Arc<crate::op_log::OpRecord>),
    /// Edit-op dispatch with a `block_type` hint — invokes
    /// [`Materializer::dispatch_edit_background`] and warns on error.
    /// The materializer uses the hint to pick a narrower cache-rebuild
    /// fan-out for content vs. tag vs. page edits.
    EditBackground {
        record: Arc<crate::op_log::OpRecord>,
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
    #[expect(
        dead_code,
        reason = "stored for a planned Drop-time debug-assert that names the originating command"
    )]
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
    ///
    /// PEND-25 L9: accepts `impl Into<Arc<OpRecord>>` so callers can pass
    /// either a fresh `OpRecord` by value (Rust's blanket
    /// `impl<T> From<T> for Arc<T>` does the wrap) or an existing
    /// `Arc<OpRecord>` they need to share with a post-commit borrow
    /// (e.g. `materializer.notify_gcal_for_op(&op_record, ...)`).
    pub fn enqueue_background(&mut self, record: impl Into<Arc<crate::op_log::OpRecord>>) {
        self.pending
            .push(PendingDispatch::Background(record.into()));
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
    ///
    /// PEND-25 L9: see [`Self::enqueue_background`] — same `Into<Arc<…>>`
    /// shape so the callsite reads identically regardless of whether the
    /// record is owned or already shared.
    pub fn enqueue_edit_background(
        &mut self,
        record: impl Into<Arc<crate::op_log::OpRecord>>,
        block_type: impl Into<String>,
    ) {
        self.pending.push(PendingDispatch::EditBackground {
            record: record.into(),
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
        // Page cache: 64 MB (negative value = KB per SQLite docs).
        // Default 2000 pages (~8 MB) thrashes on 100k+ block databases.
        .pragma("cache_size", "-65536")
        // Memory-mapped read region: 256 MB. Default is 0 (disabled).
        // Cuts hot-query latency 2-10x on multi-hundred-MB DBs.
        .pragma("mmap_size", "268435456")
        // Keep temp B-trees in RAM during large sorts/distinct/groupby
        // instead of spilling to disk. Default is FILE.
        .pragma("temp_store", "MEMORY")
        .busy_timeout(std::time::Duration::from_secs(5))
}

// ======================================================================
// Recovery helpers for corrupted databases (missing blocks table)
// ======================================================================

/// If the `blocks` table is missing (e.g. from a partial migration-73
/// DROP TABLE that was not rolled back), create a temporary table and
/// replay block-level ops from `op_log` to reconstruct it.
///
/// Dependent tables (block_properties, block_tags, …) are recovered
/// *after* migrations run via [`recover_derived_state_from_op_log`]
/// because migration 73's DROP TABLE blocks would CASCADE-delete them.
async fn ensure_blocks_table_exists(pool: &SqlitePool) -> Result<(), crate::error::AppError> {
    // R4 (#347): propagate probe errors with `?` rather than masking a
    // transient failure as `0`/false. A swallowed error here would skip
    // recovery entirely and let migrations run against a missing `blocks`
    // table — far worse than surfacing the boot error.
    let exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'blocks'"
    )
    .fetch_one(pool)
    .await?
        > 0;

    if exists {
        return Ok(());
    }

    // Only recover if this is a corrupted database (migrations have already
    // run at least once). Fresh databases have no _sqlx_migrations yet.
    let migrations_table_exists: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'"
    )
    .fetch_one(pool)
    .await?;

    if migrations_table_exists == 0 {
        return Ok(());
    }

    let migration_rows: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?;

    if migration_rows == 0 {
        return Ok(());
    }

    tracing::warn!(
        "blocks table missing — likely from a partial migration-73 run. \
         Creating temporary table and recovering from op_log."
    );

    let mut tx = pool.begin().await?;

    // Temporary blocks table: no STRICT, no FK constraints, no CHECK.
    // Migration 73 will rebuild it with the proper constraints.
    sqlx::query(
        "CREATE TABLE blocks (
            id             TEXT NOT NULL PRIMARY KEY,
            block_type     TEXT NOT NULL DEFAULT 'content',
            content        TEXT,
            parent_id      TEXT,
            position       INTEGER,
            deleted_at     TEXT,
            todo_state     TEXT,
            priority       TEXT,
            due_date       TEXT,
            scheduled_date TEXT,
            page_id        TEXT
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Replay create / edit / move / delete / restore / purge ops into blocks.
    recover_blocks_from_op_log(&mut tx).await?;

    tx.commit().await?;
    Ok(())
}

/// Replay block-level ops from `op_log` into an existing (temporary)
/// `blocks` table.  Called by [`ensure_blocks_table_exists`] inside a
/// transaction so the rebuild is atomic.
async fn recover_blocks_from_op_log(
    executor: &mut sqlx::SqliteConnection,
) -> Result<(), crate::error::AppError> {
    // Guard: op_log might not exist on ancient databases.
    // R4 (#347): propagate with `?` — a transient probe failure must not
    // silently skip block recovery.
    let op_log_exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'op_log'"
    )
    .fetch_one(&mut *executor)
    .await?
        > 0;

    if !op_log_exists {
        tracing::warn!("op_log table missing — cannot recover blocks data");
        return Ok(());
    }

    // C8 (#345): replay in materializer LWW order. The live materializer
    // resolves cross-device same-block edits by `created_at DESC` (last
    // writer wins); replaying in `(device_id, seq)` order instead would
    // let the lexically-largest `device_id` win regardless of wall-clock
    // time, diverging the recovered `blocks` table from a normally-applied
    // log. `created_at` is an indexed INTEGER-ms column post-migration
    // 0079/0080; `(device_id, seq)` is the deterministic tiebreaker for
    // ops sharing a millisecond.
    let ops =
        sqlx::query("SELECT op_type, payload FROM op_log ORDER BY created_at, device_id, seq")
            .fetch_all(&mut *executor)
            .await?;

    if ops.is_empty() {
        return Ok(());
    }

    tracing::info!("Replaying {} ops into temporary blocks table", ops.len());

    let now_rfc3339 = chrono::Utc::now().to_rfc3339();

    for row in ops {
        let op_type: String = row.try_get("op_type")?;
        let payload_str: String = row.try_get("payload")?;

        let payload: serde_json::Value =
            serde_json::from_str(&payload_str).map_err(crate::error::AppError::Json)?;

        match op_type.as_str() {
            "create_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let block_type = payload["block_type"].as_str().unwrap_or("content");
                let content = payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let parent_id = payload.get("parent_id").and_then(serde_json::Value::as_str);
                let position = payload.get("position").and_then(serde_json::Value::as_i64);

                sqlx::query(
                    "INSERT OR IGNORE INTO blocks \
                     (id, block_type, content, parent_id, position, deleted_at, \
                      todo_state, priority, due_date, scheduled_date, page_id) \
                     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
                )
                .bind(block_id)
                .bind(block_type)
                .bind(content)
                .bind(parent_id)
                .bind(position)
                .execute(&mut *executor)
                .await?;
            }
            "edit_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                if let Some(to_text) = payload.get("to_text").and_then(serde_json::Value::as_str) {
                    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                        .bind(to_text)
                        .bind(block_id)
                        .execute(&mut *executor)
                        .await?;
                }
            }
            "move_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let new_parent_id = payload
                    .get("new_parent_id")
                    .and_then(serde_json::Value::as_str);
                let new_position = payload
                    .get("new_position")
                    .and_then(serde_json::Value::as_i64);

                sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                    .bind(new_parent_id)
                    .bind(new_position)
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;
            }
            "delete_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
                    .bind(&now_rfc3339)
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;
            }
            "restore_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                sqlx::query("UPDATE blocks SET deleted_at = NULL WHERE id = ?")
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;
            }
            "purge_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                sqlx::query("DELETE FROM blocks WHERE id = ?")
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;
            }
            _ => {
                // set_property / delete_property / add_tag are handled
                // post-migration so they survive migration 73's DROP TABLE.
            }
        }
    }

    // Clean up orphaned parent_ids so migration 73's INSERT into _new_blocks
    // doesn't fail on dangling FK references (e.g. parent created on another
    // device and not present in the local op_log).
    sqlx::query(
        "UPDATE blocks SET parent_id = NULL \
         WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM blocks)",
    )
    .execute(&mut *executor)
    .await?;

    // Compute page_id: pages self-reference, content blocks inherit from
    // nearest page ancestor, tags stay NULL.
    sqlx::query("UPDATE blocks SET page_id = id WHERE block_type = 'page'")
        .execute(&mut *executor)
        .await?;

    loop {
        let rows = sqlx::query(
            "UPDATE blocks SET page_id = (
                SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END
                FROM blocks AS parent WHERE parent.id = blocks.parent_id
            )
            WHERE block_type = 'content' AND page_id IS NULL AND parent_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM blocks AS parent
                  WHERE parent.id = blocks.parent_id AND parent.page_id IS NOT NULL
              )",
        )
        .execute(&mut *executor)
        .await?
        .rows_affected();

        if rows == 0 {
            break;
        }
    }

    Ok(())
}

/// After migrations run, recover dependent tables (block_properties,
/// block_tags) from `op_log` if they are empty but the op log contains
/// the corresponding ops.  Also backfills the denormalised columns on
/// `blocks` (todo_state, priority, due_date, scheduled_date).
async fn recover_derived_state_from_op_log(
    pool: &SqlitePool,
) -> Result<(), crate::error::AppError> {
    // Guard: skip if op_log is empty or missing.
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    if op_count == 0 {
        return Ok(());
    }

    // Only recover if derived tables are empty — otherwise we would
    // duplicate rows on every startup.
    //
    // R4 (#347): propagate probe errors with `?` rather than masking them
    // as `0` (which would wrongly trigger a full re-replay against an
    // already-populated DB).
    let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
        .fetch_one(pool)
        .await?;

    let tag_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(pool)
        .await?;

    // C9 (#345) — the OR is intentional; a per-table gate is NOT safe here.
    //
    // This recovery exists for exactly one state: migration 73's
    // `DROP TABLE blocks` CASCADE-emptied both `block_properties` and
    // `block_tags` (both carry `FK … ON DELETE CASCADE` to `blocks(id)`),
    // so in the corruption path the two tables empty *together* — they
    // never empty independently. The OR therefore fires recovery iff BOTH
    // are empty and skips it the moment EITHER holds rows (the DB is
    // already populated; re-replaying would duplicate).
    //
    // A per-table gate ("recover properties iff prop_count == 0, tags iff
    // tag_count == 0") was evaluated and rejected: (1) the single shared
    // `tx` replays the whole op log once across set_property /
    // delete_property / add_tag, so per-table gating would need two passes
    // or mid-loop op-type skipping; (2) the trailing blocks-column
    // backfill (todo_state / priority / due_date / scheduled_date) reads
    // from the just-repopulated `block_properties`, so gating properties
    // off while tags ran would leave the denormalised columns stale; and
    // (3) because both tables empty together, the OR and an AND are
    // equivalent on the only path that reaches here — the OR is just the
    // more conservative phrasing (any sign of existing data ⇒ skip).
    if prop_count > 0 || tag_count > 0 {
        return Ok(());
    }

    tracing::warn!(
        "Derived tables empty but op_log has {} ops — recovering properties, tags, and attachments",
        op_count
    );

    let mut tx = pool.begin().await?;

    // C8 (#345): replay derived-state ops in materializer LWW order
    // (`created_at DESC` semantics → ascending replay with last-writer
    // overwriting earlier values), `(device_id, seq)` as the same-ms
    // tiebreaker. See the matching rationale in `recover_blocks_from_op_log`.
    //
    // #374: `created_at` is selected so the `add_attachment` arm can restore
    // `attachments.created_at` (a NOT NULL column) from the originating op's
    // timestamp — the same value the live `apply_add_attachment_tx` writes.
    let ops = sqlx::query(
        "SELECT op_type, payload, created_at FROM op_log ORDER BY created_at, device_id, seq",
    )
    .fetch_all(&mut *tx)
    .await?;

    for row in ops {
        let op_type: String = row.try_get("op_type")?;
        let payload_str: String = row.try_get("payload")?;
        let payload: serde_json::Value =
            serde_json::from_str(&payload_str).map_err(crate::error::AppError::Json)?;

        match op_type.as_str() {
            "set_property" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let key = payload["key"].as_str().unwrap_or("");
                let value_text = payload
                    .get("value_text")
                    .and_then(serde_json::Value::as_str);
                let value_num = payload.get("value_num").and_then(serde_json::Value::as_f64);
                let value_date = payload
                    .get("value_date")
                    .and_then(serde_json::Value::as_str);
                let value_ref = payload.get("value_ref").and_then(serde_json::Value::as_str);
                let value_bool = payload
                    .get("value_bool")
                    .and_then(serde_json::Value::as_bool)
                    .map(|b| if b { 1i64 } else { 0i64 });

                // A `SetProperty` with NO value set is an explicit *clear*
                // (value = None) — the live projection represents a cleared
                // property as row-absent, never an all-NULL row. Inserting
                // the all-NULL row here would violate the `exactly_one_value`
                // CHECK (migration 0062, which requires exactly one value
                // column non-NULL) and abort startup with a (275) panic.
                // Replay it as a DELETE so the LWW order is preserved: a
                // clear removes any prior value for this (block_id, key).
                let value_count = i32::from(value_text.is_some())
                    + i32::from(value_num.is_some())
                    + i32::from(value_date.is_some())
                    + i32::from(value_ref.is_some())
                    + i32::from(value_bool.is_some());
                if value_count == 0 {
                    sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                        .bind(block_id)
                        .bind(key)
                        .execute(&mut *tx)
                        .await?;
                    continue;
                }

                // Guard the two FK columns (block_id, value_ref → blocks(id)).
                // An op may reference a block that was purged or created on
                // another device and is absent from the local op_log, so
                // inserting blindly would trip FOREIGN KEY constraint failed
                // (787) and abort startup. Skip the row entirely if its owning
                // block is gone, or if a non-null value_ref dangles: under the
                // exactly-one-value invariant (migration 0062) value_ref is the
                // row's sole value, and its FK is ON DELETE CASCADE, so a dead
                // ref means the whole property is dead — nulling it would just
                // trade FK 787 for a CHECK violation on the now all-NULL row.
                sqlx::query(
                    "INSERT OR REPLACE INTO block_properties \
                     (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND (? IS NULL OR EXISTS (SELECT 1 FROM blocks WHERE id = ?))",
                )
                .bind(block_id)
                .bind(key)
                .bind(value_text)
                .bind(value_num)
                .bind(value_date)
                .bind(value_ref)
                .bind(value_bool)
                .bind(block_id)
                .bind(value_ref)
                .bind(value_ref)
                .execute(&mut *tx)
                .await?;
            }
            "delete_property" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let key = payload["key"].as_str().unwrap_or("");

                sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                    .bind(block_id)
                    .bind(key)
                    .execute(&mut *tx)
                    .await?;
            }
            "add_tag" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let tag_id = payload["tag_id"].as_str().unwrap_or("");

                // Both columns are FKs to blocks(id): skip the tag if either
                // the tagged block or the tag block is absent (purged, or
                // never created in the local op_log) to avoid FK 787 panic.
                sqlx::query(
                    "INSERT OR IGNORE INTO block_tags (block_id, tag_id) \
                     SELECT ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                )
                .bind(block_id)
                .bind(tag_id)
                .bind(block_id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await?;
            }
            // #374: `attachments` is the one AUTHORITATIVE child of `blocks`
            // (its rows are the source of truth for fs_path / mime_type /
            // filename / size_bytes — NOT a derived cache). Migration 0061
            // gave `attachments.block_id` an `ON DELETE CASCADE` to
            // `blocks(id)`, so the `DROP TABLE blocks` in the 0073/0080
            // rebuilds cascade-deleted every attachment row under
            // `foreign_keys=ON`, silently destroying that metadata and
            // orphaning the on-disk files. The op-log `add_attachment`
            // payload carries every column the row needs, so replay it here
            // to restore the table (this arm runs on the same all-derived-
            // tables-empty corruption path as the property/tag arms above).
            "add_attachment" => {
                let attachment_id = payload["attachment_id"].as_str().unwrap_or("");
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let mime_type = payload["mime_type"].as_str().unwrap_or("");
                let filename = payload["filename"].as_str().unwrap_or("");
                let size_bytes = payload["size_bytes"].as_i64().unwrap_or(0);
                let fs_path = payload["fs_path"].as_str().unwrap_or("");
                let created_at: i64 = row.try_get("created_at")?;

                // Guard the `block_id` FK (→ blocks(id)): an attachment whose
                // owning block was purged (or never reached this device) must
                // stay deleted — restoring it would trip FK 787 and abort
                // startup. `INSERT OR IGNORE` makes a duplicate `add_attachment`
                // (same id) a no-op and keeps recovery idempotent across boots.
                sqlx::query(
                    "INSERT OR IGNORE INTO attachments \
                     (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                )
                .bind(attachment_id)
                .bind(block_id)
                .bind(mime_type)
                .bind(filename)
                .bind(size_bytes)
                .bind(fs_path)
                .bind(created_at)
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
            }
            // #374: a later `delete_attachment` must win over its earlier
            // `add_attachment` (LWW replay order), so drop any row this op
            // removed — otherwise recovery would resurrect a deleted file.
            "delete_attachment" => {
                let attachment_id = payload["attachment_id"].as_str().unwrap_or("");

                sqlx::query("DELETE FROM attachments WHERE id = ?")
                    .bind(attachment_id)
                    .execute(&mut *tx)
                    .await?;
            }
            _ => {}
        }
    }

    // Backfill denormalised columns on blocks from block_properties.
    sqlx::query(
        "UPDATE blocks SET todo_state = (SELECT value_text FROM block_properties \
         WHERE block_id = blocks.id AND key = 'todo_state')",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE blocks SET priority = (SELECT value_text FROM block_properties \
         WHERE block_id = blocks.id AND key = 'priority')",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE blocks SET due_date = (SELECT value_date FROM block_properties \
         WHERE block_id = blocks.id AND key = 'due_date')",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE blocks SET scheduled_date = (SELECT value_date FROM block_properties \
         WHERE block_id = blocks.id AND key = 'scheduled_date')",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
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
        .connect_with(write_opts)
        .await?;

    // BUG-73 recovery: if a prior crash left blocks missing, recreate it
    // from op_log so migrations have a target table to rebuild.
    ensure_blocks_table_exists(&write_pool).await?;

    // Run migrations on the write pool (needs write access)
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&write_pool).await?;
    tracing::info!("database migrations complete");

    // BUG-73 recovery part 2: restore properties and tags that migration 73's
    // DROP TABLE would have CASCADE-deleted.
    recover_derived_state_from_op_log(&write_pool).await?;

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
        return Err(crate::error::AppError::Snapshot(format!(
            "read pool failed query_only assertion at boot: PRAGMA query_only = {query_only} \
             (expected 1); the read pool is not write-protected"
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
    ensure_blocks_table_exists(&pool).await?;

    // Run migrations
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("database migrations complete");

    // BUG-73 recovery part 2
    recover_derived_state_from_op_log(&pool).await?;

    // L-8: match `init_pools` — refresh planner stats after migrations.
    sqlx::query("PRAGMA optimize").execute(&pool).await?;

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

    /// Issue #109 Phase 1 — `now_ms()` returns a plausible wall-clock
    /// epoch-ms value. The test deliberately doesn't pin a value range
    /// against `chrono::Utc::now()` to avoid a circular self-test; it
    /// pins only the shape every downstream call site relies on (positive
    /// value, well below i64::MAX). It does NOT assert monotonicity:
    /// `now_ms()` is wall-clock, not OS-monotonic, and may step backward
    /// (NTP) — ordering of writes is the `(created_at, seq)` query layer's
    /// job, not this helper's.
    #[test]
    fn now_ms_returns_plausible_epoch_ms_109() {
        let a = now_ms();
        let b = now_ms();
        assert!(a > 0, "now_ms() must be positive (post-epoch)");
        assert!(b > 0, "now_ms() must be positive (post-epoch)");
        // Well below i64::MAX, where chrono panics. Year 2262-04-11
        // overflows i64 milliseconds; current date is in the 2020s, so
        // there's ~7 orders of magnitude of headroom.
        assert!(
            b < i64::MAX / 1000,
            "now_ms() must stay comfortably below i64::MAX for the foreseeable future"
        );
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

    // L-8: legacy `init_pool` should run `PRAGMA optimize` after migrations,
    // matching production `init_pools`. Real coverage: the call doesn't fail
    // and the pool is usable for a SELECT afterwards.
    #[tokio::test]
    async fn init_pool_runs_pragma_optimize() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.expect("init_pool should succeed");
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .expect("post-init SELECT should succeed");
        assert_eq!(count, 0, "fresh DB should have zero blocks");
    }

    /// BUG-73 regression: migrations 0073 and 0080 rebuild `blocks` by
    /// creating `_new_blocks`, copying data, then `DROP TABLE blocks`.
    /// The original SQL declared `parent_id REFERENCES blocks(id)` and
    /// `page_id REFERENCES blocks(id)` inside `_new_blocks`. After the
    /// INSERT, `_new_blocks` itself became a child table with RESTRICT
    /// and data, causing `DROP TABLE blocks` to fail with FK constraint.
    /// The fix uses `REFERENCES _new_blocks(id)` (self-reference); after
    /// `ALTER TABLE _new_blocks RENAME TO blocks`, SQLite rewrites the
    /// reference to `blocks(id)`.
    #[tokio::test]
    async fn blocks_rebuild_self_fk_allows_drop() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .pragma("foreign_keys", "ON"),
            )
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE blocks (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT REFERENCES blocks(id),
                page_id TEXT REFERENCES blocks(id)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO blocks VALUES ('B1', NULL, 'B1')")
            .execute(&pool)
            .await
            .unwrap();

        // Reproduce the fixed migration pattern.
        sqlx::query(
            "CREATE TABLE _new_blocks (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT REFERENCES _new_blocks(id),
                page_id TEXT REFERENCES _new_blocks(id),
                CONSTRAINT page_id_self_for_pages CHECK (
                    page_id = id
                )
            ) STRICT",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO _new_blocks SELECT * FROM blocks")
            .execute(&pool)
            .await
            .unwrap();

        // This DROP was the failure point before the fix.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("ALTER TABLE _new_blocks RENAME TO blocks")
            .execute(&pool)
            .await
            .unwrap();

        let sql: (String,) = sqlx::query_as(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            sql.0.contains("REFERENCES \"blocks\"(id)"),
            "after rename the self-FK should point to blocks: {}",
            sql.0
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

    /// R2 (#347): `init_pools` asserts `PRAGMA query_only == 1` on the read
    /// pool at boot. A correctly-wired pool passes the assertion (init
    /// succeeds) AND every read connection reports `query_only = 1`, so the
    /// structural guard against accidental writes through the read pool is
    /// verified eagerly rather than on the first errant write.
    #[tokio::test]
    async fn init_pools_asserts_read_pool_query_only_at_boot() {
        let (pools, _dir) = test_pools().await;
        // init_pools returning Ok already means the boot assertion passed;
        // double-check the live pragma value on a fresh read connection.
        let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            query_only, 1,
            "read pool must report PRAGMA query_only = 1 after init_pools boot assertion"
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
    // Performance PRAGMAs: cache_size, mmap_size, temp_store
    // ======================================================================

    #[tokio::test]
    async fn init_pool_sets_performance_pragmas() {
        let (pool, _dir) = test_pool().await;

        // cache_size: stored as a negative value meaning KB. -65536 = 64 MB.
        let cache_size = sqlx::query_scalar::<_, i64>("PRAGMA cache_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cache_size, -65536, "cache_size should be -65536 (64 MB)");

        // mmap_size: 256 MB memory-mapped read region.
        let mmap_size = sqlx::query_scalar::<_, i64>("PRAGMA mmap_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            mmap_size, 268_435_456,
            "mmap_size should be 268435456 (256 MB)"
        );

        // temp_store: 2 == MEMORY (0 == DEFAULT, 1 == FILE, 2 == MEMORY).
        let temp_store = sqlx::query_scalar::<_, i64>("PRAGMA temp_store")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(temp_store, 2, "temp_store should be 2 (MEMORY)");
    }

    // ======================================================================
    // PEND-103 (issue #103): after migration 0072 dropped the redundant
    // idx_block_links_source, `WHERE source_id = ?` lookups must fall
    // through to the PK autoindex (sqlite_autoindex_block_links_1). Lock
    // that planner choice so a future schema change can't silently
    // regress to a full table scan.
    // ======================================================================

    #[tokio::test]
    async fn block_links_source_lookup_uses_pk_autoindex() {
        let (pool, _dir) = test_pool().await;
        let plan_rows: Vec<(i64, i64, i64, String)> =
            sqlx::query_as("EXPLAIN QUERY PLAN SELECT 1 FROM block_links WHERE source_id = ?")
                .bind("X")
                .fetch_all(&pool)
                .await
                .unwrap();
        let plan_text = plan_rows
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan_text.contains("sqlite_autoindex_block_links_1"),
            "WHERE source_id = ? must use the PK autoindex after migration 0072 \
             dropped idx_block_links_source; got plan:\n{plan_text}"
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
            created_at: 0,
            block_id: None,
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

    /// BUG-73 regression: when `blocks` is missing but `op_log` still has
    /// data (partial migration-73 DROP TABLE), `init_pool` must recreate
    /// `blocks` from `op_log` and then restore dependent tables after
    /// migrations so no user data is lost.
    #[tokio::test]
    async fn init_pool_recover_blocks_from_op_log_73() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        // Step 1: create a normal migrated database with some data.
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PAGE1','page','Page A',NULL,1,'PAGE1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('CHILD1','content','child','PAGE1',1,'PAGE1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('CHILD1','priority','high')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('CHILD1','PAGE1')")
            .execute(&pool)
            .await
            .unwrap();

        // Seed op_log with create_block ops so recovery has something to replay.
        // created_at is INTEGER ms in the migrated schema (Issue #109).
        let ts = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 1, 'h1', 'create_block', \
             '{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"Page A\",\"parent_id\":null,\"position\":1}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 2, 'h2', 'create_block', \
             '{\"block_id\":\"RECOV1\",\"block_type\":\"content\",\"content\":\"recovered\",\"parent_id\":\"PAGE1\",\"position\":2}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 3, 'h3', 'set_property', \
             '{\"block_id\":\"RECOV1\",\"key\":\"due_date\",\"value_date\":\"2026-06-15\",\"value_text\":null,\"value_num\":null,\"value_ref\":null}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 4, 'h4', 'add_tag', \
             '{\"block_id\":\"RECOV1\",\"tag_id\":\"PAGE1\"}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();

        // Step 2: simulate corruption — drop blocks.  CASCADE deletes
        // dependent rows, but the empty tables remain with FK references
        // to the missing blocks table, so we cannot run DML on them.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        // Step 3: reopen the database with init_pool — recovery should run.
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        // Step 4: verify blocks were recovered from op_log.
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            count >= 2,
            "blocks should be recovered: expected at least 2 rows, got {count}"
        );

        // Verify the directly-inserted page and child survived.
        let page_exists: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM blocks WHERE id = 'PAGE1' AND block_type = 'page'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(page_exists, 1, "original page should survive recovery");

        // Verify the op_log-recovered block exists with correct page_id.
        let recov = sqlx::query("SELECT id, content, page_id FROM blocks WHERE id = 'RECOV1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let recov_id: String = recov.try_get("id").unwrap();
        let recov_content: String = recov.try_get("content").unwrap();
        let recov_page_id: Option<String> = recov.try_get("page_id").unwrap();
        assert_eq!(recov_id, "RECOV1");
        assert_eq!(recov_content, "recovered");
        assert_eq!(
            recov_page_id,
            Some("PAGE1".to_string()),
            "page_id should be computed from parent chain"
        );

        // Verify dependent tables were restored post-migration.
        let prop_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'RECOV1' AND key = 'due_date'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(prop_count, 1, "property should be recovered");

        let tag_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'RECOV1' AND tag_id = 'PAGE1'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tag_count, 1, "tag should be recovered");

        // Verify denormalised column was backfilled.
        let due_row = sqlx::query("SELECT due_date FROM blocks WHERE id = 'RECOV1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let due: Option<String> = due_row.try_get("due_date").unwrap();
        assert_eq!(
            due,
            Some("2026-06-15".to_string()),
            "due_date should be backfilled from properties"
        );
    }

    /// BUG-73 regression: derived-state recovery must not crash when op_log
    /// contains `set_property` / `add_tag` ops that reference blocks absent
    /// from the recovered `blocks` table (purged locally, or created on
    /// another device and never present in the local op_log).  Those ops'
    /// FK columns (`block_id`, `value_ref`, `tag_id` → blocks(id)) would
    /// otherwise trip `FOREIGN KEY constraint failed (787)` and abort
    /// startup.  Dangling ops must be skipped; valid ones still recovered.
    #[tokio::test]
    async fn init_pool_recovery_skips_dangling_fk_refs_73() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = init_pool(&db_path).await.unwrap();

        let ts = chrono::Utc::now().timestamp_millis();

        // Seed op_log. Only PAGE1 / CHILD1 get create_block ops, so they are
        // the only blocks rebuilt; every GHOST_* id below is absent from the
        // recovered blocks table.
        let ops: &[(i64, &str, &str)] = &[
            (1, "create_block", "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"Page A\",\"parent_id\":null,\"position\":1}"),
            (2, "create_block", "{\"block_id\":\"CHILD1\",\"block_type\":\"content\",\"content\":\"child\",\"parent_id\":\"PAGE1\",\"position\":2}"),
            // Valid property on a live block — must survive.
            (3, "set_property", "{\"block_id\":\"CHILD1\",\"key\":\"priority\",\"value_text\":\"high\"}"),
            // Dangling block_id (GHOST_BLOCK never created) — must be skipped.
            (4, "set_property", "{\"block_id\":\"GHOST_BLOCK\",\"key\":\"priority\",\"value_text\":\"low\"}"),
            // Dangling value_ref (sole value points at missing block) — skip whole row.
            (5, "set_property", "{\"block_id\":\"CHILD1\",\"key\":\"related\",\"value_ref\":\"GHOST_REF\"}"),
            // Valid tag — must survive.
            (6, "add_tag", "{\"block_id\":\"CHILD1\",\"tag_id\":\"PAGE1\"}"),
            // Dangling tag_id — skip.
            (7, "add_tag", "{\"block_id\":\"CHILD1\",\"tag_id\":\"GHOST_TAG\"}"),
            // Dangling tagged block_id — skip.
            (8, "add_tag", "{\"block_id\":\"GHOST_BLOCK\",\"tag_id\":\"PAGE1\"}"),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Corrupt: drop blocks so recovery runs on reopen.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Must NOT panic / error with FK 787 — this is the regression.
        let pool = init_pool(&db_path)
            .await
            .expect("recovery must skip dangling FK refs instead of crashing");

        // Valid property recovered.
        let prio: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'CHILD1' AND key = 'priority'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prio, 1,
            "valid property on a live block should be recovered"
        );

        // Dangling-block property skipped.
        let ghost_prop: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'GHOST_BLOCK'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ghost_prop, 0, "property on a missing block must be skipped");

        // Dangling value_ref property skipped entirely.
        let related: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'CHILD1' AND key = 'related'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            related, 0,
            "property whose sole value_ref dangles must be skipped"
        );

        // Valid tag recovered; dangling tags skipped.
        let good_tag: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'CHILD1' AND tag_id = 'PAGE1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            good_tag, 1,
            "tag between two live blocks should be recovered"
        );

        let bad_tags: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tags WHERE tag_id = 'GHOST_TAG' OR block_id = 'GHOST_BLOCK'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            bad_tags, 0,
            "tags referencing a missing block must be skipped"
        );
    }

    /// Regression: a `set_property` op that CLEARS a value (all `value_*`
    /// fields null — e.g. un-setting `todo_state`) must be replayed as a
    /// row-removal, not an all-NULL INSERT. The all-NULL row violates the
    /// `exactly_one_value` CHECK (migration 0062) and previously panicked
    /// the whole app at startup with `(275) CHECK constraint failed:
    /// exactly_one_value` while recovering derived tables from the op_log.
    #[tokio::test]
    async fn init_pool_recovery_handles_clear_property_op() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let ts = chrono::Utc::now().timestamp_millis();

        let ops: &[(i64, &str, &str)] = &[
            (1, "create_block", "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"P\",\"parent_id\":null,\"position\":1}"),
            (2, "create_block", "{\"block_id\":\"B1\",\"block_type\":\"content\",\"content\":\"b\",\"parent_id\":\"PAGE1\",\"position\":2}"),
            // Set todo_state, then CLEAR it (the all-NULL op that crashed boot).
            (3, "set_property", "{\"block_id\":\"B1\",\"key\":\"todo_state\",\"value_text\":\"DOING\"}"),
            (4, "set_property", "{\"block_id\":\"B1\",\"key\":\"todo_state\",\"value_text\":null,\"value_num\":null,\"value_date\":null,\"value_ref\":null,\"value_bool\":null}"),
            // An unrelated property that stays set — must survive the recovery.
            (5, "set_property", "{\"block_id\":\"B1\",\"key\":\"priority\",\"value_text\":\"high\"}"),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Drop blocks so the empty-derived-tables recovery runs on reopen.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Must NOT panic with the exactly_one_value CHECK — the regression.
        let pool = init_pool(&db_path)
            .await
            .expect("recovery must replay a clear-property op as a delete, not crash");

        // Cleared property is row-absent.
        let todo: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'B1' AND key = 'todo_state'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(todo, 0, "a cleared property must not be re-inserted");

        // The still-set property survives.
        let prio: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'B1' AND key = 'priority'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(prio, 1, "an unrelated set property must still be recovered");
    }

    /// Regression (#374): the `blocks`-table rebuild in migrations 0073/0080
    /// runs `DROP TABLE blocks` under `foreign_keys = ON`, which cascade-
    /// deletes every `attachments` row (migration 0061 gave
    /// `attachments.block_id` an `ON DELETE CASCADE`). `attachments` is the
    /// one AUTHORITATIVE child of `blocks` (not a derived cache), so that
    /// silently destroyed file metadata. Recovery must rebuild the table from
    /// the op-log `add_attachment` payloads, honouring later
    /// `delete_attachment` ops and skipping attachments whose owning block is
    /// gone. The `DROP TABLE blocks` below reproduces the exact cascade.
    #[tokio::test]
    async fn init_pool_recovery_restores_attachments_374() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let ts = chrono::Utc::now().timestamp_millis();

        let ops: &[(i64, &str, &str)] = &[
            (1, "create_block", "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"P\",\"parent_id\":null,\"position\":1}"),
            (2, "create_block", "{\"block_id\":\"CHILD1\",\"block_type\":\"content\",\"content\":\"b\",\"parent_id\":\"PAGE1\",\"position\":2}"),
            // Live attachment on a recovered block — must be restored verbatim.
            (3, "add_attachment", "{\"attachment_id\":\"ATT1\",\"block_id\":\"CHILD1\",\"mime_type\":\"image/png\",\"filename\":\"a.png\",\"size_bytes\":123,\"fs_path\":\"attachments/ATT1.png\"}"),
            // Attachment whose owning block was never created — must be skipped
            // (restoring it would trip the block_id FK and abort startup).
            (4, "add_attachment", "{\"attachment_id\":\"ATT2\",\"block_id\":\"GHOST\",\"mime_type\":\"image/png\",\"filename\":\"g.png\",\"size_bytes\":7,\"fs_path\":\"attachments/ATT2.png\"}"),
            // Added then deleted — the later delete must win (net absent).
            (5, "add_attachment", "{\"attachment_id\":\"ATT3\",\"block_id\":\"CHILD1\",\"mime_type\":\"text/plain\",\"filename\":\"t.txt\",\"size_bytes\":4,\"fs_path\":\"attachments/ATT3.txt\"}"),
            (6, "delete_attachment", "{\"attachment_id\":\"ATT3\",\"fs_path\":\"attachments/ATT3.txt\"}"),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // DROP blocks so the reopen rebuilds it from the op-log create ops
        // (and, under FK=ON, cascade-empties `attachments` exactly as the
        // 0073/0080 rebuild does). `attachments` is empty here because the
        // owning blocks don't exist yet — they're only materialised during
        // recovery — so the op-log replay is the sole source of restoration.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        let pool = init_pool(&db_path)
            .await
            .expect("recovery must restore attachments without crashing");

        // The live attachment is restored with every column intact.
        let row = sqlx::query(
            "SELECT block_id, mime_type, filename, size_bytes, fs_path, created_at \
             FROM attachments WHERE id = 'ATT1'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .expect("live attachment ATT1 must be recovered from the op log");
        let block_id: String = row.try_get("block_id").unwrap();
        let mime: String = row.try_get("mime_type").unwrap();
        let filename: String = row.try_get("filename").unwrap();
        let size: i64 = row.try_get("size_bytes").unwrap();
        let fs_path: String = row.try_get("fs_path").unwrap();
        let created_at: i64 = row.try_get("created_at").unwrap();
        assert_eq!(block_id, "CHILD1");
        assert_eq!(mime, "image/png");
        assert_eq!(filename, "a.png");
        assert_eq!(size, 123);
        assert_eq!(fs_path, "attachments/ATT1.png");
        assert_eq!(
            created_at, ts,
            "created_at must come from the op's timestamp"
        );

        // Attachment on a missing block is skipped (no FK abort).
        let ghost: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ghost, 0, "attachment on a missing block must be skipped");

        // Added-then-deleted attachment stays absent (delete wins).
        let deleted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT3'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(deleted, 0, "a deleted attachment must not be resurrected");

        // Idempotency: a second boot (recovery re-walks the op log because
        // this fixture has no properties/tags) must not duplicate or error —
        // `INSERT OR IGNORE` keeps ATT1 at exactly one row.
        drop(pool);
        let pool = init_pool(&db_path)
            .await
            .expect("a second recovery pass must not crash");
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 1, "recovery must be idempotent across boots");
    }

    // ======================================================================
    // Issue #376 — data-preservation across destructive migrations.
    //
    // Every other db-level test runs `sqlx::migrate!` against an EMPTY
    // database (see `test_pool` above), so no existing test seeds
    // pre-existing rows and migrates them forward. The two destructive
    // classes that were previously unvalidated:
    //   1. The `blocks` table rebuild in 0073 / 0080 (DROP/RENAME under
    //      `foreign_keys = ON`; the class that caused the #374 attachments
    //      data loss).
    //   2. The TEXT->INTEGER millisecond backfills in 0074-0082 that convert
    //      legacy RFC-3339 timestamps via
    //      `CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`.
    //
    // The harness below applies migrations INCREMENTALLY up to a target
    // version, lets a test seed rows into the intermediate schema, then
    // applies the remaining migrations to head — something `sqlx::migrate!`
    // (all-or-nothing against an empty DB) cannot do.
    // ======================================================================

    /// Build a raw pool with the SAME pragmas production uses
    /// ([`base_connect_options`] — notably `foreign_keys = ON`), but WITHOUT
    /// running any migrations. Migrations are then applied by hand via
    /// [`apply_migrations_through`] so a test can interpose a seed step at an
    /// intermediate schema version.
    ///
    /// `max_connections(1)` keeps every statement (and therefore the
    /// per-connection `foreign_keys = ON` pragma) on a single connection, so
    /// the FK-cascade behaviour during the DROP/RENAME exactly matches a
    /// real single-connection migration run.
    async fn unmigrated_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(base_connect_options(&db_path))
            .await
            .unwrap();
        (pool, dir)
    }

    /// Apply every UP migration whose `version` is in `(after, through]`, in
    /// ascending version order, by executing each migration's raw SQL string
    /// against `pool`. Down-migrations are skipped.
    ///
    /// Mechanism notes:
    /// * The migrator is the same `sqlx::migrate!("./migrations")` expansion
    ///   production uses; `.iter()` yields `Migration { version, sql,
    ///   migration_type, .. }` in source order, which we sort by version to
    ///   be robust to ordering.
    /// * sqlx's SQLite driver executes a multi-statement raw SQL string
    ///   (which every rebuild migration is) when handed to
    ///   `sqlx::query(sql).execute(&mut tx)` — verified by these tests
    ///   reaching head successfully through the 0073/0080 rebuilds.
    /// * CRUCIALLY, each migration is run inside its OWN transaction, exactly
    ///   as sqlx's `Migrate::apply` does (`self.begin()` … `tx.commit()`, see
    ///   sqlx-sqlite `migrate.rs`). This is load-bearing for the blocks
    ///   rebuild: `DROP TABLE blocks` under `foreign_keys = ON` would
    ///   immediately cascade-delete `attachments` children in *autocommit*
    ///   mode, but inside a transaction SQLite defers the foreign-key
    ///   re-validation to `COMMIT`, by which point `_new_blocks` has been
    ///   renamed to `blocks` with the same row set so every child FK
    ///   re-resolves and no cascade fires. Running migrations in autocommit
    ///   here would therefore produce a FALSE positive for the #374 data
    ///   loss. The transaction wrapper makes the harness faithful to prod.
    /// * We do NOT touch sqlx's `_sqlx_migrations` bookkeeping table; this
    ///   harness is test-only and never hands the DB back to
    ///   `sqlx::migrate!`, so version tracking is irrelevant here.
    async fn apply_migrations_through(pool: &SqlitePool, after: i64, through: i64) {
        // Collect owned (version, SQL) pairs up front so nothing borrows the
        // local `Migrator` across the awaits below. The SQL strings come from
        // our own checked-in migration files, so `AssertSqlSafe` (which
        // accepts a non-'static `String`) is appropriate — there is no
        // untrusted input here.
        let migrator = sqlx::migrate!("./migrations");
        let mut migs: Vec<(i64, String)> = migrator
            .iter()
            .filter(|m| m.migration_type.is_up_migration())
            .map(|m| (m.version, m.sql.as_str().to_owned()))
            .collect();
        migs.sort_by_key(|(version, _)| *version);
        for (version, sql) in migs {
            if version > after && version <= through {
                let mut tx = pool
                    .begin()
                    .await
                    .unwrap_or_else(|e| panic!("begin tx for migration {version}: {e}"));
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .execute(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("migration {version} failed to apply: {e}"));
                tx.commit()
                    .await
                    .unwrap_or_else(|e| panic!("commit migration {version}: {e}"));
            }
        }
    }

    /// Apply every UP migration with `version > after`, to head.
    async fn apply_migrations_to_head(pool: &SqlitePool, after: i64) {
        apply_migrations_through(pool, after, i64::MAX).await;
    }

    // ----------------------------------------------------------------------
    // Deliverable 1: the julianday CAST formula, in isolation.
    //
    // This pins the exact backfill expression used by every ms migration
    // (0074-0082) against the chrono ground truth: correctness, rounding,
    // and NULL/malformed handling. It runs on a bare connection (no schema),
    // so it is immune to migration drift.
    // ----------------------------------------------------------------------

    /// Evaluate the production backfill expression for one bound input.
    async fn julianday_ms(pool: &SqlitePool, input: Option<&str>) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000.0) AS INTEGER)",
        )
        .bind(input)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn julianday_cast_matches_chrono_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;

        // NULL in -> NULL out.
        assert_eq!(
            julianday_ms(&pool, None).await,
            None,
            "NULL timestamp must convert to NULL ms"
        );

        // Representative valid RFC-3339 forms. Each `expected` is computed
        // independently by chrono so the assertion is a true cross-check of
        // the SQL formula, not a self-test.
        let cases = [
            "2025-08-15T12:00:00Z",
            "2025-08-15T12:00:00+00:00",
            "2025-08-15T12:00:00.123Z",
            // chrono parses the space-separated form via parse_from_rfc3339
            // only with a 'T'; SQLite's julianday accepts the space form, so
            // we compare against the equivalent 'T' instant below.
        ];
        for input in cases {
            let expected = DateTime::parse_from_rfc3339(input)
                .unwrap_or_else(|e| panic!("chrono should parse {input}: {e}"))
                .timestamp_millis();
            let got = julianday_ms(&pool, Some(input)).await;
            assert_eq!(
                got,
                Some(expected),
                "SQL julianday formula for {input} must equal chrono's {expected} ms"
            );
        }

        // Space-separated form: SQLite's julianday accepts "YYYY-MM-DD HH:MM:SS"
        // and treats it as UTC, identical to the 'T'/'Z' instant.
        let space_input = "2025-08-15 12:00:00";
        let space_expected = DateTime::parse_from_rfc3339("2025-08-15T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            julianday_ms(&pool, Some(space_input)).await,
            Some(space_expected),
            "space-separated timestamp must convert to the same UTC ms as the 'T'/'Z' form"
        );

        // Sub-second precision survives the ROUND (123 ms above proves it;
        // assert it explicitly is non-zero in the fractional part).
        let sub = DateTime::parse_from_rfc3339("2025-08-15T12:00:00.123Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            sub % 1000,
            123,
            "sub-second component must be 123 ms (sanity on the chrono ground truth)"
        );

        // Malformed input: SQLite's julianday() returns NULL for an
        // unparseable string, so the whole expression yields NULL. This pins
        // the "NULL on malformed" behaviour the migrations rely on (a
        // malformed legacy value becomes NULL rather than aborting the
        // backfill or producing garbage).
        assert_eq!(
            julianday_ms(&pool, Some("not-a-date")).await,
            None,
            "malformed timestamp must convert to NULL (SQLite julianday returns NULL)"
        );
    }

    // ----------------------------------------------------------------------
    // Deliverable 2: the `blocks` rebuilds and the #374 cascade, observed
    // through the REAL migration SQL via the seed-then-migrate harness.
    //
    // After migration 0061, `attachments.block_id` carries
    // `REFERENCES blocks(id) ON DELETE CASCADE`. The 0073 and 0080 blocks
    // rebuilds run `DROP TABLE blocks` under `foreign_keys = ON`.
    //
    // IMPORTANT — what these tests pin (and why the naive "child survives"
    // assertion is WRONG): empirically, and by the project's own design,
    // `DROP TABLE blocks` under `foreign_keys = ON` IMMEDIATELY fires the
    // `ON DELETE CASCADE` and deletes every `attachments` row — even inside
    // the per-migration transaction sqlx uses (the cascade is part of the
    // DROP, not a deferred FK *validation*). This is the exact #374 data
    // loss. Production does NOT prevent it at the migration layer; it
    // RECOVERS the rows at startup from the op-log `add_attachment` payloads
    // (see `recover_derived_state_from_op_log`, and the
    // `init_pool_recovery_restores_attachments_374` regression test). These
    // harness tests therefore pin the real, faithful contract:
    //   * the migration path cascade-deletes the attachment row (a tripwire:
    //     if a future change makes the rebuild preserve children, that's a
    //     behaviour change to flag and re-evaluate against the recovery
    //     logic), AND
    //   * the parent `blocks` row and the authoritative `op_log` record both
    //     SURVIVE the rebuild — i.e. nothing the recovery depends on is lost,
    //     so the #374 restoration remains possible.
    // ----------------------------------------------------------------------

    /// Seed one page block, one attachment child, and the op-log
    /// `add_attachment` record (the authoritative source the #374 recovery
    /// replays) into the post-0061 intermediate schema. At seed time both
    /// `attachments.created_at` and `op_log.created_at` are still legacy
    /// `TEXT` (their ms cutovers are 0081/0079), so the timestamps are
    /// RFC-3339 strings.
    ///
    /// Seeds only `blocks` + `attachments` (the attachment's `created_at`
    /// stays TEXT until 0081, so this is used at intermediate versions where
    /// that column is still TEXT). The corresponding op-log `add_attachment`
    /// record is seeded by each caller via [`seed_add_attachment_op`] with a
    /// `created_at` of the correct type for that version (TEXT before 0079,
    /// INTEGER ms after).
    async fn seed_block_and_attachment(pool: &SqlitePool, block_id: &str, att_id: &str) {
        // A page block satisfies the page_id_self_for_pages CHECK that 0073
        // introduces (block_type='page' => page_id=id).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) \
             VALUES (?, 'page', 'seeded page', ?)",
        )
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'image/png', 'pic.png', 123, ?, '2025-08-15T12:00:00Z')",
        )
        .bind(att_id)
        .bind(block_id)
        .bind(format!("attachments/{att_id}.png"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// Seed an op-log `add_attachment` record. `created_at` is bound as a raw
    /// pre-formatted SQL literal fragment so callers can pass an RFC-3339
    /// string literal (pre-0079, TEXT column) or an integer ms literal
    /// (post-0079, INTEGER STRICT column).
    async fn seed_add_attachment_op(
        pool: &SqlitePool,
        block_id: &str,
        att_id: &str,
        op_seq: i64,
        created_at_literal: &str,
    ) {
        let payload = format!(
            "{{\"attachment_id\":\"{att_id}\",\"block_id\":\"{block_id}\",\
             \"mime_type\":\"image/png\",\"filename\":\"pic.png\",\
             \"size_bytes\":123,\"fs_path\":\"attachments/{att_id}.png\"}}"
        );
        let sql = format!(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev376', {op_seq}, 'h', 'add_attachment', ?, {created_at_literal}, 'user')"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(payload)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Seed before the FIRST blocks rebuild (0073) and migrate all the way to
    /// head through BOTH rebuilds (0073 and 0080). Pins the #374 cascade:
    /// the attachment is destroyed by the DROP, while the parent block and
    /// the op-log record (the recovery source) both survive.
    #[tokio::test]
    async fn blocks_rebuild_cascade_deletes_attachment_but_keeps_recovery_source_376() {
        let (pool, _dir) = unmigrated_pool().await;
        // Bring the schema up to just before the first blocks rebuild.
        apply_migrations_through(&pool, 0, 72).await;
        seed_block_and_attachment(&pool, "BLK376A", "ATT376A").await;
        // At v72 op_log.created_at is still TEXT, so seed a valid RFC-3339
        // string; 0079's julianday backfill converts it cleanly and the row
        // survives to head.
        seed_add_attachment_op(&pool, "BLK376A", "ATT376A", 1, "'2025-08-15T12:00:00Z'").await;

        // Migrate through 0073, 0080, and the ms cutovers to head.
        apply_migrations_to_head(&pool, 72).await;

        // #374: the ON DELETE CASCADE child is destroyed by the blocks DROP.
        let att_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT376A'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            att_count, 0,
            "the blocks rebuild's `DROP TABLE blocks` under FK=ON cascade-deletes the \
             attachment (the #374 data-loss class). If this ever becomes 1, the rebuild's \
             FK behaviour changed — re-evaluate against recover_derived_state_from_op_log"
        );

        // The parent block itself is copied through every rebuild — never lost.
        let blk_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'BLK376A'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            blk_count, 1,
            "the parent block must survive both blocks rebuilds (bulk-copy, not cascade)"
        );

        // The authoritative op-log record survives, so the #374 recovery can
        // restore the attachment at the next startup.
        let op_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376' AND op_type = 'add_attachment'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            op_count, 1,
            "the op-log add_attachment record (the recovery source) must survive the rebuilds"
        );
    }

    /// Narrower variant: seed right before the SECOND blocks rebuild (0080)
    /// so the attachment crosses only that DROP/RENAME. Guards the 0080
    /// cascade independently of 0073, and confirms the recovery source
    /// (op_log) survives that rebuild too.
    #[tokio::test]
    async fn blocks_0080_rebuild_cascade_deletes_attachment_376() {
        let (pool, _dir) = unmigrated_pool().await;
        // 0079 is the last migration before the 0080 blocks rebuild.
        apply_migrations_through(&pool, 0, 79).await;
        seed_block_and_attachment(&pool, "BLK376B", "ATT376B").await;
        // At v79 op_log.created_at is already INTEGER STRICT (the 0079 cutover
        // ran), so seed an integer ms literal.
        seed_add_attachment_op(&pool, "BLK376B", "ATT376B", 1, "1755259200000").await;

        apply_migrations_to_head(&pool, 79).await;

        let att_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT376B'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            att_count, 0,
            "the 0080 blocks rebuild cascade-deletes the attachment (#374 class)"
        );

        let op_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376' AND op_type = 'add_attachment'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            op_count, 1,
            "the op-log recovery source must survive the 0080 rebuild"
        );
    }

    // ----------------------------------------------------------------------
    // Deliverable 3: ms-conversion preservation on real seeded data.
    //
    // Seed legacy TEXT timestamps into `op_log.created_at` just before its
    // ms-backfill migration (0079), migrate to head, and assert each INTEGER
    // ms value equals the chrono expectation. op_log.created_at is NOT NULL,
    // so we exercise the valid `...Z`, `+00:00`, sub-second, and space forms
    // here; NULL handling is pinned by Deliverable 1's formula test and by
    // the blocks.deleted_at nullable path below.
    // ----------------------------------------------------------------------

    /// Insert one op_log row with a legacy RFC-3339 `created_at` string at
    /// the pre-0079 schema. (device_id, seq) is the PK; op_log at this point
    /// has columns through 0064's `attachment_id`.
    async fn seed_op_log_row(pool: &SqlitePool, seq: i64, created_at: &str) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev376', ?, 'h', 'create', '{}', ?, 'user')",
        )
        .bind(seq)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn op_log_created_at_ms_backfill_preserves_instants_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;
        // 0078 is the last migration before op_log's ms cutover (0079).
        apply_migrations_through(&pool, 0, 78).await;

        // seq -> legacy RFC-3339 string. All representative forms.
        let rows = [
            (1_i64, "2025-08-15T12:00:00Z"),
            (2, "2025-08-15T12:00:00+00:00"),
            (3, "2025-08-15T12:00:00.123Z"),
            (4, "2025-08-15 12:00:00"),
        ];
        for (seq, ts) in rows {
            seed_op_log_row(&pool, seq, ts).await;
        }

        apply_migrations_to_head(&pool, 78).await;

        // Every seeded row must survive the rebuild (no row loss), and its
        // created_at must now be the chrono-computed ms instant.
        let surviving: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            surviving, 4,
            "all seeded op_log rows must survive the 0079 rebuild"
        );

        for (seq, ts) in rows {
            // chrono parse_from_rfc3339 needs a 'T'; normalise the space form.
            let normalized = ts.replacen(' ', "T", 1);
            let normalized = if normalized.ends_with('Z')
                || normalized.contains('+')
                || normalized.matches('-').count() > 2
            {
                normalized
            } else {
                format!("{normalized}Z")
            };
            let expected = DateTime::parse_from_rfc3339(&normalized)
                .unwrap_or_else(|e| panic!("chrono should parse {normalized}: {e}"))
                .timestamp_millis();
            let got: i64 = sqlx::query_scalar(
                "SELECT created_at FROM op_log WHERE device_id = 'dev376' AND seq = ?",
            )
            .bind(seq)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                got, expected,
                "op_log seq {seq} ({ts}) must backfill to chrono's {expected} ms"
            );
        }
    }

    /// blocks.deleted_at ms cutover (0080) on the NULLABLE column: a live
    /// block (NULL deleted_at) must stay NULL, and a soft-deleted block's
    /// RFC-3339 string must convert to the chrono ms instant. Seeded just
    /// before 0080 (after 0079), migrated to head.
    #[tokio::test]
    async fn blocks_deleted_at_ms_backfill_handles_null_and_value_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_through(&pool, 0, 79).await;

        // Live block: deleted_at NULL.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('LIVE376', 'content', 'x')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Soft-deleted block: legacy RFC-3339 deleted_at string.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) \
             VALUES ('DEL376', 'content', 'y', '2025-08-15T12:00:00.123Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migrations_to_head(&pool, 79).await;

        let live: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'LIVE376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            live, None,
            "a live block's NULL deleted_at must stay NULL through 0080"
        );

        let expected = DateTime::parse_from_rfc3339("2025-08-15T12:00:00.123Z")
            .unwrap()
            .timestamp_millis();
        let del: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'DEL376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            del,
            Some(expected),
            "a soft-deleted block's RFC-3339 deleted_at must backfill to chrono's {expected} ms"
        );
    }
}
