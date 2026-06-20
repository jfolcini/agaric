//! Materializer struct, constructors, and public API.

use super::consumer;
use super::metrics::{QueueMetrics, StatusInfo};
use super::{
    BACKGROUND_CAPACITY, FOREGROUND_CAPACITY, MaterializeTask, QUEUE_PRESSURE_DENOMINATOR,
    QUEUE_PRESSURE_NUMERATOR,
};
use crate::error::AppError;
use crate::lifecycle::LifecycleHooks;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
// #1059: `AtomicU32` and `Notify` now back only the test-only
// `BlockCountTestHooks` sidecar; importing them unconditionally would be
// an unused-import warning in production builds.
#[cfg(test)]
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

/// #385: minimum interval between `SELECT COUNT(*) FROM op_log` refreshes
/// backing [`StatusInfo::total_ops_in_log`]. The Status view polls
/// `status_with_scheduler` every ~5s; serving a cached value for 60s
/// reduces the O(rows) index scan from ~12 per minute to at most 1,
/// making the steady-state poll path O(1). `total_ops_in_log` is a
/// best-effort diagnostics figure, so up-to-60s staleness is acceptable.
pub(super) const OP_LOG_COUNT_CACHE_TTL_MS: u64 = 60_000;

#[derive(Clone)]
pub struct Materializer {
    /// The foreground sender is set once during [`Self::build`] and
    /// never replaced. `OnceLock` removes the per-call `Mutex` acquisition
    /// from the [`Self::fg_sender`] hot path while still gating
    /// post-shutdown sends through [`Self::shutdown_flag`].
    pub(super) fg_tx: Arc<OnceLock<mpsc::Sender<MaterializeTask>>>,
    /// See [`Self::fg_tx`] — same write-once shape for the
    /// background queue sender.
    pub(super) bg_tx: Arc<OnceLock<mpsc::Sender<MaterializeTask>>>,
    pub(super) shutdown_flag: Arc<AtomicBool>,
    pub(super) metrics: Arc<QueueMetrics>,
    pub(super) reader_pool: SqlitePool,
    /// Write-capable pool used by the queue-saturation drop
    /// path in [`Self::try_enqueue_background`] to persist dropped
    /// global cache rebuilds to `materializer_retry_queue`. The
    /// `reader_pool` enforces `PRAGMA query_only = ON` so it cannot
    /// be used here. Both pools point at the same SQLite file; this
    /// field exists to satisfy the write-side query-permission check.
    pub(super) write_pool: SqlitePool,
    /// #1059: test-only readiness/drain coordination for the
    /// block-count cache refreshes. Production code never observes these
    /// signals, so the whole bundle lives behind `#[cfg(test)]` and is
    /// absent from the production `Materializer` (which carries only its
    /// 9 real fields). See [`BlockCountTestHooks`].
    #[cfg(test)]
    pub(super) block_count_test_hooks: BlockCountTestHooks,
    /// C-3c — OS-correct app data directory used by the
    /// `CleanupOrphanedAttachments` background task to walk the
    /// `attachments/` subtree and reconcile orphaned files against
    /// the `attachments` table.
    ///
    /// An empty `OnceLock` after construction, populated by
    /// [`Self::set_app_data_dir`] from `lib.rs` once
    /// `app.path().app_data_dir()` resolves. Tests that
    /// do not exercise the GC path leave the field empty —
    /// `cleanup_orphaned_attachments` short-circuits with a debug log
    /// when the dir is not set.
    pub(super) app_data_dir: Arc<OnceLock<PathBuf>>,
    /// Tracks every tokio task spawned via [`Self::spawn_task`] so
    /// [`Self::shutdown`] can call `abort_all()` on them. Without this,
    /// long-running futures (e.g. an FTS rebuild taking many seconds)
    /// kept running after the `shutdown_flag` flip and channel-sender
    /// drops, holding the writer pool open while the surrounding
    /// shutdown sequence (sync stop → materializer flush → DB close)
    /// tore down state from underneath them. That produced
    /// writer-pool-closed errors in logs and a slow / hung exit.
    ///
    /// Abort-on-shutdown contract: after `shutdown()` returns, every
    /// previously-spawned future has had cancellation signalled. The
    /// task may still take one more poll to terminate (cancellation is
    /// observed at the next `.await` point); we deliberately do **not**
    /// block `shutdown()` waiting for that drain — `shutdown()` is sync
    /// and the caller's tear-down sequence already provides ordering.
    ///
    /// `std::sync::Mutex` is fine here: every lock acquisition is brief
    /// (a single `JoinSet::spawn` or `JoinSet::abort_all` call, both
    /// sync) and never crosses an `.await` point.
    pub(super) tasks: Arc<Mutex<JoinSet<()>>>,
}

