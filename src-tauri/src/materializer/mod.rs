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
// #2344: the LOCAL create_block command core
// (`domain::block_ops::create_block_in_tx`) joined the #2325 apply-path
// collapse — it now routes through `apply_op_projected`, so the
// `apply_create_block_via_loro` re-export was dropped from here (the Create arm
// of `apply_op_tx` and the reproject proptest still reach the helper via its
// own module path within `handlers`).
// #2128 test-only: surface the LOCAL SQL purge cascade so the inbound-purge
// parity test (`sync_protocol::tests`) can build a local-purge oracle DB.
#[cfg(test)]
pub(crate) use handlers::purge_block_sql_cascade;
// #1257 re-export the simple-op engine helpers so the LOCAL command paths
// (edit_block / set_property / delete_property / add_tag / remove_tag) can route
// through the engine IN-TRANSACTION without advancing the apply cursor.
// #2344: MoveBlock joined the collapse — `move_block_in_tx` now routes through
// `apply_op_projected` (the FINAL single-op slice), so the
// `apply_move_block_via_loro` re-export was likewise dropped (the Move arm of
// `apply_op_tx` and the convergence/reproject proptests still reach the helper
// via its own module path within `handlers`).
// #1257 re-export the cohort collectors + the post-commit descendant
// fan-out so the LOCAL delete / restore command paths (`commands::blocks::crud`)
// PRE-CAPTURE each root's subtree cohort + space BEFORE the SQL soft-delete (a
// post-delete `resolve_block_space` returns None — the #1257 phantom) and then
// drive the captured cohort onto the per-space Loro engine post-commit, using
// the SAME engine apply the boot-replay / sync `ApplyOp` path uses. The apply
// cursor is never advanced (boot-replay / `dispatch_op` concern). The
// `apply_*_via_loro` CASCADE helpers' visibility is also raised to `pub(crate)`
// (re-exported via `handlers::mod`) to complete the engine-apply surface
// established and which `merge::engine_apply` mirrors; the multi-root command
// path drives the engine through the fan-out + `engine_apply` rather than the
// per-seed in-tx helper (the helper's single-root SQL projection would
// double-count the multi-root cascade, and a post-cascade call hits dead space
// resolution — the pre-captured space sidesteps both).
// #2325/#2250: the AddTag / RemoveTag / SetProperty / DeleteProperty LOCAL
// command sites no longer call `apply_*_via_loro` directly — they route through
// `apply_op_projected` — so those four re-exports were dropped from here.
// #2344: EditBlock joined the collapse — `edit_block_inner` now routes through
// `apply_op_projected` too, so the `apply_edit_block_via_loro` re-export was
// likewise dropped (the Edit arm of `apply_op_tx` and the convergence proptest
// still reach the helper via its own module path within `handlers`).
pub(crate) use handlers::{
    collect_delete_cohort, collect_restore_cohort, dispatch_delete_descendants,
    dispatch_restore_descendants,
};
// #2325/#2250: the single collapsed apply-projection entry point the LOCAL
// command sites route through (`advance_cursor = false`).
pub(crate) use handlers::apply_op_projected;
#[cfg(test)]
use handlers::{handle_background_task, handle_foreground_task};
// #1993: re-exported test-only so command-level tests can drive the GC pass
// (delete defers byte reclamation to it). Non-test code reaches it within the
// materializer module via `handlers::cleanup_orphaned_attachments`.
#[cfg(test)]
pub(crate) use handlers::cleanup_orphaned_attachments;
// Re-export the two process-global materializer counter accessors
// so the OTel metrics pipeline (`observability::metrics`) can surface them as
// observable counters WITHOUT reaching into the private `handlers` module or
// touching the underlying statics directly. Each is a thin getter over a
// monotonic `AtomicU64` (relaxed load); the metrics callback reads it on each
// collection cycle. PII-safe by construction (opaque counts only).
pub(crate) use handlers::{descendant_fanout_dropped_count, sql_only_fallback_count};
pub use metrics::{QueueMetrics, StatusInfo};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum MaterializeTask {
    /// I-Materializer-3: the inner `OpRecord` is wrapped in an `Arc`
    /// so that cloning the task (e.g. for the foreground/background
    /// retry arms in `consumer.rs`) is a refcount bump rather than a
    /// deep clone of the record's owned `String` payloads. Pairs with
    /// The fix on `BatchApplyOps`.
    ApplyOp(Arc<OpRecord>),
    /// The inner `Vec<OpRecord>` is wrapped in an `Arc` so that
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
    /// [`crate::cache::refresh_tag_usage_count`]) avoids a full O(vault)
    /// `RebuildTagsCache` enqueue on every tag click.
    RefreshTagUsageCount {
        tag_id: Arc<str>,
    },
    RebuildPagesCache,
    /// #417: full-table recompute of `pages_cache.{inbound_link_count,
    /// child_block_count}`. Enqueued ONLY on the snapshot/sync RESET path
    /// (after `RebuildPagesCache` re-inserts the page rows), where the
    /// wipe leaves both count columns at DEFAULT 0. Ordinary per-op page
    /// mutations maintain these counts in-tx (sync `ApplyOp` and the local
    /// command paths) and therefore do NOT enqueue this task — running the
    /// count UPDATE unconditionally would cost O(pages) correlated
    /// subqueries on every page edit (#417).
    RebuildPagesCacheCounts,
    RebuildAgendaCache,
    ReindexBlockLinks {
        block_id: Arc<str>,
    },
    /// Incremental reindex of `block_tag_refs` for a single
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
    /// Full-vault recompute of `block_tag_refs`. Fires on
    /// delete / restore / purge and from `apply_snapshot` / boot-time
    /// "table is empty" fallback.
    RebuildBlockTagRefsCache,
    /// Full-vault recompute of `page_link_cache`
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

// `dispatch::enqueue_background_tasks` reads `block_id` for the
// edit/delete/restore/purge arms straight from the cached
// `OpRecord::block_id` sidecar (populated at append-time / sync ingress)
// rather than re-parsing `record.payload`. `CreateBlockHint` still exists
// because the `create_block` arm also needs `block_type` (tag vs. page vs.
// content), which the sidecar doesn't carry.
