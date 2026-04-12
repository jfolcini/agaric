//! Dispatch methods for routing ops to the appropriate materializer queues.

use super::coordinator::Materializer;
use super::{BlockIdHint, CreateBlockHint, MaterializeTask};
use crate::error::AppError;
use crate::op_log::OpRecord;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;

impl Materializer {
    pub(super) fn fg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        self.fg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| AppError::Channel("foreground queue closed".into()))
    }

    pub(super) fn bg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        self.bg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| AppError::Channel("background queue closed".into()))
    }

    pub fn dispatch_background(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, None)
    }

    pub fn dispatch_edit_background(
        &self,
        record: &OpRecord,
        block_type: &str,
    ) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, Some(block_type))
    }

    pub async fn dispatch_op(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_foreground(MaterializeTask::ApplyOp(record.clone()))
            .await?;
        self.enqueue_background_tasks(record, None)
    }

    fn enqueue_background_tasks(
        &self,
        record: &OpRecord,
        block_type_hint: Option<&str>,
    ) -> Result<(), AppError> {
        match record.op_type.as_str() {
            "create_block" => {
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
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
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
                match block_type_hint {
                    Some("tag") => {
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                        if !hint.block_id.is_empty() {
                            self.try_enqueue_background(MaterializeTask::ReindexFtsReferences {
                                block_id: hint.block_id.clone(),
                            })?;
                        }
                    }
                    Some("page") => {
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                        if !hint.block_id.is_empty() {
                            self.try_enqueue_background(MaterializeTask::ReindexFtsReferences {
                                block_id: hint.block_id.clone(),
                            })?;
                        }
                    }
                    Some("content") => {}
                    _ => {
                        self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                        self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                        self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                    }
                }
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
                let edits = self
                    .metrics
                    .fts_edits_since_optimize
                    .fetch_add(1, Ordering::Relaxed)
                    + 1;
                // Millis since epoch won't exceed u64 for millions of years
                #[allow(clippy::cast_possible_truncation)]
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let last_ms = self.metrics.fts_last_optimize_ms.load(Ordering::Relaxed);
                let elapsed_ms = now_ms.saturating_sub(last_ms);
                if (edits >= 500 || elapsed_ms >= 3_600_000)
                    && self
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
            "delete_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPagesCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
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
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::RemoveFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "add_tag" | "remove_tag" => {
                self.try_enqueue_background(MaterializeTask::RebuildTagsCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
            }
            "set_property" | "delete_property" => {
                self.try_enqueue_background(MaterializeTask::RebuildAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
            }
            "move_block" => {
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
            }
            "add_attachment" | "delete_attachment" => {}
            other => {
                tracing::warn!(op_type = other, "unknown op_type in dispatch_op");
            }
        }
        Ok(())
    }
}
