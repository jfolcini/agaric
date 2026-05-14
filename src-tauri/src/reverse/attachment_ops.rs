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

/// Reverse a `delete_attachment` op by reconstructing the `add_attachment`
/// payload that originally created the row.
///
/// # Performance characteristic
///
/// The lookup predicate is
/// `op_type = 'add_attachment' AND attachment_id = ?1`, served by the
/// partial index `idx_op_log_attachment_id` (migration 0064 / SQL-review
/// B-4). This is O(log N) on the number of attachment ops, mirroring the
/// `block_id` denormalisation done for the block-scoped reverse-op
/// lookups in `block_ops` and `property_ops` (migration 0030).
pub async fn reverse_delete_attachment(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: crate::op::DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
    let attachment_id = payload.attachment_id.as_str();
    // MAINT-152(f): this query mirrors the
    // `(created_at < ?ts OR (created_at = ?ts AND seq < ?seq)) ORDER BY
    // created_at DESC, seq DESC LIMIT 1` "strictly before (ts, seq)"
    // shape used by `block_ops::find_prior_text`,
    // `block_ops::find_prior_position`, and
    // `property_ops::find_prior_property`. Reads the native indexed
    // `op_log.attachment_id` column (migration 0064 / SQL-review B-4)
    // — the partial index `idx_op_log_attachment_id` covers the
    // `WHERE attachment_id IS NOT NULL` subset, so `add_attachment`
    // and `delete_attachment` rows are O(log N) lookups.
    let original = sqlx::query!(
        r#"SELECT payload FROM op_log
         WHERE op_type = 'add_attachment'
         AND attachment_id = ?1
         AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3))
         ORDER BY created_at DESC, seq DESC
         LIMIT 1"#,
        attachment_id,
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
