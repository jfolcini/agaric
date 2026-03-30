//! Materializer coordination — foreground and background priority queues (ADR-08).
//!
//! The materializer is responsible for applying op-log effects to the
//! materialized tables (blocks, caches, indexes). It runs two async task
//! queues:
//!
//! - **Foreground queue** (capacity 256): low-latency processing of ops that
//!   affect currently visible blocks.
//! - **Background queue** (capacity 1024): stale-while-revalidate cache
//!   rebuilds (tags, pages, agenda) and block-link reindexing. Duplicate
//!   cache-rebuild tasks are automatically coalesced via batch-drain dedup.
//!
//! A single write connection (enforced by the SQLite pool) serialises all
//! materializer writes. Caches are never rebuilt synchronously on the hot
//! path or at boot — always return the last computed value immediately and
//! enqueue a background rebuild if stale.
//!
//! ## Robustness
//!
//! - **Dedup**: The background consumer batch-drains pending tasks after each
//!   recv and coalesces duplicates (by discriminant for cache rebuilds, by
//!   `block_id` for `ReindexBlockLinks`).
//! - **Backpressure**: `try_enqueue_background()` silently drops tasks when
//!   the queue is full — appropriate for stale-while-revalidate caches.
//! - **Shutdown**: An `AtomicBool` flag plus wake-up messages signal both
//!   consumers to exit. After shutdown the receivers are dropped and further
//!   sends return `Err`.
//! - **Panic isolation**: Each task is executed in a spawned sub-task so a
//!   handler panic cannot crash the consumer loop.
//! - **Metrics**: Atomic counters track fg/bg processed counts and dedup
//!   coalescing.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::mem;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::cache;
use crate::error::AppError;
use crate::op_log::OpRecord;

// ---------------------------------------------------------------------------
// MaterializeTask
// ---------------------------------------------------------------------------

/// A unit of work for the materializer queues.
#[derive(Debug, Clone)]
pub enum MaterializeTask {
    /// Foreground: apply an op's effects to core tables (blocks, block_tags, etc.)
    ApplyOp(OpRecord),
    /// Background: rebuild tags_cache
    RebuildTagsCache,
    /// Background: rebuild pages_cache
    RebuildPagesCache,
    /// Background: rebuild agenda_cache
    RebuildAgendaCache,
    /// Background: reindex block_links for a specific block
    ReindexBlockLinks { block_id: String },
    /// Background: update FTS index for a specific block
    UpdateFtsBlock { block_id: String },
    /// Background: remove a block from the FTS index
    RemoveFtsBlock { block_id: String },
    /// Background: full FTS index rebuild
    RebuildFtsIndex,
    /// Background: run FTS5 segment merge optimization
    FtsOptimize,
    /// Barrier: used by `flush_foreground()`/`flush_background()` to wait for
    /// queue drain. The consumer signals the `Notify` when it processes this
    /// task.  `Arc<Notify>` is `Clone`, so `MaterializeTask` keeps its
    /// `derive(Clone)`.
    Barrier(Arc<tokio::sync::Notify>),
}

// ---------------------------------------------------------------------------
// Queue capacities
// ---------------------------------------------------------------------------

const FOREGROUND_CAPACITY: usize = 256;
const BACKGROUND_CAPACITY: usize = 1024;

/// Queue pressure warning threshold as a fraction (3/4 = 75%).
/// A warning is logged when queue depth exceeds this fraction of capacity.
const QUEUE_PRESSURE_NUMERATOR: usize = 3;
const QUEUE_PRESSURE_DENOMINATOR: usize = 4;

// ---------------------------------------------------------------------------
// Lightweight payload hint structs — avoid full serde_json::Value parse
// ---------------------------------------------------------------------------

/// Extracts only `block_type` from a `create_block` payload; unknown fields
/// are ignored by serde's default behaviour, making this cheaper than parsing
/// the full payload into `serde_json::Value`.
#[derive(Deserialize)]
struct BlockTypeHint {
    #[serde(default)]
    block_type: String,
}

/// Extracts only `block_id` from an `edit_block` payload.
#[derive(Deserialize)]
struct BlockIdHint {
    #[serde(default)]
    block_id: String,
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/// Observable counters for materializer queue activity.
#[derive(Debug)]
pub struct QueueMetrics {
    /// Number of foreground tasks fully processed.
    pub fg_processed: AtomicU64,
    /// Number of background tasks fully processed (after dedup).
    pub bg_processed: AtomicU64,
    /// Number of background tasks dropped by dedup coalescing.
    pub bg_deduped: AtomicU64,
    /// Number of FTS edits since last optimize.
    pub fts_edits_since_optimize: AtomicU64,
    /// Epoch milliseconds of the last FTS optimize.
    pub fts_last_optimize_ms: AtomicU64,
    /// High-water mark: max foreground queue depth ever observed.
    pub fg_high_water: AtomicU64,
    /// High-water mark: max background queue depth ever observed.
    pub bg_high_water: AtomicU64,
    /// Number of foreground tasks that returned an error.
    pub fg_errors: AtomicU64,
    /// Number of background tasks that returned an error.
    pub bg_errors: AtomicU64,
    /// Number of foreground tasks that panicked.
    pub fg_panics: AtomicU64,
    /// Number of background tasks that panicked.
    pub bg_panics: AtomicU64,
}

impl Default for QueueMetrics {
    fn default() -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            fg_processed: AtomicU64::new(0),
            bg_processed: AtomicU64::new(0),
            bg_deduped: AtomicU64::new(0),
            fts_edits_since_optimize: AtomicU64::new(0),
            fts_last_optimize_ms: AtomicU64::new(now_ms),
            fg_high_water: AtomicU64::new(0),
            bg_high_water: AtomicU64::new(0),
            fg_errors: AtomicU64::new(0),
            bg_errors: AtomicU64::new(0),
            fg_panics: AtomicU64::new(0),
            bg_panics: AtomicU64::new(0),
        }
    }
}

