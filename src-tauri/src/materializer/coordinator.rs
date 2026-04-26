//! Materializer struct, constructors, and public API.

use super::consumer;
use super::metrics::{QueueMetrics, StatusInfo};
use super::{
    MaterializeTask, BACKGROUND_CAPACITY, FOREGROUND_CAPACITY, QUEUE_PRESSURE_DENOMINATOR,
    QUEUE_PRESSURE_NUMERATOR,
};
use crate::error::AppError;
use crate::gcal_push::connector::GcalConnectorHandle;
use crate::lifecycle::LifecycleHooks;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{mpsc, Notify};

#[derive(Clone)]
pub struct Materializer {
    pub(super) fg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    pub(super) bg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    pub(super) shutdown_flag: Arc<AtomicBool>,
    pub(super) metrics: Arc<QueueMetrics>,
    pub(super) reader_pool: SqlitePool,
    /// Set once the initial background task spawned by [`Materializer::build`]
    /// has finished populating [`QueueMetrics::cached_block_count`]. Tests
    /// that want to overwrite `cached_block_count` with a simulated value
    /// must first await [`Materializer::wait_for_initial_block_count_cache`]
    /// so the stale writer cannot clobber the simulated value after the
    /// `.store(…)` call. Production code does not observe this flag; the
    /// field is cheap (two pointer-sized Arcs per Materializer).
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
    ///
    /// Production code does not observe this counter; it exists so tests
    /// that exercise the FTS-optimize path can deterministically gate on
    /// "all post-optimize refresh tasks have drained" before simulating
    /// a different `cached_block_count` value. See TEST-5 in
    /// REVIEW-LATER.md (now resolved) for the rationale.
    pub(super) pending_block_count_refreshes: Arc<AtomicU32>,
    pub(super) pending_block_count_refreshes_notify: Arc<Notify>,
    /// FEAT-5h — optional handle for notifying the GCal push
    /// connector whenever a remote op could shift the projected
    /// agenda on an in-window date.
    ///
    /// `OnceLock` gives us set-once semantics without lock overhead
    /// on the hot `apply_op` read path.  The handle is wired in
    /// `lib.rs` after [`crate::gcal_push::connector::spawn_connector`]
    /// because the connector needs the DB pool (which the
    /// materializer was built with) and the materializer needs the
    /// handle (which the connector produces) — circular construction
    /// broken by a deferred setter.
    pub(super) gcal_handle: Arc<OnceLock<GcalConnectorHandle>>,
}

