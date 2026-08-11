//! Attachments command handlers.

use std::path::Path;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::now_ms;
use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::{AttachmentId, BlockId};
use agaric_store::op::OpPayload;
use agaric_store::op_log;

use super::*;

/// Maximum stored attachment display-filename length, in bytes.
///
/// 255 bytes is the near-universal single-path-component cap on mainstream
/// filesystems (ext4, APFS, NTFS all limit one name component to 255).
/// Capping here keeps a stored `filename` writable as a real path component
/// by any downstream consumer (graph-export ZIP `assets/<filename>`, a future
/// on-disk export / reveal-in-folder).
const MAX_ATTACHMENT_FILENAME_BYTES: usize = 255;

/// Validate and normalize a user-supplied attachment *display* filename,
/// rejecting anything that could be interpreted as a path once the stored
/// `attachments.filename` is joined to build a filesystem or ZIP path (#2989).
///
/// The bytes always live at the backend-generated `fs_path`
/// (`attachments/<ULID>`), never at a path derived from `filename` — but
/// several consumers DO join `filename` to a base dir to produce a portable,
/// human-readable path (the graph-export ZIP's `assets/<filename>`, a future
/// on-disk export / reveal-in-folder). A traversal-shaped `filename`
/// (`../../evil.sh`) stored here is therefore a latent path-traversal /
/// Zip-Slip primitive. #2988 hardened only the ZIP writer; this closes the
/// root cause — the bad name being STORED at all.
///
/// This **rejects** (returns [`AppError::Validation`]) rather than silently
/// sanitizing, because both local origination paths
/// (`add_attachment_with_bytes_inner`, `rename_attachment_inner`) are
/// user-initiated commands: a clear
/// error is better UX than a surprising silent rewrite, and rejecting here
/// stops THIS device from ever *originating* a traversal-shaped op into the
/// op-log (whence it would replicate to peers).
///
/// NOTE (defense-in-depth follow-up): the sync/replay APPLY path
/// (`agaric_engine::apply::apply_rename_attachment_tx` /
/// `apply_add_attachment_tx`, and the `db::recovery` replay loop) writes a
/// peer's filename straight to the row with no validation — that is the true
/// hostile-peer surface. Hardening it must *sanitize* rather than reject,
/// since a reject on apply would wedge the whole replay pipeline on one
/// hostile op (a DoS). It is out of scope for this local-command fix.
///
/// Returns the trimmed filename on success (leading/trailing whitespace is
/// normalized away). Interior spaces, dots, and unicode letters
/// (`report 2024.pdf`, `my.file.pdf`, `résumé.pdf`) pass through unchanged.
fn validate_attachment_filename(filename: &str) -> Result<String, AppError> {
    let trimmed = filename.trim();

    if trimmed.is_empty() {
        return Err(AppError::validation(
            "attachment filename cannot be empty".into(),
        ));
    }

    if trimmed.len() > MAX_ATTACHMENT_FILENAME_BYTES {
        return Err(AppError::validation(format!(
            "attachment filename exceeds the maximum of {MAX_ATTACHMENT_FILENAME_BYTES} bytes"
        )));
    }

    // Path separators (POSIX `/` and Windows `\`) let the name span directory
    // levels once joined to a base path — the core traversal vector.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::validation(
            "attachment filename may not contain path separators ('/' or '\\')".into(),
        ));
    }

    // Control characters (NUL, newlines, …): never valid in a real filename
    // and a classic path-truncation / injection vector.
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::validation(
            "attachment filename may not contain control characters".into(),
        ));
    }

    // `.`, `..`, or any all-dots name resolves to the current/parent directory
    // (or is otherwise non-representable) when used as a path component.
    if trimmed.chars().all(|c| c == '.') {
        return Err(AppError::validation(
            "attachment filename may not consist solely of dots".into(),
        ));
    }

    Ok(trimmed.to_string())
}

/// Validate and normalize metadata for a new attachment before any bytes are
/// written. The storage path is intentionally absent: only the backend-owned
/// bytes command can originate attachments, and it generates that path.
fn validate_new_attachment(
    filename: &str,
    mime_type: &str,
    size_bytes: i64,
) -> Result<String, AppError> {
    // F-11 validation: size limit.
    if size_bytes > MAX_ATTACHMENT_SIZE {
        return Err(AppError::validation(format!(
            "attachment size {size_bytes} bytes exceeds maximum {MAX_ATTACHMENT_SIZE} bytes (50 MB)"
        )));
    }

    // F-11 validation: MIME type allow-list.
    if !is_mime_allowed(mime_type) {
        return Err(AppError::validation(format!(
            "MIME type '{mime_type}' is not allowed; permitted: image/*, application/pdf, text/*, \
             application/json, application/zip, application/x-tar"
        )));
    }

    validate_attachment_filename(filename)
}

