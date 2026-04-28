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
/// # Performance characteristic (L-97)
///
/// The lookup predicate is
/// `op_type = 'add_attachment' AND json_extract(payload, '$.attachment_id') = ?1`,
/// which walks every `add_attachment` op in `op_log` — there is **no
/// covering index** on `attachment_id` (unlike `block_id`, which has
/// `idx_op_log_block_id` from migration 0030). The `op_type =
/// 'add_attachment'` filter already narrows the scan substantially in
/// practice, and reverse-op replay rates are very low (manual undo /
/// sync-replay back-out only), so the unindexed scan is acceptable today.
///
/// If profiling ever shows this query dominates, the canonical fix is a
/// new indexed `attachment_id` column on `op_log` via a new migration.
/// **That requires explicit user approval** per AGENTS.md "Architectural
/// Stability" (a new column is a schema change). Do **not** add the column
/// without that approval.
pub async fn reverse_delete_attachment(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: crate::op::DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
    let attachment_id = payload.attachment_id.as_str();
    // MAINT-152(f) / 08-MISC-008: this query mirrors the
    // `(created_at < ?ts OR (created_at = ?ts AND seq < ?seq)) ORDER BY
    // created_at DESC, seq DESC LIMIT 1` "strictly before (ts, seq)"
    // shape used by `block_ops::find_prior_text`,
    // `block_ops::find_prior_position`, and
    // `property_ops::find_prior_property`. Unlike those, it cannot use
    // the indexed `op_log.block_id` column (migration 0030) because the
    // scope key here is `attachment_id`, not `block_id` — there is no
    // covering index on `json_extract(payload, '$.attachment_id')`.
    // Reverse-op replay rates are very low (manual undo / sync-replay
    // back-out only), so the unindexed scan is acceptable; if the rate
    // ever becomes hot, the fix is a dedicated migration adding an
    // indexed `attachment_id` column on `op_log` for `add_attachment` /
    // `delete_attachment` rows. Tracked under 08-MISC-008.
    let original = sqlx::query!(
        r#"SELECT payload FROM op_log
         WHERE op_type = 'add_attachment'
         AND json_extract(payload, '$.attachment_id') = ?1
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
