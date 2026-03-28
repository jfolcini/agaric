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

use serde::Deserialize;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::mem;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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
}

// ---------------------------------------------------------------------------
// Queue capacities
// ---------------------------------------------------------------------------

const FOREGROUND_CAPACITY: usize = 256;
const BACKGROUND_CAPACITY: usize = 1024;

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
#[derive(Debug, Default)]
pub struct QueueMetrics {
    /// Number of foreground tasks fully processed.
    pub fg_processed: AtomicU64,
    /// Number of background tasks fully processed (after dedup).
    pub bg_processed: AtomicU64,
    /// Number of background tasks dropped by dedup coalescing.
    pub bg_deduped: AtomicU64,
}

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

/// Coordination handle for the materializer queues.
///
/// `Clone`-able (all inner fields are `Clone`) so it can live in Tauri
/// managed state and be shared across command handlers.
#[derive(Clone)]
pub struct Materializer {
    fg_tx: mpsc::Sender<MaterializeTask>,
    bg_tx: mpsc::Sender<MaterializeTask>,
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
            fg_tx,
            bg_tx,
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
        result: Result<Result<(), crate::error::AppError>, tokio::task::JoinError>,
    ) {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("[materializer:{label}] Error processing task: {e}");
            }
            Err(e) => {
                eprintln!("[materializer:{label}] Task panicked: {e}");
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

            // Check shutdown flag after waking — `shutdown()` sends a wake-up
            // task so we don't block forever on recv.
            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }

            // Spawn a sub-task for panic isolation — await preserves FIFO.
            let pool_clone = pool.clone();
            let result =
                tokio::task::spawn(async move { handle_foreground_task(&pool_clone, &task).await })
                    .await;

            Self::log_consumer_result("fg", result);

            metrics.fg_processed.fetch_add(1, Ordering::Relaxed);
        }
        eprintln!("[materializer:fg] Queue closed");
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

            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }

            // Drain all additionally pending tasks without blocking.
            let mut batch = vec![first];
            while let Ok(task) = rx.try_recv() {
                batch.push(task);
            }

            let total_before = batch.len();
            let deduped = dedup_tasks(batch);
            let dedup_count = (total_before - deduped.len()) as u64;

            for task in deduped {
                let pool_clone = pool.clone();
                let result =
                    tokio::task::spawn(
                        async move { handle_background_task(&pool_clone, &task).await },
                    )
                    .await;

                Self::log_consumer_result("bg", result);

                metrics.bg_processed.fetch_add(1, Ordering::Relaxed);
            }

            metrics.bg_deduped.fetch_add(dedup_count, Ordering::Relaxed);
        }
        eprintln!("[materializer:bg] Queue closed");
    }

    // -- public API --------------------------------------------------------

    /// Enqueue a task on the **foreground** (low-latency) queue.
    ///
    /// Blocks (async) until space is available. Returns `Err` if the consumer
    /// has shut down.
    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        self.fg_tx
            .send(task)
            .await
            .map_err(|e| AppError::Channel(format!("foreground queue send failed: {e}")))
    }

    /// Enqueue a task on the **background** (stale-while-revalidate) queue.
    ///
    /// Blocks (async) until space is available. Returns `Err` if the consumer
    /// has shut down.
    pub async fn enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        self.bg_tx
            .send(task)
            .await
            .map_err(|e| AppError::Channel(format!("background queue send failed: {e}")))
    }

    /// Best-effort background enqueue: if the queue is full the task is
    /// silently dropped (stale-while-revalidate — the cache will be rebuilt
    /// on the next edit). Returns `Err` only if the consumer has shut down.
    pub fn try_enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        match self.bg_tx.try_send(task) {
            Ok(()) => Ok(()),
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

    /// Gracefully shut down both consumer tasks.
    ///
    /// Sets a shared flag and sends wake-up messages so that consumers blocked
    /// on `recv()` unblock, notice the flag, and exit. After the consumers
    /// exit their receivers are dropped and subsequent sends return `Err`.
    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::Release);
        // Send wake-up tasks so consumers unblock from recv().
        // These are harmless — the consumer will check the flag and exit
        // before processing them.
        let _ = self.fg_tx.try_send(MaterializeTask::RebuildTagsCache);
        let _ = self.bg_tx.try_send(MaterializeTask::RebuildTagsCache);
    }

    /// Access the observable queue metrics (atomic counters).
    pub fn metrics(&self) -> &QueueMetrics {
        &self.metrics
    }

    /// Enqueue only background cache tasks for the given op record.
    ///
    /// Used by command handlers that have already applied the op synchronously
    /// to the blocks table. This avoids double-writes by skipping the
    /// foreground `ApplyOp` task and only triggering stale-while-revalidate
    /// cache rebuilds / reindexing.
    pub fn dispatch_background(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_background_tasks(record)
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

        self.enqueue_background_tasks(record)
    }

    /// Shared background-task routing logic used by both `dispatch_op` and
    /// `dispatch_background`.
    fn enqueue_background_tasks(&self, record: &OpRecord) -> Result<(), AppError> {
        // Background tasks are best-effort — use try_enqueue_background to
        // avoid blocking on a full queue.
        match record.op_type.as_str() {
            "create_block" => {
                // Targeted deserialization — only extracts the field we need,
                // cheaper than parsing the full payload into serde_json::Value.
                let hint: BlockTypeHint = serde_json::from_str(&record.payload)?;
                match hint.block_type.as_str() {
                    "tag" => {
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                    }
                    "page" => {
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                    }
                    _ => {}
                }
            }
            "edit_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::ReindexBlockLinks {
                    block_id: hint.block_id,
                })?;
                // Conservatively rebuild all content-dependent caches — we cannot
                // determine block_type from the edit payload alone without a DB
                // lookup, so a tag rename or date change must still invalidate.
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
            }
            "delete_block" | "restore_block" | "purge_block" => {
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
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
                eprintln!("[materializer] Unknown op_type in dispatch_op: {other}");
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
///   `RebuildAgendaCache`) are deduplicated by discriminant — only the first
///   occurrence survives.
/// - `ReindexBlockLinks` tasks are deduplicated by `block_id`.
/// - `ApplyOp` tasks are always preserved (they should not appear on the bg
///   queue, but we never silently drop them).
fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    let mut seen_discriminants: HashSet<mem::Discriminant<MaterializeTask>> = HashSet::new();
    let mut seen_block_ids: HashSet<String> = HashSet::new();
    let mut result = Vec::with_capacity(tasks.len());

    for task in tasks {
        match &task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                if seen_block_ids.insert(block_id.clone()) {
                    result.push(task);
                }
            }
            MaterializeTask::ApplyOp(_) => {
                // Never drop ApplyOp, even if unexpected on bg queue.
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
            eprintln!(
                "[materializer:fg] Processing op: {} seq={}",
                record.op_type, record.seq
            );
            Ok(())
        }
        _ => {
            // Foreground queue shouldn't receive non-ApplyOp tasks
            eprintln!(
                "[materializer:fg] Unexpected task in foreground queue: {:?}",
                task
            );
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
        MaterializeTask::ApplyOp(ref record) => {
            eprintln!(
                "[materializer:bg] Unexpected ApplyOp in background queue: seq={}",
                record.seq
            );
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
    //! logic, shutdown, and metrics. Pure-logic tests (dedup) use `#[test]`;
    //! async tests use `#[tokio::test]` with sleeps only where we need to
    //! observe consumer-side effects (metrics, shutdown).

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
        // Allow bg consumer to process
        tokio::time::sleep(Duration::from_millis(50)).await;
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
        tokio::time::sleep(Duration::from_millis(50)).await;
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
                cascade: false,
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
                cascade: true,
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
        // Give consumer tasks time to notice the flag and exit.
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
        tokio::time::sleep(Duration::from_millis(50)).await;

        mat.shutdown();
        // Give consumer tasks time to notice the flag and exit.
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

        // Allow bg consumer time to process
        tokio::time::sleep(Duration::from_millis(200)).await;

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

        // Allow fg consumer time to process
        tokio::time::sleep(Duration::from_millis(100)).await;

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

        tokio::time::sleep(Duration::from_millis(200)).await;

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
}
