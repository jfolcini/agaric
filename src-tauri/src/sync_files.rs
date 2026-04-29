//! Attachment file transfer over the sync protocol.
//!
//! After the op-sync phase completes (heads exchange → op streaming → merge),
//! both peers may have `AddAttachment` ops pointing to `fs_path` values that
//! don't exist locally.  This module provides the file transfer phase that
//! sends the actual attachment bytes over the existing WebSocket connection.
//!
//! **Protocol flow** (after `SyncComplete` exchange):
//!
//! 1. **Initiator** computes missing attachments, sends `FileRequest`.
//! 2. **Responder** sends `FileOffer` + binary data for each, then
//!    `FileTransferComplete`.
//! 3. **Responder** computes missing attachments, sends `FileRequest`.
//! 4. **Initiator** sends `FileOffer` + binary data for each, then
//!    `FileTransferComplete`.
//!
//! Files ≤ 5 MB are sent in a single binary frame; larger files are chunked
//! into 5 MB frames.  Integrity is verified via blake3 hash.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;

// The binary-frame chunk size used by chunked sends/receives lives in
// `crate::sync_constants::BINARY_FRAME_CHUNK_SIZE` so this module and
// `sync_daemon::snapshot_transfer` cannot drift apart.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Metadata for an attachment whose file is missing on disk.
#[derive(Debug, Clone)]
pub struct MissingAttachment {
    pub id: String,
    pub fs_path: String,
}

/// Counters returned after a file transfer phase.
#[derive(Debug, Default)]
pub struct FileTransferStats {
    pub files_sent: usize,
    pub files_received: usize,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub skipped_not_found: usize,
    pub skipped_hash_mismatch: usize,
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Validate that an attachment's stored `fs_path` is a safe relative path
/// under `app_data_dir` and return the resolved absolute path.
///
/// BUG-35: Prevents a malformed op record or corrupted row from
/// redirecting attachment reads/writes to arbitrary filesystem locations
/// via `..` traversal or absolute paths.  The threat model (`AGENTS.md`)
/// is not adversarial — sync peers are the user's own devices — but this
/// guard is a data-integrity defense against buggy frontends, bad imports
/// and corrupted metadata.
///
/// Rejects:
/// - Empty `fs_path`
/// - Absolute `fs_path` (any platform)
/// - Any `..` (`Component::ParentDir`) component anywhere in the path
/// - Any root-dir component (`/`, drive prefix on Windows)
///
/// The check is lexical so it works for paths whose target file does not
/// exist yet (required by [`write_attachment_file`]). Callers that want
/// an additional canonicalization check should do so separately.
///
/// # Errors
///
/// Returns [`AppError::Validation`] when the path escapes or is otherwise
/// malformed.
pub fn validate_attachment_fs_path(
    app_data_dir: &Path,
    fs_path: &str,
) -> Result<PathBuf, AppError> {
    check_attachment_fs_path_shape(fs_path)?;
    Ok(app_data_dir.join(fs_path))
}

/// Pure lexical check on an attachment `fs_path` — rejects absolute paths,
/// `..` traversal, root / drive prefixes, and empty strings. Exists so
/// command-layer inserts can validate without needing to know the current
/// `app_data_dir` (BUG-35). See [`validate_attachment_fs_path`] for the
/// full docs.
///
/// # Errors
///
/// Returns [`AppError::Validation`] when the path escapes or is otherwise
/// malformed.
pub fn check_attachment_fs_path_shape(fs_path: &str) -> Result<(), AppError> {
    use std::path::Component;

    if fs_path.is_empty() {
        return Err(AppError::Validation(
            "attachment path must not be empty".into(),
        ));
    }

    let candidate = Path::new(fs_path);
    if candidate.is_absolute() {
        return Err(AppError::Validation(
            "attachment path escapes app data dir".into(),
        ));
    }

    // Lexical walk: reject anything that is not a plain named component.
    // Note: PathBuf::components() normalizes interior `.` but NOT `..`,
    // so a `..` anywhere in the path will surface as `Component::ParentDir`.
    // On non-Windows, backslash-separated strings like "..\\foo" are a
    // single opaque file-name component (harmless on Linux / macOS but
    // documented in TEST-38).
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::Validation(
                    "attachment path escapes app data dir".into(),
                ));
            }
        }
    }

    Ok(())
}

