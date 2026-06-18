//! Attachments command handlers.

use std::path::Path;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::Manager;
use tauri::State;

use crate::db::now_ms;
use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::OpPayload;
use crate::op_log;
use crate::ulid::{AttachmentId, BlockId};

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
/// - [`AppError::Validation`] — size exceeds 50 MB, MIME type not allowed,
///   or `metadata.len()` disagrees with the IPC-supplied `size_bytes`
/// - [`AppError::Io`] — `fs_path` does not resolve to a file under
///   `app_data_dir`
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, app_data_dir, fs_path), err)]
pub async fn add_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &Path,
    block_id: BlockId,
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
    let now = now_ms();

    // Build OpPayload. `attachment_id` is freshly generated via
    // `Ulid::new().to_string().to_uppercase()` above, so `from_trusted`
    // is the correct entry point — it normalizes (no-op here, already
    // uppercase) without re-validating the ULID format.
    let payload = OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
        attachment_id: BlockId::from_trusted(&attachment_id),
        block_id: block_id.clone(),
        mime_type: mime_type.clone(),
        filename: filename.clone(),
        size_bytes,
        fs_path: fs_path.clone(),
    });

    // Single IMMEDIATE transaction: validation + op_log + attachments write.
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "add_attachment").await?;

    // Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let block_id_str = block_id.as_str();
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id_str
    )
    .fetch_optional(&mut **tx)
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
    // PEND-20 H: async stat — avoids blocking the writer-tx thread on slow /
    // contended storage (Android eMMC, USB-mounted vaults). The TOCTOU
    // window between stat and insert is irrelevant — sync GC reconciles
    // missing attachments anyway (AGENTS.md §Threat Model).
    let metadata = tokio::fs::metadata(&full_path).await?;
    let on_disk_len = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    if on_disk_len != size_bytes {
        return Err(AppError::Validation(format!(
            "attachment size mismatch: expected {size_bytes} bytes, on disk is {} bytes",
            metadata.len()
        )));
    }

    // #1453 Phase 1: compute and persist the blake3 content hash. Reuse the
    // file-sync hashing helper (`read_attachment_file` → `blake3::hash(&data)
    // .to_hex()`) so the stored hash is byte-for-byte identical to the hash
    // the sync layer computes for the same bytes. The file is already on disk
    // (the FE wrote it before invoking, and the M-29 stat above confirmed it).
    // Synchronous std::fs read on the blocking pool (PEND-20 H), like the read
    // path. A hash failure is fatal here: the bytes the M-29 stat just saw are
    // unreadable, so the row would be broken regardless.
    let content_hash = {
        let dir = app_data_dir.to_path_buf();
        let path = fs_path.clone();
        let (_bytes, hash) = tokio::task::spawn_blocking(move || {
            crate::sync_files::read_attachment_file(&dir, &path)
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
        hash
    };

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now).await?;

    // Insert into attachments table within same transaction
    sqlx::query(
        "INSERT INTO attachments \
         (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&attachment_id)
    .bind(block_id.as_str())
    .bind(&mime_type)
    .bind(&filename)
    .bind(size_bytes)
    .bind(&fs_path)
    .bind(now)
    .bind(&content_hash)
    .execute(&mut **tx)
    .await?;

    // Commit + fire-and-forget background cache dispatch.
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(AttachmentRow {
        id: BlockId::from_trusted(&attachment_id),
        block_id,
        mime_type,
        filename,
        size_bytes,
        fs_path,
        created_at: now,
        content_hash: Some(content_hash),
    })
}

/// Add an attachment by passing the raw file bytes over IPC (PEND-76 F2).
///
/// The frontend reads the file into bytes (a browser `ArrayBuffer`) and hands
/// them to this command; the **backend is the sole writer** — it generates the
/// storage path, writes the bytes under `app_data_dir/attachments/`, then
/// delegates to [`add_attachment_inner`] for the size/MIME/existence validation
/// + op-log + row insert. This avoids the FE-writes-then-backend-stats handshake
/// (and the orphaned-file-on-rejection race) of a filesystem-plugin design.
///
/// On any failure from the delegate, the freshly-written bytes are unlinked so a
/// rejected upload never leaks a file on disk.
///
/// # Errors
///
/// - [`AppError::Validation`] — size exceeds 50 MB or MIME type not allowed
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
/// - [`AppError::Io`] — writing the bytes to disk failed
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, app_data_dir, bytes), err)]
pub async fn add_attachment_with_bytes_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &Path,
    block_id: BlockId,
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<AttachmentRow, AppError> {
    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);

    // Pre-validate size + MIME BEFORE writing anything, so a rejected upload
    // never touches the disk. `add_attachment_inner` re-checks (cheap).
    if size_bytes > MAX_ATTACHMENT_SIZE {
        return Err(AppError::Validation(format!(
            "attachment size {} bytes exceeds maximum {} bytes (50 MB)",
            size_bytes, MAX_ATTACHMENT_SIZE
        )));
    }
    if !is_mime_allowed(&mime_type) {
        return Err(AppError::Validation(format!(
            "MIME type '{}' is not allowed; permitted: image/*, application/pdf, text/*, \
             application/json, application/zip, application/x-tar",
            mime_type
        )));
    }

    // Backend-generated relative storage path — the FE never supplies one.
    let storage_id = ulid::Ulid::new().to_string().to_uppercase();
    let fs_path = format!("attachments/{storage_id}");

    // Write the bytes first (creates the attachments dir). `write_attachment_file`
    // is synchronous std::fs; run it on the blocking pool so a large write does
    // not stall the async runtime (PEND-20 H rationale).
    {
        let dir = app_data_dir.to_path_buf();
        let path = fs_path.clone();
        tokio::task::spawn_blocking(move || {
            crate::sync_files::write_attachment_file(&dir, &path, &bytes)
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    }

    // Delegate for validation + op-log + row insert. On ANY failure, unlink the
    // bytes we just wrote so a rejected upload leaves nothing behind.
    match add_attachment_inner(
        pool,
        device_id,
        materializer,
        app_data_dir,
        block_id,
        filename,
        mime_type,
        size_bytes,
        fs_path.clone(),
    )
    .await
    {
        Ok(row) => Ok(row),
        Err(e) => {
            let full_path = app_data_dir.join(&fs_path);
            match tokio::fs::remove_file(&full_path).await {
                Ok(()) => {}
                Err(unlink_err) if unlink_err.kind() == std::io::ErrorKind::NotFound => {}
                Err(unlink_err) => {
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %unlink_err,
                        "failed to clean up attachment bytes after add_attachment rejection; \
                         will be reconciled by the GC pass"
                    );
                }
            }
            Err(e)
        }
    }
}