/// #1059: test-only readiness/drain coordination for the block-count
/// cache refreshes, extracted out of the production [`Materializer`].
///
/// Production code WRITES the underlying flag/counter (set in
/// [`Materializer::build`]'s initial refresh task, incremented in
/// [`Materializer::refresh_block_count_cache`]); those writes are now
/// routed through this handle and exist only under `#[cfg(test)]`. The
/// only *readers* — [`Materializer::wait_for_initial_block_count_cache`]
/// and [`Materializer::wait_for_pending_block_count_refreshes`] — are
/// called exclusively from `materializer::tests`. Keeping the whole
/// bundle here means the production struct carries none of it.
#[cfg(test)]
#[derive(Clone)]
pub(super) struct BlockCountTestHooks {
    /// Set once the initial background task spawned by
    /// [`Materializer::build`] has finished populating
    /// [`QueueMetrics::cached_block_count`]. Tests that want to overwrite
    /// `cached_block_count` with a simulated value must first await
    /// [`Materializer::wait_for_initial_block_count_cache`] so the stale
    /// writer cannot clobber the simulated value after the `.store(…)`
    /// call.
    pub(super) block_count_cache_ready_flag: Arc<AtomicBool>,
    pub(super) block_count_cache_ready_notify: Arc<Notify>,
    /// Count of in-flight `refresh_block_count_cache()` tasks spawned
    /// after the initial one-shot refresh (currently: post-FTS-optimize,
    /// see [`Materializer::refresh_block_count_cache`]).
    ///
    /// Incremented before each `tokio::spawn`, decremented via an RAII
    /// guard when the spawned future terminates (normal completion,
    /// panic, or runtime-shutdown cancellation — all paths hit `Drop`).
    /// Paired with [`Self::pending_block_count_refreshes_notify`]: on
    /// transition to zero the notify fires, waking any tasks blocked in
    /// [`Materializer::wait_for_pending_block_count_refreshes`].
    pub(super) pending_block_count_refreshes: Arc<AtomicU32>,
    pub(super) pending_block_count_refreshes_notify: Arc<Notify>,
}

#[cfg(test)]
impl BlockCountTestHooks {
    fn new() -> Self {
        Self {
            block_count_cache_ready_flag: Arc::new(AtomicBool::new(false)),
            block_count_cache_ready_notify: Arc::new(Notify::new()),
            pending_block_count_refreshes: Arc::new(AtomicU32::new(0)),
            pending_block_count_refreshes_notify: Arc::new(Notify::new()),
        }
    }
}

/// RAII guard that decrements
/// [`BlockCountTestHooks::pending_block_count_refreshes`] on drop and
/// fires the matching notify when the counter reaches zero.
///
/// Using a guard (rather than an explicit decrement at the tail of the
/// spawned future) ensures the counter stays consistent even if the
/// future panics or is cancelled mid-refresh (e.g. during runtime
/// shutdown). Missing a decrement would permanently desync the counter
/// from reality and leave `wait_for_pending_block_count_refreshes` hung.
#[cfg(test)]
struct PendingRefreshGuard {
    counter: Arc<AtomicU32>,
    notify: Arc<Notify>,
}

#[cfg(test)]
impl Drop for PendingRefreshGuard {
    fn drop(&mut self) {
        // AcqRel matches the increment at spawn time; the post-decrement
        // value is `prev - 1`, so `prev == 1` means "we just transitioned
        // the counter to zero". Only the thread that observes that
        // transition must call `notify_waiters()`. If another thread
        // races and increments the counter back to 1 between the
        // decrement and the notify, the notify still fires — waiters
        // re-check the counter on wake and will re-park if needed.
        let prev = self.counter.fetch_sub(1, Ordering::AcqRel);
        if prev == 1 {
            self.notify.notify_waiters();
        }
    }
}

impl Materializer {
    pub fn new(pool: SqlitePool) -> Self {
        Self::build(pool.clone(), None, pool, None)
    }

    pub fn with_read_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Self {
        Self::build(write_pool, Some(read_pool.clone()), read_pool, None)
    }

    /// Construct a `Materializer` wired up to app-foreground
    /// lifecycle hooks.
    ///
    /// The internal metrics-snapshot task skips its body when
    /// `lifecycle.is_foreground == false`, eliminating debug-level log
    /// writes while the app is backgrounded on mobile.
    pub fn with_read_pool_and_lifecycle(
        write_pool: SqlitePool,
        read_pool: SqlitePool,
        lifecycle: LifecycleHooks,
    ) -> Self {
        Self::build(
            write_pool,
            Some(read_pool.clone()),
            read_pool,
            Some(lifecycle),
        )
    }

