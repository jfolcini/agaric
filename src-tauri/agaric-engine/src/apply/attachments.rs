//! Attachment apply handlers (#2621 THE INVERSION — moved from
//! `crate::materializer::handlers::attachments`). The three per-op
//! `apply_*_attachment_tx` writers are pure `attachments`-table SQL; the
//! orphaned-attachment GC (`cleanup_orphaned_attachments`) is a background
//! reconciliation task and stays app-side.

use super::*;

/// Per-variant body for [`OpType::AddAttachment`].
pub async fn apply_add_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddAttachmentPayload,
    created_at: i64,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    let block_id_str = p.block_id.as_str();
    sqlx::query!(
        "INSERT OR IGNORE INTO attachments \
             (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        attachment_id_str,
        block_id_str,
        p.filename,
        p.fs_path,
        p.mime_type,
        p.size_bytes,
        created_at,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Per-variant body for [`OpType::DeleteAttachment`].
pub async fn apply_delete_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteAttachmentPayload,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    sqlx::query!("DELETE FROM attachments WHERE id = ?", attachment_id_str)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Per-variant body for [`OpType::RenameAttachment`].
pub async fn apply_rename_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: RenameAttachmentPayload,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    sqlx::query!(
        "UPDATE attachments SET filename = ? WHERE id = ?",
        p.new_filename,
        attachment_id_str
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}