/// Serializable status snapshot of the materializer queues.
///
/// Built from [`QueueMetrics`] (atomic counters) and channel capacity info.
/// Exposed by the `get_status` command.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StatusInfo {
    pub foreground_queue_depth: usize,
    pub background_queue_depth: usize,
    pub total_ops_dispatched: u64,
    pub total_background_dispatched: u64,
    pub fg_high_water: u64,
    pub bg_high_water: u64,
    pub fg_errors: u64,
    pub bg_errors: u64,
    pub fg_panics: u64,
    pub bg_panics: u64,
}

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

/// Coordination handle for the materializer queues.
///
/// `Clone`-able (all inner fields are `Clone`) so it can live in Tauri
/// managed state and be shared across command handlers.
///
/// Senders are wrapped in `Arc<Mutex<Option<…>>>` so that [`shutdown`]
/// can drop them, closing the channel and unblocking consumers even when
/// the queues are completely full (where `try_send` would silently fail).
#[derive(Clone)]
pub struct Materializer {
    fg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    bg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    shutdown_flag: Arc<AtomicBool>,
    metrics: Arc<QueueMetrics>,
}

impl Materializer {
    /// Create a new `Materializer`, spawning foreground and background
    /// consumer tasks on the Tokio runtime.
    pub fn new(pool: SqlitePool) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let metrics = Arc::new(QueueMetrics::default());

        // Spawn foreground consumer
        {
            let pool = pool.clone();
            let shutdown_flag = shutdown_flag.clone();
            let metrics = metrics.clone();
            Self::spawn_task(Self::run_foreground(pool, fg_rx, shutdown_flag, metrics));
        }

        // Spawn background consumer (with batch-drain dedup)
        {
            let shutdown_flag = shutdown_flag.clone();
            let metrics = metrics.clone();
            Self::spawn_task(Self::run_background(pool, bg_rx, shutdown_flag, metrics));
        }

