//! Post-recovery cache refresh (BUG-23).
//!
//! [`recover_at_boot`] appends synthetic `edit_block` ops and updates
//! `blocks.content` directly without driving them through the
//! materializer's `UpdateFtsBlock` / `ReindexBlockLinks` paths. That
//! leaves FTS / `block_links` / tags / pages caches stale for the
//! recovered blocks until some later event causes re-materialization.
//!
//! (Pre-C-2b the materializer was constructed AFTER recovery, so this
//! step also covered "no materializer existed during recovery". As of
//! C-2b the materializer is built before `recover_at_boot` so the
//! foreground queue can carry replayed `ApplyOp` tasks; the
//! cache-refresh step still runs after recovery because draft recovery
//! goes through `append_local_op` rather than the materializer.)
//!
//! This module exposes [`refresh_caches_for_recovered_drafts`] which the
//! boot sequence calls **after** `recover_at_boot` returns. It enqueues
//! targeted cache-update tasks (`UpdateFtsBlock`, `ReindexBlockLinks`)
//! for each recovered block and rebuilds the tags/pages caches (in case
//! a recovered edit touched a tag or page block), then awaits a barrier
//! so the caller (lib.rs / tests) never observes stale caches.
//!
//! The cache-update tasks are idempotent and dedup'd by the materializer
//! (see `materializer::dedup`), so calling this with an empty list or with
//! duplicate block_ids is safe.
//!
//! [`recover_at_boot`]: super::recover_at_boot

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// Refresh caches affected by recovered drafts, then block until the
/// materializer background queue drains so consumers never observe stale
/// state.
///
/// `pool` is the reader pool used for the I-Lifecycle-5 gate query that
/// decides whether the global tag/page cache rebuilds need to fire (the
/// query only reads from `blocks`, so the read pool is the correct
/// choice — it must not contend with the materializer's write pool).
///
/// This is a no-op when `recovered_block_ids` is empty.
pub async fn refresh_caches_for_recovered_drafts(
    pool: &SqlitePool,
    materializer: &Materializer,
    recovered_block_ids: &[String],
) -> Result<(), AppError> {
    if recovered_block_ids.is_empty() {
        return Ok(());
    }

    for block_id in recovered_block_ids {
        let block_id: std::sync::Arc<str> = std::sync::Arc::from(block_id.as_str());
        materializer
            .enqueue_background(MaterializeTask::UpdateFtsBlock {
                block_id: std::sync::Arc::clone(&block_id),
            })
            .await?;
        materializer
            .enqueue_background(MaterializeTask::ReindexBlockLinks { block_id })
            .await?;
    }

    // I-Lifecycle-5: gate the tag/page cache rebuilds on whether any
    // recovered block actually touches a tag or page block. Materializer
    // dedup collapses repeated calls but doesn't skip the enqueue + Tokio
    // task spawn cost; for recovered drafts that only touched content
    // blocks, both rebuilds are pure waste (full O(N) scans of `blocks`).
    //
    // Use `json_each` over a JSON array of the recovered IDs so the IN
    // clause works for any batch size without per-row binding. This
    // matches the batch-resolve pattern in `fts.rs` / `backlink/query.rs`
    // (see AGENTS.md anti-pattern #1: avoid N+1 query loops).
    let block_ids_json = serde_json::to_string(recovered_block_ids)?;
    let needs_rebuild: Option<i64> = sqlx::query_scalar!(
        "SELECT 1 \
         FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?)) \
           AND block_type IN ('tag', 'page') \
         LIMIT 1",
        block_ids_json,
    )
    .fetch_optional(pool)
    .await?;

    if needs_rebuild.is_some() {
        materializer
            .enqueue_background(MaterializeTask::RebuildTagsCache)
            .await?;
        materializer
            .enqueue_background(MaterializeTask::RebuildPagesCache)
            .await?;
    }

    // Block until all enqueued background tasks (plus anything ahead of us
    // in the queue) have been processed — this closes the stale-cache
    // window that BUG-23 was reporting.
    materializer.flush_background().await?;

    Ok(())
}