/// Persist metadata for bytes already written at a backend-generated path.
///
/// Validation and filesystem I/O happen before this helper. Keeping this core
/// private ensures renderer callers can never supply an arbitrary app-data
/// path while preserving the existing transaction, op-log, and dedup queries.
#[allow(clippy::too_many_arguments)]
async fn persist_attachment(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    fs_path: String,
    content_hash: String,
) -> Result<AttachmentRow, AppError> {
    // Generate ULID for attachment_id
    let attachment_id = ulid::Ulid::generate().to_string().to_uppercase();
    let now = now_ms();

    // Build OpPayload. `attachment_id` is freshly generated via
    // `Ulid::generate().to_string().to_uppercase()` above, so `from_trusted`
    // is the correct entry point — it normalizes (no-op here, already
    // uppercase) without re-validating the ULID format.
    let payload = OpPayload::AddAttachment(agaric_store::op::AddAttachmentPayload {
        attachment_id: BlockId::from_trusted(&attachment_id),
        block_id: block_id.clone(),
        mime_type: mime_type.clone(),
        filename: filename.clone(),
        size_bytes,
        fs_path: fs_path.clone(),
    });

    // Single IMMEDIATE transaction: validation + op_log + attachments write.
    // CommandTx couples commit + post-commit dispatch.
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

    // #1993 Phase 1 — content-addressed blob dedup. If a blob with this hash
    // already exists, REUSE its canonical file: the new attachment row links
    // to it by pointing `fs_path` at the blob's `on_disk_path`, and the
    // freshly-written duplicate at the supplied `fs_path` becomes redundant
    // (unlinked after commit). Otherwise this is the first copy of these
    // bytes — create the blob row pointing at the supplied `fs_path`.
    let existing_blob = sqlx::query_scalar!(
        "SELECT on_disk_path FROM attachment_blobs WHERE content_hash = ?",
        content_hash
    )
    .fetch_optional(&mut **tx)
    .await?;

    // The path the row will store + the path whose bytes are now redundant.
    let (row_fs_path, redundant_file): (String, Option<String>) = match existing_blob {
        Some(canonical) if canonical != fs_path => {
            // Reuse: redirect the row at the canonical blob file and mark the
            // just-written duplicate for post-commit cleanup.
            (canonical, Some(fs_path.clone()))
        }
        Some(canonical) => {
            // Same path already is the canonical file (e.g. re-add of the
            // exact same fs_path). Nothing redundant.
            (canonical, None)
        }
        None => {
            // First copy of these bytes — register the blob owning them.
            sqlx::query!(
                "INSERT INTO attachment_blobs \
                 (content_hash, on_disk_path, size_bytes, created_at) \
                 VALUES (?, ?, ?, ?)",
                content_hash,
                fs_path,
                size_bytes,
                now,
            )
            .execute(&mut **tx)
            .await?;
            (fs_path.clone(), None)
        }
    };

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now).await?;

    // Insert into attachments table within same transaction. `fs_path` is the
    // canonical blob path (which may differ from the supplied path on a dedup
    // reuse), so every read/sync path resolves the shared bytes.
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
    .bind(&row_fs_path)
    .bind(now)
    .bind(&content_hash)
    .execute(&mut **tx)
    .await?;

    // Commit + fire-and-forget background cache dispatch.
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // #1993 Phase 1 — on a dedup reuse, the just-written duplicate at the
    // supplied `fs_path` is redundant (the committed row points at the
    // canonical blob path instead). Reclamation of those bytes is DEFERRED to
    // the GC pass (`cleanup_orphaned_attachments`) rather than unlinked here.
    //
    // Same reasoning as the delete path: an eager post-commit "EXISTS? then
    // remove_file" is racy on a multi-connection write pool with no global
    // write mutex — between the EXISTS check and the unlink a concurrent
    // operation could link a row to this path. The blast radius of unlinking
    // wrongly is smaller here (the path is a fresh per-add ULID), but we defer
    // for consistency and to never unlink a path a committed row may
    // reference. The GC reclaims the orphan race-free (its referenced-path
    // membership test and unlink are colocated).
    let _ = redundant_file;

    Ok(AttachmentRow {
        id: BlockId::from_trusted(&attachment_id),
        block_id,
        mime_type,
        filename,
        size_bytes,
        fs_path: row_fs_path,
        created_at: now,
        content_hash: Some(content_hash),
    })
}