/// RAII guard that decrements
/// [`Materializer::pending_block_count_refreshes`] on drop and fires the
/// matching notify when the counter reaches zero.
///
/// Using a guard (rather than an explicit decrement at the tail of the
/// spawned future) ensures the counter stays consistent even if the
/// future panics or is cancelled mid-refresh (e.g. during runtime
/// shutdown). Missing a decrement would permanently desync the counter
/// from reality and leave `wait_for_pending_block_count_refreshes` hung.
struct PendingRefreshGuard {
    counter: Arc<AtomicU32>,
    notify: Arc<Notify>,
}

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

    /// PERF-24: construct a `Materializer` wired up to app-foreground
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
        let block_count_cache_ready_flag = Arc::new(AtomicBool::new(false));
        let block_count_cache_ready_notify = Arc::new(Notify::new());
        let pending_block_count_refreshes = Arc::new(AtomicU32::new(0));
        let pending_block_count_refreshes_notify = Arc::new(Notify::new());
        let gcal_handle: Arc<OnceLock<GcalConnectorHandle>> = Arc::new(OnceLock::new());
        {
            let p = write_pool.clone();
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            let g = gcal_handle.clone();
            Self::spawn_task(consumer::run_foreground(p, fg_rx, s, m, g));
        }
        {
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(consumer::run_background(
                write_pool,
                bg_rx,
                s,
                m,
                read_pool_for_consumer,
            ));
        }
        {
            let p = reader_pool.clone();
            let m = metrics.clone();
            let flag = block_count_cache_ready_flag.clone();
            let notify = block_count_cache_ready_notify.clone();
            Self::spawn_task(async move {
                if let Ok(count) = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL",
                )
                .fetch_one(&p)
                .await
                {
                    #[allow(clippy::cast_sign_loss)]
                    m.cached_block_count.store(count as u64, Ordering::Relaxed);
                }
                // Signal completion so tests can observe a deterministic
                // post-init state. Release-ordering pairs with the Acquire
                // load in `wait_for_initial_block_count_cache`. The notify
                // wake is a belt-and-suspenders addition for waiters that
                // attached before the flag was set; the double-checked
                // pattern in the waiter handles the race where notify
                // fires before anyone is waiting.
                flag.store(true, Ordering::Release);
                notify.notify_waiters();
            });
        }
        {
            let m = metrics.clone();
            let s = shutdown_flag.clone();
            Self::spawn_task(Self::metrics_snapshot_task(m, s, lifecycle));
        }
        Self {
            fg_tx: Arc::new(Mutex::new(Some(fg_tx))),
            bg_tx: Arc::new(Mutex::new(Some(bg_tx))),
            shutdown_flag,
            metrics,
            reader_pool,
            block_count_cache_ready_flag,
            block_count_cache_ready_notify,
            pending_block_count_refreshes,
            pending_block_count_refreshes_notify,
            gcal_handle,
        }
    }

    /// Register the GCal push connector so remote-op applications
    /// wake the connector immediately instead of waiting for the
    /// 15-minute reconcile sweep.
    ///
    /// Called once from `lib.rs` after
    /// [`crate::gcal_push::connector::spawn_connector`] returns.
    /// Subsequent calls are rejected (the `OnceLock` semantics) and
    /// logged at warn level — this is a programmer error, not a
    /// runtime recoverable case.
    pub fn set_gcal_handle(&self, handle: GcalConnectorHandle) {
        if self.gcal_handle.set(handle).is_err() {
            tracing::warn!("Materializer::set_gcal_handle called twice — ignoring later set",);
        }
    }

    /// FEAT-5i — return whether a `GcalConnectorHandle` is wired.
    ///
    /// Local command handlers peek this flag before taking the
    /// pre-mutation block-date snapshot so they can short-circuit
    /// the extra `SELECT` query when no connector is listening
    /// (common in headless dev, tests, and installs where the
    /// user never enabled GCal push).
    ///
    /// The check is a lock-free atomic load on the `OnceLock`.
    #[must_use]
    pub fn is_gcal_hook_active(&self) -> bool {
        self.gcal_handle.get().is_some()
    }

    /// FEAT-5i — notify the GCal connector of a newly-applied local
    /// op.
    ///
    /// Callers MUST invoke this AFTER their outer transaction has
    /// committed so the connector only ever observes durable state.
    /// A mid-command rollback must not fire this call.  `snapshot`
    /// is the pre-mutation block state captured inside the same
    /// transaction (via
    /// [`crate::gcal_push::dirty_producer::snapshot_block`]).
    ///
    /// No-op when no connector handle is wired (idempotent with
    /// [`Self::is_gcal_hook_active`]) or when the op is not
    /// agenda-relevant (delegated to
    /// [`crate::gcal_push::dirty_producer::compute_dirty_event`]).
    pub fn notify_gcal_for_op(
        &self,
        record: &crate::op_log::OpRecord,
        snapshot: &crate::gcal_push::dirty_producer::BlockDateSnapshot,
    ) {
        let Some(handle) = self.gcal_handle.get() else {
            return;
        };
        let today = chrono::Local::now().date_naive();
        if let Some(event) =
            crate::gcal_push::dirty_producer::compute_dirty_event(record, snapshot, today)
        {
            handle.notify_dirty(event);
        }
    }

    /// Periodic (5 min) metrics snapshot task.
    ///
    /// PERF-24: when `lifecycle` is `Some` and `is_foreground` reads
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
            if let Some(ref l) = lifecycle {
                if l.is_backgrounded() {
                    continue;
                }
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

    fn spawn_task<F>(future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        #[cfg(test)]
        tokio::spawn(future);
        #[cfg(not(test))]
        tauri::async_runtime::spawn(future);
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
        // Increment BEFORE the spawn so a waiter cannot observe a
        // zero-counter between this call returning and the spawned task
        // incrementing itself later. The guard constructed here moves
        // into the async block and decrements on drop.
        self.pending_block_count_refreshes
            .fetch_add(1, Ordering::AcqRel);
        let guard = PendingRefreshGuard {
            counter: self.pending_block_count_refreshes.clone(),
            notify: self.pending_block_count_refreshes_notify.clone(),
        };
        Self::spawn_task(async move {
            let _g = guard;
            if let Ok(count) =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
                    .fetch_one(&pool)
                    .await
            {
                #[allow(clippy::cast_sign_loss)]
                metrics
                    .cached_block_count
                    .store(count as u64, Ordering::Relaxed);
            }
        });
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
    /// parallelism-flaky test. See TEST-2 in REVIEW-LATER.md for history.
    ///
    /// The method is cheap in the common "already initialized" case — a
    /// single Acquire atomic load. Production code does not need to call
    /// this; the helper is `pub` purely so tests in sibling modules can
    /// use it. Two `Arc`s on the `Materializer` back the signal and are
    /// negligible cost.
    pub async fn wait_for_initial_block_count_cache(&self) {
        // Double-checked pattern: check the flag, construct a Notified
        // future *before* rechecking so we cannot miss a notification
        // fired between the two checks, then await. If notify_waiters
        // ran before we attached a waiter the flag load after the
        // construction catches it.
        loop {
            if self.block_count_cache_ready_flag.load(Ordering::Acquire) {
                return;
            }
            let notified = self.block_count_cache_ready_notify.notified();
            if self.block_count_cache_ready_flag.load(Ordering::Acquire) {
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
    /// (cheap: a single `Acquire` load). Production code does not need
    /// to call this; the helper is `pub` so integration tests in sibling
    /// crates / modules can use it.
    pub async fn wait_for_pending_block_count_refreshes(&self) {
        // Double-checked pattern, identical in shape to
        // wait_for_initial_block_count_cache: load the counter, build
        // the Notified future, re-load. The second load closes the
        // narrow window where the notify fires between the first load
        // and our attach. AcqRel on the decrement side + Acquire here
        // establishes a happens-before edge from "guard dropped" to
        // "waiter observes zero".
        loop {
            if self.pending_block_count_refreshes.load(Ordering::Acquire) == 0 {
                return;
            }
            let notified = self.pending_block_count_refreshes_notify.notified();
            if self.pending_block_count_refreshes.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.fg_sender()?;
        // MAINT-24: Detect backpressure — if the channel is currently full
        // the `send().await` below will wait. Count that wait so `StatusInfo`
        // can surface "foreground backpressure" without rummaging through
        // tokio internals.
        if tx.capacity() == 0 {
            self.metrics.fg_full_waits.fetch_add(1, Ordering::Relaxed);
        }
        tx.send(task)
            .await
            .map_err(|e| AppError::Channel(format!("foreground queue send failed: {e}")))?;
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
            Err(mpsc::error::TrySendError::Full(_)) => {
                // M-7 / M-8: when the bounded background channel is full,
                // we shed the task and warn — but every dropped fan-out
                // (RebuildTagsCache, RebuildAgendaCache, …) must also be
                // visible in the `StatusInfo.bg_dropped` counter. Without
                // this increment, sustained backpressure silently degrades
                // cache freshness with no observable signal.
                self.metrics.bg_dropped.fetch_add(1, Ordering::Relaxed);
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
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
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

    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::Release);
        let _ = self
            .fg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let _ = self
            .bg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
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
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);

        // MAINT-24: convert the raw epoch-ms atomic to RFC 3339 and derive
        // "seconds since last batch". last_materialize_ms==0 means "no
        // batch recorded yet" (initial state).
        let last_ms = self.metrics.last_materialize_ms.load(Ordering::Relaxed);
        let (last_materialize_at, time_since_last_materialize_secs) = if last_ms == 0 {
            (None, None)
        } else {
            #[allow(clippy::cast_possible_wrap)]
            let secs = (last_ms / 1000) as i64;
            #[allow(clippy::cast_possible_truncation)]
            let nsecs = ((last_ms % 1000) * 1_000_000) as u32;
            let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nsecs);
            let rfc = dt.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            #[allow(clippy::cast_possible_truncation)]
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let elapsed = now_ms.saturating_sub(last_ms) / 1000;
            (rfc, Some(elapsed))
        };

        // total_ops_in_log: cheap COUNT(*) against reader pool. Any error
        // becomes `None` — this is observability, not a correctness path,
        // so the status call never fails because of it.
        let total_ops_in_log: Option<i64> =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
                .fetch_one(&self.reader_pool)
                .await
                .ok();

        let retry_queue_pending: Option<i64> =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM materializer_retry_queue")
                .fetch_one(&self.reader_pool)
                .await
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
            bg_dropped: self.metrics.bg_dropped.load(Ordering::Relaxed),
            bg_deduped: self.metrics.bg_deduped.load(Ordering::Relaxed),
            fg_full_waits: self.metrics.fg_full_waits.load(Ordering::Relaxed),
            last_materialize_at,
            time_since_last_materialize_secs,
            total_ops_in_log,
            sync_peer_failure_counts,
            retry_queue_pending,
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
