mod consumer;
mod coordinator;
mod dedup;
mod dispatch;
mod handlers;
mod metrics;
pub mod retry_queue;
#[cfg(test)]
mod tests;
use crate::op_log::OpRecord;
#[cfg(test)]
use consumer::process_single_foreground_task;
pub use coordinator::Materializer;
#[cfg(test)]
use dedup::dedup_tasks;
#[cfg(test)]
use handlers::{handle_background_task, handle_foreground_task};
pub use metrics::{QueueMetrics, StatusInfo};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum MaterializeTask {
    ApplyOp(OpRecord),
    /// M-10: the inner `Vec<OpRecord>` is wrapped in an `Arc` so that
    /// cloning the task (e.g. for the foreground/background retry arms in
    /// `consumer.rs`) is a refcount bump rather than a deep clone of a
    /// potentially multi-thousand-op chunk during sync catch-up. Mobile
    /// (Android) RAM is constrained — the previous shape made every
    /// retry-prep clone proportional to batch size, even on the common
    /// no-retry path.
    BatchApplyOps(Arc<Vec<OpRecord>>),
    RebuildTagsCache,
    RebuildPagesCache,
    RebuildAgendaCache,
    ReindexBlockLinks {
        block_id: String,
    },
    /// UX-250: incremental reindex of `block_tag_refs` for a single
    /// block after a content mutation. Mirrors `ReindexBlockLinks`.
    ReindexBlockTagRefs {
        block_id: String,
    },
    UpdateFtsBlock {
        block_id: String,
    },
    ReindexFtsReferences {
        block_id: String,
    },
    RemoveFtsBlock {
        block_id: String,
    },
    RebuildFtsIndex,
    FtsOptimize,
    CleanupOrphanedAttachments,
    RebuildTagInheritanceCache,
    RebuildProjectedAgendaCache,
    RebuildPageIds,
    /// UX-250: full-vault recompute of `block_tag_refs`. Fires on
    /// delete / restore / purge and from `apply_snapshot` / boot-time
    /// "table is empty" fallback.
    RebuildBlockTagRefsCache,
    Barrier(Arc<tokio::sync::Notify>),
}

const FOREGROUND_CAPACITY: usize = 256;
const BACKGROUND_CAPACITY: usize = 1024;
const QUEUE_PRESSURE_NUMERATOR: usize = 3;
const QUEUE_PRESSURE_DENOMINATOR: usize = 4;

#[derive(Deserialize)]
struct CreateBlockHint {
    #[serde(default)]
    block_id: String,
    #[serde(default)]
    block_type: String,
}

#[derive(Deserialize)]
struct BlockIdHint {
    #[serde(default)]
    block_id: String,
}
