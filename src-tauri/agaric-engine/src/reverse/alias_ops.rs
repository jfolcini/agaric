//! Reverse functions for page alias ops (add, remove).

use agaric_core::error::AppError;
use agaric_store::op::{AddPageAliasPayload, OpPayload, RemovePageAliasPayload};
use agaric_store::op_log::OpRecord;

pub fn reverse_add_page_alias(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: AddPageAliasPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RemovePageAlias(RemovePageAliasPayload {
        page_id: payload.page_id,
        alias: payload.alias,
    }))
}

pub fn reverse_remove_page_alias(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RemovePageAliasPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::AddPageAlias(AddPageAliasPayload {
        page_id: payload.page_id,
        alias: payload.alias,
    }))
}