/// Read an attachment's raw bytes by ID (PEND-76 F2).
///
/// The render path calls this and wraps the bytes in a `blob:` URL (the CSP
/// permits `blob:`), avoiding the asset protocol entirely.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment row does not exist
/// - [`AppError::Io`] — the file is missing on disk or unreadable
/// - [`AppError::Validation`] — the stored `fs_path` is malformed (BUG-35 guard)
#[instrument(skip(pool, app_data_dir), err)]
pub async fn read_attachment_inner(
    pool: &SqlitePool,
    app_data_dir: &Path,
    attachment_id: AttachmentId,
) -> Result<Vec<u8>, AppError> {
    let attachment_id_str = attachment_id.as_str();
    let fs_path = sqlx::query_scalar!(
        "SELECT fs_path FROM attachments WHERE id = ?",
        attachment_id_str
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("attachment '{attachment_id}'")))?;

    // Synchronous std::fs read on the blocking pool (PEND-20 H).
    let dir = app_data_dir.to_path_buf();
    let (bytes, _hash) = tokio::task::spawn_blocking(move || {
        crate::sync_files::read_attachment_file(&dir, &fs_path)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(bytes)
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
    attachment_id: AttachmentId,
) -> Result<(), AppError> {
    // Single IMMEDIATE transaction: validation + op_log + delete.
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "delete_attachment").await?;

    // Validate attachment exists AND fetch its fs_path in one query.
    // The fs_path goes into the op-log payload (so remote peers / future
    // GC passes can reconcile) and into the post-commit unlink.
    let attachment_id_str = attachment_id.as_str();
    let row = sqlx::query!(
        r#"SELECT fs_path FROM attachments WHERE id = ?"#,
        attachment_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound(format!("attachment '{attachment_id}'")));
    };
    let fs_path = row.fs_path;

    let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
        attachment_id: attachment_id.clone(),
        fs_path: fs_path.clone(),
    });

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_ms()).await?;

    // Delete from attachments table within same transaction
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(attachment_id.as_str())
        .execute(&mut **tx)
        .await?;

    // Commit + fire-and-forget background cache dispatch. The cache
    // dispatch enqueues before the post-commit unlink, then
    // `commit_and_dispatch` fires them in order (commit → dispatch).
    // The unlink below is independent — the materializer reads from
    // the committed op_log entry, not from the filesystem.
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

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

    Ok(())
}