        Self {
            fg_tx: Arc::new(Mutex::new(Some(fg_tx))),
            bg_tx: Arc::new(Mutex::new(Some(bg_tx))),
            shutdown_flag,
            metrics,
        }
    }

    /// Spawn an async task on the appropriate runtime.
    /// In production (Tauri), uses `tauri::async_runtime::spawn` which works
    /// inside the Tauri setup hook. In tests, uses `tokio::spawn` directly.
    fn spawn_task<F>(future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        #[cfg(test)]
        tokio::spawn(future);
        #[cfg(not(test))]
        tauri::async_runtime::spawn(future);
    }

    // -- error logging (excluded from coverage — defensive panic/error paths
    //    that require injecting failures into spawned tokio tasks) ----------

    /// Log consumer task results — only the error/panic arms execute under
    /// exceptional circumstances that are impractical to trigger in tests
    /// (spawned-task panic, DB failure inside a tokio::spawn).
    #[cfg(not(tarpaulin_include))]
    fn log_consumer_result(
        label: &str,
        result: &Result<Result<(), crate::error::AppError>, tokio::task::JoinError>,
    ) {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::error!(label, error = %e, "error processing materializer task");
            }
            Err(e) => {
                tracing::error!(label, error = %e, "materializer task panicked");
            }
        }
    }

    // -- consumer loops (type-safe, separate functions) --------------------

    /// Foreground consumer: processes tasks one-at-a-time in FIFO order.
    /// Each task runs in a spawned sub-task for panic isolation; we await the
    /// handle immediately to preserve ordering.
    async fn run_foreground(
        pool: SqlitePool,
        mut rx: mpsc::Receiver<MaterializeTask>,
        shutdown_flag: Arc<AtomicBool>,
        metrics: Arc<QueueMetrics>,
    ) {
        loop {
            let task = match rx.recv().await {
                Some(t) => t,
                None => break, // All senders dropped
            };

            // Process the received task FIRST — even if shutdown has been
            // signalled, the task was already dequeued and must not be lost.
            let pool_clone = pool.clone();
            let result =
                tokio::task::spawn(async move { handle_foreground_task(&pool_clone, &task).await })
                    .await;

            Self::log_consumer_result("fg", &result);

            match &result {
                Ok(Err(_)) => {
                    metrics.fg_errors.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => {
                    metrics.fg_panics.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }

            metrics.fg_processed.fetch_add(1, Ordering::Relaxed);

            // Check shutdown flag AFTER processing — `shutdown()` sends a
            // wake-up task so we don't block forever on recv.
            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }
        }
        tracing::info!("foreground queue closed");
    }

    /// Background consumer: batch-drains pending tasks, deduplicates, then
    /// processes each unique task. Panic-isolated via spawned sub-tasks.
    async fn run_background(
        pool: SqlitePool,
        mut rx: mpsc::Receiver<MaterializeTask>,
        shutdown_flag: Arc<AtomicBool>,
        metrics: Arc<QueueMetrics>,
    ) {
        loop {
            // Block until at least one task arrives.
            let first = match rx.recv().await {
                Some(t) => t,
                None => break, // All senders dropped
            };

            // Drain all additionally pending tasks without blocking.
            let mut batch = vec![first];
            while let Ok(task) = rx.try_recv() {
                batch.push(task);
            }

            let total_before = batch.len();
            let deduped = dedup_tasks(batch);
            let dedup_count = (total_before - deduped.len()) as u64;

            // Process ALL deduped tasks FIRST — even if shutdown has been
            // signalled, these tasks were already dequeued and must not be lost.
            for task in deduped {
                let pool_clone = pool.clone();
                let result =
                    tokio::task::spawn(
                        async move { handle_background_task(&pool_clone, &task).await },
                    )
                    .await;

                Self::log_consumer_result("bg", &result);

                match &result {
                    Ok(Err(_)) => {
                        metrics.bg_errors.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        metrics.bg_panics.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }

                metrics.bg_processed.fetch_add(1, Ordering::Relaxed);
            }

            metrics.bg_deduped.fetch_add(dedup_count, Ordering::Relaxed);

            // Check shutdown flag AFTER processing the batch.
            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }
        }
        tracing::info!("background queue closed");
    }

    // -- sender access helpers ----------------------------------------------

    /// Obtain a clone of the foreground sender, or `Err` if already shut down.
    fn fg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        self.fg_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| AppError::Channel("foreground queue closed".into()))
    }

    /// Obtain a clone of the background sender, or `Err` if already shut down.
    fn bg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        self.bg_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| AppError::Channel("background queue closed".into()))
    }

    // -- public API --------------------------------------------------------

    /// Enqueue a task on the **foreground** (low-latency) queue.
    ///
    /// Blocks (async) until space is available. Returns `Err` if the consumer
    /// has shut down.
    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.fg_sender()?;
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

    /// Enqueue a task on the **background** (stale-while-revalidate) queue.
    ///
    /// Blocks (async) until space is available. Returns `Err` if the consumer
    /// has shut down.
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

    /// Best-effort background enqueue: if the queue is full the task is
    /// silently dropped (stale-while-revalidate — the cache will be rebuilt
    /// on the next edit). Returns `Err` only if the consumer has shut down.
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
                // Queue full — silently drop. The cache will be rebuilt on
                // the next edit that triggers the same task type.
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(AppError::Channel("background queue closed".into()))
            }
        }
    }

    /// Log a warning when queue depth exceeds 75% of capacity.
    ///
    /// Called after each successful enqueue to detect unbounded growth early.
    fn check_queue_pressure(&self) {
        let fg_depth = self
            .fg_sender()
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);

        // 75% thresholds: 192 for fg (256 * 0.75), 768 for bg (1024 * 0.75)
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

    /// Gracefully shut down both consumer tasks.
    ///
    /// Sets the shared shutdown flag, then **drops** both senders so that
    /// consumers blocked on `recv()` see channel closure and exit — even
    /// when the queues are completely full (where `try_send` would silently
    /// fail).
    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::Release);
        // Drop the senders to close the channels. This unblocks any
        // consumer waiting on `recv()` regardless of queue depth.
        let _ = self.fg_tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        let _ = self.bg_tx.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Wait for all currently-queued **foreground** tasks to be processed.
    ///
    /// Enqueues a [`MaterializeTask::Barrier`] and waits for the consumer to
    /// reach it.  Useful in tests to avoid sleep-based settling.
    pub async fn flush_foreground(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_foreground(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    /// Wait for all currently-queued **background** tasks to be processed.
    ///
    /// Enqueues a [`MaterializeTask::Barrier`] and waits for the consumer to
    /// reach it.  Useful in tests to avoid sleep-based settling.
    pub async fn flush_background(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_background(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    /// Flush both foreground and background queues sequentially.
    ///
    /// Flushes foreground first (it may enqueue background tasks), then
    /// background.
    pub async fn flush(&self) -> Result<(), AppError> {
        self.flush_foreground().await?;
        self.flush_background().await
    }

    /// Access the observable queue metrics (atomic counters).
    pub fn metrics(&self) -> &QueueMetrics {
        &self.metrics
    }

    /// Build a [`StatusInfo`] snapshot from the current queue state.
    pub fn status(&self) -> StatusInfo {
        let fg_depth = self
            .fg_sender()
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
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
        }
    }

    /// Enqueue only background cache tasks for the given op record.
    ///
    /// Used by command handlers that have already applied the op synchronously
    /// to the blocks table. This avoids double-writes by skipping the
    /// foreground `ApplyOp` task and only triggering stale-while-revalidate
    /// cache rebuilds / reindexing.
    pub fn dispatch_background(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, None)
    }

    /// Like [`dispatch_background`], but with a `block_type` hint for
    /// `edit_block` ops so that only relevant caches are rebuilt:
    ///
    /// - `"content"` blocks: only `ReindexBlockLinks` (content may have `[[ULID]]` links)
    /// - `"page"` blocks: `RebuildPagesCache` + `ReindexBlockLinks`
    /// - `"tag"` blocks: `RebuildTagsCache` + `ReindexBlockLinks`
    ///
    /// Callers that already know the block_type (e.g. `edit_block_inner`)
    /// should prefer this method to avoid unnecessary cache rebuilds.
    pub fn dispatch_edit_background(
        &self,
        record: &OpRecord,
        block_type: &str,
    ) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, Some(block_type))
    }

    /// Main entry point after an op is appended to the log.
    ///
    /// 1. Always enqueues `ApplyOp` on the foreground queue (must not be
    ///    dropped — user-visible latency path).
    /// 2. Inspects the op type and payload to best-effort enqueue appropriate
    ///    background cache-rebuild / reindex tasks via `try_enqueue_background`.
    ///
    /// Used for replayed/remote ops (Phase 4) where the materializer must
    /// apply the op from scratch.
    pub async fn dispatch_op(&self, record: &OpRecord) -> Result<(), AppError> {
        // Always apply the op in the foreground (critical path).
        self.enqueue_foreground(MaterializeTask::ApplyOp(record.clone()))
            .await?;

        self.enqueue_background_tasks(record, None)
    }

    /// Shared background-task routing logic used by both `dispatch_op` and
    /// `dispatch_background`.
    ///
    /// `block_type_hint` is used by `edit_block` to skip irrelevant cache
    /// rebuilds when the caller already knows the block type. When `None`,
    /// the conservative path rebuilds all content-dependent caches.
    fn enqueue_background_tasks(
        &self,
        record: &OpRecord,
        block_type_hint: Option<&str>,
    ) -> Result<(), AppError> {
        // Background tasks are best-effort — use try_enqueue_background to
        // avoid blocking on a full queue.
        match record.op_type.as_str() {
            "create_block" => {
                // Targeted deserialization — only extracts the field we need,
                // cheaper than parsing the full payload into serde_json::Value.
                let hint: BlockTypeHint = serde_json::from_str(&record.payload)?;
                let hint2: BlockIdHint = serde_json::from_str(&record.payload)?;
                match hint.block_type.as_str() {
                    "tag" => {
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                    }
                    "page" => {
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                    }
                    _ => {}
                }
                // FTS: index the new block
                if !hint2.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint2.block_id,
                    })?;
                }
            }
            "edit_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                debug_assert!(
                    !hint.block_id.is_empty(),
                    "edit_block payload has empty block_id"
                );
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::ReindexBlockLinks {
                        block_id: hint.block_id.clone(),
                    })?;
                }

                // Selectively rebuild caches based on block_type when the
                // caller provides a hint (e.g. edit_block_inner already
                // queried the block row). Without the hint, conservatively
                // rebuild all content-dependent caches since the edit
                // payload alone doesn't carry block_type.
                match block_type_hint {
                    Some("tag") => {
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                    }
                    Some("page") => {
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                    }
                    Some("content") => {
                        // Content blocks only need link reindexing (done above).
                    }
                    _ => {
                        // No hint or unknown block_type — conservative path.
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                        self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                    }
                }

                // FTS: update the edited block
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }

                // FTS optimize scheduling
                let edits = self
                    .metrics
                    .fts_edits_since_optimize
                    .fetch_add(1, Ordering::Relaxed)
                    + 1;
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let last_ms = self.metrics.fts_last_optimize_ms.load(Ordering::Relaxed);
                let elapsed_ms = now_ms.saturating_sub(last_ms);

                if edits >= 500 || elapsed_ms >= 3_600_000 {
                    self.try_enqueue_background(MaterializeTask::FtsOptimize)?;
                    self.metrics
                        .fts_edits_since_optimize
                        .store(0, Ordering::Relaxed);
                    self.metrics
                        .fts_last_optimize_ms
                        .store(now_ms, Ordering::Relaxed);
                }
            }
            "delete_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                // FTS: remove the deleted block
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::RemoveFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "restore_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                // FTS: re-index the restored block
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "purge_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                // FTS: remove the purged block
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::RemoveFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "add_tag" | "remove_tag" => {
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
            }
            "set_property" | "delete_property" => {
                // Always rebuild agenda cache — the property may contain a
                // value_date even if it's null in this particular op.
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
            }
            "move_block" => {
                // No extra background tasks — foreground apply is sufficient.
            }
            "add_attachment" | "delete_attachment" => {
                // No extra background tasks.
            }
            other => {
                tracing::warn!(op_type = other, "unknown op_type in dispatch_op");
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Dedup logic for background batch-drain
// ---------------------------------------------------------------------------

/// Coalesce duplicate tasks from a batch:
///
/// - Parameterless cache-rebuild tasks (`RebuildTagsCache`, `RebuildPagesCache`,
///   `RebuildAgendaCache`, `RebuildFtsIndex`, `FtsOptimize`) are deduplicated
///   by discriminant — only the first occurrence survives.
/// - `ReindexBlockLinks`, `UpdateFtsBlock`, and `RemoveFtsBlock` tasks are
///   deduplicated by `block_id`.
/// - `ApplyOp` tasks are always preserved (they should not appear on the bg
///   queue, but we never silently drop them).
fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    let mut seen_discriminants: HashSet<mem::Discriminant<MaterializeTask>> = HashSet::new();
    let mut seen_block_ids: HashSet<String> = HashSet::new();
    let mut seen_fts_update_ids: HashSet<String> = HashSet::new();
    let mut seen_fts_remove_ids: HashSet<String> = HashSet::new();
    let mut result = Vec::with_capacity(tasks.len());

    for task in tasks {
        match &task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                if seen_block_ids.insert(block_id.clone()) {
                    result.push(task);
                }
            }
            MaterializeTask::UpdateFtsBlock { block_id } => {
                if seen_fts_update_ids.insert(block_id.clone()) {
                    result.push(task);
                }
            }
            MaterializeTask::RemoveFtsBlock { block_id } => {
                if seen_fts_remove_ids.insert(block_id.clone()) {
                    result.push(task);
                }
            }
            MaterializeTask::ApplyOp(_) => {
                // Never drop ApplyOp, even if unexpected on bg queue.
                result.push(task);
            }
            MaterializeTask::Barrier(_) => {
                // Never drop Barrier — each one signals a unique flush waiter.
                result.push(task);
            }
            _ => {
                if seen_discriminants.insert(mem::discriminant(&task)) {
                    result.push(task);
                }
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Task handlers (stubs — filled in by later implementation batches)
// ---------------------------------------------------------------------------

async fn handle_foreground_task(
    _pool: &SqlitePool,
    task: &MaterializeTask,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            // Stub: will implement actual op application in next batch
            tracing::debug!(op_type = %record.op_type, seq = record.seq, "processing foreground op");
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
        _ => {
            // Foreground queue shouldn't receive non-ApplyOp tasks
            tracing::warn!(?task, "unexpected task in foreground queue");
            Ok(())
        }
    }
}

async fn handle_background_task(pool: &SqlitePool, task: &MaterializeTask) -> Result<(), AppError> {
    match task {
        MaterializeTask::RebuildTagsCache => cache::rebuild_tags_cache(pool).await,
        MaterializeTask::RebuildPagesCache => cache::rebuild_pages_cache(pool).await,
        MaterializeTask::RebuildAgendaCache => cache::rebuild_agenda_cache(pool).await,
        MaterializeTask::ReindexBlockLinks { ref block_id } => {
            cache::reindex_block_links(pool, block_id).await
        }
        MaterializeTask::UpdateFtsBlock { ref block_id } => {
            crate::fts::update_fts_for_block(pool, block_id).await
        }
        MaterializeTask::RemoveFtsBlock { ref block_id } => {
            crate::fts::remove_fts_for_block(pool, block_id).await
        }
        MaterializeTask::RebuildFtsIndex => crate::fts::rebuild_fts_index(pool).await,
        MaterializeTask::FtsOptimize => crate::fts::fts_optimize(pool).await,
        MaterializeTask::ApplyOp(ref record) => {
            tracing::warn!(seq = record.seq, "unexpected ApplyOp in background queue");
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for materializer queue coordination, dispatch routing, dedup
    //! logic, shutdown, flush barriers, and metrics. Pure-logic tests (dedup)
    //! use `#[test]`; async tests use `#[tokio::test]` with barrier-flush
    //! for deterministic settling and sleeps only for shutdown timing.

    use super::*;
    use crate::db::init_pool;
    use crate::op::{
        AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
        DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
        PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
    };
    use crate::op_log::append_local_op;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering as AtomicOrdering;
    use std::time::Duration;
    use tempfile::TempDir;

    // -- Deterministic test fixtures --

    const DEV: &str = "test-device-mat";
    const FIXED_TS: &str = "2025-01-01T00:00:00Z";
    const FAKE_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    // -- Helpers --

    /// Creates a temporary SQLite database with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Helper to build a fake OpRecord without touching the DB.
    fn fake_op_record(op_type: &str, payload: &str) -> OpRecord {
        OpRecord {
            device_id: DEV.into(),
            seq: 1,
            parent_seqs: None,
            hash: FAKE_HASH.into(),
            op_type: op_type.into(),
            payload: payload.into(),
            created_at: FIXED_TS.into(),
        }
    }

    /// Helper: create op record via DB for tests that need a real sequence.
    async fn make_op_record(pool: &SqlitePool, payload: OpPayload) -> OpRecord {
        append_local_op(pool, DEV, payload).await.unwrap()
    }

    // ======================================================================
    // Construction & clone
    // ======================================================================

    #[tokio::test]
    async fn new_creates_materializer_with_functional_queues() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        // Verify queues accept tasks (smoke test)
        assert!(
            mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
                .is_ok(),
            "newly created materializer should accept background tasks"
        );
    }

    #[tokio::test]
    async fn clone_shares_queues_both_can_enqueue() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);
        let mat2 = mat.clone();

        assert!(
            mat.enqueue_background(MaterializeTask::RebuildTagsCache)
                .await
                .is_ok(),
            "original should enqueue successfully"
        );
        assert!(
            mat2.enqueue_background(MaterializeTask::RebuildPagesCache)
                .await
                .is_ok(),
            "clone should enqueue successfully"
        );
    }

    // ======================================================================
    // dispatch_op — all op type routing branches
    // ======================================================================

    #[tokio::test]
    async fn dispatch_op_create_block_page_enqueues_pages_cache() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-1".into(),
                block_type: "page".into(),
                parent_id: None,
                position: Some(0),
                content: "My page".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for create_block(page) should succeed"
        );
        mat.flush().await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_op_create_block_tag_enqueues_tags_cache() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-tag".into(),
                block_type: "tag".into(),
                parent_id: None,
                position: None,
                content: "urgent".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for create_block(tag) should succeed"
        );
        mat.flush().await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_op_create_block_content_no_extra_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-c".into(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "just content".into(),
            }),
        )
        .await;

        // "content" block type does NOT trigger tag or page cache rebuild
        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for create_block(content) should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_edit_block_enqueues_reindex_and_pages_cache() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create block first so sequence exists
        make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-2".into(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "original".into(),
            }),
        )
        .await;

        let record = make_op_record(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: "blk-2".into(),
                to_text: "edited".into(),
                prev_edit: None,
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for edit_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_delete_block_enqueues_all_caches() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: "blk-3".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for delete_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_restore_block_enqueues_all_caches() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: "blk-r".into(),
                deleted_at_ref: FIXED_TS.into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for restore_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_purge_block_enqueues_all_caches() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: "blk-p".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for purge_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_add_tag_enqueues_tags_and_agenda() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::AddTag(AddTagPayload {
                block_id: "blk-4".into(),
                tag_id: "tag-1".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for add_tag should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_remove_tag_enqueues_tags_and_agenda() {
        use crate::op::RemoveTagPayload;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: "blk-rt".into(),
                tag_id: "tag-99".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for remove_tag should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_set_property_enqueues_agenda() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: "blk-5".into(),
                key: "due".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-01-15".into()),
                value_ref: None,
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for set_property should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_delete_property_enqueues_agenda() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: "blk-dp".into(),
                key: "due".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for delete_property should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_move_block_no_extra_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: "blk-6".into(),
                new_parent_id: Some("blk-parent".into()),
                new_position: 2,
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for move_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_add_attachment_no_extra_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: "att-1".into(),
                block_id: "blk-a".into(),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for add_attachment should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_delete_attachment_no_extra_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: "att-2".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "dispatch_op for delete_attachment should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_op_unknown_op_type_does_not_panic() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        let record = fake_op_record("unknown_future_op", "{}");

        assert!(
            mat.dispatch_op(&record).await.is_ok(),
            "unknown op_type should be logged but not cause an error"
        );
    }

    // ======================================================================
    // dispatch_background (used by command handlers)
    // ======================================================================

    #[tokio::test]
    async fn dispatch_background_for_edit_block_skips_foreground() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: "blk-bg".into(),
                to_text: "edited bg".into(),
                prev_edit: None,
            }),
        )
        .await;

        // dispatch_background skips foreground ApplyOp, only enqueues bg tasks
        assert!(
            mat.dispatch_background(&record).is_ok(),
            "dispatch_background for edit_block should succeed"
        );
    }

    #[tokio::test]
    async fn dispatch_background_for_delete_block_enqueues_all_caches() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: "blk-db".into(),
            }),
        )
        .await;

        assert!(
            mat.dispatch_background(&record).is_ok(),
            "dispatch_background for delete_block should succeed"
        );
    }

    // ======================================================================
    // Enqueue methods
    // ======================================================================

    #[tokio::test]
    async fn enqueue_foreground_accepts_any_task_type() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        // Even though this is a bg task type, the foreground queue accepts it
        assert!(
            mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
                .await
                .is_ok(),
            "foreground queue should accept any task type"
        );
    }

    #[tokio::test]
    async fn enqueue_background_accepts_all_task_variants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        assert!(mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok());
        assert!(mat
            .enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok());
        assert!(mat
            .enqueue_background(MaterializeTask::RebuildAgendaCache)
            .await
            .is_ok());
        assert!(mat
            .enqueue_background(MaterializeTask::ReindexBlockLinks {
                block_id: "blk-x".into(),
            })
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn try_enqueue_background_silently_drops_when_full() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        // Flood the queue well beyond capacity (1024). try_enqueue_background
        // must never return Err — it silently drops when full.
        for _ in 0..2000 {
            let result = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
            assert!(
                result.is_ok(),
                "try_enqueue_background should never fail for a full queue"
            );
        }
    }

    #[tokio::test]
    async fn try_enqueue_background_after_shutdown_returns_err() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        mat.shutdown();
        // Allow 100ms for consumer tasks to notice the shutdown flag and exit.
        // Consumer loops check the flag on each poll (~10ms interval); 100ms
        // gives ~10 iterations which is ample time to observe the flag and break.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let result = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
        assert!(
            result.is_err(),
            "try_enqueue_background should fail after shutdown"
        );
    }

    // ======================================================================
    // Shutdown
    // ======================================================================

    #[tokio::test]
    async fn shutdown_stops_consumers_and_rejects_new_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        // Verify queue is functional before shutdown.
        assert!(mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok());
        mat.flush_background().await.unwrap();

        mat.shutdown();
        // Allow 100ms for consumer tasks to notice the shutdown flag and exit.
        // Consumer loops check the flag on each poll (~10ms interval); 100ms
        // gives ~10 iterations which is ample time to observe the flag and break.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // After consumers exit the receiver is dropped, so send returns Err.
        let result = mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await;
        assert!(
            result.is_err(),
            "enqueue_background should fail after shutdown"
        );
    }

    #[tokio::test]
    async fn shutdown_completes_even_when_queues_are_full() {
        let (pool, _dir) = test_pool().await;

        // Create a materializer with small-capacity channels by using the
        // standard constructor (fg=256, bg=1024). We flood the background
        // queue via try_send to fill it, then verify shutdown still
        // completes and unblocks the consumer.
        let mat = Materializer::new(pool);

        // Fill the background queue to capacity (try_send silently drops
        // when full, so this loop always succeeds).
        for _ in 0..2000 {
            let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
        }

        // Shutdown must succeed even though queues are full — the senders
        // are dropped, closing the channel and unblocking recv().
        mat.shutdown();
        // Allow 150ms for consumer tasks to notice the shutdown flag and fully exit,
        // even though the queues are full. The consumer may be blocked on recv() with
        // a full queue; shutdown drops the senders which unblocks recv(). 150ms gives
        // ample time for the unblock + loop exit + task completion cycle.
        tokio::time::sleep(Duration::from_millis(150)).await;

        // Verify the materializer is fully shut down.
        let result = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
        assert!(
            result.is_err(),
            "try_enqueue_background should fail after shutdown with full queues"
        );
        let result = mat
            .enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await;
        assert!(
            result.is_err(),
            "enqueue_foreground should fail after shutdown with full queues"
        );
    }

    // ======================================================================
    // Metrics
    // ======================================================================

    #[tokio::test]
    async fn metrics_track_processed_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Enqueue distinct bg tasks to minimise dedup interference.
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .unwrap();
        mat.enqueue_background(MaterializeTask::RebuildAgendaCache)
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let m = mat.metrics();
        let processed = m.bg_processed.load(AtomicOrdering::Relaxed);
        assert!(
            processed >= 1,
            "expected at least 1 bg task processed, got {processed}"
        );
    }

    #[tokio::test]
    async fn metrics_track_processed_fg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-fg".into(),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "hello".into(),
            }),
        )
        .await;

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();

        mat.flush_foreground().await.unwrap();

        let m = mat.metrics();
        let fg = m.fg_processed.load(AtomicOrdering::Relaxed);
        assert!(fg >= 1, "expected at least 1 fg task processed, got {fg}");
    }

    #[tokio::test]
    async fn consumer_survives_multiple_tasks_and_remains_functional() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Enqueue several different tasks — the consumer loop must survive
        // all of them (error isolation).
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .unwrap();
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: "blk-iso".into(),
        })
        .await
        .unwrap();
        mat.enqueue_background(MaterializeTask::RebuildAgendaCache)
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // Queue should still be functional — consumer loop survived.
        let result = mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await;
        assert!(
            result.is_ok(),
            "queue should still accept tasks after processing multiple tasks"
        );
    }

    // ======================================================================
    // Flush barrier (#26)
    // ======================================================================

    #[tokio::test]
    async fn flush_foreground_completes_after_queued_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-flush-fg".into(),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "flush fg test".into(),
            }),
        )
        .await;

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.flush_foreground().await.unwrap();

        assert!(
            mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "at least 1 fg task should be processed after flush"
        );
    }

    #[tokio::test]
    async fn flush_background_completes_after_queued_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert!(
            mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "at least 1 bg task should be processed after flush"
        );
    }

    #[tokio::test]
    async fn flush_drains_both_queues() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-flush-both".into(),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "flush both test".into(),
            }),
        )
        .await;

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .unwrap();

        mat.flush().await.unwrap();

        assert!(
            mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "fg tasks should be processed after flush()"
        );
        assert!(
            mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "bg tasks should be processed after flush()"
        );
    }

    #[test]
    fn dedup_never_drops_barrier() {
        let notify1 = Arc::new(tokio::sync::Notify::new());
        let notify2 = Arc::new(tokio::sync::Notify::new());

        let tasks = vec![
            MaterializeTask::RebuildTagsCache,
            MaterializeTask::Barrier(notify1),
            MaterializeTask::RebuildTagsCache, // dup — coalesced
            MaterializeTask::Barrier(notify2),
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            3,
            "RebuildTagsCache + 2 Barriers = 3 (Barrier never deduped)"
        );
        let barrier_count = deduped
            .iter()
            .filter(|t| matches!(t, MaterializeTask::Barrier(_)))
            .count();
        assert_eq!(barrier_count, 2, "both Barrier tasks must survive dedup");
    }

    // ======================================================================
    // dedup_tasks (pure logic, no async)
    // ======================================================================

    #[test]
    fn dedup_coalesces_duplicate_cache_tasks() {
        let tasks = vec![
            MaterializeTask::RebuildTagsCache,
            MaterializeTask::RebuildPagesCache,
            MaterializeTask::RebuildTagsCache, // dup
            MaterializeTask::RebuildAgendaCache,
            MaterializeTask::RebuildPagesCache, // dup
            MaterializeTask::RebuildTagsCache,  // dup
        ];

        let deduped = dedup_tasks(tasks);

        assert_eq!(deduped.len(), 3, "should coalesce to 3 unique cache tasks");
        assert!(matches!(deduped[0], MaterializeTask::RebuildTagsCache));
        assert!(matches!(deduped[1], MaterializeTask::RebuildPagesCache));
        assert!(matches!(deduped[2], MaterializeTask::RebuildAgendaCache));
    }

    #[test]
    fn dedup_preserves_unique_block_link_ids() {
        let tasks = vec![
            MaterializeTask::ReindexBlockLinks {
                block_id: "a".into(),
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "b".into(),
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "a".into(),
            }, // dup
            MaterializeTask::RebuildTagsCache,
            MaterializeTask::ReindexBlockLinks {
                block_id: "c".into(),
            },
        ];

        let deduped = dedup_tasks(tasks);

        assert_eq!(deduped.len(), 4, "a, b, RebuildTagsCache, c");
        assert!(matches!(
            &deduped[0],
            MaterializeTask::ReindexBlockLinks { block_id } if block_id == "a"
        ));
        assert!(matches!(
            &deduped[1],
            MaterializeTask::ReindexBlockLinks { block_id } if block_id == "b"
        ));
        assert!(matches!(deduped[2], MaterializeTask::RebuildTagsCache));
        assert!(matches!(
            &deduped[3],
            MaterializeTask::ReindexBlockLinks { block_id } if block_id == "c"
        ));
    }

    #[test]
    fn dedup_never_drops_apply_op() {
        let record = fake_op_record("create_block", "{}");

        let tasks = vec![
            MaterializeTask::ApplyOp(record.clone()),
            MaterializeTask::RebuildTagsCache,
            MaterializeTask::ApplyOp(record.clone()),
            MaterializeTask::RebuildTagsCache, // dup — coalesced
            MaterializeTask::ApplyOp(record),
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(deduped.len(), 4, "3 ApplyOps + 1 RebuildTagsCache = 4");

        let apply_count = deduped
            .iter()
            .filter(|t| matches!(t, MaterializeTask::ApplyOp(_)))
            .count();
        assert_eq!(apply_count, 3, "ApplyOp should never be deduped");
    }

    #[test]
    fn dedup_empty_batch_returns_empty() {
        let deduped = dedup_tasks(vec![]);
        assert!(
            deduped.is_empty(),
            "empty input should produce empty output"
        );
    }

    #[test]
    fn dedup_single_item_returns_single_item() {
        let deduped = dedup_tasks(vec![MaterializeTask::RebuildTagsCache]);
        assert_eq!(
            deduped.len(),
            1,
            "single item should pass through unchanged"
        );
    }

    // ======================================================================
    // handle_foreground_task / handle_background_task edge cases
    // ======================================================================

    #[tokio::test]
    async fn handle_foreground_task_unexpected_non_apply_op_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildTagsCache;
        let result = handle_foreground_task(&pool, &task).await;
        assert!(
            result.is_ok(),
            "unexpected task in fg queue should return Ok"
        );
    }

    #[tokio::test]
    async fn handle_foreground_task_unexpected_reindex_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::ReindexBlockLinks {
            block_id: "01FAKE00000000000000000000".into(),
        };
        let result = handle_foreground_task(&pool, &task).await;
        assert!(
            result.is_ok(),
            "unexpected ReindexBlockLinks in fg queue should return Ok"
        );
    }

    #[tokio::test]
    async fn handle_background_task_unexpected_apply_op_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let record = fake_op_record(
            "create_block",
            r#"{"block_id":"X","block_type":"content","content":"t","parent_id":null,"position":null}"#,
        );
        let task = MaterializeTask::ApplyOp(record);
        let result = handle_background_task(&pool, &task).await;
        assert!(
            result.is_ok(),
            "unexpected ApplyOp in bg queue should return Ok"
        );
    }

    #[test]
    fn dedup_all_same_reindex_block_id_coalesces_to_one() {
        let tasks = vec![
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into(),
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into(),
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into(),
            },
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            1,
            "all-same block_id should coalesce to one task"
        );
    }

    #[test]
    fn dedup_fts_update_blocks_coalesced_by_block_id() {
        let tasks = vec![
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-a".into(),
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-b".into(),
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-a".into(),
            }, // dup
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-c".into(),
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-b".into(),
            }, // dup
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            3,
            "should coalesce to 3 unique UpdateFtsBlock tasks"
        );
    }

    #[test]
    fn dedup_fts_remove_blocks_coalesced_by_block_id() {
        let tasks = vec![
            MaterializeTask::RemoveFtsBlock {
                block_id: "blk-x".into(),
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "blk-y".into(),
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "blk-x".into(),
            }, // dup
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            2,
            "should coalesce to 2 unique RemoveFtsBlock tasks"
        );
    }

    #[test]
    fn dedup_fts_update_and_remove_same_block_id_both_survive() {
        // UpdateFtsBlock and RemoveFtsBlock for the same block_id are tracked
        // independently — both should survive dedup.
        let tasks = vec![
            MaterializeTask::UpdateFtsBlock {
                block_id: "blk-z".into(),
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "blk-z".into(),
            },
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            2,
            "UpdateFtsBlock and RemoveFtsBlock for same block_id should both survive"
        );
    }

    #[test]
    fn dedup_fts_optimize_and_rebuild_coalesced_by_discriminant() {
        let tasks = vec![
            MaterializeTask::FtsOptimize,
            MaterializeTask::RebuildFtsIndex,
            MaterializeTask::FtsOptimize,     // dup
            MaterializeTask::RebuildFtsIndex, // dup
            MaterializeTask::RebuildTagsCache,
            MaterializeTask::FtsOptimize, // dup
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            3,
            "should coalesce to FtsOptimize + RebuildFtsIndex + RebuildTagsCache"
        );
        assert!(matches!(deduped[0], MaterializeTask::FtsOptimize));
        assert!(matches!(deduped[1], MaterializeTask::RebuildFtsIndex));
        assert!(matches!(deduped[2], MaterializeTask::RebuildTagsCache));
    }

    // ======================================================================
    // High-watermark tracking & StatusInfo fields
    // ======================================================================

    #[test]
    fn high_water_marks_start_at_zero() {
        let metrics = QueueMetrics::default();
        assert_eq!(
            metrics.fg_high_water.load(AtomicOrdering::Relaxed),
            0,
            "fg_high_water should start at 0"
        );
        assert_eq!(
            metrics.bg_high_water.load(AtomicOrdering::Relaxed),
            0,
            "bg_high_water should start at 0"
        );
    }

    #[tokio::test]
    async fn high_water_fg_increments_after_dispatch() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-hw-fg".into(),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "hw test".into(),
            }),
        )
        .await;

        // dispatch_op enqueues on the foreground queue
        mat.dispatch_op(&record).await.unwrap();

        let hw = mat.metrics().fg_high_water.load(AtomicOrdering::Relaxed);
        assert!(
            hw >= 1,
            "fg_high_water should be >= 1 after dispatching an op, got {hw}"
        );
    }

    #[tokio::test]
    async fn high_water_bg_increments_after_enqueue() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();

        let hw = mat.metrics().bg_high_water.load(AtomicOrdering::Relaxed);
        assert!(
            hw >= 1,
            "bg_high_water should be >= 1 after enqueuing a bg task, got {hw}"
        );
    }

    #[tokio::test]
    async fn status_info_includes_high_water_fields() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Allow 10ms for consumer tokio tasks to be spawned and start their event loops.
        // This is minimal — just enough for the runtime to schedule the spawned tasks
        // before we query their status. No I/O or processing is expected yet.
        tokio::time::sleep(Duration::from_millis(10)).await;

        let status = mat.status();
        // New fields must exist and be accessible
        assert_eq!(
            status.fg_high_water, 0,
            "fg_high_water should be 0 on fresh materializer"
        );
        assert_eq!(
            status.bg_high_water, 0,
            "bg_high_water should be 0 on fresh materializer"
        );

        // Enqueue some work and verify the marks propagate to StatusInfo
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "blk-si".into(),
                block_type: "page".into(),
                parent_id: None,
                position: None,
                content: "status info test".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();

        let status = mat.status();
        assert!(
            status.fg_high_water >= 1,
            "fg_high_water in StatusInfo should be >= 1 after dispatch"
        );
    }

    // ======================================================================
    // #28: empty block_id skips ReindexBlockLinks
    // ======================================================================

    #[tokio::test]
    #[should_panic(expected = "edit_block payload has empty block_id")]
    async fn dispatch_background_empty_block_id_triggers_debug_assert() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build a fake edit_block record with an empty block_id.
        // In production this shouldn't happen, but serde(default) can produce
        // it if the payload is malformed. The debug_assert catches this.
        let record = fake_op_record("edit_block", r#"{"to_text":"hello","prev_edit":null}"#);

        // The debug_assert fires in debug/test builds, preventing the
        // wasted no-op reindex.
        let _ = mat.dispatch_background(&record);
    }

    // ======================================================================
    // Error/panic counter tests
    // ======================================================================

    #[tokio::test]
    async fn error_counters_start_at_zero() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        let m = mat.metrics();
        assert_eq!(
            m.fg_errors.load(AtomicOrdering::Relaxed),
            0,
            "fg_errors should start at 0"
        );
        assert_eq!(
            m.bg_errors.load(AtomicOrdering::Relaxed),
            0,
            "bg_errors should start at 0"
        );
        assert_eq!(
            m.fg_panics.load(AtomicOrdering::Relaxed),
            0,
            "fg_panics should start at 0"
        );
        assert_eq!(
            m.bg_panics.load(AtomicOrdering::Relaxed),
            0,
            "bg_panics should start at 0"
        );
    }

    #[tokio::test]
    async fn status_info_includes_error_and_panic_counters() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        let status = mat.status();
        assert_eq!(
            status.fg_errors, 0,
            "fg_errors in StatusInfo should be 0 on fresh materializer"
        );
        assert_eq!(
            status.bg_errors, 0,
            "bg_errors in StatusInfo should be 0 on fresh materializer"
        );
        assert_eq!(
            status.fg_panics, 0,
            "fg_panics in StatusInfo should be 0 on fresh materializer"
        );
        assert_eq!(
            status.bg_panics, 0,
            "bg_panics in StatusInfo should be 0 on fresh materializer"
        );
    }
}