/// Best-effort cleanup for bytes written by a rejected upload.
async fn cleanup_rejected_attachment(full_path: &Path) {
    match tokio::fs::remove_file(full_path).await {
        Ok(()) => {}
        Err(unlink_err) if unlink_err.kind() == std::io::ErrorKind::NotFound => {}
        Err(unlink_err) => {
            tracing::warn!(
                path = %full_path.display(),
                error = %unlink_err,
                "failed to clean up attachment bytes after add_attachment_with_bytes rejection; \
                 will be reconciled by the GC pass"
            );
        }
    }
}

/// Post-write verification of freshly-stored attachment bytes.
///
/// The backend is the sole writer, but a row must never be committed for bytes
/// that are not actually on disk, or whose on-disk length disagrees with the
/// length recorded in the row. Both conditions would commit a row pointing at
/// storage that does not match it, which later surfaces as a sync-layer
/// `MissingAttachment` or as a row whose `size_bytes` lies about the blob.
///
/// On either rejection the freshly written bytes are cleaned up, so a rejected
/// upload leaves nothing behind.
///
/// Extracted from [`add_attachment_with_bytes_inner`] so the guards are
/// directly exercisable: in production the storage path is a backend-generated
/// random ULID, so neither failure can be provoked through the public entry
/// point without racing the filesystem.
///
/// # Errors
///
/// - [`AppError::Io`] — the just-written file cannot be stat'd
/// - [`AppError::Validation`] — the on-disk length differs from `size_bytes`
pub(crate) async fn verify_written_attachment(
    full_path: &Path,
    size_bytes: i64,
) -> Result<(), AppError> {
    let metadata = match tokio::fs::metadata(full_path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            cleanup_rejected_attachment(full_path).await;
            return Err(AppError::Io(error));
        }
    };
    let on_disk_len = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    if on_disk_len != size_bytes {
        cleanup_rejected_attachment(full_path).await;
        return Err(AppError::validation(format!(
            "attachment size mismatch: expected {size_bytes} bytes, on disk is {} bytes",
            metadata.len()
        )));
    }
    Ok(())
}

/// Test-only fault-injection seam for the post-write verification guards
/// (#3435).
///
/// [`verify_written_attachment`]'s two rejections are directly unit-tested, but
/// those tests call the function, so they stay green if someone deletes the
/// `verify_written_attachment(...)` **call** from
/// [`add_attachment_with_bytes_inner`] and leaves the function itself intact —
/// and an uncalled guard is exactly as absent as a deleted one. Detecting a
/// missing call site needs a rejection provoked through the real entry point,
/// which production alone cannot produce: `size_bytes` is derived from
/// `bytes.len()` and the storage path is a freshly generated ULID, so storage
/// and the recorded length can never legitimately disagree.
///
/// This seam supplies the one thing production cannot — a blob whose on-disk
/// bytes stop matching the buffer that was hashed — by damaging the file
/// *inside* the write step, immediately after `write_attachment_file` returns
/// and before anything reads it back. It therefore models storage failing to
/// hold what was written, not a guard being called with bad arguments.
///
/// Arming is a marker file under the caller's app-data directory rather than a
/// process global: every test owns a private `TempDir`, so two tests can arm
/// different faults concurrently under both `cargo nextest` (process per test)
/// and plain `cargo test` (threads in one process) without a shared registry,
/// a lock, or cross-talk. The whole module is `#[cfg(test)]`, so no release
/// binary contains either the markers or the stat that looks for them.
#[cfg(test)]
pub(crate) mod write_fault {
    use std::path::Path;

    /// Arms "storage kept a different number of bytes than we wrote".
    const TRUNCATE_MARKER: &str = ".inject-attachment-truncate";
    /// Arms "storage lost the blob between the write and the read-back".
    const UNLINK_MARKER: &str = ".inject-attachment-unlink";

    /// Make every subsequent attachment write under `app_data_dir` leave a
    /// one-byte file on disk, so the recorded `size_bytes` cannot match it.
    pub(crate) fn arm_truncate(app_data_dir: &Path) {
        std::fs::write(app_data_dir.join(TRUNCATE_MARKER), b"")
            .expect("arm the truncate write fault");
    }