/// Query the `attachments` table and return entries whose `fs_path` file
/// is missing — or corrupted — on disk under `app_data_dir`.
///
/// M-48: a file is also classified as missing when it exists on disk
/// but its length disagrees with the authoritative `attachments.size_bytes`
/// in the DB row. This catches truncated copies left behind by interrupted
/// downloads, partial writes, or antivirus quarantines that leave a 0-byte
/// stub — without that check, the existence test alone would treat the
/// stub as present forever and the next sync cycle would never re-request
/// the file. The size comparison is the cheap path; a stronger content-hash
/// verification is the deferred "better path" tracked in `REVIEW-LATER.md`.
///
/// If `metadata()` errors at all (file missing, permission denied,
/// quarantined path), the entry is classified as missing — the most
/// defensive choice per AGENTS.md's "preventing accidental corruption"
/// framing, and ensures a re-request rather than a silent skip.
pub async fn find_missing_attachments(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<Vec<MissingAttachment>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, fs_path, size_bytes FROM attachments WHERE deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;

    let mut missing = Vec::new();
    for (id, fs_path, size_bytes) in rows {
        let full_path = app_data_dir.join(&fs_path);
        // M-49: prefer the async syscall over std's blocking `Path::exists`
        // so the daemon's runtime is not stalled on cold-cache filesystems
        // (notably Android with thousands of attachments).
        //
        // M-48: cross-check the on-disk length against the DB's
        // `size_bytes`. A truncated stub (interrupted download, partial
        // write, antivirus 0-byte quarantine) would otherwise pass the
        // existence check forever. Any metadata error (incl. permission
        // denied) is treated as missing so the file is re-requested.
        match tokio::fs::metadata(&full_path).await {
            Ok(meta) => {
                let expected = u64::try_from(size_bytes).unwrap_or(0);
                if meta.len() != expected {
                    tracing::warn!(
                        attachment_id = %id,
                        path = %full_path.display(),
                        expected_size = expected,
                        actual_size = meta.len(),
                        "M-48: attachment file size disagrees with DB row; classifying as missing for re-request"
                    );
                    missing.push(MissingAttachment { id, fs_path });
                }
            }
            Err(_) => {
                missing.push(MissingAttachment { id, fs_path });
            }
        }
    }
    Ok(missing)
}

/// Look up the `fs_path` for a given attachment ID.
async fn get_attachment_fs_path(
    pool: &SqlitePool,
    attachment_id: &str,
) -> Result<Option<String>, AppError> {
    let row = sqlx::query_scalar::<_, String>("SELECT fs_path FROM attachments WHERE id = ?")
        .bind(attachment_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Metadata loaded from the `attachments` row when authorising an inbound
/// `FileOffer` (M-50, M-52).
struct AttachmentReceiveMeta {
    fs_path: String,
    /// Authoritative size from the local DB; an inbound `FileOffer` whose
    /// `size_bytes` disagrees with this value must be rejected (M-52).
    size_bytes: i64,
}

/// Look up the `fs_path` and `size_bytes` for a given attachment ID.
///
/// Combines what `get_attachment_fs_path` returns with the DB-side
/// `size_bytes` so the receiver can cross-check `FileOffer.size_bytes`
/// against the row before allocating any buffer (M-52).
async fn get_attachment_receive_meta(
    pool: &SqlitePool,
    attachment_id: &str,
) -> Result<Option<AttachmentReceiveMeta>, AppError> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT fs_path, size_bytes FROM attachments WHERE id = ?")
            .bind(attachment_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(fs_path, size_bytes)| AttachmentReceiveMeta {
        fs_path,
        size_bytes,
    }))
}

