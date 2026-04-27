//! Dispatch methods for routing ops to the appropriate materializer queues.

use super::coordinator::Materializer;
use super::{BlockIdHint, CreateBlockHint, MaterializeTask};
use crate::error::AppError;
use crate::op_log::OpRecord;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;

/// Fixed set of rebuild tasks enqueued after any `delete_block` /
/// `restore_block` / `purge_block` op, in their canonical order.
///
/// Exposed at module scope so tests can assert the exact sequence and so
/// `enqueue_full_cache_rebuild` has a single source of truth to iterate.
/// Adding a new block-referencing cache should only require appending to
/// this array — the three dispatch arms pick up the change automatically.
pub(super) const FULL_CACHE_REBUILD_TASKS: [MaterializeTask; 7] = [
    MaterializeTask::RebuildTagsCache,
    MaterializeTask::RebuildPagesCache,
    MaterializeTask::RebuildAgendaCache,
    MaterializeTask::RebuildProjectedAgendaCache,
    MaterializeTask::RebuildTagInheritanceCache,
    MaterializeTask::RebuildPageIds,
    // UX-250: inline `#[ULID]` references may disappear when a block
    // (or a subtree containing referencing blocks) is deleted; the
    // full recompute picks that up on the same queue drain as the
    // other caches.
    MaterializeTask::RebuildBlockTagRefsCache,
];

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

    /// Dispatch background cache rebuild tasks for `record`, logging a `warn`
    /// on failure instead of propagating the error.
    ///
    /// Centralises the 17+ identical call sites across `commands/**` that all
    /// fire-and-forget background work after a successful op-log append. The
    /// convention is deliberate: background task enqueue failures (queue
    /// closed, serialization failure) should not unwind the command handler
    /// because the op itself has already been durably written to the op log.
    /// Callers that need propagation should use [`dispatch_background`]
    /// directly.
    pub fn dispatch_background_or_warn(&self, record: &OpRecord) {
        if let Err(e) = self.dispatch_background(record) {
            tracing::warn!(
                op_type = %record.op_type,
                seq = record.seq,
                device_id = %record.device_id,
                error = %e,
                "failed to dispatch background cache task"
            );
        }
    }

    pub fn dispatch_edit_background(
        &self,
        record: &OpRecord,
        block_type: &str,
    ) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, Some(block_type))
    }

    /// Enqueue the full cache-rebuild fan-out that every block-structure
    /// mutation (`delete_block` / `restore_block` / `purge_block`) triggers.
    ///
    /// Any of these ops can invalidate every block-referencing cache
    /// simultaneously, so the three dispatch arms enqueue an identical set
    /// of rebuild tasks. Centralising the list here means adding a future
    /// cache only requires one edit, not three, and the materializer's
    /// dedup layer collapses duplicates across consecutive mutations.
    ///
    /// Order is fixed by [`FULL_CACHE_REBUILD_TASKS`] so tests can assert
    /// the exact sequence against `BackgroundQueue::inspect()` / metrics.
    pub(super) fn enqueue_full_cache_rebuild(&self) -> Result<(), AppError> {
        for task in FULL_CACHE_REBUILD_TASKS {
            self.try_enqueue_background(task.clone())?;
        }
        Ok(())
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
                        block_id: hint.block_id.clone(),
                    })?;
                    // UX-250: a freshly created block can already contain
                    // inline `#[ULID]` tag refs if the creator passed
                    // non-empty content (imports, paste, programmatic
                    // creates). Scan for them.
                    self.try_enqueue_background(MaterializeTask::ReindexBlockTagRefs {
                        block_id: hint.block_id,
                    })?;
                }
                self.try_enqueue_background(MaterializeTask::RebuildTagInheritanceCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)?;
                self.try_enqueue_background(MaterializeTask::RebuildPageIds)?;
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
                    // UX-250: reindex inline tag refs regardless of
                    // `block_type_hint` — every content edit may gain or
                    // lose `#[ULID]` tokens. Tag/page blocks typically
                    // don't contain inline refs themselves but the cost
                    // of scanning an empty diff is negligible vs. the
                    // correctness risk of skipping.
                    self.try_enqueue_background(MaterializeTask::ReindexBlockTagRefs {
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
                // Millis since epoch fits in u64 for millions of years; saturate on overflow.
                let now_ms = u64::try_from(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                )
                .unwrap_or(u64::MAX);
                let last_ms = self.metrics.fts_last_optimize_ms.load(Ordering::Relaxed);
                let elapsed_ms = now_ms.saturating_sub(last_ms);
                let block_count = self.metrics.cached_block_count.load(Ordering::Relaxed);
                let threshold = std::cmp::max(500, block_count / 10_000);
                if (edits >= threshold || elapsed_ms >= 3_600_000)
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
                    self.refresh_block_count_cache();
                }
            }
            "delete_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.enqueue_full_cache_rebuild()?;
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::RemoveFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "restore_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.enqueue_full_cache_rebuild()?;
                if !hint.block_id.is_empty() {
                    self.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
                        block_id: hint.block_id,
                    })?;
                }
            }
            "purge_block" => {
                let hint: BlockIdHint = serde_json::from_str(&record.payload)?;
                self.enqueue_full_cache_rebuild()?;
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
                self.try_enqueue_background(MaterializeTask::RebuildPageIds)?;
            }
            "add_attachment" | "delete_attachment" => {}
            other => {
                tracing::warn!(
                    op_type = other,
                    device_id = %record.device_id,
                    seq = record.seq,
                    "unknown op_type in dispatch_op"
                );
            }
        }
        Ok(())
    }
}