    /// Make every subsequent attachment write under `app_data_dir` vanish
    /// before the read-back, so the stat guard cannot find it.
    pub(crate) fn arm_unlink(app_data_dir: &Path) {
        std::fs::write(app_data_dir.join(UNLINK_MARKER), b"").expect("arm the unlink write fault");
    }

    /// Apply whichever fault is armed for `app_data_dir` to the blob just
    /// written at `full_path`. A no-op when nothing is armed, which is every
    /// test but the two that opt in.
    pub(crate) fn apply(app_data_dir: &Path, full_path: &Path) {
        if app_data_dir.join(TRUNCATE_MARKER).exists() {
            // One byte, not zero: the guard must be comparing lengths, not
            // testing emptiness.
            std::fs::write(full_path, b"x").expect("inject the truncate write fault");
        } else if app_data_dir.join(UNLINK_MARKER).exists() {
            std::fs::remove_file(full_path).expect("inject the unlink write fault");
        }
    }
}

/// Add an attachment by passing the raw file bytes over IPC.
///
/// The frontend reads the file into bytes (a browser `ArrayBuffer`) and hands
/// them to this command; the **backend is the sole writer** — it generates the
/// storage path, writes the bytes under `app_data_dir/attachments/`, then
/// persists the op-log + row atomically. This avoids exposing any renderer API
/// that can point an attachment row at an arbitrary app-data file.
///
/// On any failure after writing, cleanup of the freshly-written bytes is
/// attempted. A failed cleanup is logged and left for the attachment GC to
/// reconcile.
///
/// # Errors
///
/// - [`AppError::Validation`] — size exceeds 50 MB or MIME type not allowed
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
/// - [`AppError::Io`] — writing or verifying the bytes on disk failed
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
    let filename = validate_new_attachment(&filename, &mime_type, size_bytes)?;

    // Backend-generated relative storage path — the FE never supplies one.
    // #3370: minted through the same type the apply / undo / replay writers
    // coerce into and the resolvers parse, so there is exactly one definition
    // of what a stored attachment path may look like.
    let storage_id = ulid::Ulid::generate().to_string().to_uppercase();
    // No re-check follows. `for_storage_id` re-parses its own output and
    // guarantees the result is a value `parse` accepts, so a re-parse here
    // could only fail if that guarantee
    // broke — turning a constructor bug into a failed user upload rather than
    // surfacing it. The type carries the invariant; the call site does not
    // restate it (#3370 review).
    let fs_path =
        agaric_core::attachment_path::AttachmentFsPath::for_storage_id(&storage_id).into_string();

    // Write the bytes first (creates the attachments dir). `write_attachment_file`
    // is synchronous std::fs; run it on the blocking pool so a large write does
    // Not stall the async runtime (H rationale).
    //
    // #2192: we already hold the full byte buffer in memory, so hash it HERE
    // (inside the same blocking task, before the buffer is dropped) instead of
    // re-reading the file from disk only to hash the same bytes.
    // `blake3::hash(&bytes).to_hex()` is byte-identical to the disk-read hash
    // (`read_attachment_file` hashes the exact same bytes it just read back),
    // so the stored `content_hash` and the dedup key are unchanged.
    let content_hash = {
        let dir = app_data_dir.to_path_buf();
        let path = fs_path.clone();
        tokio::task::spawn_blocking(move || {
            agaric_sync::sync_files::write_attachment_file(&dir, &path, &bytes)?;
            // #3435: test-only seam (compiled out of every release binary) that
            // makes storage disagree with the buffer we are about to hash — the
            // one fault this path cannot otherwise produce, and the only way to
            // prove the post-write verification below is actually CALLED.
            #[cfg(test)]
            write_fault::apply(&dir, &dir.join(&path));
            Ok::<String, AppError>(blake3::hash(&bytes).to_hex().to_string())
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??
    };

    // Retain the post-write stat guard from the former delegated path so a row
    // is never committed if storage disappears or reports a different length.
    let full_path = app_data_dir.join(&fs_path);
    verify_written_attachment(&full_path, size_bytes).await?;

    // On ANY persistence failure, unlink the bytes we just wrote so a rejected
    // upload leaves nothing behind.
    match persist_attachment(
        pool,
        device_id,
        materializer,
        block_id,
        filename,
        mime_type,
        size_bytes,
        fs_path.clone(),
        content_hash,
    )
    .await
    {
        Ok(row) => Ok(row),
        Err(e) => {
            cleanup_rejected_attachment(&full_path).await;
            Err(e)
        }
    }
}

/// Read an attachment's metadata row by ID (#1490 export).
///
/// The markdown export carries inline images as opaque `attachment:<id>`
/// refs; the graph-export ZIP builder needs the attachment's original
/// `filename` (and `mime_type`) to emit a portable `assets/<filename>` path
/// alongside the bytes from [`read_attachment_inner`]. This is a metadata-only
/// lookup (no file read), so a missing on-disk file does not fail it — the
/// caller surfaces a byte-read failure separately and skips that asset.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment row does not exist
#[instrument(skip(pool), err)]
pub async fn read_attachment_meta_inner(
    pool: &SqlitePool,
    attachment_id: AttachmentId,
) -> Result<AttachmentRow, AppError> {
    let attachment_id_str = attachment_id.as_str();
    let row = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash \
         FROM attachments WHERE id = ?",
        attachment_id_str
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("attachment '{attachment_id}'")))?;
    Ok(row)
}