    /// Shared constructor that dispatches to the two public variants.
    ///
    /// - `write_pool`: pool used by the foreground consumer and by
    ///   background writes.
    /// - `read_pool_for_consumer`: optional dedicated read pool passed
    ///   into `consumer::run_background`; `None` means the consumer
    ///   will reuse the write pool for reads (legacy single-pool mode).
    /// - `reader_pool_for_caches`: pool used for cache-refresh queries
    ///   (cheap `SELECT COUNT(*)` etc.). Always required.
    /// - `lifecycle`: optional foreground-gating hooks for the metrics
    ///   snapshot task.
    fn build(
        write_pool: SqlitePool,
        read_pool_for_consumer: Option<SqlitePool>,
        reader_pool_for_caches: SqlitePool,
        lifecycle: Option<LifecycleHooks>,
    ) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let metrics = Arc::new(QueueMetrics::default());
        let reader_pool = reader_pool_for_caches;
        #[cfg(test)]
        let block_count_test_hooks = BlockCountTestHooks::new();
        let app_data_dir: Arc<OnceLock<PathBuf>> = Arc::new(OnceLock::new());
        // JoinSet must exist before the four `spawn_task` calls
        // below so every task we spawn is registered for abort-on-shutdown.
        let tasks: Arc<Mutex<JoinSet<()>>> = Arc::new(Mutex::new(JoinSet::new()));
        {
            let p = write_pool.clone();
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(&tasks, consumer::run_foreground(p, fg_rx, s, m));
        }
        // Clone write_pool for the queue-saturation persistence
        // path before moving the original into `run_background`.
        let write_pool_for_struct = write_pool.clone();
        {
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            let d = app_data_dir.clone();
            Self::spawn_task(
                &tasks,
                consumer::run_background(write_pool, bg_rx, s, m, read_pool_for_consumer, d),
            );
        }
        {
            let p = reader_pool.clone();
            let m = metrics.clone();
            // #1059: the completion flag/notify are test-only coordination;
            // production never observes them, so they are cloned and signalled
            // only under `#[cfg(test)]`. The `cached_block_count` store below
            // is the real production behaviour and runs unconditionally.
            #[cfg(test)]
            let flag = block_count_test_hooks.block_count_cache_ready_flag.clone();
            #[cfg(test)]
            let notify = block_count_test_hooks
                .block_count_cache_ready_notify
                .clone();
            Self::spawn_task(&tasks, async move {
                if let Ok(count) = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL",
                )
                .fetch_one(&p)
                .await
                {
                    let count_u64: u64 =
                        u64::try_from(count).expect("invariant: SQL COUNT(*) is non-negative");
                    m.cached_block_count.store(count_u64, Ordering::Relaxed);
                }
                // Signal completion so tests can observe a deterministic
                // post-init state. Release-ordering pairs with the Acquire
                // load in `wait_for_initial_block_count_cache`. The notify
                // wake is a belt-and-suspenders addition for waiters that
                // attached before the flag was set; the double-checked
                // pattern in the waiter handles the race where notify
                // fires before anyone is waiting.
                #[cfg(test)]
                {
                    flag.store(true, Ordering::Release);
                    notify.notify_waiters();
                }
            });
        }
        {
            let m = metrics.clone();
            let s = shutdown_flag.clone();
            Self::spawn_task(&tasks, Self::metrics_snapshot_task(m, s, lifecycle));
        }
        // Senders live in `OnceLock`s instead of `Mutex<Option<…>>`
        // since they are written exactly once here and never replaced.
        // Reads stay lock-free on the hot path; post-shutdown gating is
        // handled by checking `shutdown_flag` inside `fg_sender` /
        // `bg_sender`.
        let fg_tx_cell: Arc<OnceLock<mpsc::Sender<MaterializeTask>>> = Arc::new(OnceLock::new());
        fg_tx_cell
            .set(fg_tx)
            .expect("freshly-constructed OnceLock cannot already be set");
        let bg_tx_cell: Arc<OnceLock<mpsc::Sender<MaterializeTask>>> = Arc::new(OnceLock::new());
        bg_tx_cell
            .set(bg_tx)
            .expect("freshly-constructed OnceLock cannot already be set");
        Self {
            fg_tx: fg_tx_cell,
            bg_tx: bg_tx_cell,
            shutdown_flag,
            metrics,
            reader_pool,
            write_pool: write_pool_for_struct,
            #[cfg(test)]
            block_count_test_hooks,
            app_data_dir,
            tasks,
        }
    }

    /// C-3c — register the OS-correct app data directory
    /// so the `CleanupOrphanedAttachments` background task can locate
    /// the `attachments/` subtree at execution time.
    ///
    /// Called once from `lib.rs` setup after `app.path().app_data_dir()`
    /// resolves. Subsequent calls are rejected (the `OnceLock`
    /// semantics) and logged at warn level — this is a programmer
    /// error, not a runtime recoverable case.
    ///
    /// When the dir is not set (typical in unit tests that construct
    /// `Materializer::new(pool)` without wiring), the GC handler
    /// short-circuits with a debug log instead of running.
    pub fn set_app_data_dir(&self, dir: PathBuf) {
        if self.app_data_dir.set(dir).is_err() {
            tracing::warn!("Materializer::set_app_data_dir called twice — ignoring later set");
        }
    }

    /// The resolved app-data directory, if `set_app_data_dir` has run (always
    /// in production via `lib.rs` setup; typically `None` in unit tests that
    /// construct `Materializer::new(pool)` without wiring). Attachment
    /// `fs_path`s are app-data-relative, so callers that unlink attachment
    /// files (e.g. the purge paths, #85 F2) resolve them against this.
    pub fn app_data_dir(&self) -> Option<PathBuf> {
        self.app_data_dir.get().cloned()
    }

    /// Periodic (5 min) metrics snapshot task.
    ///
    /// When `lifecycle` is `Some` and `is_foreground` reads
    /// `false`, the snapshot body is skipped for that tick. The tick
    /// itself still fires so the interval's internal deadline stays
    /// aligned — we just don't pay for the atomic reads or the tracing
    /// call while the user isn't looking at the app.
    async fn metrics_snapshot_task(
        m: Arc<QueueMetrics>,
        s: Arc<AtomicBool>,
        lifecycle: Option<LifecycleHooks>,
    ) {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.tick().await; // skip immediate first tick
        loop {
            interval.tick().await;
            if s.load(Ordering::Acquire) {
                break;
            }
            if let Some(ref l) = lifecycle
                && l.is_backgrounded()
            {
                continue;
            }
            let fg_processed = m.fg_processed.load(Ordering::Relaxed);
            let bg_processed = m.bg_processed.load(Ordering::Relaxed);
            let bg_deduped = m.bg_deduped.load(Ordering::Relaxed);
            let fg_high_water = m.fg_high_water.load(Ordering::Relaxed);
            let bg_high_water = m.bg_high_water.load(Ordering::Relaxed);
            let fg_errors = m.fg_errors.load(Ordering::Relaxed);
            let bg_errors = m.bg_errors.load(Ordering::Relaxed);
            tracing::debug!(
                fg_processed,
                bg_processed,
                bg_deduped,
                fg_high_water,
                bg_high_water,
                fg_errors,
                bg_errors,
                "materializer metrics snapshot"
            );
            // Reset high-water marks after dump
            m.fg_high_water.store(0, Ordering::Relaxed);
            m.bg_high_water.store(0, Ordering::Relaxed);
        }
    }

    /// Spawn `future` on a tokio runtime and register its handle
    /// on `tasks` so [`Self::shutdown`] can abort it.
    ///
    /// `JoinSet::spawn` calls `tokio::runtime::Handle::current()` and
    /// panics outside a Tokio runtime context. Tauri 2's `setup`
    /// callback runs synchronously on the main thread, *outside* any
    /// runtime — `tauri::async_runtime::spawn` works there only because
    /// it dispatches through Tauri's stored handle, not via
    /// `Handle::current()`. To keep the abort-on-shutdown
    /// semantics while not panicking in `setup`, we bind the task
    /// explicitly via `JoinSet::spawn_on` to either:
    ///   - the current Tokio runtime when one exists (tests under
    ///     `#[tokio::test]`, async command handlers, async tasks); or
    ///   - Tauri's stored `async_runtime` handle as a fallback (the
    ///     non-async `setup` callback path).
    ///
    /// `pub(super)` so sibling modules — in particular the
    /// regression test in `materializer::tests` — can spawn directly
    /// onto the same `JoinSet` and observe abort-on-shutdown semantics.
    pub(super) fn spawn_task<F>(tasks: &Arc<Mutex<JoinSet<()>>>, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        // Lock is held only for the duration of `JoinSet::spawn_on`,
        // which is sync — we never cross an `.await` while holding it,
        // so `std::sync::Mutex` is safe here.
        let mut guard = tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                guard.spawn_on(future, &handle);
            }
            Err(_) => {
                guard.spawn_on(future, tauri::async_runtime::handle().inner());
            }
        }
    }

    /// Spawn a lightweight task to refresh the cached block count used for
    /// the adaptive FTS-optimize threshold.
    ///
    /// Production code treats this as pure fire-and-forget. Tests that
    /// need to observe completion (e.g. before simulating a different
    /// `cached_block_count`) should call
    /// [`Materializer::wait_for_pending_block_count_refreshes`] — the
    /// counter + [`PendingRefreshGuard`] wiring below keeps the tracked
    /// "in flight" count accurate across normal completion, panic, and
    /// runtime-shutdown cancellation.
    pub(super) fn refresh_block_count_cache(&self) {
        let pool = self.reader_pool.clone();
        let metrics = self.metrics.clone();
        // #1059: the in-flight counter + RAII drain guard are test-only
        // coordination (production treats this as pure fire-and-forget).
        // Increment BEFORE the spawn so a waiter cannot observe a
        // zero-counter between this call returning and the spawned task
        // incrementing itself later. The guard constructed here moves
        // into the async block and decrements on drop.
        #[cfg(test)]
        let guard = {
            let hooks = &self.block_count_test_hooks;
            hooks
                .pending_block_count_refreshes
                .fetch_add(1, Ordering::AcqRel);
            PendingRefreshGuard {
                counter: hooks.pending_block_count_refreshes.clone(),
                notify: hooks.pending_block_count_refreshes_notify.clone(),
            }
        };
        Self::spawn_task(&self.tasks, async move {
            #[cfg(test)]
            let _g = guard;
            if let Ok(count) =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
                    .fetch_one(&pool)
                    .await
            {
                let count_u64: u64 =
                    u64::try_from(count).expect("invariant: SQL COUNT(*) is non-negative");
                metrics
                    .cached_block_count
                    .store(count_u64, Ordering::Relaxed);
            }
        });
    }

    /// #385: rate-limited `SELECT COUNT(*) FROM op_log` backing
    /// [`StatusInfo::total_ops_in_log`].
    ///
    /// Returns the cached value when the last successful refresh is younger
    /// than [`OP_LOG_COUNT_CACHE_TTL_MS`]; otherwise runs the COUNT once
    /// against the reader pool, updates the cache, and returns the fresh
    /// value. On COUNT error, returns the last cached value (or `None` if no
    /// successful count has ever been recorded) without touching the cache —
    /// observability never fails the status call.
    ///
    /// Mirrors `cached_block_count`'s stale-tolerant cache shape rather than
    /// a live per-append counter: op_log appends happen in the command /
    /// sync / recovery / snapshot layers, none of which hold a
    /// `Materializer` reference, so a live counter cannot be maintained at
    /// the append sites. The TTL bounds the staleness instead.
    async fn cached_op_log_count(&self) -> Option<i64> {
        let now = u64::try_from(crate::db::now_ms()).unwrap_or(0);
        let last_at = self
            .metrics
            .cached_op_log_count_at_ms
            .load(Ordering::Relaxed);
        let cached = self.metrics.cached_op_log_count.load(Ordering::Relaxed);

        // Serve the cache when it has been computed at least once and is
        // still within the TTL window. `u64::MAX` is the "never computed"
        // sentinel and forces a refresh regardless of `last_at`.
        let cache_valid =
            cached != u64::MAX && now.saturating_sub(last_at) < OP_LOG_COUNT_CACHE_TTL_MS;
        if cache_valid {
            return i64::try_from(cached).ok();
        }

        match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.reader_pool)
            .await
        {
            Ok(count) => {
                let count_u64 =
                    u64::try_from(count).expect("invariant: SQL COUNT(*) is non-negative");
                self.metrics
                    .cached_op_log_count
                    .store(count_u64, Ordering::Relaxed);
                self.metrics
                    .cached_op_log_count_at_ms
                    .store(now, Ordering::Relaxed);
                Some(count)
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    query = "total_ops_in_log",
                    "materializer status query failed"
                );
                // Fall back to the last-known cached value, if any.
                if cached == u64::MAX {
                    None
                } else {
                    i64::try_from(cached).ok()
                }
            }
        }
    }

    /// Await completion of the one-shot background task spawned in
    /// [`Materializer::build`] that populates
    /// [`QueueMetrics::cached_block_count`] from the current DB state.
    ///
    /// Tests that want to overwrite `cached_block_count` with a simulated
    /// value (e.g. to exercise the adaptive FTS-optimize threshold at
    /// 10 M-block scale without inserting 10 M rows) must call this before
    /// their `.store(simulated_count, …)`. Otherwise the stale initial
    /// writer may race with the simulation and clobber the value after it
    /// has been set, producing a deterministic-in-isolation but
    /// Parallelism-flaky test.
    ///
    /// The method is cheap in the common "already initialized" case — a
    /// single Acquire atomic load. Production code does not call this:
    /// #1059 moved the backing flag/notify into the test-only
    /// [`BlockCountTestHooks`] sidecar, so the helper is `#[cfg(test)]`
    /// and available only to tests in sibling modules.
    #[cfg(test)]
    pub async fn wait_for_initial_block_count_cache(&self) {
        let hooks = &self.block_count_test_hooks;
        // Double-checked pattern: check the flag, construct a Notified
        // future *before* rechecking so we cannot miss a notification
        // fired between the two checks, then await. If notify_waiters
        // ran before we attached a waiter the flag load after the
        // construction catches it.
        loop {
            if hooks.block_count_cache_ready_flag.load(Ordering::Acquire) {
                return;
            }
            let notified = hooks.block_count_cache_ready_notify.notified();
            if hooks.block_count_cache_ready_flag.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    /// Await until every in-flight `refresh_block_count_cache()` task
    /// currently counted in
    /// [`Self::pending_block_count_refreshes`] has drained to zero.
    ///
    /// Unlike [`Self::wait_for_initial_block_count_cache`] — which is a
    /// one-shot gate on the background task spawned inside
    /// [`Materializer::build`] — this helper covers the *repeatable*,
    /// counted refreshes spawned after an FTS optimize (see
    /// [`super::dispatch`]). Each `refresh_block_count_cache` call
    /// increments the counter before `tokio::spawn`; the RAII
    /// [`PendingRefreshGuard`] decrements it when the spawned future
    /// terminates, firing a `Notify` on transition to zero.
    ///
    /// The two helpers compose: if a test wants a completely settled
    /// block-count cache after an FTS-optimize round, call
    /// [`Self::wait_for_initial_block_count_cache`] once (to gate the
    /// startup refresh) and [`Self::wait_for_pending_block_count_refreshes`]
    /// after the FTS-optimize trigger (to gate the post-optimize
    /// refreshes). Either helper alone remains independently useful.
    ///
    /// Returns immediately if zero refreshes are in flight at call time
    /// (cheap: a single `Acquire` load). Production code does not call
    /// this: #1059 moved the backing counter/notify into the test-only
    /// [`BlockCountTestHooks`] sidecar, so the helper is `#[cfg(test)]`
    /// and available only to tests in sibling modules.
    #[cfg(test)]
    pub async fn wait_for_pending_block_count_refreshes(&self) {
        let hooks = &self.block_count_test_hooks;
        // Double-checked pattern, identical in shape to
        // wait_for_initial_block_count_cache: load the counter, build
        // the Notified future, re-load. The second load closes the
        // narrow window where the notify fires between the first load
        // and our attach. AcqRel on the decrement side + Acquire here
        // establishes a happens-before edge from "guard dropped" to
        // "waiter observes zero".
        loop {
            if hooks.pending_block_count_refreshes.load(Ordering::Acquire) == 0 {
                return;
            }
            let notified = hooks.pending_block_count_refreshes_notify.notified();
            if hooks.pending_block_count_refreshes.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.fg_sender()?;
        // / avoid the TOCTOU on `tx.capacity()` — a snapshot
        // read followed by `send().await` is racy because the consumer can
        // drain the channel between the check and the send, so the old
        // `capacity() == 0` precondition under-counted real wait events.
        // `try_send` first; on `Full` we know we are about to block on a
        // full channel, so `fg_full_waits` correlates 1:1 with actual
        // wait events. `Closed` still propagates as a `Channel` error.
        match tx.try_send(task) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(task)) => {
                self.metrics.fg_full_waits.fetch_add(1, Ordering::Relaxed);
                tx.send(task)
                    .await
                    .map_err(|e| AppError::Channel(format!("foreground queue send failed: {e}")))?;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(AppError::Channel(
                    "foreground queue send failed: channel closed".into(),
                ));
            }
        }
        let depth = FOREGROUND_CAPACITY - tx.capacity();
        self.metrics
            .fg_high_water
            .fetch_max(depth as u64, Ordering::Relaxed);
        self.check_queue_pressure();
        Ok(())
    }

    pub async fn enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.bg_sender()?;
        tx.send(task)
            .await
            .map_err(|e| AppError::Channel(format!("background queue send failed: {e}")))?;
        let depth = BACKGROUND_CAPACITY - tx.capacity();
        self.metrics
            .bg_high_water
            .fetch_max(depth as u64, Ordering::Relaxed);
        self.check_queue_pressure();
        Ok(())
    }

    pub fn try_enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.bg_sender()?;
        match tx.try_send(task) {
            Ok(()) => {
                let depth = BACKGROUND_CAPACITY - tx.capacity();
                self.metrics
                    .bg_high_water
                    .fetch_max(depth as u64, Ordering::Relaxed);
                self.check_queue_pressure();
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(task)) => {
                // When the bounded background channel is full,
                // we shed the task and warn — but every dropped fan-out
                // (RebuildTagsCache, RebuildAgendaCache, …) must also be
                // visible in the `StatusInfo.bg_dropped` counter. Without
                // this increment, sustained backpressure silently degrades
                // cache freshness with no observable signal.
                //
                // + audit #423: a task shed *here* at enqueue time
                // never reaches the consumer's failure path, so it must be
                // persisted to `materializer_retry_queue` directly or it is
                // lost with no self-healing. This applies to BOTH global
                // cache rebuilds (under the `'__GLOBAL__'` sentinel) AND the
                // per-block reindex tasks (`UpdateFtsBlock`,
                // `ReindexBlockLinks`, `ReindexBlockTagRefs`, keyed by
                // block_id) — `record_failure` derives the correct key from
                // the task. Previously only globals were persisted on this
                // path on the (incorrect) assumption that per-block tasks
                // are covered by `consumer.rs`; the consumer failure path
                // only runs for tasks that were *dequeued and ran*, never
                // for tasks shed at enqueue, so a saturated queue left a
                // block's FTS / link / tag-ref index stale until its next
                // edit. `bg_dropped_global` stays global-only so operators
                // can still distinguish a cache-freshness gap from a
                // per-block reindex backlog. The persist is fire-and-forget
                // via a spawned write (errors warned) because `try_enqueue_*`
                // is sync and on the hot path.
                self.metrics.bg_dropped.fetch_add(1, Ordering::Relaxed);
                if let Some((kind, _)) = super::retry_queue::RetryKind::from_task(&task) {
                    if kind.is_global() {
                        self.metrics
                            .bg_dropped_global
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    let pool = self.write_pool.clone();
                    let task_for_spawn = task.clone();
                    let metrics_for_spawn = self.metrics.clone();
                    Self::spawn_task(&self.tasks, async move {
                        use super::retry_queue::record_failure;
                        match record_failure(&pool, &task_for_spawn, "background queue full").await
                        {
                            Ok(()) => {}
                            Err(e1) => {
                                metrics_for_spawn
                                    .retry_queue_persist_errors
                                    .fetch_add(1, Ordering::Relaxed);
                                tracing::warn!(
                                    error = %e1,
                                    "record_failure first attempt failed; retrying after 100ms"
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                if let Err(e2) =
                                    record_failure(&pool, &task_for_spawn, "background queue full")
                                        .await
                                {
                                    metrics_for_spawn
                                        .retry_queue_persist_errors
                                        .fetch_add(1, Ordering::Relaxed);
                                    tracing::error!(
                                        error = %e2,
                                        "record_failure failed on retry — task dropped without persistence"
                                    );
                                }
                            }
                        }
                    });
                }
                tracing::warn!("background queue full, dropping task");
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(AppError::Channel("background queue closed".into()))
            }
        }
    }

    fn check_queue_pressure(&self) {
        let fg_depth = self
            .fg_sender()
            .map_or(0, |tx| FOREGROUND_CAPACITY - tx.capacity());
        let bg_depth = self
            .bg_sender()
            .map_or(0, |tx| BACKGROUND_CAPACITY - tx.capacity());
        if fg_depth > FOREGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR {
            tracing::warn!(
                depth = fg_depth,
                capacity = FOREGROUND_CAPACITY,
                "foreground queue pressure"
            );
        }
        if bg_depth > BACKGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR {
            tracing::warn!(
                depth = bg_depth,
                capacity = BACKGROUND_CAPACITY,
                "background queue pressure"
            );
        }
    }

    /// Stop the materializer.
    ///
    /// Steps, in order:
    ///   1. Flip [`Self::shutdown_flag`] (Release) so cooperative
    ///      consumers exit their loops on the next iteration.
    ///   2. Drop the foreground / background mpsc senders so any
    ///      future `enqueue_*` call returns `AppError::Channel` and the
    ///      consumer-side `recv()` resolves to `None`.
    /// 3. `abort_all()` every task tracked on [`Self::tasks`].
    ///    This covers long-running futures (e.g. an in-progress FTS
    ///    rebuild) that would otherwise outlive the shutdown signal
    ///    and try to use the writer pool after the surrounding
    ///    tear-down sequence (sync stop → materializer flush → DB
    ///    close) had torn it down — the symptom on the user's
    ///    machine being writer-pool-closed errors in logs and a
    ///    slow / hung exit.
    ///
    /// `shutdown()` is intentionally **sync and non-blocking**: it
    /// signals cancellation but does not wait for tasks to drain.
    /// `JoinSet::abort_all` is itself synchronous; the abort signal is
    /// observed by each task at its next `.await` point. The caller's
    /// tear-down sequence (which already orders sync stop → flush →
    /// DB close) is responsible for any further bounded wait — we
    /// deliberately do not introduce a `tokio::time::timeout`-bounded
    /// drain here so a stuck task can never block process exit.
    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::Release);
        // With senders living in `OnceLock`s we cannot drop them
        // here to wake the consumer's `recv().await`. The `tasks`
        // `abort_all()` below cancels each consumer at its next await
        // point (which is the `recv().await`), and post-shutdown
        // `fg_sender` / `bg_sender` calls return `Channel(...)` because
        // they short-circuit on `shutdown_flag`. Future `try_send` calls
        // also surface `Closed` once the consumer's receiver drops.
        // Abort tracked tasks. Brief lock — `abort_all` is sync
        // and just signals; tasks finalize asynchronously.
        self.tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .abort_all();
    }

    pub async fn flush_foreground(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_foreground(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    pub async fn flush_background(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_background(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    pub async fn flush(&self) -> Result<(), AppError> {
        self.flush_foreground().await?;
        self.flush_background().await
    }

    pub fn metrics(&self) -> &QueueMetrics {
        &self.metrics
    }

    pub async fn status(&self) -> StatusInfo {
        self.status_with_scheduler::<crate::sync_scheduler::SyncScheduler>(None)
            .await
    }

    /// Collect status with optional sync-scheduler failure counts.
    ///
    /// Decoupling the scheduler from the materializer keeps the command
    /// handler in charge of wiring them together; legacy callers that
    /// don't care about sync peer health still receive an empty vector.
    pub async fn status_with_scheduler<S: SchedulerLike>(
        &self,
        scheduler: Option<&S>,
    ) -> StatusInfo {
        let fg_depth = self
            .fg_sender()
            .map_or(0, |tx| FOREGROUND_CAPACITY - tx.capacity());
        let bg_depth = self
            .bg_sender()
            .map_or(0, |tx| BACKGROUND_CAPACITY - tx.capacity());

        // Convert the raw epoch-ms atomic to RFC 3339 and derive
        // "seconds since last batch". last_materialize_ms==0 means "no
        // batch recorded yet" (initial state).
        let last_ms = self.metrics.last_materialize_ms.load(Ordering::Relaxed);
        let (last_materialize_at, time_since_last_materialize_secs) = if last_ms == 0 {
            (None, None)
        } else {
            let secs: i64 = i64::try_from(last_ms / 1000)
                .expect("invariant: epoch-seconds fits in i64 for millennia");
            let nsecs: u32 = u32::try_from((last_ms % 1000) * 1_000_000)
                .expect("invariant: (ms % 1000) * 1_000_000 < 1e9 fits in u32");
            let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nsecs);
            let rfc = dt.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            // Millis since epoch fits in u64 for millions of years; saturate on overflow.
            let now_ms = u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            )
            .unwrap_or(u64::MAX);
            let elapsed = now_ms.saturating_sub(last_ms) / 1000;
            (rfc, Some(elapsed))
        };

        // #385: total_ops_in_log is served from a rate-limited cache so the
        // O(rows) `SELECT COUNT(*) FROM op_log` does not run on every ~5s
        // status poll. We recompute only when the cache is older than
        // OP_LOG_COUNT_CACHE_TTL_MS (or has never been computed); otherwise
        // we return the cached value. Any COUNT error leaves the cache
        // untouched and falls back to the last-known value (or None if we
        // have never had a successful count) — this is observability, not a
        // correctness path, so the status call never fails because of it.
        let total_ops_in_log: Option<i64> = self.cached_op_log_count().await;

        let retry_queue_pending: Option<i64> =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM materializer_retry_queue")
                .fetch_one(&self.reader_pool)
                .await
                .inspect_err(|e| {
                    tracing::warn!(
                        error = %e,
                        query = "retry_queue_pending",
                        "materializer status query failed"
                    );
                })
                .ok();

        let sync_peer_failure_counts = scheduler
            .map(SchedulerLike::failure_counts_snapshot)
            .unwrap_or_default();

        StatusInfo {
            foreground_queue_depth: fg_depth,
            background_queue_depth: bg_depth,
            total_ops_dispatched: self.metrics.fg_processed.load(Ordering::Relaxed),
            total_background_dispatched: self.metrics.bg_processed.load(Ordering::Relaxed),
            fg_high_water: self.metrics.fg_high_water.load(Ordering::Relaxed),
            bg_high_water: self.metrics.bg_high_water.load(Ordering::Relaxed),
            fg_errors: self.metrics.fg_errors.load(Ordering::Relaxed),
            bg_errors: self.metrics.bg_errors.load(Ordering::Relaxed),
            fg_panics: self.metrics.fg_panics.load(Ordering::Relaxed),
            bg_panics: self.metrics.bg_panics.load(Ordering::Relaxed),
            fg_apply_dropped: self.metrics.fg_apply_dropped.load(Ordering::Relaxed),
            fg_apply_dropped_persisted: self
                .metrics
                .fg_apply_dropped_persisted
                .load(Ordering::Relaxed),
            bg_dropped: self.metrics.bg_dropped.load(Ordering::Relaxed),
            bg_dropped_global: self.metrics.bg_dropped_global.load(Ordering::Relaxed),
            bg_deduped: self.metrics.bg_deduped.load(Ordering::Relaxed),
            fg_full_waits: self.metrics.fg_full_waits.load(Ordering::Relaxed),
            retry_queue_persist_errors: self
                .metrics
                .retry_queue_persist_errors
                .load(Ordering::Relaxed),
            retry_queue_giveup_total: self
                .metrics
                .retry_queue_giveup_total
                .load(Ordering::Relaxed),
            last_materialize_at,
            time_since_last_materialize_secs,
            total_ops_in_log,
            sync_peer_failure_counts,
            retry_queue_pending,
            // #1326: surface the SQL-only fallback observability counter
            // (process-global, monotonic) through the status endpoint.
            sql_only_fallback_count: super::handlers::sql_only_fallback::count(),
            // #1319: surface the cross-session sync snapshot-fallback
            // aggregate (process-global, monotonic count + last occurrence)
            // through the status endpoint.
            snapshot_fallback_count: crate::sync_protocol::snapshot_fallback_metrics::count(),
            snapshot_fallback_last: crate::sync_protocol::snapshot_fallback_metrics::last(),
        }
    }
}

/// Abstraction over [`crate::sync_scheduler::SyncScheduler`] so
/// [`Materializer::status_with_scheduler`] can be called from tests without
/// pulling in the real scheduler or from command handlers that have a
/// `State<Arc<SyncScheduler>>` on hand.
pub trait SchedulerLike {
    fn failure_counts_snapshot(&self) -> Vec<(String, u32)>;
}

impl SchedulerLike for crate::sync_scheduler::SyncScheduler {
    fn failure_counts_snapshot(&self) -> Vec<(String, u32)> {
        self.failure_counts()
    }
}
