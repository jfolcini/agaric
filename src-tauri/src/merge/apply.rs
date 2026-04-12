use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::ulid::BlockId;

use super::detect::merge_text;
use super::resolve::create_conflict_copy;
use super::types::{MergeOutcome, MergeResult};

/// High-level merge orchestrator for a single block.
///
/// 1. If heads are identical, returns `AlreadyUpToDate`.
/// 2. Calls `merge_text()` for three-way merge.
/// 3. On clean merge: creates an `edit_block` op via `dag::append_merge_op`.
/// 4. On conflict: creates a conflict copy with "theirs" content, then
///    creates a merge op on the original to unify the DAG and preserve
///    the local ("ours") content in-place (user's edits are retained).
///
/// **TODO (F04):** This orchestrator handles **text** conflicts only.
/// `resolve_property_conflict` (LWW) exists but is not called here — the
/// sync orchestrator (not yet implemented) must iterate concurrent
/// `set_property` ops per block and call `resolve_property_conflict` for
/// each conflicting `(block_id, key)` pair.
pub async fn merge_block(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    our_head: &(String, i64),
    their_head: &(String, i64),
) -> Result<MergeOutcome, AppError> {
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

            Ok(MergeOutcome::Merged(record))
        }
        MergeResult::Conflict {
            ours,
            theirs,
            ancestor: _,
        } => {
            // 4. Create conflict copy with "theirs" content
            let conflict_op =
                create_conflict_copy(pool, device_id, block_id, &theirs, "Text").await?;

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

            Ok(MergeOutcome::ConflictCopy {
                original_kept_ours: true,
                conflict_block_op: conflict_op,
            })
        }
    }
}
