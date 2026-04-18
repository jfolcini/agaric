//! Attachments command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

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
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
/// - [`AppError::Validation`] — size exceeds 50 MB or MIME type not allowed
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, fs_path), err)]
pub async fn add_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
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

    // Build OpPayload
    let payload = OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
        attachment_id: attachment_id.clone(),
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
/// Validates the attachment exists, appends a `DeleteAttachment` op,
/// deletes from the `attachments` table, and dispatches background cache
/// tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment does not exist
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    attachment_id: String,
) -> Result<(), AppError> {
    let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
        attachment_id: attachment_id.clone(),
    });

    // Single IMMEDIATE transaction: validation + op_log + delete.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate attachment exists
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        attachment_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("attachment '{attachment_id}'")));
    }

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // Delete from attachments table within same transaction
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(&attachment_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

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
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    fs_path: String,
) -> Result<AttachmentRow, AppError> {
    add_attachment_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
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
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    attachment_id: String,
) -> Result<(), AppError> {
    delete_attachment_inner(&pool.0, device_id.as_str(), &materializer, attachment_id)
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
