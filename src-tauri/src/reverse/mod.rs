//! Reverse (inverse) op computation for the undo engine.

mod attachment_ops;
mod block_ops;
mod property_ops;
mod tag_ops;

pub(crate) use block_ops::find_prior_text;

use sqlx::SqlitePool;
use std::str::FromStr;

use crate::db::ReadPool;
use crate::error::AppError;
use crate::op::{OpPayload, OpType};

pub async fn compute_reverse(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> Result<OpPayload, AppError> {
    // I-Core-8: wrap to typed read-pool — caller is in write context
    let record = crate::op_log::get_op_by_seq(&ReadPool(pool.clone()), device_id, seq).await?;
    let op_type = OpType::from_str(&record.op_type)
        .map_err(|e| AppError::Validation(format!("unknown op_type in record: {e}")))?;
    match op_type {
        OpType::CreateBlock => block_ops::reverse_create_block(&record),
        OpType::DeleteBlock => block_ops::reverse_delete_block(pool, &record),
        OpType::EditBlock => block_ops::reverse_edit_block(pool, &record).await,
        OpType::MoveBlock => block_ops::reverse_move_block(pool, &record).await,
        OpType::AddTag => tag_ops::reverse_add_tag(&record),
        OpType::RemoveTag => tag_ops::reverse_remove_tag(&record),
        OpType::SetProperty => property_ops::reverse_set_property(pool, &record).await,
        OpType::DeleteProperty => property_ops::reverse_delete_property(pool, &record).await,
        OpType::AddAttachment => attachment_ops::reverse_add_attachment(&record),
        OpType::RestoreBlock => block_ops::reverse_restore_block(&record),
        OpType::DeleteAttachment => attachment_ops::reverse_delete_attachment(pool, &record).await,
        OpType::PurgeBlock => Err(AppError::NonReversible {
            op_type: record.op_type.clone(),
        }),
    }
}

#[cfg(test)]
mod tests;
