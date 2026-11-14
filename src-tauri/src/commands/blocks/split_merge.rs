//! Enter inside a block's text and a merge into the block above, each as one
//! transaction of the ops the single commands append (#6531).

use agaric_engine::block_ops::create_block_in_tx;
use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::instrument;

use super::super::*;
use super::crud::{delete_block_in_tx, edit_block_in_tx, remove_deleted_fts};
use super::move_ops::{live_placement, move_blocks_batch_in_tx, ordered_live_children};
use crate::db::{CommandTx, WriteCtx};

/// What [`split_block`] cuts where.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SplitBlockRequest {
    /// The block split, which keeps `before`.
    pub block_id: BlockId,
    pub before: String,
    /// The text of the block created as the next sibling.
    pub after: String,
    /// The created block's id, minted by the caller, which has already shown it.
    pub new_block_id: BlockId,
    /// The text the editor started from, as for `edit_block`.
    pub base_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SplitResponse {
    /// The split block as written: its text is not `before` when it was rebased.
    pub block: BlockRow,
    pub created: BlockRow,
}

/// What [`merge_blocks`] joins into what.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeBlocksRequest {
    /// The block merged away.
    pub block_id: BlockId,
    /// The block that takes its text and its children.
    pub into_id: BlockId,
    /// The target's new text, joined by the caller: the join is Markdown-aware.
    pub merged_text: String,
    /// The target's text as the caller knew it, as for `edit_block`.
    pub base_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MergeResponse {
    /// The block merged into, as written.
    pub block: BlockRow,
    /// The merged-away block's children, now under `block`.
    pub moves: Vec<MoveResponse>,
}

/// Split `block_id` at the caret: it keeps `before`, and `after` becomes its
/// next sibling, in one transaction.
///
/// The create comes first: a `[[link]]` into another space that sits after the
/// caret is accepted only while a live block of the page still holds it (#5272).
///
/// # Errors
///
/// - [`AppError::NotFound`] — the block does not exist or is deleted
/// - [`AppError::Conflict`] / [`AppError::Ulid`] — `new_block_id` is taken or malformed
/// - [`AppError::Validation`] — either text is over the length cap or links into another space
#[instrument(skip_all, fields(block_id = ?request.block_id), err)]
pub async fn split_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    request: SplitBlockRequest,
) -> Result<SplitResponse, AppError> {
    let block_id = request.block_id.into_string();
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "split_block").await?;
    tx.arm_engine_rollback(state);

    let placement = live_placement(&mut tx, &block_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let (created, create_op) = create_block_in_tx(
        &mut tx,
        state,
        device_id,
        "content".into(),
        request.after,
        placement.parent_id.map(BlockId::into_string),
        Some(placement.index + 1),
        Some(request.new_block_id),
    )
    .await?;
    tx.enqueue_background(create_op);
    let block = edit_block_in_tx(
        &mut tx,
        state,
        device_id,
        block_id,
        request.before,
        request.base_text.as_deref(),
    )
    .await?;

    tx.commit_and_dispatch(materializer).await?;
    Ok(SplitResponse { block, created })
}

/// Merge `block_id` into `into_id`: `into_id` takes `merged_text`, the live
/// children of `block_id` move under it after its own, and `block_id` is
/// deleted, in one transaction.
///
/// The edit precedes the delete for the #5272 reason [`split_block_inner`]
/// gives; the moves precede it so the delete's cascade takes the block alone.
///
/// # Errors
///
/// - [`AppError::InvalidOperation`] — the two ids are one block, `block_id` is
///   already deleted, or `into_id` is its child
/// - [`AppError::NotFound`] — either block does not exist, or `into_id` is deleted
/// - [`AppError::Validation`] — the text is over the length cap or links into
///   another space, `into_id` sits deeper under `block_id`, or a child would
///   pass the depth cap
#[instrument(skip_all, fields(block_id = ?request.block_id), err)]
pub async fn merge_blocks_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    request: MergeBlocksRequest,
) -> Result<MergeResponse, AppError> {
    // Without this the block would be edited, then deleted.
    if request.block_id == request.into_id {
        return Err(AppError::InvalidOperation(format!(
            "block '{}' cannot be merged into itself",
            request.block_id.as_str()
        )));
    }
    let block_id = request.block_id.into_string();
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "merge_blocks").await?;
    tx.arm_engine_rollback(state);

    let block = edit_block_in_tx(
        &mut tx,
        state,
        device_id,
        request.into_id.as_str().to_owned(),
        request.merged_text,
        request.base_text.as_deref(),
    )
    .await?;
    let children = ordered_live_children(&mut tx, Some(&block_id)).await?;
    let moves = if children.is_empty() {
        Vec::new()
    } else {
        move_blocks_batch_in_tx(
            &mut tx,
            state,
            device_id,
            children
                .iter()
                .map(|id| BlockId::from_trusted(id))
                .collect(),
            Some(request.into_id),
            // A slot past the last child is an append.
            i64::MAX,
        )
        .await?
    };
    let deleted = delete_block_in_tx(&mut tx, state, device_id, block_id).await?;

    tx.commit_and_dispatch(materializer).await?;
    remove_deleted_fts(pool, std::slice::from_ref(&deleted)).await;
    Ok(MergeResponse { block, moves })
}

/// Tauri command: Enter inside a block's text. Delegates to [`split_block_inner`];
/// the response carries the refs of the create and the edit, in that order.
#[tauri::command]
#[specta::specta]
pub async fn split_block(
    ctx: State<'_, WriteCtx>,
    request: SplitBlockRequest,
) -> Result<WithOps<SplitResponse>, AppError> {
    capture_op_refs(split_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        request,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: merge a block into the one above. Delegates to
/// [`merge_blocks_inner`]; the response carries the refs of the edit, each
/// move and the delete, in that order.
#[tauri::command]
#[specta::specta]
pub async fn merge_blocks(
    ctx: State<'_, WriteCtx>,
    request: MergeBlocksRequest,
) -> Result<WithOps<MergeResponse>, AppError> {
    capture_op_refs(merge_blocks_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        request,
    ))
    .await
    .map_err(sanitize_internal_error)
}
