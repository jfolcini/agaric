//! Attachments command handlers.

use std::path::Path;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::Manager;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::OpPayload;
use crate::op_log;
use crate::ulid::BlockId;

use super::*;

/// Add a file attachment to a block.
///
/// Validates the block exists and is not deleted, checks file size and MIME
/// type against the allow-list, generates a ULID for the attachment, appends
/// an `AddAttachment` op, inserts into the `attachments` table, and dispatches
/// background cache tasks.
///
/// M-29: also stat-checks the file at `app_data_dir.join(&fs_path)` inside
/// the IMMEDIATE transaction so a row is never committed without the
/// underlying bytes on disk. The frontend writes the bytes via
/// `@tauri-apps/plugin-fs` *before* invoking this command; if that write
/// failed silently or the path drifted, the metadata lookup surfaces the
/// problem as `AppError::Io` instead of leaving the sync layer to report
/// `MissingAttachment` later.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
/// - [`AppError::Validation`] — size exceeds 50 MB or MIME type not allowed
/// - [`AppError::Io`] — `fs_path` does not resolve to a file under
///   `app_data_dir` (or `metadata.len()` disagrees with `size_bytes` in
///   debug builds)
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, app_data_dir, fs_path), err)]
pub async fn add_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &Path,
    block_id: String,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    fs_path: String,
) -> Result<AttachmentRow, AppError> {
    // F-11 validation: size limit
    if size_bytes > MAX_ATTACHMENT_SIZE {
        return Err(AppError::Validation(format!(
            "attachment size {} bytes exceeds maximum {} bytes (50 MB)",
            size_bytes, MAX_ATTACHMENT_SIZE
        )));
    }

    // F-11 validation: MIME type allow-list
    if !is_mime_allowed(&mime_type) {
        return Err(AppError::Validation(format!(
            "MIME type '{}' is not allowed; permitted: image/*, application/pdf, text/*, \
             application/json, application/zip, application/x-tar",
            mime_type
        )));
    }

    // BUG-35: Reject `fs_path` values that would escape the app data dir
    // (absolute paths, `..` traversal, drive prefixes). The full path
    // resolution happens later in read/write, but validating here stops
    // bad rows from ever reaching the `attachments` table.
    crate::sync_files::check_attachment_fs_path_shape(&fs_path)?;

    // Generate ULID for attachment_id
    let attachment_id = ulid::Ulid::new().to_string().to_uppercase();
    let now = now_rfc3339();

    // Build OpPayload. `attachment_id` is freshly generated via
    // `Ulid::new().to_string().to_uppercase()` above, so `from_trusted`
    // is the correct entry point — it normalizes (no-op here, already
    // uppercase) without re-validating the ULID format.
    let payload = OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
        attachment_id: BlockId::from_trusted(&attachment_id),
        block_id: BlockId::from_trusted(&block_id),
        mime_type: mime_type.clone(),
        filename: filename.clone(),
        size_bytes,
        fs_path: fs_path.clone(),
    });

    // Single IMMEDIATE transaction: validation + op_log + attachments write.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // M-29: confirm the file really exists on disk before committing
    // the row. The frontend writes bytes via `@tauri-apps/plugin-fs`
    // *before* invoking `add_attachment`; without this guard, a silent
    // FS-write failure leaves the DB row pointing at a non-existent
    // file and the sync layer eventually reports `MissingAttachment`.
    // Doing this inside the IMMEDIATE tx keeps it TOCTOU-safe relative
    // to the row insert.
    let full_path = app_data_dir.join(&fs_path);
    let metadata = std::fs::metadata(&full_path)?;
    debug_assert_eq!(
        i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        size_bytes,
        "attachment fs metadata size ({}) does not match declared size_bytes ({}) for {}",
        metadata.len(),
        size_bytes,
        full_path.display(),
    );

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;

    // Insert into attachments table within same transaction
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&attachment_id)
    .bind(&block_id)
    .bind(&mime_type)
    .bind(&filename)
    .bind(size_bytes)
    .bind(&fs_path)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    materializer.dispatch_background_or_warn(&op_record);

    Ok(AttachmentRow {
        id: attachment_id,
        block_id,
        mime_type,
        filename,
        size_bytes,
        fs_path,
        created_at: now,
    })
}

