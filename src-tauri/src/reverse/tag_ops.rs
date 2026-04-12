//! Reverse functions for tag ops (add, remove).

use crate::error::AppError;
use crate::op::{AddTagPayload, OpPayload, RemoveTagPayload};
use crate::op_log::OpRecord;

pub fn reverse_add_tag(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: AddTagPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RemoveTag(RemoveTagPayload {
        block_id: payload.block_id,
        tag_id: payload.tag_id,
    }))
}

pub fn reverse_remove_tag(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RemoveTagPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::AddTag(AddTagPayload {
        block_id: payload.block_id,
        tag_id: payload.tag_id,
    }))
}
