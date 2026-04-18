//! Reverse functions for block ops (create, edit, delete, move, restore).

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    RestoreBlockPayload,
};
use crate::op_log::OpRecord;
use crate::ulid::BlockId;

pub fn reverse_create_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

pub fn reverse_delete_block(_pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: payload.block_id,
        deleted_at_ref: record.created_at.clone(),
    }))
}

pub async fn reverse_edit_block(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
    let prior_text = find_prior_text(
        pool,
        payload.block_id.as_str(),
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior text found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;
    Ok(OpPayload::EditBlock(EditBlockPayload {
        block_id: payload.block_id,
        to_text: prior_text,
        prev_edit: Some((record.device_id.clone(), record.seq)),
    }))
}

pub async fn reverse_move_block(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: MoveBlockPayload = serde_json::from_str(&record.payload)?;
    let (old_parent, old_pos) = find_prior_position(
        pool,
        payload.block_id.as_str(),
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior position found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;
    Ok(OpPayload::MoveBlock(MoveBlockPayload {
        block_id: payload.block_id,
        new_parent_id: old_parent,
        new_position: old_pos,
    }))
}

pub fn reverse_restore_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

pub async fn find_prior_text(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<String>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND op_type IN ('edit_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            if r.op_type == "edit_block" {
                let p: EditBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.to_text))
            } else {
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.content))
            }
        }
        None => Ok(None),
    }
}

async fn find_prior_position(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<(Option<BlockId>, i64)>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND op_type IN ('move_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            if r.op_type == "move_block" {
                let p: MoveBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some((p.new_parent_id, p.new_position)))
            } else {
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                // BUG-26: block positions are 1-based and `move_block_inner`
                // rejects position 0 (and negatives) with a Validation error.
                // Ancient `create_block` payloads serialized before position
                // became part of the wire format carry `position = None`; we
                // cannot fabricate a valid reverse move for them. Surface this
                // as a `NonReversible` error — matching the pattern used for
                // `DeleteAttachment` when the paired `AddAttachment` is gone —
                // instead of silently defaulting to 0 (which overflows into a
                // downstream Validation error) or 1 (which pretends to know
                // where the block started).
                match p.position {
                    Some(pos) => Ok(Some((p.parent_id, pos))),
                    None => Err(AppError::NonReversible {
                        op_type: "move_block".into(),
                    }),
                }
            }
        }
        None => Ok(None),
    }
}
