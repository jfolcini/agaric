use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::op_log;

use super::types::MergeResult;

/// Maximum number of iterations when walking prev_edit chains.
/// Prevents infinite loops on corrupted cyclic data.           (F07)
pub(crate) const MAX_CHAIN_WALK_ITERATIONS: usize = 1_000;

/// Three-way text merge for a block's content.
///
/// 1. Finds the LCA of `op_ours` and `op_theirs` via `dag::find_lca`.
/// 2. Extracts text at ancestor, ours, and theirs via `dag::text_at`.
/// 3. If no LCA is found (both trace to same `create_block` root), walks
///    back to find the `create_block` and uses its content as ancestor.
/// 4. Calls `diffy::merge` for a **line-level** three-way merge.
///
/// **Important:** `diffy::merge` operates at line-level granularity (splits
/// on `\n` boundaries), *not* word-level.  Because auto-split on blur turns
/// each paragraph into its own block, most blocks contain a single line.
/// Any concurrent edit to a single-line block will therefore produce a
/// conflict, even if the changes affect different words.  (See F03.)
pub async fn merge_text(
    pool: &SqlitePool,
    block_id: &str,
    op_ours: &(String, i64),
    op_theirs: &(String, i64),
) -> Result<MergeResult, AppError> {
    // 1. Find the Lowest Common Ancestor
    let lca = dag::find_lca(pool, op_ours, op_theirs).await?;

    // 2. Get the text content at each point
    let text_ours = dag::text_at(pool, &op_ours.0, op_ours.1).await?;
    let text_theirs = dag::text_at(pool, &op_theirs.0, op_theirs.1).await?;

    let text_ancestor = match lca {
        Some((ref dev, seq)) => dag::text_at(pool, dev, seq).await?,
        None => {
            // No LCA found -- find the create_block for this block to use as ancestor.
            // Walk back from op_ours to find the root create_block.
            let mut current: Option<(String, i64)> = Some(op_ours.clone());
            let mut root_text = String::new();
            let mut found_create = false;
            let mut iterations = 0usize;
            let mut visited_walk: HashSet<(String, i64)> = HashSet::new();
            while let Some(key) = current.take() {
                iterations += 1;
                if iterations > MAX_CHAIN_WALK_ITERATIONS {
                    return Err(AppError::InvalidOperation(format!(
                        "prev_edit chain for block '{}' exceeded {} iterations \
                         — possible cycle in corrupted data",
                        block_id, MAX_CHAIN_WALK_ITERATIONS,
                    )));
                }
                if !visited_walk.insert(key.clone()) {
                    return Err(AppError::InvalidOperation(format!(
                        "cycle detected in prev_edit chain for block '{}' at ({}, {})",
                        block_id, key.0, key.1,
                    )));
                }
                let record = op_log::get_op_by_seq(pool, &key.0, key.1).await?;
                match record.op_type.as_str() {
                    "create_block" => {
                        let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
                        root_text = payload.content;
                        found_create = true;
                        break;
                    }
                    "edit_block" => {
                        let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
                        current = payload.prev_edit;
                    }
                    _ => {
                        return Err(AppError::InvalidOperation(format!(
                            "unexpected op type '{}' in edit chain for block '{}'",
                            record.op_type, block_id,
                        )));
                    }
                }
            }
            if !found_create {
                return Err(AppError::InvalidOperation(format!(
                    "prev_edit chain for block '{}' ended without reaching a \
                     create_block — broken chain (possible op log compaction)",
                    block_id,
                )));
            }
            root_text
        }
    };

    // 3. Line-level three-way merge via diffy.
    //    Note: diffy splits on `\n` boundaries (line-level, NOT word-level).
    //    For single-line blocks, any concurrent edit produces a conflict.
    match diffy::merge(&text_ancestor, &text_ours, &text_theirs) {
        Ok(merged) => Ok(MergeResult::Clean(merged)),
        Err(_conflict_text) => Ok(MergeResult::Conflict {
            ours: text_ours,
            theirs: text_theirs,
            ancestor: text_ancestor,
        }),
    }
}
