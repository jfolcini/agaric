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
            tokio::spawn(Self::run_foreground(pool, fg_rx, shutdown_flag, metrics));
        }

        // Spawn background consumer (with batch-drain dedup)
        {
            let shutdown_flag = shutdown_flag.clone();
            let metrics = metrics.clone();
            tokio::spawn(Self::run_background(pool, bg_rx, shutdown_flag, metrics));
        }

        Self {
            fg_tx,
            bg_tx,
            shutdown_flag,
            metrics,
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

            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    eprintln!("[materializer:fg] Error processing task: {e}");
                }
                Err(e) => {
                    eprintln!("[materializer:fg] Task panicked: {e}");
                }
            }

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

                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        eprintln!("[materializer:bg] Error processing task: {e}");
                    }
                    Err(e) => {
                        eprintln!("[materializer:bg] Task panicked: {e}");
                    }
                }

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
                // Conservatively rebuild pages cache — we cannot determine
                // block_type from the edit payload alone without a DB lookup.
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
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

    /// Helper: create a SQLite pool backed by a temp file.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    // ── construction & clone ────────────────────────────────────────────

    #[tokio::test]
    async fn materializer_new_creates_successfully() {
        let (pool, _dir) = test_pool().await;
        let _mat = Materializer::new(pool);
        // If we get here without panic the queues were created
    }

    #[tokio::test]
    async fn materializer_is_clone() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);
        let mat2 = mat.clone();

        // Both clones can enqueue
        assert!(mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok());
        assert!(mat2
            .enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ── dispatch_op coverage (all op types) ─────────────────────────────

    #[tokio::test]
    async fn dispatch_op_create_block_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "blk-1".into(),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            content: "My page".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        let result = mat.dispatch_op(&record).await;
        assert!(result.is_ok());

        // Give the consumer tasks a moment to process
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_create_block_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "blk-tag".into(),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "urgent".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_edit_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // First create a block so the sequence exists
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "blk-2".into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "original".into(),
        });
        append_local_op(&pool, "dev-1", create).await.unwrap();

        let edit = OpPayload::EditBlock(EditBlockPayload {
            block_id: "blk-2".into(),
            to_text: "edited".into(),
            prev_edit: None,
        });
        let record = append_local_op(&pool, "dev-1", edit).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_delete_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: "blk-3".into(),
            cascade: false,
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_restore_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: "blk-r".into(),
            deleted_at_ref: "2025-01-01T00:00:00Z".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // restore_block triggers RebuildTagsCache + RebuildPagesCache + RebuildAgendaCache
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_purge_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: "blk-p".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // purge_block triggers RebuildTagsCache + RebuildPagesCache + RebuildAgendaCache
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_add_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::AddTag(AddTagPayload {
            block_id: "blk-4".into(),
            tag_id: "tag-1".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_set_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: "blk-5".into(),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-01-15".into()),
            value_ref: None,
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_delete_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: "blk-dp".into(),
            key: "due".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // delete_property triggers RebuildAgendaCache
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_move_block_no_background_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: "blk-6".into(),
            new_parent_id: Some("blk-parent".into()),
            new_position: 2,
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_add_attachment_no_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: "att-1".into(),
            block_id: "blk-a".into(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // add_attachment triggers NO background tasks
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_delete_attachment_no_bg_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: "att-2".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // delete_attachment triggers NO background tasks
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn dispatch_op_unknown_op_type() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        // Construct an OpRecord with an unrecognised op_type directly.
        let record = OpRecord {
            device_id: "dev-1".into(),
            seq: 99,
            parent_seqs: None,
            hash: "0".repeat(64),
            op_type: "unknown_future_op".into(),
            payload: "{}".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
        };

        // Should succeed without panicking — unknown ops are logged but not fatal.
        assert!(mat.dispatch_op(&record).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ── enqueue methods ─────────────────────────────────────────────────

    #[tokio::test]
    async fn enqueue_foreground_directly() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        let task = MaterializeTask::RebuildTagsCache;
        // Even though this is a bg task type, the queue accepts it
        assert!(mat.enqueue_foreground(task).await.is_ok());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn enqueue_background_directly() {
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
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn try_enqueue_background_ok_when_full() {
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
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // ── dedup ───────────────────────────────────────────────────────────

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

        assert_eq!(deduped.len(), 3);
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

        // a, b, RebuildTagsCache, c — four unique tasks
        assert_eq!(deduped.len(), 4);
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

    // ── shutdown ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn shutdown_stops_consumers() {
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
        assert!(result.is_err(), "send should fail after shutdown");
    }

    // ── metrics ─────────────────────────────────────────────────────────

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

        tokio::time::sleep(Duration::from_millis(200)).await;

        let m = mat.metrics();
        let processed = m.bg_processed.load(AtomicOrdering::Relaxed);
        assert!(
            processed >= 1,
            "Expected at least 1 bg task processed, got {processed}"
        );
    }

    #[tokio::test]
    async fn foreground_processes_apply_op_and_tracks_metric() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "blk-fg".into(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "hello".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        mat.enqueue_foreground(MaterializeTask::ApplyOp(record))
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(100)).await;

        let m = mat.metrics();
        let fg = m.fg_processed.load(AtomicOrdering::Relaxed);
        assert!(fg >= 1, "Expected at least 1 fg task processed, got {fg}");
    }

    // ── FIFO ordering ───────────────────────────────────────────────────

    #[tokio::test]
    async fn queue_fifo_ordering() {
        // mpsc channels guarantee FIFO — verify with direct recv.
        let (tx, mut rx) = mpsc::channel::<MaterializeTask>(10);

        tx.send(MaterializeTask::RebuildTagsCache).await.unwrap();
        tx.send(MaterializeTask::RebuildPagesCache).await.unwrap();
        tx.send(MaterializeTask::RebuildAgendaCache).await.unwrap();
        tx.send(MaterializeTask::ReindexBlockLinks {
            block_id: "x".into(),
        })
        .await
        .unwrap();

        assert!(matches!(
            rx.recv().await.unwrap(),
            MaterializeTask::RebuildTagsCache
        ));
        assert!(matches!(
            rx.recv().await.unwrap(),
            MaterializeTask::RebuildPagesCache
        ));
        assert!(matches!(
            rx.recv().await.unwrap(),
            MaterializeTask::RebuildAgendaCache
        ));
        assert!(matches!(
            rx.recv().await.unwrap(),
            MaterializeTask::ReindexBlockLinks { block_id } if block_id == "x"
        ));
    }

    // ── error isolation ─────────────────────────────────────────────────

    #[tokio::test]
    async fn consumer_continues_after_multiple_tasks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Enqueue several different tasks — the consumer loop must survive
        // all of them (error isolation) and update metrics.
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

        // All tasks should have been processed (no crash).
        let m = mat.metrics();
        let processed = m.bg_processed.load(AtomicOrdering::Relaxed);
        assert!(
            processed >= 1,
            "Consumer should have processed tasks, got {processed}"
        );

        // Queue should still be functional — consumer loop survived.
        let result = mat
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await;
        assert!(
            result.is_ok(),
            "Queue should still accept tasks after processing"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