/// Read an attachment file from disk and compute its blake3 hash.
///
/// Returns `(file_bytes, blake3_hex_hash)`.
///
/// The `fs_path` is validated via [`validate_attachment_fs_path`] before
/// any I/O is performed (BUG-35). A malformed `fs_path` that attempts to
/// escape `app_data_dir` (absolute path, `..` traversal, drive prefix on
/// Windows) is rejected with [`AppError::Validation`].
pub fn read_attachment_file(
    app_data_dir: &Path,
    fs_path: &str,
) -> Result<(Vec<u8>, String), AppError> {
    let full_path = validate_attachment_fs_path(app_data_dir, fs_path)?;
    let data = std::fs::read(&full_path).map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("reading attachment {}: {e}", full_path.display()),
        ))
    })?;
    let hash = blake3::hash(&data).to_hex().to_string();
    Ok((data, hash))
}

/// Write an attachment file to disk, creating parent directories as needed.
///
/// The `fs_path` is validated via [`validate_attachment_fs_path`] before
/// any I/O is performed (BUG-35).
pub fn write_attachment_file(
    app_data_dir: &Path,
    fs_path: &str,
    data: &[u8],
) -> Result<(), AppError> {
    let full_path = validate_attachment_fs_path(app_data_dir, fs_path)?;
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Io(std::io::Error::new(
                e.kind(),
                format!("creating directory {}: {e}", parent.display()),
            ))
        })?;
    }
    std::fs::write(&full_path, data).map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("writing attachment {}: {e}", full_path.display()),
        ))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// File transfer protocol — sender side
// ---------------------------------------------------------------------------

/// Send files requested by the remote peer.
///
/// 1. Receive `FileRequest` from the remote peer.
/// 2. For each requested attachment: send `FileOffer` + binary data.
/// 3. Send `FileTransferComplete`.
///
/// M-47: at the start of every per-file iteration, the cancel flag is
/// checked. If the user invoked `cancel_active_sync()` during the
/// transfer, we break out of the per-file loop and fall through to the
/// existing `FileTransferComplete` send — the receiver sees a clean
/// "no more files" signal and exits its own loop without protocol error
/// (the wire format is unchanged: `FileTransferComplete` already means
/// "I'm done sending"). Cancel is checked between files, not per chunk,
/// because the per-chunk inner loop is in a private helper and the
/// granularity at the file boundary already lets a multi-gigabyte
/// transfer be aborted before the *next* file starts.
pub async fn receive_request_and_send_files(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
    cancel: &AtomicBool,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // 1. Receive FileRequest
    let msg: SyncMessage = conn.recv_json().await?;
    let attachment_ids = match msg {
        SyncMessage::FileRequest { attachment_ids } => attachment_ids,
        SyncMessage::FileTransferComplete => {
            // Remote has no missing files — nothing to do.
            // But we still need to send our own FileTransferComplete.
            conn.send_json(&SyncMessage::FileTransferComplete).await?;
            return Ok(stats);
        }
        other => {
            tracing::warn!(
                "expected FileRequest during file transfer, got {:?}",
                std::mem::discriminant(&other)
            );
            // Graceful degradation: skip file transfer
            return Ok(stats);
        }
    };

    // 2. For each requested attachment: send FileOffer + binary data
    for attachment_id in &attachment_ids {
        // M-47: stop sending more files when the user cancels mid-round.
        // Falls through to the FileTransferComplete send below so the
        // receiver exits cleanly via the normal "no more files" sentinel.
        if cancel.load(Ordering::Acquire) {
            tracing::info!(
                "M-47: cancel observed during send loop; stopping after {} of {} files",
                stats.files_sent,
                attachment_ids.len()
            );
            break;
        }
        let Some(fs_path) = get_attachment_fs_path(pool, attachment_id).await? else {
            tracing::warn!(
                attachment_id,
                "requested attachment not found in DB, skipping"
            );
            stats.skipped_not_found += 1;
            continue;
        };

        let (data, hash) = match read_attachment_file(app_data_dir, &fs_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    attachment_id,
                    error = %e,
                    "could not read attachment file, skipping"
                );
                stats.skipped_not_found += 1;
                continue;
            }
        };

        let size_bytes = data.len() as u64;

        // Send FileOffer metadata
        conn.send_json(&SyncMessage::FileOffer {
            attachment_id: attachment_id.clone(),
            size_bytes,
            blake3_hash: hash,
        })
        .await?;

        // Send binary data (chunked if > BINARY_FRAME_CHUNK_SIZE).
        // Empty data is delivered as a single empty frame so the
        // receiver's per-frame accounting terminates cleanly — see
        // `SyncConnection::send_binary_chunked` for the shared contract.
        conn.send_binary_chunked(&data, BINARY_FRAME_CHUNK_SIZE)
            .await?;

        // Wait for FileReceived acknowledgment
        let ack: SyncMessage = conn.recv_json().await?;
        match ack {
            SyncMessage::FileReceived {
                attachment_id: ref ack_id,
            } if ack_id == attachment_id => {
                stats.files_sent += 1;
                stats.bytes_sent += size_bytes;
            }
            other => {
                tracing::warn!(
                    attachment_id,
                    "expected FileReceived, got {:?}",
                    std::mem::discriminant(&other)
                );
            }
        }
    }

    // 3. Send FileTransferComplete
    conn.send_json(&SyncMessage::FileTransferComplete).await?;

    Ok(stats)
}

