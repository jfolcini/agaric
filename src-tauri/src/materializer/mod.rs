mod consumer;
mod coordinator;
mod dedup;
mod dispatch;
mod handlers;
mod metrics;
#[cfg(test)]
mod tests;
use crate::op_log::OpRecord;
#[cfg(test)]
use consumer::process_single_foreground_task;
pub use coordinator::Materializer;
#[cfg(test)]
use dedup::{dedup_tasks, group_tasks_by_block_id};
#[cfg(test)]
use handlers::{handle_background_task, handle_foreground_task};
pub use metrics::{QueueMetrics, StatusInfo};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum MaterializeTask {
    ApplyOp(OpRecord),
    BatchApplyOps(Vec<OpRecord>),
    RebuildTagsCache,
    RebuildPagesCache,
    RebuildAgendaCache,
    ReindexBlockLinks { block_id: String },
    UpdateFtsBlock { block_id: String },
    ReindexFtsReferences { block_id: String },
    RemoveFtsBlock { block_id: String },
    RebuildFtsIndex,
    FtsOptimize,
    CleanupOrphanedAttachments,
    RebuildTagInheritanceCache,
    RebuildProjectedAgendaCache,
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