/// Rename an attachment by its ID.
///
/// Validates the attachment exists, records the old filename, appends a
/// `RenameAttachment` op, updates the `attachments` table, and commits.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment does not exist
/// - [`AppError::Validation`] — new filename is empty
pub async fn rename_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    attachment_id: AttachmentId,
    new_filename: String,
) -> Result<(), AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "rename_attachment").await?;

    let attachment_id_str = attachment_id.as_str();
    let row = sqlx::query!(
        r#"SELECT id, filename FROM attachments WHERE id = ?"#,
        attachment_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound(format!("attachment '{attachment_id}'")));
    };
    let old_filename = row.filename;

    if new_filename.is_empty() {
        return Err(AppError::Validation("filename cannot be empty".into()));
    }

    let payload = OpPayload::RenameAttachment(crate::op::RenameAttachmentPayload {
        attachment_id: attachment_id.clone(),
        old_filename,
        new_filename: new_filename.clone(),
    });

    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_ms()).await?;

    sqlx::query!(
        "UPDATE attachments SET filename = ? WHERE id = ?",
        new_filename,
        attachment_id_str
    )
    .execute(&mut **tx)
    .await?;

    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(())
}

/// List all attachments for a block.
///
/// Pure read — no op log entry, no materializer dispatch.
///
/// M-28: the `attachments` table declares a `deleted_at` column (see
/// migration `0001_initial.sql`), but no code path ever writes a non-NULL
/// value to it. Both [`delete_attachment_inner`] and the materializer's
/// `OpType::DeleteAttachment` handler (`materializer/handlers.rs`) issue
/// `DELETE FROM attachments` — i.e. hard-delete. The historical filter
/// `AND deleted_at IS NULL` was therefore a no-op: every surviving row
/// already had `deleted_at IS NULL`. It has been removed so the query
/// reflects what actually happens at runtime and so future readers do
/// not assume soft-delete semantics.
///
/// The column itself is left in place: dropping it would require a new
/// migration, and flipping the delete path to a real soft-delete would
/// require a new op-type or payload extension. Both are out of scope per
/// AGENTS.md "Architectural Stability" and need explicit user approval.
///
/// # Errors
///
/// - [`AppError::Database`] — on query failure
#[instrument(skip(pool), err)]
pub async fn list_attachments_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<Vec<AttachmentRow>, AppError> {
    let block_id_str = block_id.as_str();
    let rows = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash \
         FROM attachments WHERE block_id = ? \
         ORDER BY created_at, id",
        block_id_str
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Batch-fetch full attachment lists for many blocks in one query.
///
/// Returns a `HashMap<block_id, Vec<AttachmentRow>>` where missing block IDs
/// (those with no attachments OR not present in the database) are simply
/// absent from the map. Frontend callers should default missing keys to `[]`.
/// Counts are derivable as `result[id].len()` — PEND-35 Tier 2.7a folded the
/// separate `get_batch_attachment_counts` command into this one (one less
/// IPC, specta binding, and tauri-mock handler).
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction. Mirrors the pattern used in
/// `commands/blocks/queries.rs::batch_resolve_inner`.
///
/// Empty `block_ids` returns an empty map (not an error). This matches the
/// frontend pattern where a page with no blocks should not fail.
///
/// MAINT-131 — replaces N per-block `list_attachments` IPCs (badge counts +
/// inline-image-render decisions) with a single batched query mounted at
/// the BlockTree level.
///
/// # Errors
///
/// - [`AppError::Database`] — on query failure
#[instrument(skip(pool, block_ids), err)]
pub async fn list_attachments_batch_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
) -> Result<std::collections::HashMap<String, Vec<AttachmentRow>>, AppError> {
    if block_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let ids_json = serde_json::to_string(&block_ids)?;

    // Fetch ALL attachments for the given block IDs in one query, then group
    // by block_id in Rust. Same column order as `list_attachments_inner` so
    // the per-row shape is identical.
    let rows = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash \
         FROM attachments \
         WHERE block_id IN (SELECT value FROM json_each(?)) \
         ORDER BY created_at, id",
        ids_json
    )
    .fetch_all(pool)
    .await?;

    // M7b (#348): grouping is via a HashMap keyed on `block_id`, so the
    // result is NOT block-id ordered — the leading `block_id` sort key was
    // dead (it never affected the HashMap output). `ORDER BY created_at` is
    // kept because it fixes the order *within* each block's Vec, which the
    // frontend relies on.
    let mut grouped: std::collections::HashMap<String, Vec<AttachmentRow>> =
        std::collections::HashMap::new();
    for row in rows {
        grouped
            .entry(row.block_id.clone().into_string())
            .or_default()
            .push(row);
    }

    Ok(grouped)
}

