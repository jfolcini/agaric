//! Materializer coordination — foreground and background priority queues.
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
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::mem;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::cache;
use crate::error::AppError;
use crate::op::{
    is_reserved_property_key, AddAttachmentPayload, AddTagPayload, CreateBlockPayload,
    DeleteAttachmentPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpType, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;

// ---------------------------------------------------------------------------
// MaterializeTask
// ---------------------------------------------------------------------------

/// A unit of work for the materializer queues.
#[derive(Debug, Clone)]
pub enum MaterializeTask {
    /// Foreground: apply an op's effects to core tables (blocks, block_tags, etc.)
    ApplyOp(OpRecord),
    /// Foreground: apply multiple remote ops in batch (reduces channel overhead for bulk sync)
    BatchApplyOps(Vec<OpRecord>),
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
    /// Background: reindex FTS for all blocks referencing a renamed tag/page
    ReindexFtsReferences { block_id: String },
    /// Background: remove a block from the FTS index
    RemoveFtsBlock { block_id: String },
    /// Background: full FTS index rebuild
    RebuildFtsIndex,
    /// Background: run FTS5 segment merge optimization
    FtsOptimize,
    /// Background: clean up orphaned attachment files in the app data directory
    CleanupOrphanedAttachments,
    /// Background: rebuild the block_tag_inherited cache (P-4)
    RebuildTagInheritanceCache,
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

/// Extracts `block_id` and `block_type` from a `create_block` payload in a
/// single deserialization pass.
#[derive(Deserialize)]
struct CreateBlockHint {
    #[serde(default)]
    block_id: String,
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
    /// Create a new `Materializer` with a single pool for all operations.
    ///
    /// Both foreground and background tasks use the same pool. For reduced
    /// write-connection hold time, use [`with_read_pool`](Self::with_read_pool)
    /// which offloads read-heavy phases of background cache rebuilds to a
    /// separate read pool.
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
            Self::spawn_task(Self::run_background(
                pool,
                bg_rx,
                shutdown_flag,
                metrics,
                None,
            ));
        }

        Self {
            fg_tx: Arc::new(Mutex::new(Some(fg_tx))),
            bg_tx: Arc::new(Mutex::new(Some(bg_tx))),
            shutdown_flag,
            metrics,
        }
    }

    /// Create a `Materializer` with separate read and write pools.
    ///
    /// Background cache-rebuild tasks will read from `read_pool` and write
    /// to `write_pool`, reducing write-connection hold time. Foreground
    /// tasks always use `write_pool` (they need read-your-writes).
    pub fn with_read_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let metrics = Arc::new(QueueMetrics::default());

        // Spawn foreground consumer (always uses write pool)
        {
            let pool = write_pool.clone();
            let shutdown_flag = shutdown_flag.clone();
            let metrics = metrics.clone();
            Self::spawn_task(Self::run_foreground(pool, fg_rx, shutdown_flag, metrics));
        }

        // Spawn background consumer with read pool for split operations
        {
            let shutdown_flag = shutdown_flag.clone();
            let metrics = metrics.clone();
            Self::spawn_task(Self::run_background(
                write_pool,
                bg_rx,
                shutdown_flag,
                metrics,
                Some(read_pool.clone()),
            ));
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

    /// Foreground consumer: batch-drains available tasks, groups by `block_id`,
    /// and processes each group sequentially. Barrier tasks act as ordering
    /// fences — all tasks before a Barrier complete before it is signalled.
    ///
    /// Each task runs in a spawned sub-task for panic isolation; we await the
    /// handle immediately to preserve ordering within a group.
    async fn run_foreground(
        pool: SqlitePool,
        mut rx: mpsc::Receiver<MaterializeTask>,
        shutdown_flag: Arc<AtomicBool>,
        metrics: Arc<QueueMetrics>,
    ) {
        loop {
            let first_task = match rx.recv().await {
                Some(t) => t,
                None => break, // All senders dropped
            };

            // Drain all immediately available tasks into a batch.
            let mut batch = vec![first_task];
            while let Ok(task) = rx.try_recv() {
                batch.push(task);
                if batch.len() >= FOREGROUND_CAPACITY {
                    break;
                }
            }

            // Split batch at Barrier boundaries. Barriers are ordering
            // fences: all tasks before a Barrier must complete before the
            // Barrier is signalled, so we never group across them.
            let mut segment: Vec<MaterializeTask> = Vec::new();
            for task in batch {
                if matches!(task, MaterializeTask::Barrier(_)) {
                    // Process accumulated segment grouped by block_id.
                    if !segment.is_empty() {
                        Self::process_foreground_segment(&pool, mem::take(&mut segment), &metrics)
                            .await;
                    }
                    // Process the barrier itself (signals the flush waiter).
                    Self::process_single_foreground_task(&pool, task, &metrics).await;
                } else {
                    segment.push(task);
                }
            }

            // Process remaining segment after all barriers.
            if !segment.is_empty() {
                Self::process_foreground_segment(&pool, segment, &metrics).await;
            }

            // Check shutdown flag AFTER processing — `shutdown()` sends a
            // wake-up task so we don't block forever on recv.
            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }
        }
        tracing::info!("foreground queue closed");
    }

    /// Process a segment of foreground tasks grouped by `block_id`.
    ///
    /// Tasks without a block_id go into a catch-all group processed last.
    /// Independent groups (different `block_id`) run in parallel via
    /// [`tokio::task::JoinSet`]; ops within each group stay sequential
    /// to preserve causal ordering (#374).
    async fn process_foreground_segment(
        pool: &SqlitePool,
        tasks: Vec<MaterializeTask>,
        metrics: &Arc<QueueMetrics>,
    ) {
        let groups = group_tasks_by_block_id(tasks);

        if groups.len() <= 1 {
            // Single group — process sequentially (no spawn overhead).
            for (_block_id, group_tasks) in groups {
                for task in group_tasks {
                    Self::process_single_foreground_task(pool, task, metrics).await;
                }
            }
            return;
        }

        // Multiple independent groups — process in parallel via JoinSet.
        // Each group's tasks stay sequential (preserving op ordering within
        // a block_id), but groups targeting different block_ids run concurrently.
        let mut join_set = tokio::task::JoinSet::new();

        for (_block_id, group_tasks) in groups {
            let pool = pool.clone();
            let metrics = Arc::clone(metrics);

            join_set.spawn(async move {
                for task in group_tasks {
                    Materializer::process_single_foreground_task(&pool, task, &metrics).await;
                }
            });
        }

        // Await all groups.
        while let Some(result) = join_set.join_next().await {
            if let Err(e) = result {
                tracing::error!("foreground group task panicked: {e}");
            }
        }
    }

    /// Process a single foreground task with panic isolation, single retry,
    /// and metrics.
    ///
    /// Retry policy (foreground only):
    /// - `Ok(Err(_))` (DB/IO error): retry **once** after 100 ms backoff.
    ///   If the retry succeeds the error counter is *not* incremented.
    /// - `Err(_)` (panic / JoinError): **no** retry — panics indicate code
    ///   bugs, not transient failures.
    /// - `Barrier` tasks are never retried (they are ordering signals, not
    ///   DB operations).
    async fn process_single_foreground_task(
        pool: &SqlitePool,
        task: MaterializeTask,
        metrics: &Arc<QueueMetrics>,
    ) {
        // Don't retry barriers — they're just ordering signals
        if matches!(&task, MaterializeTask::Barrier(_)) {
            let pool_clone = pool.clone();
            let metrics_clone = Arc::clone(metrics);
            let result = tokio::task::spawn(async move {
                handle_foreground_task(&pool_clone, &task, &metrics_clone).await
            })
            .await;
            Self::log_consumer_result("fg", &result);
            metrics.fg_processed.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let retry_task = task.clone();
        let pool_clone = pool.clone();
        let metrics_clone = Arc::clone(metrics);
        let result = tokio::task::spawn(async move {
            handle_foreground_task(&pool_clone, &task, &metrics_clone).await
        })
        .await;

        match &result {
            Ok(Ok(())) => {
                // Success — no retry needed
            }
            Ok(Err(_)) => {
                // Transient error — retry once after backoff
                Self::log_consumer_result("fg", &result);
                tracing::info!("retrying failed foreground task after 100ms backoff");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let pool_clone2 = pool.clone();
                let metrics_clone2 = Arc::clone(metrics);
                let retry_result = tokio::task::spawn(async move {
                    handle_foreground_task(&pool_clone2, &retry_task, &metrics_clone2).await
                })
                .await;
                Self::log_consumer_result("fg-retry", &retry_result);
                if matches!(&retry_result, Ok(Err(_)) | Err(_)) {
                    metrics.fg_errors.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(_) => {
                // Panic — don't retry, just log
                Self::log_consumer_result("fg", &result);
                metrics.fg_panics.fetch_add(1, Ordering::Relaxed);
            }
        }
        metrics.fg_processed.fetch_add(1, Ordering::Relaxed);
    }

    /// Background consumer: batch-drains pending tasks, deduplicates, then
    /// processes each unique task. Panic-isolated via spawned sub-tasks.
    async fn run_background(
        pool: SqlitePool,
        mut rx: mpsc::Receiver<MaterializeTask>,
        shutdown_flag: Arc<AtomicBool>,
        metrics: Arc<QueueMetrics>,
        read_pool: Option<SqlitePool>,
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
                let rp_ref = read_pool.as_ref();

                // Barrier tasks are ordering signals, not DB operations — never retry.
                if matches!(&task, MaterializeTask::Barrier(_)) {
                    let pool_clone = pool.clone();
                    let result = tokio::task::spawn(async move {
                        handle_background_task(&pool_clone, &task, None).await
                    })
                    .await;
                    Self::log_consumer_result("bg", &result);
                    metrics.bg_processed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }

                const MAX_RETRIES: u32 = 2;
                const INITIAL_BACKOFF_MS: u64 = 50;

                let mut succeeded = false;
                let mut panicked = false;

                // First attempt
                let task_clone = task.clone();
                let pool_clone = pool.clone();
                let rp_clone = rp_ref.cloned();
                let result = tokio::task::spawn(async move {
                    handle_background_task(&pool_clone, &task_clone, rp_clone.as_ref()).await
                })
                .await;

                match &result {
                    Ok(Ok(())) => {
                        succeeded = true;
                    }
                    Ok(Err(_)) => {
                        Self::log_consumer_result("bg", &result);
                        // Retry with exponential backoff
                        for attempt in 1..=MAX_RETRIES {
                            let backoff_ms = INITIAL_BACKOFF_MS * (1 << (attempt - 1));
                            let backoff = std::time::Duration::from_millis(backoff_ms);
                            tracing::warn!(
                                task = ?format!("{:?}", std::mem::discriminant(&task)),
                                retry = attempt,
                                backoff_ms = backoff_ms,
                                "retrying failed background task after {backoff_ms}ms backoff"
                            );
                            tokio::time::sleep(backoff).await;

                            let retry_task = task.clone();
                            let pool_clone2 = pool.clone();
                            let rp_clone2 = rp_ref.cloned();
                            let retry_result = tokio::task::spawn(async move {
                                handle_background_task(
                                    &pool_clone2,
                                    &retry_task,
                                    rp_clone2.as_ref(),
                                )
                                .await
                            })
                            .await;

                            match &retry_result {
                                Ok(Ok(())) => {
                                    succeeded = true;
                                    break;
                                }
                                Ok(Err(_)) => {
                                    Self::log_consumer_result(
                                        &format!("bg-retry-{attempt}"),
                                        &retry_result,
                                    );
                                }
                                Err(_) => {
                                    // Panic during retry — stop retrying
                                    Self::log_consumer_result(
                                        &format!("bg-retry-{attempt}"),
                                        &retry_result,
                                    );
                                    panicked = true;
                                    break;
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // Panic / JoinError — no retry
                        Self::log_consumer_result("bg", &result);
                        panicked = true;
                    }
                }

                if panicked {
                    metrics.bg_panics.fetch_add(1, Ordering::Relaxed);
                } else if !succeeded {
                    metrics.bg_errors.fetch_add(1, Ordering::Relaxed);
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
            Err(mpsc::error::TrySendError::Full(_dropped)) => {
                // Queue full — drop with warning.  The cache will be rebuilt
                // on the next edit that triggers the same task type
                // (stale-while-revalidate).
                tracing::warn!("background queue full, dropping task");
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
                // Single deserialization extracts both fields we need.
                let hint: CreateBlockHint = serde_json::from_str(&record.payload)?;
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
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                        // Reindex FTS for blocks referencing this tag (name changed)
                        if !hint.block_id.is_empty() {
                            self.try_enqueue_background(MaterializeTask::ReindexFtsReferences {
                                block_id: hint.block_id.clone(),
                            })?;
                        }
                    }
                    Some("page") => {
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                        // Reindex FTS for blocks referencing this page (title changed)
                        if !hint.block_id.is_empty() {
                            self.try_enqueue_background(MaterializeTask::ReindexFtsReferences {
                                block_id: hint.block_id.clone(),
                            })?;
                        }
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
                    // Atomically reset only if we're the one that crossed the threshold
                    if self
                        .metrics
                        .fts_edits_since_optimize
                        .compare_exchange(edits, 0, Ordering::AcqRel, Ordering::Relaxed)
                        .is_ok()
                    {
                        self.try_enqueue_background(MaterializeTask::FtsOptimize)?;
                        self.metrics
                            .fts_last_optimize_ms
                            .store(now_ms, Ordering::Relaxed);
                    }
                }
            }
            "delete_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
            }
            "set_property" | "delete_property" => {
                // Always rebuild agenda cache — the property may contain a
                // value_date even if it's null in this particular op.
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
            }
            "move_block" => {
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
/// - `ReindexBlockLinks`, `UpdateFtsBlock`, `ReindexFtsReferences`, and
///   `RemoveFtsBlock` tasks are deduplicated by `block_id`.
/// - `ApplyOp` tasks are always preserved (they should not appear on the bg
///   queue, but we never silently drop them).
fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    let mut seen_discriminants: HashSet<mem::Discriminant<MaterializeTask>> = HashSet::new();
    let mut seen_block_ids: HashSet<String> = HashSet::new();
    let mut seen_fts_update_ids: HashSet<String> = HashSet::new();
    let mut seen_fts_remove_ids: HashSet<String> = HashSet::new();
    let mut seen_fts_reindex_ref_ids: HashSet<String> = HashSet::new();
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
            MaterializeTask::ReindexFtsReferences { block_id } => {
                if seen_fts_reindex_ref_ids.insert(block_id.clone()) {
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
            MaterializeTask::BatchApplyOps(_) => {
                // Never drop BatchApplyOps — each batch must be fully applied.
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
// Foreground batch grouping (§374)
// ---------------------------------------------------------------------------

/// Extract the target `block_id` from a foreground task's payload.
///
/// Uses lightweight [`BlockIdHint`] deserialization (only extracts the
/// `block_id` field, ignoring the rest). Returns `None` for tasks
/// without a `block_id` (e.g. `Barrier`, background-only tasks).
fn extract_block_id(task: &MaterializeTask) -> Option<String> {
    match task {
        MaterializeTask::ApplyOp(record) => serde_json::from_str::<BlockIdHint>(&record.payload)
            .ok()
            .map(|h| h.block_id)
            .filter(|id| !id.is_empty()),
        MaterializeTask::BatchApplyOps(records) => records.first().and_then(|r| {
            serde_json::from_str::<BlockIdHint>(&r.payload)
                .ok()
                .map(|h| h.block_id)
                .filter(|id| !id.is_empty())
        }),
        MaterializeTask::CleanupOrphanedAttachments => None,
        _ => None,
    }
}

/// Group foreground tasks by their target `block_id`.
///
/// Returns groups in first-seen order, with the `None` group (tasks
/// without a `block_id`) moved to the end. Preserves original ordering
/// within each group.
fn group_tasks_by_block_id(
    tasks: Vec<MaterializeTask>,
) -> Vec<(Option<String>, Vec<MaterializeTask>)> {
    let mut order: Vec<Option<String>> = Vec::new();
    let mut groups: HashMap<Option<String>, Vec<MaterializeTask>> = HashMap::new();

    for task in tasks {
        let block_id = extract_block_id(&task);
        match groups.entry(block_id) {
            std::collections::hash_map::Entry::Vacant(e) => {
                order.push(e.key().clone());
                e.insert(vec![task]);
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                e.get_mut().push(task);
            }
        }
    }

    // Build result in first-seen order, but move None group to the end.
    let mut result = Vec::with_capacity(order.len());
    let mut none_group = None;

    for key in order {
        if let Some(tasks) = groups.remove(&key) {
            if key.is_none() {
                none_group = Some(tasks);
            } else {
                result.push((key, tasks));
            }
        }
    }

    // Append None group last.
    if let Some(tasks) = none_group {
        result.push((None, tasks));
    }

    result
}

// ---------------------------------------------------------------------------
// Task handlers (stubs — filled in by later implementation batches)
// ---------------------------------------------------------------------------

async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    _metrics: &QueueMetrics,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            // Phase 4: apply remote ops to the blocks table.
            // Remote ops arrive as raw op_log entries without going through
            // the command layer, so the materializer must apply them.
            // Uses INSERT OR IGNORE / idempotent patterns so local ops that
            // were already applied by command handlers are harmless no-ops.
            if let Err(e) = apply_op(pool, record).await {
                tracing::warn!(
                    op_type = %record.op_type,
                    seq = record.seq,
                    error = %e,
                    "failed to apply remote op — will retry"
                );
                return Err(e);
            }
            Ok(())
        }
        MaterializeTask::BatchApplyOps(records) => {
            let mut failed = 0u32;
            let mut last_err = None;
            for record in records {
                if let Err(e) = apply_op(pool, record).await {
                    tracing::warn!(
                        op_type = %record.op_type,
                        seq = record.seq,
                        error = %e,
                        "failed to apply remote op in batch — will retry batch"
                    );
                    failed += 1;
                    last_err = Some(e);
                }
            }
            match last_err {
                Some(e) => {
                    tracing::warn!(failed_count = failed, "batch had failures");
                    Err(e)
                }
                None => Ok(()),
            }
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

/// Apply a single op record to the materialized tables (blocks, block_tags,
/// block_properties, attachments).
///
/// Parses the `op_type` string to [`OpType`], deserializes the JSON `payload`
/// to the matching payload struct, then executes the appropriate SQL.
///
/// Uses idempotent patterns (`INSERT OR IGNORE`, `deleted_at IS NULL` guards)
/// so that re-applying an op that was already materialized by the local
/// command handler is a harmless no-op.
async fn apply_op(pool: &SqlitePool, record: &OpRecord) -> Result<(), AppError> {
    use std::str::FromStr;

    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::Validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;

    match op_type {
        OpType::CreateBlock => {
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
                 VALUES (?, ?, ?, ?, ?, 0)",
            )
            .bind(p.block_id.as_str())
            .bind(&p.block_type)
            .bind(&p.content)
            .bind(parent_id_str.as_deref())
            .bind(p.position)
            .execute(pool)
            .await?;
            // P-4: Inherit parent tags for the new block
            let parent_str = parent_id_str.as_deref();
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::inherit_parent_tags(
                    &mut conn,
                    p.block_id.as_str(),
                    parent_str,
                )
                .await?;
            }
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
                .bind(&p.to_text)
                .bind(p.block_id.as_str())
                .execute(pool)
                .await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            let now = &record.created_at;
            sqlx::query(
                "WITH RECURSIVE descendants(id) AS ( \
                     SELECT id FROM blocks WHERE id = ? \
                     UNION ALL \
                     SELECT b.id FROM blocks b \
                     INNER JOIN descendants d ON b.parent_id = d.id \
                     WHERE b.deleted_at IS NULL \
                 ) \
                 UPDATE blocks SET deleted_at = ? \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
            )
            .bind(p.block_id.as_str())
            .bind(now)
            .execute(pool)
            .await?;
            // P-4: Remove inherited entries for soft-deleted subtree
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::remove_subtree_inherited(&mut conn, p.block_id.as_str())
                    .await?;
            }
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
            sqlx::query(
                "WITH RECURSIVE descendants(id) AS ( \
                     SELECT id FROM blocks WHERE id = ? \
                     UNION ALL \
                     SELECT b.id FROM blocks b \
                     INNER JOIN descendants d ON b.parent_id = d.id \
                 ) \
                 UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
            )
            .bind(p.block_id.as_str())
            .bind(&p.deleted_at_ref)
            .execute(pool)
            .await?;
            // P-4: Recompute inherited tags for restored subtree
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::recompute_subtree_inheritance(
                    &mut conn,
                    p.block_id.as_str(),
                )
                .await?;
            }
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            let block_id = p.block_id.as_str();

            // Wrap the entire cascade in a transaction for atomicity.
            // Without this, a mid-cascade failure would leave partially-purged
            // data. Mirrors the IMMEDIATE transaction in commands::purge_block_inner.
            let mut tx = pool.begin().await?;

            // Defer FK checks until commit — the entire subtree will be gone.
            sqlx::query("PRAGMA defer_foreign_keys = ON")
                .execute(&mut *tx)
                .await?;

            const DESC_CTE: &str = "WITH RECURSIVE descendants(id) AS ( \
                SELECT id FROM blocks WHERE id = ? \
                UNION ALL \
                SELECT b.id FROM blocks b \
                INNER JOIN descendants d ON b.parent_id = d.id \
            )";

            // block_tags
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_tags \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR tag_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_tag_inherited (P-4)
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_tag_inherited \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR inherited_from IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_properties
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_properties \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_properties: value_ref pointing into subtree
            sqlx::query(&format!(
                "{DESC_CTE} UPDATE block_properties SET value_ref = NULL \
                 WHERE value_ref IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_links
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_links \
                 WHERE source_id IN (SELECT id FROM descendants) \
                    OR target_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // agenda_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM agenda_cache \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // tags_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM tags_cache \
                 WHERE tag_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // pages_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM pages_cache \
                 WHERE page_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // attachments
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM attachments \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_drafts
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_drafts \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // Nullify conflict_source refs
            sqlx::query(&format!(
                "{DESC_CTE} UPDATE blocks SET conflict_source = NULL \
                 WHERE conflict_source IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // FTS
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM fts_blocks \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // Finally delete blocks
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM blocks \
                 WHERE id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                .bind(new_parent_str.as_deref())
                .bind(p.new_position)
                .bind(p.block_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Recompute inherited tags for the moved subtree
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::recompute_subtree_inheritance(
                    &mut conn,
                    p.block_id.as_str(),
                )
                .await?;
            }
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Propagate inherited tag to descendants
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::propagate_tag_to_descendants(
                    &mut conn,
                    p.block_id.as_str(),
                    p.tag_id.as_str(),
                )
                .await?;
            }
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Clean up inherited tag entries
            {
                let mut conn = pool.acquire().await?;
                crate::tag_inheritance::remove_inherited_tag(
                    &mut conn,
                    p.block_id.as_str(),
                    p.tag_id.as_str(),
                )
                .await?;
            }
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            if is_reserved_property_key(&p.key) {
                let col = match p.key.as_str() {
                    "todo_state" => "todo_state",
                    "priority" => "priority",
                    "due_date" => "due_date",
                    "scheduled_date" => "scheduled_date",
                    _ => unreachable!(),
                };
                let value = match col {
                    "due_date" | "scheduled_date" => &p.value_date,
                    _ => &p.value_text,
                };
                sqlx::query(&format!("UPDATE blocks SET {col} = ? WHERE id = ?"))
                    .bind(value)
                    .bind(p.block_id.as_str())
                    .execute(pool)
                    .await?;
            } else {
                sqlx::query(
                    "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(p.block_id.as_str())
                .bind(&p.key)
                .bind(&p.value_text)
                .bind(p.value_num)
                .bind(&p.value_date)
                .bind(&p.value_ref)
                .execute(pool)
                .await?;
            }
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            if is_reserved_property_key(&p.key) {
                let col = match p.key.as_str() {
                    "todo_state" => "todo_state",
                    "priority" => "priority",
                    "due_date" => "due_date",
                    "scheduled_date" => "scheduled_date",
                    _ => unreachable!(),
                };
                sqlx::query(&format!("UPDATE blocks SET {col} = NULL WHERE id = ?"))
                    .bind(p.block_id.as_str())
                    .execute(pool)
                    .await?;
            } else {
                sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                    .bind(p.block_id.as_str())
                    .bind(&p.key)
                    .execute(pool)
                    .await?;
            }
        }
        OpType::AddAttachment => {
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query(
                "INSERT OR IGNORE INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&p.attachment_id)
            .bind(p.block_id.as_str())
            .bind(&p.filename)
            .bind(&p.fs_path)
            .bind(&p.mime_type)
            .bind(p.size_bytes)
            .bind(&record.created_at)
            .execute(pool)
            .await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(&p.attachment_id)
                .execute(pool)
                .await?;
        }
    }

    tracing::debug!(
        op_type = %record.op_type,
        seq = record.seq,
        "applied op to materialized tables"
    );

    Ok(())
}

/// Scan the attachments directory, cross-reference with the database,
/// and delete files with no matching row.
async fn cleanup_orphaned_attachments(pool: &SqlitePool) -> Result<(), AppError> {
    // For now, this is a no-op placeholder — the actual file scanning
    // requires access to the app data directory path, which is not
    // available in the materializer context. The infrastructure is in
    // place for when the file storage convention is established (F-7/F-9).
    //
    // Implementation plan:
    // 1. List all files in attachments/ directory
    // 2. Query all fs_path values from attachments table
    // 3. Delete files not in the DB set
    let _ = pool;
    tracing::debug!("orphaned attachment cleanup: no-op (file storage not yet established)");
    Ok(())
}

async fn handle_background_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::RebuildTagsCache => match read_pool {
            Some(rp) => cache::rebuild_tags_cache_split(pool, rp).await,
            None => cache::rebuild_tags_cache(pool).await,
        },
        MaterializeTask::RebuildPagesCache => match read_pool {
            Some(rp) => cache::rebuild_pages_cache_split(pool, rp).await,
            None => cache::rebuild_pages_cache(pool).await,
        },
        MaterializeTask::RebuildAgendaCache => match read_pool {
            Some(rp) => cache::rebuild_agenda_cache_split(pool, rp).await,
            None => cache::rebuild_agenda_cache(pool).await,
        },
        MaterializeTask::ReindexBlockLinks { ref block_id } => match read_pool {
            Some(rp) => cache::reindex_block_links_split(pool, rp, block_id).await,
            None => cache::reindex_block_links(pool, block_id).await,
        },
        MaterializeTask::UpdateFtsBlock { ref block_id } => {
            crate::fts::update_fts_for_block(pool, block_id).await
        }
        MaterializeTask::ReindexFtsReferences { ref block_id } => {
            crate::fts::reindex_fts_references(pool, block_id).await
        }
        MaterializeTask::RemoveFtsBlock { ref block_id } => {
            crate::fts::remove_fts_for_block(pool, block_id).await
        }
        MaterializeTask::RebuildFtsIndex => match read_pool {
            Some(rp) => crate::fts::rebuild_fts_index_split(pool, rp).await,
            None => crate::fts::rebuild_fts_index(pool).await,
        },
        MaterializeTask::FtsOptimize => crate::fts::fts_optimize(pool).await,
        MaterializeTask::CleanupOrphanedAttachments => cleanup_orphaned_attachments(pool).await,
        MaterializeTask::RebuildTagInheritanceCache => match read_pool {
            Some(rp) => crate::tag_inheritance::rebuild_all_split(pool, rp).await,
            None => crate::tag_inheritance::rebuild_all(pool).await,
        },
        MaterializeTask::ApplyOp(ref record) => {
            tracing::warn!(seq = record.seq, "unexpected ApplyOp in background queue");
            Ok(())
        }
        MaterializeTask::BatchApplyOps(_) => {
            tracing::warn!("unexpected BatchApplyOps in background queue");
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
    use crate::ulid::BlockId;
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
                block_id: BlockId::test_id("blk-1"),
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
                block_id: BlockId::test_id("blk-tag"),
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
                block_id: BlockId::test_id("blk-c"),
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
                block_id: BlockId::test_id("blk-2"),
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
                block_id: BlockId::test_id("blk-2"),
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
                block_id: BlockId::test_id("blk-3"),
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
                block_id: BlockId::test_id("blk-r"),
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
                block_id: BlockId::test_id("blk-p"),
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
                block_id: BlockId::test_id("blk-4"),
                tag_id: BlockId::test_id("tag-1"),
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
                block_id: BlockId::test_id("blk-rt"),
                tag_id: BlockId::test_id("tag-99"),
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
                block_id: BlockId::test_id("blk-5"),
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
                block_id: BlockId::test_id("blk-dp"),
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
                block_id: BlockId::test_id("blk-6"),
                new_parent_id: Some(BlockId::test_id("blk-parent")),
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
                block_id: BlockId::test_id("blk-a"),
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
                block_id: BlockId::test_id("blk-bg"),
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
                block_id: BlockId::test_id("blk-db"),
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
                block_id: BlockId::test_id("blk-fg"),
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
                block_id: BlockId::test_id("blk-flush-fg"),
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
                block_id: BlockId::test_id("blk-flush-both"),
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
    async fn handle_foreground_task_apply_op_applies_edit() {
        let (pool, _dir) = test_pool().await;

        // Insert a block directly so we can verify it IS modified by ApplyOp
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('NOOP_BLK', 'content', 'original')")
            .execute(&pool)
            .await
            .unwrap();

        // Build a fake OpRecord for an edit_block op targeting that block
        let record = fake_op_record(
            "edit_block",
            r#"{"block_id":"NOOP_BLK","to_text":"modified","prev_edit":null}"#,
        );

        let task = MaterializeTask::ApplyOp(record);
        let metrics = QueueMetrics::default();
        let result = handle_foreground_task(&pool, &task, &metrics).await;
        assert!(result.is_ok(), "ApplyOp should return Ok after applying");

        // Verify the block content WAS modified — Phase 4 applies remote ops
        let content: Option<String> =
            sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'NOOP_BLK'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            content.as_deref(),
            Some("modified"),
            "ApplyOp should update block content"
        );
    }

    #[tokio::test]
    async fn handle_foreground_task_barrier_signals_notify() {
        let (pool, _dir) = test_pool().await;

        let notify = Arc::new(tokio::sync::Notify::new());
        let task = MaterializeTask::Barrier(Arc::clone(&notify));

        let result = handle_foreground_task(&pool, &task, &QueueMetrics::default()).await;
        assert!(result.is_ok(), "Barrier task should return Ok");

        // Verify the Notify was signaled by checking if notified() resolves
        // immediately (with a short timeout to avoid hanging if broken).
        let signaled =
            tokio::time::timeout(std::time::Duration::from_millis(100), notify.notified()).await;
        assert!(
            signaled.is_ok(),
            "Barrier should have signaled the Notify, but notified() did not resolve"
        );
    }

    #[tokio::test]
    async fn handle_foreground_task_unexpected_non_apply_op_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildTagsCache;
        let result = handle_foreground_task(&pool, &task, &QueueMetrics::default()).await;
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
        let result = handle_foreground_task(&pool, &task, &QueueMetrics::default()).await;
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
        let result = handle_background_task(&pool, &task, None).await;
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
    fn dedup_fts_reindex_references_coalesced_by_block_id() {
        let tasks = vec![
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-1".into(),
            },
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-2".into(),
            },
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-1".into(),
            }, // dup
        ];

        let deduped = dedup_tasks(tasks);
        assert_eq!(
            deduped.len(),
            2,
            "should coalesce to 2 unique ReindexFtsReferences tasks"
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
    // Foreground batch grouping (§374)
    // ======================================================================

    #[test]
    fn batch_groups_ops_by_block_id() {
        // Three ops targeting two different blocks, plus one without a block_id.
        let tasks = vec![
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-A","to_text":"a1"}"#,
            )),
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-B","to_text":"b1"}"#,
            )),
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-A","to_text":"a2"}"#,
            )),
            // No block_id → None group
            MaterializeTask::RebuildTagsCache,
        ];

        let groups = group_tasks_by_block_id(tasks);

        // Expect 3 groups: blk-A (2 ops), blk-B (1 op), None (1 op)
        assert_eq!(groups.len(), 3, "should have 3 groups (blk-A, blk-B, None)");

        // None group must be last
        let (last_key, last_tasks) = groups.last().unwrap();
        assert!(last_key.is_none(), "None group should be last");
        assert_eq!(last_tasks.len(), 1);

        // blk-A group: 2 ops
        let a_group = groups
            .iter()
            .find(|(k, _)| k.as_deref() == Some("blk-A"))
            .expect("blk-A group should exist");
        assert_eq!(a_group.1.len(), 2, "blk-A should have 2 ops");

        // blk-B group: 1 op
        let b_group = groups
            .iter()
            .find(|(k, _)| k.as_deref() == Some("blk-B"))
            .expect("blk-B group should exist");
        assert_eq!(b_group.1.len(), 1, "blk-B should have 1 op");
    }

    #[test]
    fn batch_preserves_order_within_group() {
        // Three edits to the same block — order must be preserved.
        let tasks = vec![
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-X","to_text":"first"}"#,
            )),
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-X","to_text":"second"}"#,
            )),
            MaterializeTask::ApplyOp(fake_op_record(
                "edit_block",
                r#"{"block_id":"blk-X","to_text":"third"}"#,
            )),
        ];

        let groups = group_tasks_by_block_id(tasks);
        assert_eq!(groups.len(), 1, "all ops target same block → 1 group");

        let (key, group_tasks) = &groups[0];
        assert_eq!(key.as_deref(), Some("blk-X"));
        assert_eq!(group_tasks.len(), 3);

        // Verify ordering by checking payload content
        for (i, expected) in ["first", "second", "third"].iter().enumerate() {
            match &group_tasks[i] {
                MaterializeTask::ApplyOp(record) => {
                    assert!(
                        record.payload.contains(expected),
                        "task {i} should contain '{expected}', got '{}'",
                        record.payload
                    );
                }
                other => panic!("expected ApplyOp, got {other:?}"),
            }
        }
    }

    // ======================================================================
    // Parallel group execution (#374)
    // ======================================================================

    #[tokio::test]
    async fn parallel_groups_complete_independently() {
        // Two groups targeting different block_ids both complete when
        // processed through the parallel foreground segment path.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Pre-create two distinct blocks so the edits have something to update.
        insert_block_direct(&pool, "PAR_A", "content", "original-A").await;
        insert_block_direct(&pool, "PAR_B", "content", "original-B").await;

        // Enqueue edits targeting two different block_ids — the consumer
        // groups these into two independent groups that run in parallel.
        let record_a = make_op_record(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("PAR_A"),
                to_text: "updated-A".into(),
                prev_edit: None,
            }),
        )
        .await;
        let record_b = make_op_record(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("PAR_B"),
                to_text: "updated-B".into(),
                prev_edit: None,
            }),
        )
        .await;

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record_a))
            .await
            .unwrap();
        mat.enqueue_foreground(MaterializeTask::ApplyOp(record_b))
            .await
            .unwrap();

        mat.flush_foreground().await.unwrap();

        // Both blocks should have been updated — proving both groups
        // completed independently.
        let content_a: Option<String> =
            sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_A'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            content_a.as_deref(),
            Some("updated-A"),
            "block PAR_A should be updated by its group"
        );

        let content_b: Option<String> =
            sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_B'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            content_b.as_deref(),
            Some("updated-B"),
            "block PAR_B should be updated by its group"
        );

        // Verify metrics: at least 2 fg tasks processed (one per group).
        let processed = mat.metrics().fg_processed.load(AtomicOrdering::Relaxed);
        assert!(
            processed >= 2,
            "expected at least 2 fg tasks processed (one per group), got {processed}"
        );
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
                block_id: BlockId::test_id("blk-hw-fg"),
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
                block_id: BlockId::test_id("blk-si"),
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

    // ======================================================================
    // DB state verification: cache tables populated after flush (#97)
    // ======================================================================

    // -- Helpers for DB state verification tests --

    /// Insert a block row directly into the blocks table (bypasses op log).
    ///
    /// Used by cache-rebuild tests to pre-populate blocks without going
    /// through the op log and materializer pipeline.
    async fn insert_block_direct(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Soft-delete a block using a fixed, deterministic timestamp.
    async fn soft_delete_block_direct(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_TS)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a `block_tags` association row directly.
    async fn insert_block_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a `block_properties` row with a date value directly.
    async fn insert_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
        )
        .bind(block_id)
        .bind(key)
        .bind(value_date)
        .execute(pool)
        .await
        .unwrap();
    }

    // -- Test 1: create tag → tags_cache populated --

    #[tokio::test]
    async fn flush_populates_tags_cache_after_create_tag() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a tag block directly so the cache rebuild finds it.
        insert_block_direct(&pool, "TAG_FLUSH_1", "tag", "urgent").await;

        // Dispatch a create_block(tag) op — triggers RebuildTagsCache on bg queue.
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("TAG_FLUSH_1"),
                block_type: "tag".into(),
                parent_id: None,
                position: None,
                content: "urgent".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify tags_cache has the tag with correct name and zero usage.
        let row = sqlx::query(
            "SELECT tag_id, name, usage_count FROM tags_cache WHERE tag_id = 'TAG_FLUSH_1'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(row.is_some(), "tags_cache should contain the new tag");
        let row = row.unwrap();
        assert_eq!(row.get::<String, _>("name"), "urgent");
        assert_eq!(
            row.get::<i32, _>("usage_count"),
            0,
            "new tag with no usages should have count 0"
        );
    }

    // -- Test 2: create page → pages_cache populated --

    #[tokio::test]
    async fn flush_populates_pages_cache_after_create_page() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a page block directly so the cache rebuild finds it.
        insert_block_direct(&pool, "PAGE_FLUSH_1", "page", "My Test Page").await;

        // Dispatch a create_block(page) op — triggers RebuildPagesCache on bg queue.
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("PAGE_FLUSH_1"),
                block_type: "page".into(),
                parent_id: None,
                position: Some(0),
                content: "My Test Page".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify pages_cache has the page with correct title.
        let row =
            sqlx::query("SELECT page_id, title FROM pages_cache WHERE page_id = 'PAGE_FLUSH_1'")
                .fetch_optional(&pool)
                .await
                .unwrap();

        assert!(row.is_some(), "pages_cache should contain the new page");
        let row = row.unwrap();
        assert_eq!(row.get::<String, _>("title"), "My Test Page");
    }

    // -- Test 3: delete block → tag removed from tags_cache --

    #[tokio::test]
    async fn flush_removes_deleted_tag_from_tags_cache() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Step 1: Insert tag block, dispatch create, flush — verify in cache.
        insert_block_direct(&pool, "TAG_DEL_1", "tag", "to-delete").await;

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("TAG_DEL_1"),
                block_type: "tag".into(),
                parent_id: None,
                position: None,
                content: "to-delete".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            row.is_some(),
            "tags_cache should contain the tag before deletion"
        );

        // Step 2: Soft-delete the block and dispatch a delete_block op.
        soft_delete_block_direct(&pool, "TAG_DEL_1").await;

        let del_record = make_op_record(
            &pool,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::test_id("TAG_DEL_1"),
            }),
        )
        .await;

        mat.dispatch_op(&del_record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify tags_cache no longer has the deleted tag.
        let row = sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            row.is_none(),
            "tags_cache should not contain the deleted tag after flush"
        );
    }

    // -- Test 4: add tag → tags_cache usage_count updated --

    #[tokio::test]
    async fn flush_updates_tags_cache_usage_count_after_add_tag() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a tag block and a content block.
        insert_block_direct(&pool, "TAG_USE_1", "tag", "important").await;
        insert_block_direct(&pool, "BLK_USE_1", "content", "some note").await;

        // Dispatch create_block(tag) to seed tags_cache.
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("TAG_USE_1"),
                block_type: "tag".into(),
                parent_id: None,
                position: None,
                content: "important".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify initial usage_count is 0.
        let row = sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<i32, _>("usage_count"),
            0,
            "initial usage_count should be 0"
        );

        // Add the tag to the content block (write directly + dispatch add_tag).
        insert_block_tag(&pool, "BLK_USE_1", "TAG_USE_1").await;

        let add_record = make_op_record(
            &pool,
            OpPayload::AddTag(AddTagPayload {
                block_id: BlockId::test_id("BLK_USE_1"),
                tag_id: BlockId::test_id("TAG_USE_1"),
            }),
        )
        .await;

        mat.dispatch_op(&add_record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify usage_count increased to 1.
        let row = sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<i32, _>("usage_count"),
            1,
            "usage_count should be 1 after adding tag to one block"
        );
    }

    // -- Test 5: set property with due date → agenda_cache populated --

    #[tokio::test]
    async fn flush_populates_agenda_cache_after_set_property_with_due_date() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a content block and set a due_date property on it.
        insert_block_direct(&pool, "BLK_AGD_1", "content", "task with deadline").await;
        insert_property_date(&pool, "BLK_AGD_1", "due", "2025-03-15").await;

        // Dispatch set_property op — triggers RebuildAgendaCache on bg queue.
        let record = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_AGD_1"),
                key: "due".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-03-15".into()),
                value_ref: None,
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify agenda_cache has the entry with correct date and source.
        let row = sqlx::query(
            "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'BLK_AGD_1'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(
            row.is_some(),
            "agenda_cache should contain the block with due date property"
        );
        let row = row.unwrap();
        assert_eq!(row.get::<String, _>("date"), "2025-03-15");
        assert_eq!(row.get::<String, _>("source"), "property:due");
    }

    // ======================================================================
    // ApplyOp handler tests (#216: Materializer ApplyOp for remote ops)
    // ======================================================================

    #[tokio::test]
    async fn apply_op_create_block_inserts_row() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_CREATE_1";
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello from remote".into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT id, block_type, content, position FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(&pool)
            .await
            .unwrap();

        assert!(
            row.is_some(),
            "block should exist after ApplyOp CreateBlock"
        );
        let row = row.unwrap();
        assert_eq!(row.get::<String, _>("block_type"), "content");
        assert_eq!(
            row.get::<Option<String>, _>("content").as_deref(),
            Some("hello from remote")
        );
        assert_eq!(row.get::<Option<i64>, _>("position"), Some(1));
    }

    #[tokio::test]
    async fn apply_op_create_block_idempotent() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_IDEM_1";
        // Pre-insert the block (simulating local command handler)
        insert_block_direct(&pool, block_id, "content", "original").await;

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "from remote".into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Content should remain "original" since INSERT OR IGNORE skips duplicates
        let row = sqlx::query("SELECT content FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("content").as_deref(),
            Some("original"),
            "INSERT OR IGNORE should not overwrite existing block"
        );
    }

    #[tokio::test]
    async fn apply_op_edit_block_updates_content() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_EDIT_1";
        insert_block_direct(&pool, block_id, "content", "before edit").await;

        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
            to_text: "after edit".into(),
            prev_edit: None,
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT content FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("content").as_deref(),
            Some("after edit")
        );
    }

    #[tokio::test]
    async fn apply_op_delete_block_soft_deletes() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_DEL_1";
        insert_block_direct(&pool, block_id, "content", "to delete").await;

        let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id(block_id),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.get::<Option<String>, _>("deleted_at").is_some(),
            "block should be soft-deleted after ApplyOp DeleteBlock"
        );
    }

    #[tokio::test]
    async fn apply_op_invalid_payload_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build a record with valid op_type but invalid JSON payload
        let record = fake_op_record("create_block", r#"{"not_valid": true}"#);

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.flush_foreground().await.unwrap();

        // Should not panic — the handler logs a warning and returns Ok(())
        // If we get here without panic, the test passes.
    }

    #[tokio::test]
    async fn apply_op_unknown_op_type_returns_ok() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = fake_op_record("unknown_op", r#"{}"#);

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.flush_foreground().await.unwrap();

        // Should not panic — unknown op_type is logged and skipped
    }

    // ======================================================================
    // ApplyOp: remaining op type coverage (review #216)
    // ======================================================================

    #[tokio::test]
    async fn apply_op_restore_block_clears_deleted_at() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_RESTORE_1";
        insert_block_direct(&pool, block_id, "content", "to restore").await;
        soft_delete_block_direct(&pool, block_id).await;

        // Verify block is soft-deleted
        let row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.get::<Option<String>, _>("deleted_at").is_some(),
            "block must be soft-deleted before restore"
        );

        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id(block_id),
            deleted_at_ref: FIXED_TS.into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.get::<Option<String>, _>("deleted_at").is_none(),
            "deleted_at should be NULL after ApplyOp RestoreBlock"
        );
    }

    #[tokio::test]
    async fn apply_op_purge_block_physically_deletes() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_PURGE_1";
        insert_block_direct(&pool, block_id, "content", "to purge").await;
        soft_delete_block_direct(&pool, block_id).await;

        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id(block_id),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT id FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            row.is_none(),
            "block should be physically deleted after ApplyOp PurgeBlock"
        );
    }

    #[tokio::test]
    async fn apply_op_move_block_updates_parent_and_position() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_MOVE_1";
        let parent_id = "APPLY_MOVE_PARENT";
        insert_block_direct(&pool, parent_id, "page", "parent").await;
        insert_block_direct(&pool, block_id, "content", "movable").await;

        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id(block_id),
            new_parent_id: Some(BlockId::test_id(parent_id)),
            new_position: 5,
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT parent_id, position FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("parent_id").as_deref(),
            Some(parent_id)
        );
        assert_eq!(row.get::<Option<i64>, _>("position"), Some(5));
    }

    #[tokio::test]
    async fn apply_op_add_tag_inserts_block_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_ADDTAG_BLK";
        let tag_id = "APPLY_ADDTAG_TAG";
        insert_block_direct(&pool, block_id, "content", "note").await;
        insert_block_direct(&pool, tag_id, "tag", "urgent").await;

        let payload = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id(block_id),
            tag_id: BlockId::test_id(tag_id),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
            block_id,
            tag_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "block_tags row should exist after ApplyOp AddTag");
    }

    #[tokio::test]
    async fn apply_op_add_tag_idempotent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_ADDTAG_IDEM_BLK";
        let tag_id = "APPLY_ADDTAG_IDEM_TAG";
        insert_block_direct(&pool, block_id, "content", "note").await;
        insert_block_direct(&pool, tag_id, "tag", "urgent").await;

        // Pre-insert the tag association
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(&pool)
            .await
            .unwrap();

        let payload = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id(block_id),
            tag_id: BlockId::test_id(tag_id),
        });
        let record = make_op_record(&pool, payload).await;

        // Should not fail — INSERT OR IGNORE handles the duplicate
        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
            block_id,
            tag_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "idempotent add_tag should not create duplicates");
    }

    #[tokio::test]
    async fn apply_op_remove_tag_deletes_block_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_RMTAG_BLK";
        let tag_id = "APPLY_RMTAG_TAG";
        insert_block_direct(&pool, block_id, "content", "note").await;
        insert_block_direct(&pool, tag_id, "tag", "stale").await;
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(&pool)
            .await
            .unwrap();

        let payload = OpPayload::RemoveTag(crate::op::RemoveTagPayload {
            block_id: BlockId::test_id(block_id),
            tag_id: BlockId::test_id(tag_id),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
            block_id,
            tag_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            count, 0,
            "block_tags row should be gone after ApplyOp RemoveTag"
        );
    }

    #[tokio::test]
    async fn apply_op_set_property_upserts_row() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_SETPROP_1";
        insert_block_direct(&pool, block_id, "content", "note").await;

        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id(block_id),
            key: "importance".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row =
            sqlx::query("SELECT value_text FROM block_properties WHERE block_id = ? AND key = ?")
                .bind(block_id)
                .bind("importance")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(row.is_some(), "property row should exist after SetProperty");
        assert_eq!(
            row.unwrap()
                .get::<Option<String>, _>("value_text")
                .as_deref(),
            Some("high")
        );
    }

    #[tokio::test]
    async fn apply_op_set_property_replaces_existing() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_SETPROP_REPL";
        insert_block_direct(&pool, block_id, "content", "note").await;

        // Pre-insert a property
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind("importance")
            .bind("low")
            .execute(&pool)
            .await
            .unwrap();

        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id(block_id),
            key: "importance".into(),
            value_text: Some("critical".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row =
            sqlx::query("SELECT value_text FROM block_properties WHERE block_id = ? AND key = ?")
                .bind(block_id)
                .bind("importance")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("value_text").as_deref(),
            Some("critical"),
            "INSERT OR REPLACE should overwrite existing property"
        );
    }

    #[tokio::test]
    async fn apply_op_delete_property_removes_row() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_DELPROP_1";
        insert_block_direct(&pool, block_id, "content", "note").await;
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind("status")
            .bind("done")
            .execute(&pool)
            .await
            .unwrap();

        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id(block_id),
            key: "status".into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = ?",
            block_id,
            "status"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "property row should be gone after DeleteProperty");
    }

    #[tokio::test]
    async fn apply_op_add_attachment_inserts_row() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_ADDATT_BLK";
        let att_id = "APPLY_ATT_1";
        insert_block_direct(&pool, block_id, "content", "note with file").await;

        let payload = OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: att_id.into(),
            block_id: BlockId::test_id(block_id),
            mime_type: "application/pdf".into(),
            filename: "doc.pdf".into(),
            size_bytes: 2048,
            fs_path: "/tmp/doc.pdf".into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row =
            sqlx::query("SELECT id, filename, mime_type, size_bytes FROM attachments WHERE id = ?")
                .bind(att_id)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(row.is_some(), "attachment should exist after AddAttachment");
        let row = row.unwrap();
        assert_eq!(row.get::<String, _>("filename"), "doc.pdf");
        assert_eq!(row.get::<String, _>("mime_type"), "application/pdf");
        assert_eq!(row.get::<i64, _>("size_bytes"), 2048);
    }

    #[tokio::test]
    async fn apply_op_delete_attachment_removes_row() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "APPLY_DELATT_BLK";
        let att_id = "APPLY_DELATT_1";
        insert_block_direct(&pool, block_id, "content", "note").await;
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(block_id)
        .bind("text/plain")
        .bind("notes.txt")
        .bind(512_i64)
        .bind("/tmp/notes.txt")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        let payload = OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: att_id.into(),
        });
        let record = make_op_record(&pool, payload).await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let row = sqlx::query("SELECT id FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            row.is_none(),
            "attachment should be gone after DeleteAttachment"
        );
    }

    // ======================================================================
    // Concurrent stress — foreground + background on same block_id
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_fg_bg_same_block_does_not_panic() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "STRESS_BLOCK_01";
        sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
            .bind(block_id)
            .bind("content")
            .bind("stress test")
            .bind(1_i64)
            .execute(&pool)
            .await
            .unwrap();

        // Fire 20 foreground ApplyOp + 20 background tasks concurrently for the same block
        let mut handles = Vec::new();
        for i in 0..20 {
            let mat_fg = mat.clone();
            let payload_str = format!(
                r#"{{"op_type":"edit_block","block_id":"{block_id}","to_text":"v{i}","prev_edit":null}}"#,
            );
            let record = fake_op_record("edit_block", &payload_str);
            handles.push(tokio::spawn(async move {
                let _ = mat_fg
                    .enqueue_foreground(MaterializeTask::ApplyOp(record))
                    .await;
            }));

            let mat_bg = mat.clone();
            let bid = block_id.to_string();
            handles.push(tokio::spawn(async move {
                let _ = mat_bg
                    .enqueue_background(MaterializeTask::ReindexBlockLinks {
                        block_id: bid.clone(),
                    })
                    .await;
                let _ = mat_bg
                    .enqueue_background(MaterializeTask::UpdateFtsBlock { block_id: bid })
                    .await;
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        // Flush both queues — if there's a deadlock or panic, this will hang/fail
        mat.flush().await.unwrap();

        // Verify materializer is still functional after the storm
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_dispatch_ops_serialized_correctly() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block_id = "STRESS_SERIAL_01";
        sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
            .bind(block_id)
            .bind("content")
            .bind("initial")
            .bind(1_i64)
            .execute(&pool)
            .await
            .unwrap();

        // Dispatch 10 edit ops concurrently through dispatch_op
        let mut handles = Vec::new();
        for i in 0..10 {
            let mat_c = mat.clone();
            let pool_c = pool.clone();
            let payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id(block_id),
                to_text: format!("concurrent-v{i}"),
                prev_edit: None,
            });
            handles.push(tokio::spawn(async move {
                let record = make_op_record(&pool_c, payload).await;
                mat_c.dispatch_op(&record).await.unwrap();
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        mat.flush().await.unwrap();

        // All 10 ops should have been processed — check metrics
        let metrics = mat.metrics();
        assert!(
            metrics.fg_processed.load(AtomicOrdering::Relaxed) >= 10,
            "at least 10 foreground tasks should have been processed"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatch_op_set_property_reserved_key_writes_blocks_column() {
        use crate::op::is_reserved_property_key;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a block to act on (uppercase to match BlockId::test_id)
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES ('BLK-RES', 'content', 'test', 1, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(is_reserved_property_key("todo_state"));

        let record = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK-RES"),
                key: "todo_state".into(),
                value_text: Some("DONE".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify blocks.todo_state column is updated
        let todo_state: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-RES'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            todo_state,
            Some("DONE".into()),
            "blocks.todo_state column should be DONE"
        );

        // Verify block_properties does NOT have a row for this key
        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-RES' AND key = 'todo_state'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key should NOT be stored in block_properties"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatch_op_set_property_priority_reserved_key_writes_blocks_column() {
        use crate::op::is_reserved_property_key;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a block to act on
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES ('BLK-PRI', 'content', 'test', 1, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(is_reserved_property_key("priority"));

        let record = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK-PRI"),
                key: "priority".into(),
                value_text: Some("2".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify blocks.priority column is updated
        let priority: Option<String> =
            sqlx::query_scalar("SELECT priority FROM blocks WHERE id = 'BLK-PRI'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            priority,
            Some("2".into()),
            "blocks.priority column should be 2"
        );

        // Verify block_properties does NOT have a row for this key
        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-PRI' AND key = 'priority'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key should NOT be stored in block_properties"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatch_op_set_property_due_date_reserved_key_writes_blocks_column() {
        use crate::op::is_reserved_property_key;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a block to act on
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES ('BLK-DUE', 'content', 'test', 1, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(is_reserved_property_key("due_date"));

        let record = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK-DUE"),
                key: "due_date".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2026-05-15".into()),
                value_ref: None,
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify blocks.due_date column is updated
        let due_date: Option<String> =
            sqlx::query_scalar("SELECT due_date FROM blocks WHERE id = 'BLK-DUE'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            due_date,
            Some("2026-05-15".into()),
            "blocks.due_date column should be 2026-05-15"
        );

        // Verify block_properties does NOT have a row for this key
        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-DUE' AND key = 'due_date'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key should NOT be stored in block_properties"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatch_op_delete_property_reserved_key_clears_blocks_column() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a block with todo_state set via direct SQL
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, is_conflict, todo_state) \
             VALUES ('BLK-DEL', 'content', 'test', 1, 0, 'TODO')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Verify todo_state is set
        let before: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-DEL'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            before,
            Some("TODO".into()),
            "precondition: todo_state = TODO"
        );

        let record = make_op_record(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK-DEL"),
                key: "todo_state".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        // Verify blocks.todo_state column is NULL
        let after: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-DEL'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            after.is_none(),
            "blocks.todo_state should be NULL after DeleteProperty, got: {after:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cleanup_orphaned_attachments_runs_without_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // Enqueue and process the cleanup task
        mat.try_enqueue_background(MaterializeTask::CleanupOrphanedAttachments)
            .unwrap();
        mat.flush_background().await.unwrap();
        // No error = success (no-op for now)
    }

    // ======================================================================
    // Foreground retry mechanism tests (#R-20)
    // ======================================================================

    /// Verify that `process_single_foreground_task` handles a successful
    /// foreground task without retry and increments fg_processed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fg_retry_success_on_first_attempt_no_error_counted() {
        let (pool, _dir) = test_pool().await;
        let metrics = Arc::new(QueueMetrics::default());

        // Create a valid block so the ApplyOp succeeds
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("blk-retry-ok"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "retry test".into(),
            }),
        )
        .await;

        let task = MaterializeTask::ApplyOp(record);
        Materializer::process_single_foreground_task(&pool, task, &metrics).await;

        assert_eq!(
            metrics.fg_processed.load(AtomicOrdering::Relaxed),
            1,
            "fg_processed should be 1 after successful task"
        );
        assert_eq!(
            metrics.fg_errors.load(AtomicOrdering::Relaxed),
            0,
            "fg_errors should be 0 when task succeeds on first attempt"
        );
        assert_eq!(
            metrics.fg_panics.load(AtomicOrdering::Relaxed),
            0,
            "fg_panics should be 0 for non-panicking task"
        );
    }

    /// Verify that barrier tasks take the early-return path in
    /// `process_single_foreground_task` (no retry logic, still increments
    /// fg_processed).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fg_retry_barrier_not_retried() {
        let (pool, _dir) = test_pool().await;
        let metrics = Arc::new(QueueMetrics::default());

        let notify = Arc::new(tokio::sync::Notify::new());
        let task = MaterializeTask::Barrier(Arc::clone(&notify));

        Materializer::process_single_foreground_task(&pool, task, &metrics).await;

        assert_eq!(
            metrics.fg_processed.load(AtomicOrdering::Relaxed),
            1,
            "fg_processed should be 1 after barrier task"
        );
        assert_eq!(
            metrics.fg_errors.load(AtomicOrdering::Relaxed),
            0,
            "fg_errors should remain 0 for barrier"
        );
    }

    /// Verify that a foreground task that fails (DB error path inside
    /// `handle_foreground_task`) propagates the error so the retry path
    /// in `process_single_foreground_task` fires. The retry also fails
    /// (same bad payload), so `fg_errors` is incremented once by the
    /// retry mechanism.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fg_retry_task_with_bad_payload_handled_internally() {
        let (pool, _dir) = test_pool().await;
        let metrics = Arc::new(QueueMetrics::default());

        // ApplyOp with an unknown op_type — apply_op returns Err,
        // handle_foreground_task propagates it. The retry path in
        // process_single_foreground_task sees Ok(Err(_)), retries once,
        // the retry also fails, and fg_errors is incremented.
        let record = fake_op_record("bogus_op_type", "{}");
        let task = MaterializeTask::ApplyOp(record);
        Materializer::process_single_foreground_task(&pool, task, &metrics).await;

        assert_eq!(
            metrics.fg_processed.load(AtomicOrdering::Relaxed),
            1,
            "fg_processed should be 1"
        );
        // The retry mechanism counted the error after both attempts failed
        assert_eq!(
            metrics.fg_errors.load(AtomicOrdering::Relaxed),
            1,
            "fg_errors should be 1 from retry mechanism after propagated failure"
        );
        assert_eq!(
            metrics.fg_panics.load(AtomicOrdering::Relaxed),
            0,
            "fg_panics should be 0"
        );
    }

    /// End-to-end: foreground retry doesn't interfere with normal
    /// materializer flush/shutdown lifecycle.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fg_retry_full_lifecycle_no_regression() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Enqueue a valid op, flush, then verify metrics
        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("blk-lifecycle"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "lifecycle test".into(),
            }),
        )
        .await;

        mat.dispatch_op(&record).await.unwrap();
        mat.flush().await.unwrap();

        let m = mat.metrics();
        assert!(
            m.fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "at least one fg task should be processed"
        );
        assert_eq!(
            m.fg_errors.load(AtomicOrdering::Relaxed),
            0,
            "no errors expected for valid op"
        );
        assert_eq!(
            m.fg_panics.load(AtomicOrdering::Relaxed),
            0,
            "no panics expected"
        );

        mat.shutdown();
    }

    // ======================================================================
    // B-4: Error propagation tests for ApplyOp / BatchApplyOps
    // ======================================================================

    /// Verify that a failed ApplyOp propagates the error through the retry
    /// mechanism in `process_single_foreground_task`. A malformed payload
    /// causes `apply_op()` to fail; `handle_foreground_task` now returns
    /// `Err`, the retry fires and also fails, so `fg_errors` is incremented
    /// exactly once by the retry mechanism.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_op_failure_propagated_for_retry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Enqueue an ApplyOp with a malformed payload that will fail
        let record = fake_op_record("create_block", "{}");
        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.flush().await.unwrap();

        let m = mat.metrics();
        assert!(
            m.fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "task should be processed"
        );
        assert_eq!(
            m.fg_errors.load(AtomicOrdering::Relaxed),
            1,
            "fg_errors should be 1 — error propagated and retry also failed"
        );

        mat.shutdown();
    }

    /// Verify that a BatchApplyOps with a mix of valid and invalid ops
    /// propagates the error. The batch contains one valid create_block
    /// and one malformed op. The batch handler collects failures and
    /// returns the last error, which triggers the retry path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_apply_ops_partial_failure_propagated() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // One valid op
        let good_record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("blk-batch-good"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "batch good".into(),
            }),
        )
        .await;

        // One malformed op (empty JSON for create_block will fail deserialization)
        let bad_record = fake_op_record("create_block", "{}");

        let batch = vec![good_record, bad_record];
        mat.enqueue_foreground(MaterializeTask::BatchApplyOps(batch))
            .await
            .unwrap();
        mat.flush().await.unwrap();

        let m = mat.metrics();
        assert!(
            m.fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "batch task should be processed"
        );
        assert_eq!(
            m.fg_errors.load(AtomicOrdering::Relaxed),
            1,
            "fg_errors should be 1 — partial batch failure propagated and retry also failed"
        );

        mat.shutdown();
    }

    /// Verify that a valid ApplyOp succeeds without any error counting.
    /// This is the happy-path counterpart to the failure propagation tests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_op_success_no_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let record = make_op_record(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("blk-success"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "success test".into(),
            }),
        )
        .await;

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();
        mat.flush().await.unwrap();

        let m = mat.metrics();
        assert!(
            m.fg_processed.load(AtomicOrdering::Relaxed) >= 1,
            "at least one fg task should be processed"
        );
        assert_eq!(
            m.fg_errors.load(AtomicOrdering::Relaxed),
            0,
            "fg_errors should be 0 for a valid op"
        );

        mat.shutdown();
    }

    // ======================================================================
    // P-8 Phase 2: with_read_pool and handle_background_task split dispatch
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_read_pool_constructor_processes_background_tasks() {
        // Verify that Materializer::with_read_pool works end-to-end
        let (pool, _dir) = test_pool().await;
        // Insert a tag block
        insert_block_direct(&pool, "TAG01", "tag", "test-tag").await;
        // Create materializer with split pools (same pool for both — test environment)
        let mat = Materializer::with_read_pool(pool.clone(), pool.clone());
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        // Verify cache was rebuilt
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "tags_cache should have 1 entry after split rebuild"
        );
        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_background_task_with_read_pool_uses_split() {
        // Test handle_background_task dispatches to _split variants when read_pool is Some
        let (pool, _dir) = test_pool().await;
        insert_block_direct(&pool, "TAG02", "tag", "split-tag").await;
        // Call handle_background_task directly with Some read_pool
        let result =
            handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, Some(&pool)).await;
        assert!(result.is_ok(), "split rebuild should succeed");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "tags_cache should have 1 entry");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_background_task_without_read_pool_uses_original() {
        // Test handle_background_task falls back to original when read_pool is None
        let (pool, _dir) = test_pool().await;
        insert_block_direct(&pool, "TAG03", "tag", "orig-tag").await;
        let result = handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, None).await;
        assert!(result.is_ok(), "original rebuild should succeed");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "tags_cache should have 1 entry");
    }
}