// ---------------------------------------------------------------------------
// File transfer protocol — receiver side
// ---------------------------------------------------------------------------

/// Request and receive files from the remote peer.
///
/// 1. Compute which attachment files are missing locally.
/// 2. Send `FileRequest` with the missing attachment IDs.
/// 3. Receive `FileOffer` + binary data for each, verify, and write to disk.
/// 4. Until `FileTransferComplete` is received.
///
/// M-47: at the start of every iteration of the receive loop (before
/// `recv_json()` for the next `FileOffer`/`FileTransferComplete`), the
/// cancel flag is checked. If set, we break and return the partial
/// stats. The remote sender will hit a broken-pipe / connection-close
/// when its next `send_json` or `send_binary` attempt fails — that
/// surfaces as a non-fatal warning on the sender side; the next sync
/// cycle re-attempts the missing files. The wire format is unchanged
/// (no new message variants).
pub async fn request_and_receive_files(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
    cancel: &AtomicBool,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // 1. Find missing attachments
    let missing = find_missing_attachments(pool, app_data_dir).await?;
    let ids: Vec<String> = missing.iter().map(|m| m.id.clone()).collect();

    if ids.is_empty() {
        tracing::debug!("no missing attachment files, sending empty FileRequest");
    }

    // 2. Send FileRequest
    conn.send_json(&SyncMessage::FileRequest {
        attachment_ids: ids,
    })
    .await?;

    // 3. Receive files until FileTransferComplete
    //
    // M-50: a `FileReceived` ACK is sent ONLY after the file has been
    // hash-verified AND written to disk. Any failure on the offer (size
    // disagreement with the DB row, hash mismatch, write failure)
    // returns `Err` so the connection is closed and the daemon retries
    // on the next sync cycle. Stats counters reflect actual receiver
    // outcomes, never optimistic ACKs.
    loop {
        // M-47: check cancel before reading the next FileOffer. Granularity
        // is per-file (not per-chunk) because the per-chunk inner read
        // lives in `receive_binary_data`; aborting between files lets
        // multi-gigabyte transfers be interrupted before the *next* file
        // starts streaming.
        if cancel.load(Ordering::Acquire) {
            tracing::info!(
                files_received = stats.files_received,
                "M-47: cancel observed during receive loop; aborting before next FileOffer"
            );
            break;
        }
        let msg: SyncMessage = conn.recv_json().await?;
        match msg {
            SyncMessage::FileOffer {
                attachment_id,
                size_bytes,
                blake3_hash,
            } => {
                // Look up fs_path + DB size_bytes for this attachment
                let Some(meta) = get_attachment_receive_meta(pool, &attachment_id).await? else {
                    tracing::warn!(
                        attachment_id,
                        "received file offer for unknown attachment, skipping binary data"
                    );
                    // Still need to consume the binary data
                    consume_binary_data(conn, size_bytes).await?;
                    continue;
                };

                // M-52: cross-check the offer's size_bytes against the
                // authoritative DB row. A mismatch is a sender bug
                // (`u32` truncation, wrong file picked up), so reject
                // the offer without writing anything and return Err so
                // the daemon retries.
                let expected_size_u64 = u64::try_from(meta.size_bytes).unwrap_or(0);
                if size_bytes != expected_size_u64 {
                    tracing::error!(
                        attachment_id,
                        expected_size = meta.size_bytes,
                        offered_size = size_bytes,
                        "FileOffer size_bytes disagrees with attachments DB row, rejecting without ACK"
                    );
                    return Err(AppError::InvalidOperation(format!(
                        "file_offer.size_mismatch: attachment {attachment_id} expected {} bytes, peer offered {size_bytes}",
                        meta.size_bytes
                    )));
                }

                // Receive binary data (may be chunked)
                let data = receive_binary_data(conn, size_bytes).await?;

                // M-50: Verify blake3 hash. Mismatch ⇒ no ACK, return
                // Err so the daemon closes the connection and retries.
                let actual_hash = blake3::hash(&data).to_hex().to_string();
                if actual_hash != blake3_hash {
                    tracing::error!(
                        attachment_id,
                        expected = blake3_hash,
                        actual = actual_hash,
                        "blake3 hash mismatch for received file, rejecting without ACK"
                    );
                    return Err(AppError::InvalidOperation(format!(
                        "file_offer.hash_mismatch: attachment {attachment_id} expected {blake3_hash}, got {actual_hash}"
                    )));
                }

                // M-50: Write file to disk. On failure, no ACK, return
                // Err so the daemon retries the file later.
                if let Err(e) = write_attachment_file(app_data_dir, &meta.fs_path, &data) {
                    tracing::error!(
                        attachment_id,
                        error = %e,
                        "failed to write attachment file, rejecting without ACK"
                    );
                    return Err(e);
                }

                stats.files_received += 1;
                stats.bytes_received += data.len() as u64;

                // Only after successful write + hash verify do we ACK.
                conn.send_json(&SyncMessage::FileReceived { attachment_id })
                    .await?;
            }
            SyncMessage::FileTransferComplete => {
                tracing::debug!("received FileTransferComplete from remote");
                break;
            }
            other => {
                tracing::warn!(
                    "unexpected message during file receive: {:?}",
                    std::mem::discriminant(&other)
                );
                break;
            }
        }
    }

    Ok(stats)
}

