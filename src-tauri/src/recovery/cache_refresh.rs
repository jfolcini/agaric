//! Post-recovery cache refresh (BUG-23).
//!
//! [`recover_at_boot`] appends synthetic `edit_block` ops and updates
//! `blocks.content` directly, but runs **before** the materializer is
//! created (see [`crate::recovery`] module docs for the F04 design note).
//! That leaves FTS / `block_links` / tags / pages caches stale for the
//! recovered blocks until some later event causes re-materialization.
//!
//! This module exposes [`refresh_caches_for_recovered_drafts`] which the
//! boot sequence calls **after** the materializer is created. It enqueues
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

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// Refresh caches affected by recovered drafts, then block until the
/// materializer background queue drains so consumers never observe stale
/// state.
///
/// This is a no-op when `recovered_block_ids` is empty.
pub async fn refresh_caches_for_recovered_drafts(
    materializer: &Materializer,
    recovered_block_ids: &[String],
) -> Result<(), AppError> {
    if recovered_block_ids.is_empty() {
        return Ok(());
    }

    for block_id in recovered_block_ids {
        materializer
            .enqueue_background(MaterializeTask::UpdateFtsBlock {
                block_id: block_id.clone(),
            })
            .await?;
        materializer
            .enqueue_background(MaterializeTask::ReindexBlockLinks {
                block_id: block_id.clone(),
            })
            .await?;
    }

    // A recovered edit may have rewritten the text of a tag or page block.
    // We cannot tell from the block_id alone, so refresh both caches. Both
    // tasks are idempotent and inexpensive; they'll be dedup'd by the
    // background consumer when coalesced with other boot-time rebuilds.
    materializer
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await?;
    materializer
        .enqueue_background(MaterializeTask::RebuildPagesCache)
        .await?;

    // Block until all enqueued background tasks (plus anything ahead of us
    // in the queue) have been processed — this closes the stale-cache
    // window that BUG-23 was reporting.
    materializer.flush_background().await?;

    Ok(())
}
