//! Reverse functions for property ops (set, delete).

use crate::error::AppError;
use crate::op::{DeletePropertyPayload, OpPayload, SetPropertyPayload};
use crate::op_log::OpRecord;
use sqlx::SqlitePool;

struct PriorPropertyRow {
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
}

pub async fn reverse_set_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?;
    match prior {
        Some(p) => Ok(OpPayload::SetProperty(SetPropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
            value_text: p.value_text,
            value_num: p.value_num,
            value_date: p.value_date,
            value_ref: p.value_ref,
        })),
        None => Ok(OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
        })),
    }
}

pub async fn reverse_delete_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior set_property found for block '{}' key '{}' — cannot reverse delete_property",
            payload.block_id, payload.key
        ))
    })?;
    Ok(OpPayload::SetProperty(SetPropertyPayload {
        block_id: payload.block_id,
        key: payload.key,
        value_text: prior.value_text,
        value_num: prior.value_num,
        value_date: prior.value_date,
        value_ref: prior.value_ref,
    }))
}

async fn find_prior_property(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<PriorPropertyRow>, AppError> {
    let row = sqlx::query!(
        "SELECT payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND json_extract(payload, '$.key') = ?2 \
           AND op_type = 'set_property' \
           AND (created_at < ?3 OR (created_at = ?3 AND seq < ?4)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,
        key,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            let p: SetPropertyPayload = serde_json::from_str(&r.payload)?;
            Ok(Some(PriorPropertyRow {
                value_text: p.value_text,
                value_num: p.value_num,
                value_date: p.value_date,
                value_ref: p.value_ref,
            }))
        }
        None => Ok(None),
    }
}
