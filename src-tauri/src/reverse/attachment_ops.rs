//! Reverse functions for attachment ops (add, delete).

use crate::error::AppError;
use crate::op::OpPayload;
use crate::op_log::OpRecord;
use sqlx::SqlitePool;

pub fn reverse_add_attachment(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: crate::op::AddAttachmentPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteAttachment(
        crate::op::DeleteAttachmentPayload {
            attachment_id: payload.attachment_id,
            // Carry forward the original `fs_path` so the reverse op can
            // unlink the file the AddAttachment created.
            fs_path: payload.fs_path,
        },
    ))
}

pub async fn reverse_delete_attachment(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: crate::op::DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
    let original = sqlx::query!(
        r#"SELECT payload FROM op_log
         WHERE op_type = 'add_attachment'
         AND json_extract(payload, '$.attachment_id') = ?1
         AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3))
         ORDER BY created_at DESC, seq DESC
         LIMIT 1"#,
        payload.attachment_id,
        record.created_at,
        record.seq
    )
    .fetch_optional(pool)
    .await?;
    match original {
        Some(row) => {
            let add_payload: crate::op::AddAttachmentPayload = serde_json::from_str(&row.payload)?;
            Ok(OpPayload::AddAttachment(add_payload))
        }
        None => Err(AppError::NonReversible {
            op_type: "delete_attachment".into(),
        }),
    }
}