/// Read an attachment's raw bytes by ID.
///
/// The render path calls this and wraps the bytes in a `blob:` URL (the CSP
/// permits `blob:`), avoiding the asset protocol entirely.
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment row does not exist
/// - [`AppError::Io`] — the file is missing on disk or unreadable
/// [`AppError::Validation`] — the stored `fs_path` is malformed (guard)
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

    // Synchronous std::fs read on the blocking pool (H).
    let dir = app_data_dir.to_path_buf();
    let (bytes, _hash) = tokio::task::spawn_blocking(move || {
        agaric_sync::sync_files::read_attachment_file(&dir, &fs_path)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(bytes)
}

/// Delete an attachment by its ID.
///
/// Validates the attachment exists, appends a `DeleteAttachment` op (carrying
/// the captured `fs_path`), deletes from the `attachments` table, and commits.
///
/// # Byte reclamation is deferred to GC (#1993)
///
/// This command removes the attachment ROW (the *reference*) only; it does
/// NOT touch the filesystem or the `attachment_blobs` table. With
/// content-addressed dedup, many live rows may share one on-disk file, so the
/// only race-free place to unlink bytes is the GC pass
/// ([`cleanup_orphaned_attachments`](crate::materializer::handlers)) — it
/// loads the full referenced-path set and unlinks a file only if no live row
/// references it, with the check and the unlink colocated. An eager unlink
/// here would race a concurrent same-bytes ingest (no global write mutex on a
/// multi-connection write pool) and could delete a file a freshly-committed
/// row references. The op-log entry is authoritative; the bytes are reclaimed
/// by the next GC pass (boot/maintenance/materializer-periodic).
///
/// # Errors
///
/// - [`AppError::NotFound`] — attachment does not exist
#[instrument(skip(pool, device_id, materializer, _app_data_dir), err)]
pub async fn delete_attachment_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    // Retained for signature stability with the other attachment commands.
    // Byte reclamation moved to the GC pass (#1993), so this is now unused.
    _app_data_dir: &Path,
    attachment_id: AttachmentId,
) -> Result<(), AppError> {
    // Single IMMEDIATE transaction: validation + op_log + delete.
    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "delete_attachment").await?;

    // Validate attachment exists AND fetch its fs_path in one query.
    // The fs_path goes into the op-log payload (so remote peers / future
    // GC passes can reconcile). Byte reclamation is NOT done here — see the
    // post-commit comment below.
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

    let payload = OpPayload::DeleteAttachment(agaric_store::op::DeleteAttachmentPayload {
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

    // Commit + fire-and-forget background cache dispatch. The materializer
    // reads from the committed op_log entry, not from the filesystem.
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // #1993 Phase 1 — byte reclamation is DEFERRED to the GC pass
    // (`cleanup_orphaned_attachments`); we deliberately do NOT unlink the file
    // or prune the `attachment_blobs` row here.
    //
    // Rationale (delete-vs-ingest race): the write pool has >1 connection and
    // no global write mutex, so a concurrent ingest of the SAME bytes
    // (`add_attachment_with_bytes_inner`) can link a fresh `attachments` row to this file
    // between any post-commit "is it still referenced?" check and a
    // `remove_file`. An eager unlink here would then delete a file a live,
    // committed row references → data loss + a dangling reference.
    //
    // `cleanup_orphaned_attachments` reclaims bytes race-free: it loads the
    // full set of referenced `fs_path`s and unlinks each walked file ONLY if
    // its path is absent from that set, with the membership test and the
    // unlink colocated. A shared blob (N rows → 1 file) thus survives until
    // the last referencing row is gone. GC is invoked at boot/maintenance and
    // periodically by the materializer, so deferring is safe — the bytes are
    // a storage-reclamation concern, not a correctness invariant (the op-log
    // entry already records the delete authoritatively).

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
#[instrument(skip(pool, device_id, materializer, new_filename), err)]
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

    // #2989 (SECURITY): validate/normalize the new display filename, rejecting
    // path-traversal shapes (`../../evil.sh`, `..\evil`, `.`/`..`/dots-only,
    // separators, control chars, over-length) — the stored `filename` is later
    // joined to build human-readable export/ZIP paths. Replaces the old
    // empty-only check. `new_filename` is shadowed with the validated value so
    // the op payload and the UPDATE both record the trimmed form.
    let new_filename = validate_attachment_filename(&new_filename)?;

    let payload = OpPayload::RenameAttachment(agaric_store::op::RenameAttachmentPayload {
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
/// The `attachments` table declares a `deleted_at` column (see
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
/// Counts are derivable as `result[id].len()` — folded the
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
/// Replaces N per-block `list_attachments` IPCs (badge counts +
/// inline-image-render decisions) with a single batched query mounted at
/// the BlockTree level.
///
/// # Errors
///
/// - [`AppError::Validation`] — `block_ids.len()` >
///   [`agaric_store::pagination::MAX_BATCH_BLOCK_IDS`]
/// - [`AppError::Database`] — on query failure
#[instrument(skip(pool, block_ids), err)]
pub async fn list_attachments_batch_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
) -> Result<std::collections::HashMap<String, Vec<AttachmentRow>>, AppError> {
    if block_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

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
    // #3334 — via the `app_paths` seam so attachment bytes land in the SAME
    // directory boot opened `notes.db` in. A direct `app.path().app_data_dir()`
    // here would write into the real vault while a sandboxed run's database
    // lived elsewhere: rows pointing at files nobody sandboxed.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
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

/// Tauri command: read an attachment's raw bytes as a zero-copy IPC
/// [`Response`](tauri::ipc::Response).
///
/// Returns the file bytes wrapped in [`tauri::ipc::Response`] so the IPC
/// bridge ships them as a raw octet-stream body — the frontend `invoke`
/// resolves an `ArrayBuffer` with ZERO JSON encoding. The previous
/// `Result<Vec<u8>, AppError>` shape serde-serialized every byte into a JSON
/// number (`[137, 80, 78, …]`), roughly quadrupling a multi-MB image/PDF on
/// the wire and forcing a main-thread `Uint8Array` rebuild exactly on
/// scroll-into-view (#2654).
///
/// `tauri::ipc::Response` does NOT implement [`specta::Type`], so this command
/// is deliberately not a `#[specta::specta]` command and is absent from
/// `agaric_commands!` / the generated `bindings.ts`. It is registered on the
/// Tauri invoke handler directly (see `run()` in `lib.rs`) and called from the
/// hand-written `readAttachment` wrapper in `src/lib/tauri.ts` (the sanctioned
/// raw-`invoke` seam). The byte fetch itself delegates to
/// [`read_attachment_inner`].
#[tauri::command]
pub async fn read_attachment(
    app: tauri::AppHandle,
    pool: State<'_, ReadPool>,
    attachment_id: AttachmentId,
) -> Result<tauri::ipc::Response, AppError> {
    // #3334 — via the `app_paths` seam so attachment bytes land in the SAME
    // directory boot opened `notes.db` in. A direct `app.path().app_data_dir()`
    // here would write into the real vault while a sandboxed run's database
    // lived elsewhere: rows pointing at files nobody sandboxed.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    let bytes = read_attachment_inner(&pool.0, &app_data_dir, attachment_id)
        .await
        .map_err(sanitize_internal_error)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command: read an attachment's metadata row (filename, mime, etc.).
/// Delegates to [`read_attachment_meta_inner`]. Used by the graph-export ZIP
/// builder (#1490) to resolve an inline-image `attachment:<id>` ref to a
/// portable `assets/<filename>` path.
#[tauri::command]
#[specta::specta]
pub async fn read_attachment_meta(
    pool: State<'_, ReadPool>,
    attachment_id: AttachmentId,
) -> Result<AttachmentRow, AppError> {
    read_attachment_meta_inner(&pool.0, attachment_id)
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
    // #3334 — via the `app_paths` seam so attachment bytes land in the SAME
    // directory boot opened `notes.db` in. A direct `app.path().app_data_dir()`
    // here would write into the real vault while a sandboxed run's database
    // lived elsewhere: rows pointing at files nobody sandboxed.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
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