/// Receive binary data for a file, accumulating chunks until the expected
/// size is reached.
///
/// Thin wrapper around
/// [`SyncConnection::receive_binary_chunked`] so the chunking contract
/// (zero-byte payload as a single empty frame, over-run rejection) is
/// shared with [`crate::sync_daemon::snapshot_transfer`] rather than
/// duplicated here.
async fn receive_binary_data(
    conn: &mut SyncConnection,
    size_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    conn.receive_binary_chunked(size_bytes).await
}

/// Consume and discard binary data for a file we don't need.
///
/// Mirrors [`SyncConnection::send_binary_chunked`]: a zero-byte payload
/// is delivered as a single empty frame, so when `size_bytes == 0` we
/// still drain exactly one frame off the wire to keep the receiver's
/// frame pointer aligned with the sender's.
async fn consume_binary_data(conn: &mut SyncConnection, size_bytes: u64) -> Result<(), AppError> {
    if size_bytes == 0 {
        let _ = conn.recv_binary().await?;
        return Ok(());
    }
    let mut received = 0u64;
    while received < size_bytes {
        let chunk = conn.recv_binary().await?;
        received += chunk.len() as u64;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Top-level file transfer orchestrator
// ---------------------------------------------------------------------------

/// Run the complete bidirectional file transfer phase.
///
/// Called by the **initiator** after `SyncComplete` exchange:
/// 1. Initiator requests files it's missing.
/// 2. Initiator responds to responder's file request.
///
/// M-47: `cancel` is checked at every per-file boundary inside both
/// helper functions. When set mid-transfer the receiver loop exits early
/// (partial stats returned) and the sender loop falls through to the
/// existing `FileTransferComplete` sentinel — both without changing the
/// wire format.
pub async fn run_file_transfer_initiator(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
    cancel: &AtomicBool,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // Phase 1: Request our missing files from responder
    let recv_stats = request_and_receive_files(conn, pool, app_data_dir, cancel).await?;
    stats.files_received += recv_stats.files_received;
    stats.bytes_received += recv_stats.bytes_received;
    stats.skipped_hash_mismatch += recv_stats.skipped_hash_mismatch;
    stats.skipped_not_found += recv_stats.skipped_not_found;

    // Phase 2: Respond to responder's file request
    let send_stats = receive_request_and_send_files(conn, pool, app_data_dir, cancel).await?;
    stats.files_sent += send_stats.files_sent;
    stats.bytes_sent += send_stats.bytes_sent;
    stats.skipped_not_found += send_stats.skipped_not_found;
    stats.skipped_hash_mismatch += send_stats.skipped_hash_mismatch;

    if stats.files_received > 0 || stats.files_sent > 0 {
        tracing::info!(
            files_received = stats.files_received,
            files_sent = stats.files_sent,
            bytes_received = stats.bytes_received,
            bytes_sent = stats.bytes_sent,
            "file transfer complete"
        );
    }

    Ok(stats)
}

/// Run the complete bidirectional file transfer phase.
///
/// Called by the **responder** after `SyncComplete` exchange:
/// 1. Responder sends files the initiator requested.
/// 2. Responder requests files it's missing.
///
/// M-47: `cancel` is threaded through to the inner per-file loops. See
/// the matching docs on [`run_file_transfer_initiator`] for the rationale
/// and protocol-compatibility notes.
pub async fn run_file_transfer_responder(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
    cancel: &AtomicBool,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // Phase 1: Respond to initiator's file request
    let send_stats = receive_request_and_send_files(conn, pool, app_data_dir, cancel).await?;
    stats.files_sent += send_stats.files_sent;
    stats.bytes_sent += send_stats.bytes_sent;
    stats.skipped_not_found += send_stats.skipped_not_found;
    stats.skipped_hash_mismatch += send_stats.skipped_hash_mismatch;

    // Phase 2: Request our missing files from initiator
    let recv_stats = request_and_receive_files(conn, pool, app_data_dir, cancel).await?;
    stats.files_received += recv_stats.files_received;
    stats.bytes_received += recv_stats.bytes_received;
    stats.skipped_hash_mismatch += recv_stats.skipped_hash_mismatch;
    stats.skipped_not_found += recv_stats.skipped_not_found;

    if stats.files_received > 0 || stats.files_sent > 0 {
        tracing::info!(
            files_received = stats.files_received,
            files_sent = stats.files_sent,
            bytes_received = stats.bytes_received,
            bytes_sent = stats.bytes_sent,
            "file transfer complete"
        );
    }

    Ok(stats)
}

/// Derive the application data directory from the SQLite pool.
///
/// The pool connects to a database file (e.g. `/path/to/app_data/notes.db`);
/// the parent directory of that file is the app data dir where attachments
/// are stored.
pub async fn app_data_dir_from_pool(pool: &SqlitePool) -> Result<PathBuf, AppError> {
    let row: (String,) =
        sqlx::query_as("SELECT file FROM pragma_database_list WHERE name = 'main'")
            .fetch_one(pool)
            .await?;
    let db_path = PathBuf::from(&row.0);
    db_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| {
            AppError::InvalidOperation("cannot determine app data dir from database path".into())
        })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests;
