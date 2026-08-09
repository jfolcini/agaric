//! Attachment apply handlers (#2621 THE INVERSION — moved from
//! `crate::materializer::handlers::attachments`). The three per-op
//! `apply_*_attachment_tx` writers are pure `attachments`-table SQL; the
//! orphaned-attachment GC (`cleanup_orphaned_attachments`) is a background
//! reconciliation task and stays app-side.

use super::*;
use agaric_core::attachment_filename::sanitize_attachment_filename;
use agaric_core::attachment_path::AttachmentFsPath;

/// Per-variant body for [`OpType::AddAttachment`].
pub async fn apply_add_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddAttachmentPayload,
    created_at: i64,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    let block_id_str = p.block_id.as_str();
    // #3029 (SECURITY): `p.filename` is a PEER-supplied display name arriving
    // via a synced op — the origination guard (#2989) only vets this device's
    // own commands. Sanitize before it reaches the `attachments.filename` row
    // so a hostile `../../evil.sh` can never land a traversal-shaped name.
    // Sanitize (never reject) here: a reject would wedge the apply pipeline.
    let filename = sanitize_attachment_filename(&p.filename);
    if filename != p.filename {
        tracing::warn!(
            attachment_id = attachment_id_str,
            original = %p.filename,
            sanitized = %filename,
            "sanitized traversal-unsafe peer attachment filename on apply (add_attachment)"
        );
    }
    // #3370 (SECURITY): `p.fs_path` is peer-supplied too, and unlike `filename`
    // it is a real path — every resolver joins it onto `app_data_dir` and then
    // reads, writes or unlinks what it names. Parse it into the confined,
    // canonical form before it reaches the row. Two things this stops:
    // an unconfined relative path (`notes.db`) naming a non-attachment file
    // that the file-receive path then overwrites with the peer's bytes, and a
    // non-canonical spelling (`attachments/./x.png`) that the orphan GC's
    // walk-derived membership test misses — whereupon it destroys the bytes of
    // this very row. Coerce (never reject), as for `filename`: a reject here
    // would wedge the apply pipeline on one hostile op.
    let fs_path = AttachmentFsPath::coerce_from_peer(&p.fs_path, attachment_id_str);
    let fs_path_str = fs_path.as_str();
    if fs_path_str != p.fs_path {
        tracing::warn!(
            attachment_id = attachment_id_str,
            original = %p.fs_path,
            canonical = fs_path_str,
            "rewrote unsafe or non-canonical peer attachment fs_path on apply (add_attachment)"
        );
    }
    sqlx::query!(
        "INSERT OR IGNORE INTO attachments \
             (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        attachment_id_str,
        block_id_str,
        filename,
        fs_path_str,
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
    // #3029 (SECURITY): sanitize the peer-supplied new filename before store
    // — same hostile-peer surface as `apply_add_attachment_tx` above.
    let new_filename = sanitize_attachment_filename(&p.new_filename);
    if new_filename != p.new_filename {
        tracing::warn!(
            attachment_id = attachment_id_str,
            original = %p.new_filename,
            sanitized = %new_filename,
            "sanitized traversal-unsafe peer attachment filename on apply (rename_attachment)"
        );
    }
    sqlx::query!(
        "UPDATE attachments SET filename = ? WHERE id = ?",
        new_filename,
        attachment_id_str
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}