/// Delete an attachment by its ID.
///
/// Validates the attachment exists, appends a `DeleteAttachment` op (carrying
/// the captured `fs_path`), deletes from the `attachments` table, commits,
/// and *then* attempts to unlink the underlying file from disk.
///
/// C-3a/b: the on-disk file must be removed when the user deletes an
/// attachment, otherwise the file leaks on disk. The op-log entry is the
/// source of truth: if the unlink fails for any reason (other than
/// `NotFound`, which is already-clean), the row is still committed and a
/// future GC pass (C-3c) will reconcile orphaned files. We never return an
/// error from a failed unlink — that would leave the DB and op-log saying
/// "deleted" but force the caller to retry, which would then return
/// `NotFound` from the existence check above and surface a misleading
/// error to the user.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment does not exist
#[instrument(skip(pool, device_id, materializer, app_data_dir), err)]
pub async fn delete_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &Path,
    attachment_id: String,
) -> Result<(), AppError> {
    // Single IMMEDIATE transaction: validation + op_log + delete.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate attachment exists AND fetch its fs_path in one query.
    // The fs_path goes into the op-log payload (so remote peers / future
    // GC passes can reconcile) and into the post-commit unlink.
    let row = sqlx::query!(
        r#"SELECT fs_path FROM attachments WHERE id = ?"#,
        attachment_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound(format!("attachment '{attachment_id}'")));
    };
    let fs_path = row.fs_path;

    let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
        attachment_id: BlockId::from_trusted(&attachment_id),
        fs_path: fs_path.clone(),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // Delete from attachments table within same transaction
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(&attachment_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // C-3b: unlink the on-disk file *after* the commit. The op-log entry is
    // authoritative — failures here are logged and reconciled later by the
    // C-3c GC pass; we never surface them as errors because the user-facing
    // delete already succeeded.
    let full_path = app_data_dir.join(&fs_path);
    match tokio::fs::remove_file(&full_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(
                path = %full_path.display(),
                attachment_id = %attachment_id,
                "attachment file already missing on disk; skipping unlink"
            );
        }
        Err(e) => {
            tracing::warn!(
                path = %full_path.display(),
                attachment_id = %attachment_id,
                error = %e,
                "failed to unlink attachment file; will be reconciled by C-3c GC pass"
            );
        }
    }

    // Fire-and-forget background cache dispatch
    materializer.dispatch_background_or_warn(&op_record);

    Ok(())
}

/// List all (non-deleted) attachments for a block.
///
/// Pure read — no op log entry, no materializer dispatch.
///
/// # Errors
///
/// - [`AppError::Database`] — on query failure
#[instrument(skip(pool), err)]
pub async fn list_attachments_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<AttachmentRow>, AppError> {
    let rows = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at \
         FROM attachments WHERE block_id = ? AND deleted_at IS NULL \
         ORDER BY created_at",
        block_id
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Tauri command: add an attachment to a block. Delegates to [`add_attachment_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn add_attachment(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    fs_path: String,
) -> Result<AttachmentRow, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    add_attachment_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        &app_data_dir,
        block_id,
        filename,
        mime_type,
        size_bytes,
        fs_path,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: delete an attachment. Delegates to [`delete_attachment_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_attachment(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    attachment_id: String,
) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    delete_attachment_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        &app_data_dir,
        attachment_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list attachments for a block. Delegates to [`list_attachments_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_attachments(
    pool: State<'_, ReadPool>,
    block_id: String,
) -> Result<Vec<AttachmentRow>, AppError> {
    list_attachments_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}
