//! Editing many blocks in one transaction (#6608): [`edit_blocks_batch`].
//!
//! Replace across pages computes each block's new text in the frontend, from
//! the content a search returned, and writes them all here. An `EditBlock` is
//! applied as a diff from the block's current text, so a text computed from
//! stale content would revert whatever landed in between: each edit carries
//! the content it was computed from, and a block that no longer holds it is
//! left alone and reported.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::instrument;

use super::super::*;
use crate::db::{CommandTx, WriteCtx};
use super::crud::edit_block_in_tx;
use crate::commands::history::MAX_REVERT_OPS;
use agaric_store::pagination::MAX_BATCH_BLOCK_IDS;

// One `undo_ops` must be able to revert a whole run.
const _: () = assert!(MAX_BATCH_BLOCK_IDS <= MAX_REVERT_OPS);

/// One edit of [`edit_blocks_batch`]: `to_text` replaces the block's content
/// only while that content is still `expected`.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockEdit {
    pub block_id: BlockId,
    pub expected: String,
    pub to_text: String,
}

/// Reply of [`edit_blocks_batch`].
#[derive(Debug, Clone, Serialize, Type)]
pub struct EditBlocksBatchResponse {
    /// The blocks left alone, in request order: in the Trash, gone, or no
    /// longer holding the `expected` content.
    pub skipped: Vec<BlockId>,
}

/// Apply every edit whose block still holds its `expected` content, in one
/// transaction: each is the `EditBlock` op [`edit_block_inner`] appends, with
/// its validation.
///
/// # Errors
///
/// - [`AppError::Validation`] — empty `edits`, or more than
///   `MAX_BATCH_BLOCK_IDS` of them
/// - whatever [`edit_block_inner`] refuses an edit with; nothing is written
#[instrument(skip_all, fields(edits = edits.len()), err)]
pub async fn edit_blocks_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    edits: Vec<BlockEdit>,
) -> Result<EditBlocksBatchResponse, AppError> {
    if edits.is_empty() {
        return Err(AppError::validation("edits list cannot be empty".into()));
    }
    crate::commands::ensure_batch_within_cap("edits", edits.len())?;

    let mut tx = CommandTx::begin_immediate(pool, "edit_blocks_batch").await?;
    tx.arm_engine_rollback(materializer.loro_state());

    let ids_json = serde_json::to_string(&edits.iter().map(|e| &e.block_id).collect::<Vec<_>>())?;
    let mut current: HashMap<String, Option<String>> = sqlx::query!(
        r#"SELECT id, content FROM blocks
           WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL"#,
        ids_json
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| (row.id, row.content))
    .collect();

    let mut skipped = Vec::new();
    for edit in edits {
        match current.get_mut(edit.block_id.as_str()) {
            Some(content) if content.as_deref() == Some(edit.expected.as_str()) => {
                // A second edit of the same block sees what the first wrote.
                *content = Some(edit.to_text.clone());
                edit_block_in_tx(
                    &mut tx,
                    materializer.loro_state(),
                    device_id,
                    edit.block_id.into_string(),
                    edit.to_text,
                )
                .await?;
            }
            _ => skipped.push(edit.block_id),
        }
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(EditBlocksBatchResponse { skipped })
}

/// Tauri command: edit many blocks in one transaction. Delegates to
/// [`edit_blocks_batch_inner`]; the response carries the appended op refs.
#[tauri::command]
#[specta::specta]
pub async fn edit_blocks_batch(
    ctx: State<'_, WriteCtx>,
    edits: Vec<BlockEdit>,
) -> Result<WithOps<EditBlocksBatchResponse>, AppError> {
    capture_op_refs(edit_blocks_batch_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        edits,
    ))
    .await
    .map_err(sanitize_internal_error)
}
