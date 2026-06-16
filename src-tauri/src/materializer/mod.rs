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
// #417/#432: the local command path (commands/blocks/*) maintains
// `pages_cache.{child_block_count,inbound_link_count}` in-tx for ops that
// do NOT enqueue a full `RebuildPagesCache` (notably content `create`),
// reusing the materializer's single source of truth for the two columns
// rather than duplicating the correlated-subquery SQL.
#[cfg(test)]
use dedup::dedup_tasks;
// #1257 PR-2: re-export the engine-apply-+-dense-projection helper so the
// LOCAL create_block command core (`domain::block_ops::create_block_in_tx`)
// can route a create through the engine IN-TRANSACTION without advancing the
// apply cursor.
pub(crate) use handlers::apply_create_block_via_loro;
// #1257 PR-3: re-export the simple-op engine helpers so the LOCAL command paths
// (edit_block / set_property / delete_property / add_tag / remove_tag) can route
// through the engine IN-TRANSACTION without advancing the apply cursor.
pub(crate) use handlers::recompute_pages_cache_counts_for_pages;
pub(crate) use handlers::{
    apply_add_tag_via_loro, apply_delete_property_via_loro, apply_edit_block_via_loro,
    apply_remove_tag_via_loro, apply_set_property_via_loro,
};
#[cfg(test)]
use handlers::{handle_background_task, handle_foreground_task};
pub use metrics::{QueueMetrics, StatusInfo};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum MaterializeTask {
    /// I-Materializer-3: the inner `OpRecord` is wrapped in an `Arc`
    /// so that cloning the task (e.g. for the foreground/background
    /// retry arms in `consumer.rs`) is a refcount bump rather than a
    /// deep clone of the record's owned `String` payloads. Pairs with
    /// the M-10 fix on `BatchApplyOps`.
    ApplyOp(Arc<OpRecord>),
    /// M-10: the inner `Vec<OpRecord>` is wrapped in an `Arc` so that
    /// cloning the task (e.g. for the foreground/background retry arms in
    /// `consumer.rs`) is a refcount bump rather than a deep clone of a
    /// potentially multi-thousand-op chunk during sync catch-up. Mobile
    /// (Android) RAM is constrained — the previous shape made every
    /// retry-prep clone proportional to batch size, even on the common
    /// no-retry path.
    BatchApplyOps(Arc<Vec<OpRecord>>),
    RebuildTagsCache,
    /// #676: incremental, single-tag refresh of `tags_cache.usage_count`
    /// after an `add_tag` / `remove_tag` op. Those ops mutate exactly one
    /// `(block_id, tag_id)` edge, so only the affected tag's `usage_count`
    /// can change — neither its name nor the set of cached tags can move.
    /// Recomputing just this one row (via
    /// [`crate::cache::refresh_tag_usage_count`]) replaces the former full
    /// O(vault) `RebuildTagsCache` enqueue on every tag click.
    RefreshTagUsageCount {
        tag_id: Arc<str>,
    },
    RebuildPagesCache,
    /// #417: full-table recompute of `pages_cache.{inbound_link_count,
    /// child_block_count}`. Enqueued ONLY on the snapshot/sync RESET path
    /// (after `RebuildPagesCache` re-inserts the page rows), where the
    /// wipe leaves both count columns at DEFAULT 0. Ordinary per-op page
    /// mutations maintain these counts in-tx (sync `ApplyOp` and the local
    /// command paths) and therefore do NOT enqueue this task — that is the
    /// whole point of #417 (the count UPDATE used to run unconditionally on
    /// every `RebuildPagesCache`, i.e. O(pages) correlated subqueries on
    /// every page edit).
    RebuildPagesCacheCounts,
    RebuildAgendaCache,
    ReindexBlockLinks {
        block_id: Arc<str>,
    },
    /// UX-250: incremental reindex of `block_tag_refs` for a single
    /// block after a content mutation. Mirrors `ReindexBlockLinks`.
    ReindexBlockTagRefs {
        block_id: Arc<str>,
    },
    UpdateFtsBlock {
        block_id: Arc<str>,
    },
    ReindexFtsReferences {
        block_id: Arc<str>,
    },
    RemoveFtsBlock {
        block_id: Arc<str>,
    },
    RebuildFtsIndex,
    FtsOptimize,
    CleanupOrphanedAttachments,
    RebuildTagInheritanceCache,
    RebuildProjectedAgendaCache,
    RebuildPageIds,
    /// Incremental `page_id` maintenance for a single newly created block.
    /// The new block has no descendants; its `page_id` is simply its parent's
    /// `page_id`. Avoids the full O(N) recursive-CTE rebuild on `create_block`.
    SetBlockPageId {
        block_id: Arc<str>,
    },
    /// UX-250: full-vault recompute of `block_tag_refs`. Fires on
    /// delete / restore / purge and from `apply_snapshot` / boot-time
    /// "table is empty" fallback.
    RebuildBlockTagRefsCache,
    /// SQL-review §H-2: full-vault recompute of `page_link_cache`
    /// (the page-level roll-up of `block_links`). Fires on delete /
    /// restore / purge and from `apply_snapshot` / boot-time "table
    /// is empty" fallback. Per-content-edit invalidation rolls up
    /// inside the [`ReindexBlockLinks`] handler.
    RebuildPageLinkCache,
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

/// #676: minimal projection of an `add_tag` / `remove_tag` payload —
/// just the `tag_id` needed to scope the incremental
/// [`MaterializeTask::RefreshTagUsageCount`] enqueue. Both
/// `AddTagPayload` and `RemoveTagPayload` (op.rs) carry
/// `{ block_id, tag_id }`; only `tag_id` is read here.
#[derive(Deserialize)]
pub(super) struct TagOpHint {
    #[serde(default)]
    pub(super) tag_id: String,
}

// L-13 (2026-04): the former `BlockIdHint` type was used by
// `dispatch::enqueue_background_tasks` to deserialise just `block_id`
// from `record.payload` for the edit/delete/restore/purge arms. Those
// sites now read from the cached `OpRecord::block_id` sidecar
// (populated at append-time / sync ingress) so the type became
// completely unused and was deleted along with the dispatch parse.
// `CreateBlockHint` survives because the `create_block` arm also needs
// `block_type` (tag vs. page vs. content); caching that on `OpRecord`
// would be a larger sidecar than L-13's `block_id`-only scope.
