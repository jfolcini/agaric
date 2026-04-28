use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::ulid::BlockId;

use super::detect::merge_text;
use super::resolve::create_conflict_copy_with_reindex;
use super::types::{MergeOutcome, MergeResult};

/// Three-way **text-only** merge orchestrator for a single block's
/// `edit_block` history.
///
/// **Scope (what this function does):**
/// 1. If heads are identical, returns `AlreadyUpToDate`.
/// 2. Calls `merge_text()` for three-way text merge of block content.
/// 3. On clean merge: creates an `edit_block` op via `dag::append_merge_op`.
/// 4. On conflict: creates a conflict copy with "theirs" content, then
///    creates a merge op on the original to unify the DAG and preserve
///    the local ("ours") content in-place (user's edits are retained).
///
/// **Limitations (what this function does NOT do):**
/// - **Property conflicts** (`set_property` LWW) are NOT resolved here.
///   `resolve_property_conflict` must be invoked separately by the caller
///   for each concurrent `(block_id, key)` pair. See
///   `sync_protocol::operations::merge_diverged_blocks` for the
///   property-LWW pass that complements this function.
/// - **Move conflicts** (concurrent `move_block` on the same block) are
///   NOT resolved here. The caller must apply move LWW separately.
/// - **Delete vs. edit** resurrection (one device deleted while the other
///   edited) is NOT handled here. The caller must detect and emit a
///   `restore_block` op separately.
///
/// A future caller that treats this as a complete three-way merge will
/// silently drop property/move/delete conflicts. The name
/// `merge_block_text_only` is deliberate: any caller wiring up a new
/// merge entry point must explicitly compose the text pass with the
/// property/move/delete-resurrect passes (see `merge_diverged_blocks`
/// for the canonical composition).
pub async fn merge_block_text_only(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &crate::materializer::Materializer,
    block_id: &str,
    our_head: &(String, i64),
    their_head: &(String, i64),
) -> Result<MergeOutcome, AppError> {
    tracing::debug!(block_id, "merge_block_text_only invoked");

    // 1. Already up to date?
    if our_head == their_head {
        return Ok(MergeOutcome::AlreadyUpToDate);
    }

    // 2. Three-way merge
    let result = merge_text(pool, block_id, our_head, their_head).await?;

    match result {
        MergeResult::Clean(merged) => {
            // 3. Create edit_block op with merged text
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: merged,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            tracing::info!(block_id, "merge completed — clean merge applied");
            Ok(MergeOutcome::Merged(record))
        }
        MergeResult::Conflict {
            ours,
            theirs,
            ancestor: _,
        } => {
            // 4. Create conflict copy with "theirs" content. Uses the
            //    `_with_reindex` variant (M-74) so the new block's
            //    `[[ULID]]` / `#[ULID]` references are picked up by the
            //    backlinks/tags caches without waiting for the
            //    materializer's periodic re-index cycle.
            let conflict_op = create_conflict_copy_with_reindex(
                pool,
                device_id,
                materializer,
                block_id,
                &theirs,
                "Text",
            )
            .await?;

            // 5. Create a merge op on the ORIGINAL block to unify the two
            //    divergent heads in the DAG.  The original block retains the
            //    local ("ours") content so the user's own edits are preserved
            //    in-place.  Without this merge op the two heads would remain
            //    unresolved and `get_block_edit_heads` would re-detect
            //    divergence on the next sync, potentially creating duplicate
            //    conflict copies.                             (fixes F01+F02)
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: ours,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let _merge_record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            tracing::warn!(block_id, "merge completed — conflict copy created");
            Ok(MergeOutcome::ConflictCopy {
                conflict_block_op: conflict_op,
            })
        }
    }
}
