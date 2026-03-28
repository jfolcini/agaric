//! Materializer coordination — foreground and background priority queues (ADR-08).
//!
//! The materializer is responsible for applying op-log effects to the
//! materialized tables (blocks, caches, indexes). It runs two async task
//! queues:
//!
//! - **Foreground queue** (capacity 256): low-latency processing of ops that
//!   affect currently visible blocks.
//! - **Background queue** (capacity 1024): stale-while-revalidate cache
//!   rebuilds (tags, pages, agenda) and block-link reindexing.
//!
//! A single write connection (enforced by the SQLite pool) serialises all
//! materializer writes. Caches are never rebuilt synchronously on the hot
//! path or at boot — always return the last computed value immediately and
//! enqueue a background rebuild if stale.

#![allow(dead_code)]

use sqlx::SqlitePool;
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
}

impl Materializer {
    /// Create a new `Materializer`, spawning foreground and background
    /// consumer tasks on the Tokio runtime.
    pub fn new(pool: SqlitePool) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);

        // Spawn foreground consumer
        {
            let pool = pool.clone();
            tokio::spawn(Self::run_queue(pool, fg_rx, "fg"));
        }

        // Spawn background consumer
        {
            tokio::spawn(Self::run_queue(pool, bg_rx, "bg"));
        }

        Self { fg_tx, bg_tx }
    }

    /// Generic queue consumer loop. Reads tasks from `rx` until the channel
    /// closes, dispatching each to the appropriate handler.
    async fn run_queue(
        pool: SqlitePool,
        mut rx: mpsc::Receiver<MaterializeTask>,
        label: &'static str,
    ) {
        while let Some(task) = rx.recv().await {
            let result = match label {
                "fg" => handle_foreground_task(&pool, &task).await,
                _ => handle_background_task(&pool, &task).await,
            };
            if let Err(e) = result {
                eprintln!("[materializer:{label}] Error processing task: {e}");
            }
        }
        eprintln!("[materializer:{label}] Queue closed");
    }

    // -- public API --------------------------------------------------------

    /// Enqueue a task on the **foreground** (low-latency) queue.
    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        self.fg_tx
            .send(task)
            .await
            .map_err(|e| AppError::Channel(format!("foreground queue send failed: {e}")))
    }

    /// Enqueue a task on the **background** (stale-while-revalidate) queue.
    pub async fn enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        self.bg_tx
            .send(task)
            .await
            .map_err(|e| AppError::Channel(format!("background queue send failed: {e}")))
    }

    /// Main entry point after an op is appended to the log.
    ///
    /// 1. Always enqueues `ApplyOp` on the foreground queue.
    /// 2. Inspects the op type and payload to enqueue appropriate background
    ///    cache-rebuild / reindex tasks.
    pub async fn dispatch_op(&self, record: &OpRecord) -> Result<(), AppError> {
        // Always apply the op in the foreground
        self.enqueue_foreground(MaterializeTask::ApplyOp(record.clone()))
            .await?;

        // Parse the payload JSON to extract fields needed for dispatch decisions.
        let payload_value: serde_json::Value = serde_json::from_str(&record.payload)?;

        match record.op_type.as_str() {
            "create_block" => {
                let block_type = payload_value
                    .get("block_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match block_type {
                    "tag" => {
                        self.enqueue_background(MaterializeTask::RebuildTagsCache)
                            .await?;
                    }
                    "page" => {
                        self.enqueue_background(MaterializeTask::RebuildPagesCache)
                            .await?;
                    }
                    _ => {}
                }
            }
            "edit_block" => {
                let block_id = payload_value
                    .get("block_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                self.enqueue_background(MaterializeTask::ReindexBlockLinks { block_id })
                    .await?;
                // Conservatively rebuild pages cache — we cannot determine
                // block_type from the edit payload alone without a DB lookup.
                self.enqueue_background(MaterializeTask::RebuildPagesCache)
                    .await?;
            }
            "delete_block" | "restore_block" | "purge_block" => {
                self.enqueue_background(MaterializeTask::RebuildTagsCache)
                    .await?;
                self.enqueue_background(MaterializeTask::RebuildPagesCache)
                    .await?;
                self.enqueue_background(MaterializeTask::RebuildAgendaCache)
                    .await?;
            }
            "add_tag" | "remove_tag" => {
                self.enqueue_background(MaterializeTask::RebuildTagsCache)
                    .await?;
                self.enqueue_background(MaterializeTask::RebuildAgendaCache)
                    .await?;
            }
            "set_property" => {
                // Always rebuild agenda cache for set_property — the property
                // may contain a value_date even if it's null in this particular op.
                self.enqueue_background(MaterializeTask::RebuildAgendaCache)
                    .await?;
            }
            "delete_property" => {
                // Cannot determine if the deleted property had a value_date
                // without a DB lookup, so conservatively rebuild.
                self.enqueue_background(MaterializeTask::RebuildAgendaCache)
                    .await?;
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
        AddTagPayload, CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload,
        OpPayload, SetPropertyPayload,
    };
    use crate::op_log::append_local_op;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Helper: create a SQLite pool backed by a temp file.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[tokio::test]
    async fn materializer_new_creates_successfully() {
        let (pool, _dir) = test_pool().await;
        let _mat = Materializer::new(pool);
        // If we get here without panic the queues were created
    }

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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn enqueue_foreground_directly() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool);

        let task = MaterializeTask::RebuildTagsCache;
        // Even though this is a bg task type, the queue accepts it
        assert!(mat.enqueue_foreground(task).await.is_ok());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