/// Tauri command: add an attachment to a block. Delegates to [`add_attachment_inner`].
#[tauri::command]
#[specta::specta]
pub async fn add_attachment(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
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
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
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

/// Tauri command: add an attachment from raw bytes. Delegates to
/// [`add_attachment_with_bytes_inner`].
#[tauri::command]
#[specta::specta]
pub async fn add_attachment_with_bytes(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<AttachmentRow, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    add_attachment_with_bytes_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        block_id,
        filename,
        mime_type,
        bytes,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: read an attachment's raw bytes. Delegates to
/// [`read_attachment_inner`].
#[tauri::command]
#[specta::specta]
pub async fn read_attachment(
    app: tauri::AppHandle,
    pool: State<'_, ReadPool>,
    attachment_id: AttachmentId,
) -> Result<Vec<u8>, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    read_attachment_inner(&pool.0, &app_data_dir, attachment_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete an attachment. Delegates to [`delete_attachment_inner`].
#[tauri::command]
#[specta::specta]
pub async fn delete_attachment(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    attachment_id: AttachmentId,
) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    delete_attachment_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        attachment_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: rename an attachment. Delegates to [`rename_attachment_inner`].
#[tauri::command]
#[specta::specta]
pub async fn rename_attachment(
    ctx: State<'_, WriteCtx>,
    attachment_id: AttachmentId,
    new_filename: String,
) -> Result<(), AppError> {
    rename_attachment_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        attachment_id,
        new_filename,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list attachments for a block. Delegates to [`list_attachments_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_attachments(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
) -> Result<Vec<AttachmentRow>, AppError> {
    list_attachments_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-fetch full attachment lists. Delegates to [`list_attachments_batch_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_attachments_batch(
    pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
) -> Result<std::collections::HashMap<String, Vec<AttachmentRow>>, AppError> {
    list_attachments_batch_inner(&pool.0, block_ids)
        .await
        .map_err(sanitize_internal_error)
}
