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
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    // ── find_missing_attachments ─────────────────────────────────────────

    #[tokio::test]
    async fn find_missing_returns_ids_for_missing_files() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        // Insert a block first (FK constraint)
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert an attachment whose file does NOT exist on disk
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT1', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/att1.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert another attachment whose file DOES exist; `size_bytes`
        // must match the on-disk length so M-48's size check accepts it.
        let existing_path = dir.path().join("attachments");
        std::fs::create_dir_all(&existing_path).unwrap();
        let existing_bytes: &[u8] = b"fake image data"; // 15 bytes
        std::fs::write(existing_path.join("att2.png"), existing_bytes).unwrap();

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 15, 'attachments/att2.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        assert_eq!(missing.len(), 1, "only one attachment should be missing");
        assert_eq!(missing[0].id, "ATT1");
        assert_eq!(missing[0].fs_path, "attachments/att1.png");
    }

    #[tokio::test]
    async fn find_missing_excludes_deleted_attachments() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Deleted attachment — should NOT appear in missing list
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at) \
             VALUES ('ATT_DEL', 'BLK1', 'image/png', 'deleted.png', 100, 'attachments/deleted.png', '2025-01-15T12:00:00Z', '2025-01-16T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        assert!(missing.is_empty(), "deleted attachments should be excluded");
    }

    #[tokio::test]
    async fn find_missing_empty_db() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        assert!(
            missing.is_empty(),
            "empty DB should have no missing attachments"
        );
    }

    // ── read_attachment_file ─────────────────────────────────────────────

    #[test]
    fn read_file_returns_data_and_hash() {
        let dir = TempDir::new().unwrap();
        let att_dir = dir.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();

        let content = b"hello world attachment data";
        std::fs::write(att_dir.join("test.png"), content).unwrap();

        let (data, hash) = read_attachment_file(dir.path(), "attachments/test.png").unwrap();
        assert_eq!(data, content);
        assert_eq!(hash.len(), 64, "blake3 hash should be 64 hex chars");

        // Verify hash is correct
        let expected_hash = blake3::hash(content).to_hex().to_string();
        assert_eq!(hash, expected_hash);
    }

    #[test]
    fn read_file_not_found() {
        let dir = TempDir::new().unwrap();
        let result = read_attachment_file(dir.path(), "attachments/nonexistent.png");
        assert!(result.is_err(), "reading nonexistent file should fail");
    }

    // ── write_attachment_file ────────────────────────────────────────────

    #[test]
    fn write_file_creates_directories_and_writes() {
        let dir = TempDir::new().unwrap();
        let content = b"test attachment content";

        write_attachment_file(dir.path(), "attachments/subdir/test.png", content).unwrap();

        let full_path = dir.path().join("attachments/subdir/test.png");
        assert!(full_path.exists(), "file should exist after write");
        assert_eq!(std::fs::read(&full_path).unwrap(), content);
    }

    #[test]
    fn write_file_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        let att_dir = dir.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("test.png"), b"old data").unwrap();

        write_attachment_file(dir.path(), "attachments/test.png", b"new data").unwrap();
        assert_eq!(
            std::fs::read(att_dir.join("test.png")).unwrap(),
            b"new data"
        );
    }

    // ── blake3 hash verification ─────────────────────────────────────────

    #[test]
    fn hash_verification_detects_corruption() {
        let data = b"original file content";
        let hash = blake3::hash(data).to_hex().to_string();

        // Correct data → hash matches
        let actual = blake3::hash(data).to_hex().to_string();
        assert_eq!(actual, hash);

        // Corrupted data → hash mismatch
        let corrupted = b"corrupted file content";
        let bad_hash = blake3::hash(corrupted).to_hex().to_string();
        assert_ne!(bad_hash, hash, "corrupted data must produce different hash");
    }

    // ── app_data_dir_from_pool ───────────────────────────────────────────

    #[tokio::test]
    async fn app_data_dir_from_pool_resolves_correctly() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        let resolved = app_data_dir_from_pool(&pool).await.unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            dir.path().canonicalize().unwrap(),
            "resolved app_data_dir should match the temp directory"
        );
    }

    // ── get_attachment_fs_path ────────────────────────────────────────────

    #[tokio::test]
    async fn get_fs_path_returns_path_for_existing_attachment() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT1', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/att1.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let path = get_attachment_fs_path(&pool, "ATT1").await.unwrap();
        assert_eq!(path.as_deref(), Some("attachments/att1.png"));

        let none = get_attachment_fs_path(&pool, "NONEXISTENT").await.unwrap();
        assert!(none.is_none());
    }

    // ── read + write round-trip ──────────────────────────────────────────

    #[test]
    fn write_then_read_roundtrip_preserves_data() {
        let dir = TempDir::new().unwrap();
        let original = b"binary attachment data \x00\x01\x02\xFF";

        write_attachment_file(dir.path(), "attachments/roundtrip.bin", original).unwrap();
        let (data, hash) = read_attachment_file(dir.path(), "attachments/roundtrip.bin").unwrap();

        assert_eq!(data, original, "data must survive write→read roundtrip");
        let expected_hash = blake3::hash(original).to_hex().to_string();
        assert_eq!(hash, expected_hash, "hash must match after roundtrip");
    }

    // ── empty file handling ──────────────────────────────────────────────

    #[test]
    fn write_and_read_empty_file() {
        let dir = TempDir::new().unwrap();
        write_attachment_file(dir.path(), "attachments/empty.bin", b"").unwrap();
        let (data, hash) = read_attachment_file(dir.path(), "attachments/empty.bin").unwrap();
        assert!(data.is_empty(), "empty file should read as empty");
        let expected_hash = blake3::hash(b"").to_hex().to_string();
        assert_eq!(hash, expected_hash, "empty file hash should match");
    }

    // ── large file handling ──────────────────────────────────────────────

    #[test]
    fn write_and_read_large_file() {
        let dir = TempDir::new().unwrap();
        // 1 MB file
        let data = vec![0xABu8; 1_000_000];
        write_attachment_file(dir.path(), "attachments/large.bin", &data).unwrap();
        let (read_data, hash) = read_attachment_file(dir.path(), "attachments/large.bin").unwrap();
        assert_eq!(read_data.len(), 1_000_000);
        assert_eq!(read_data, data);
        let expected_hash = blake3::hash(&data).to_hex().to_string();
        assert_eq!(hash, expected_hash);
    }

    // ── BINARY_FRAME_CHUNK_SIZE constant ────────────────────────────────

    #[test]
    fn file_chunk_size_is_under_max_msg_size() {
        // MAX_MSG_SIZE in SyncConnection is 10_000_000 (10 MB).
        // The shared chunk-size constant lives in `crate::sync_constants`.
        const _: () = assert!(
            BINARY_FRAME_CHUNK_SIZE < 10_000_000,
            "BINARY_FRAME_CHUNK_SIZE must be under the 10 MB WebSocket frame limit"
        );
        assert_eq!(
            BINARY_FRAME_CHUNK_SIZE, 5_000_000,
            "BINARY_FRAME_CHUNK_SIZE should be 5 MB"
        );
    }

    // ── find_missing_attachments with multiple missing ───────────────────

    #[tokio::test]
    async fn find_missing_returns_all_missing_attachments() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert 3 attachments, all with missing files
        for i in 1..=3 {
            sqlx::query(
                "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                 VALUES (?, 'BLK1', 'image/png', ?, 100, ?, '2025-01-15T12:00:00Z')",
            )
            .bind(format!("ATT{i}"))
            .bind(format!("file{i}.png"))
            .bind(format!("attachments/att{i}.png"))
            .execute(&pool)
            .await
            .unwrap();
        }

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        assert_eq!(missing.len(), 3, "all 3 attachments should be missing");
    }

    // ── M-48: truncated / partial file detection ─────────────────────────

    /// M-48: a file that exists on disk but is shorter than the DB's
    /// `size_bytes` (e.g. interrupted download, antivirus 0-byte stub,
    /// partial write) MUST be re-classified as missing so the next sync
    /// cycle re-requests it. Before the fix, `Path::exists()` alone
    /// short-circuited the check and the truncated stub was treated as
    /// present forever.
    #[tokio::test]
    async fn find_missing_attachments_treats_truncated_file_as_missing_m48() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // DB row claims size 1024 bytes...
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT_TRUNC', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/trunc.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // ...but the on-disk stub is 0 bytes (interrupted download /
        // antivirus quarantine / partial write).
        let att_dir = dir.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("trunc.png"), b"").unwrap();

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();

        assert!(
            missing.iter().any(|m| m.id == "ATT_TRUNC"),
            "M-48: truncated file (0 bytes vs DB's 1024) must be re-requested; got {missing:?}",
        );
    }

    // ── SyncMessage serde roundtrip for file transfer variants ───────────

    #[test]
    fn file_request_serde_roundtrip() {
        let msg = SyncMessage::FileRequest {
            attachment_ids: vec!["ATT1".into(), "ATT2".into(), "ATT3".into()],
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, msg, "FileRequest must survive serde roundtrip");
        assert!(
            json.contains("\"type\":\"FileRequest\""),
            "must contain type tag"
        );
    }

    #[test]
    fn file_offer_serde_roundtrip() {
        let msg = SyncMessage::FileOffer {
            attachment_id: "ATT1".into(),
            size_bytes: 1_048_576,
            blake3_hash: "a".repeat(64),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, msg, "FileOffer must survive serde roundtrip");
    }

    #[test]
    fn file_received_serde_roundtrip() {
        let msg = SyncMessage::FileReceived {
            attachment_id: "ATT1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, msg, "FileReceived must survive serde roundtrip");
    }

    #[test]
    fn file_transfer_complete_serde_roundtrip() {
        let msg = SyncMessage::FileTransferComplete;
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed, msg,
            "FileTransferComplete must survive serde roundtrip"
        );
    }

    #[test]
    fn file_request_empty_ids_serde_roundtrip() {
        let msg = SyncMessage::FileRequest {
            attachment_ids: vec![],
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed, msg,
            "FileRequest with empty ids must survive roundtrip"
        );
    }

    #[test]
    fn file_offer_zero_size_serde_roundtrip() {
        let msg = SyncMessage::FileOffer {
            attachment_id: "ATT1".into(),
            size_bytes: 0,
            blake3_hash: "b".repeat(64),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed, msg,
            "FileOffer with zero size must survive roundtrip"
        );
    }

    // ── FileTransferStats default ────────────────────────────────────────

    #[test]
    fn file_transfer_stats_defaults_to_zero() {
        let stats = FileTransferStats::default();
        assert_eq!(stats.files_sent, 0);
        assert_eq!(stats.files_received, 0);
        assert_eq!(stats.bytes_sent, 0);
        assert_eq!(stats.bytes_received, 0);
        assert_eq!(stats.skipped_not_found, 0);
        assert_eq!(stats.skipped_hash_mismatch, 0);
    }

    // ── MissingAttachment clone ──────────────────────────────────────────

    #[test]
    fn missing_attachment_is_cloneable_and_debuggable() {
        let ma = MissingAttachment {
            id: "ATT1".into(),
            fs_path: "attachments/att1.png".into(),
        };
        let clone = ma.clone();
        assert_eq!(clone.id, ma.id);
        assert_eq!(clone.fs_path, ma.fs_path);
        // Debug impl check
        let debug = format!("{:?}", ma);
        assert!(debug.contains("ATT1"));
    }

    // ── File transfer protocol integration tests ─────────────────────────

    /// Install the `ring` CryptoProvider for rustls (idempotent).
    fn install_crypto_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    /// Set up a TLS server/client pair and return both connections + server handle.
    async fn setup_tls_pair() -> (SyncConnection, SyncConnection, crate::sync_net::SyncServer) {
        use crate::sync_net::{connect_to_peer, generate_self_signed_cert, SyncServer};

        install_crypto_provider();
        let server_cert = generate_self_signed_cert("responder").unwrap();
        let client_cert = generate_self_signed_cert("initiator").unwrap();

        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));

        let (server, port) = SyncServer::start(&server_cert, move |conn| {
            if let Some(sender) = tx.lock().unwrap().take() {
                let _ = sender.send(conn);
            }
        })
        .await
        .unwrap();

        let client_conn = connect_to_peer(&format!("127.0.0.1:{port}"), None, None, &client_cert)
            .await
            .unwrap();

        let server_conn = rx.await.unwrap();
        (server_conn, client_conn, server)
    }

    /// Insert a block + attachment record for protocol tests.
    async fn insert_test_attachment(pool: &SqlitePool, att_id: &str, fs_path: &str, size: i64) {
        let blk_id = format!("BLK_{att_id}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'test')")
            .bind(&blk_id)
            .execute(pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'application/octet-stream', 'file.bin', ?, ?, datetime('now'))",
        )
        .bind(att_id)
        .bind(&blk_id)
        .bind(size)
        .bind(fs_path)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_initiator_requests_and_receives_files() {
        let initiator_dir = TempDir::new().unwrap();
        let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
            .await
            .unwrap();

        let responder_dir = TempDir::new().unwrap();
        let responder_pool = init_pool(&responder_dir.path().join("test.db"))
            .await
            .unwrap();

        let file_data = b"test photo data for protocol transfer";
        let expected_hash = blake3::hash(file_data).to_hex().to_string();

        // Both DBs have the same attachment record
        insert_test_attachment(
            &initiator_pool,
            "ATT01",
            "attachments/photo.jpg",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/photo.jpg",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;

        // File exists ONLY on the responder side
        write_attachment_file(responder_dir.path(), "attachments/photo.jpg", file_data).unwrap();
        assert!(!initiator_dir.path().join("attachments/photo.jpg").exists());

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let cancel_resp = AtomicBool::new(false);
        let cancel_init = AtomicBool::new(false);
        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(
                &mut server_conn,
                &responder_pool,
                responder_dir.path(),
                &cancel_resp
            ),
            request_and_receive_files(
                &mut client_conn,
                &initiator_pool,
                initiator_dir.path(),
                &cancel_init
            ),
        );

        let sender_stats = responder_result.unwrap();
        let receiver_stats = initiator_result.unwrap();

        // File now exists in initiator's dir with correct data and hash
        let (data, hash) =
            read_attachment_file(initiator_dir.path(), "attachments/photo.jpg").unwrap();
        assert_eq!(data, file_data);
        assert_eq!(hash, expected_hash);

        // Stats
        assert_eq!(receiver_stats.files_received, 1);
        assert_eq!(
            receiver_stats.bytes_received,
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64")
        );
        assert_eq!(sender_stats.files_sent, 1);
        assert_eq!(
            sender_stats.bytes_sent,
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64")
        );

        server.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_empty_transfer_when_no_missing_files() {
        let initiator_dir = TempDir::new().unwrap();
        let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
            .await
            .unwrap();

        let responder_dir = TempDir::new().unwrap();
        let responder_pool = init_pool(&responder_dir.path().join("test.db"))
            .await
            .unwrap();

        let file_data = b"already present on both sides";

        insert_test_attachment(
            &initiator_pool,
            "ATT01",
            "attachments/photo.jpg",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/photo.jpg",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;

        // File exists on BOTH sides → nothing to transfer
        write_attachment_file(initiator_dir.path(), "attachments/photo.jpg", file_data).unwrap();
        write_attachment_file(responder_dir.path(), "attachments/photo.jpg", file_data).unwrap();

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let cancel_resp = AtomicBool::new(false);
        let cancel_init = AtomicBool::new(false);
        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(
                &mut server_conn,
                &responder_pool,
                responder_dir.path(),
                &cancel_resp
            ),
            request_and_receive_files(
                &mut client_conn,
                &initiator_pool,
                initiator_dir.path(),
                &cancel_init
            ),
        );

        let sender_stats = responder_result.unwrap();
        let receiver_stats = initiator_result.unwrap();

        assert_eq!(receiver_stats.files_received, 0);
        assert_eq!(receiver_stats.bytes_received, 0);
        assert_eq!(sender_stats.files_sent, 0);
        assert_eq!(sender_stats.bytes_sent, 0);
        assert_eq!(receiver_stats.skipped_hash_mismatch, 0);

        server.shutdown().await;
    }

    /// M-50: hash mismatch must NOT ACK and must surface an Err so the
    /// daemon closes the connection and retries on the next cycle. The
    /// receiver writes nothing to disk.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_hash_mismatch_no_ack_returns_err() {
        let initiator_dir = TempDir::new().unwrap();
        let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
            .await
            .unwrap();

        let file_data = b"the actual file content";
        let wrong_hash = "0".repeat(64); // deliberately wrong

        // Initiator has the attachment record but NOT the file on disk
        insert_test_attachment(
            &initiator_pool,
            "ATT01",
            "attachments/photo.jpg",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        // Responder side: manually drive the protocol with a bad hash and
        // assert that no FileReceived ACK is delivered before the
        // connection drops.
        let server_side = async move {
            // 1. Receive FileRequest
            let msg: SyncMessage = server_conn.recv_json().await.unwrap();
            match msg {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert_eq!(attachment_ids, vec!["ATT01".to_string()]);
                }
                other => panic!("expected FileRequest, got {other:?}"),
            }

            // 2. Send FileOffer with WRONG blake3_hash
            server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT01".into(),
                    size_bytes: u64::try_from(file_data.len())
                        .expect("invariant: test fixture file size fits in u64"),
                    blake3_hash: wrong_hash,
                })
                .await
                .unwrap();

            // 3. Send binary data
            server_conn.send_binary(file_data).await.unwrap();

            // 4. Confirm we never receive a FileReceived ACK — the
            //    receiver must drop the connection (or we'll time out).
            let ack: Result<SyncMessage, _> = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                server_conn.recv_json::<SyncMessage>(),
            )
            .await
            .unwrap_or_else(|_| Err(AppError::InvalidOperation("recv_json timed out".into())));
            assert!(
                !matches!(ack, Ok(SyncMessage::FileReceived { .. })),
                "M-50: receiver must NOT send FileReceived ACK on hash mismatch (got {ack:?})"
            );
        };

        let cancel_init = AtomicBool::new(false);
        let (_, initiator_result) = tokio::join!(
            server_side,
            request_and_receive_files(
                &mut client_conn,
                &initiator_pool,
                initiator_dir.path(),
                &cancel_init
            ),
        );

        // M-50: receiver returns Err so the daemon's `try_sync_with_peer`
        // records a failure and reconnects.
        assert!(
            initiator_result.is_err(),
            "M-50: hash mismatch must surface as Err, got Ok"
        );

        // File must NOT have been written.
        assert!(
            !initiator_dir.path().join("attachments/photo.jpg").exists(),
            "corrupt file must not be written to disk"
        );

        server.shutdown().await;
    }

    /// M-52: a `FileOffer` whose `size_bytes` disagrees with the local
    /// `attachments.size_bytes` row must be rejected without an ACK.
    /// The function returns `Err` and never reads the binary stream.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_size_mismatch_no_ack_returns_err() {
        let initiator_dir = TempDir::new().unwrap();
        let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
            .await
            .unwrap();

        // Local DB says the attachment is 100 bytes — peer will lie and
        // say 200 bytes (a sender-side bug — `u32` truncation regression).
        let stored_size: i64 = 100;
        insert_test_attachment(
            &initiator_pool,
            "ATT_SIZE",
            "attachments/sizecheck.bin",
            stored_size,
        )
        .await;

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let server_side = async move {
            let msg: SyncMessage = server_conn.recv_json().await.unwrap();
            match msg {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert_eq!(attachment_ids, vec!["ATT_SIZE".to_string()]);
                }
                other => panic!("expected FileRequest, got {other:?}"),
            }

            // Lie about the size — DB has 100 bytes, peer claims 200.
            // Hash is correct for the (truthful) bytes but it doesn't
            // matter because the size check rejects the offer first.
            let bytes = vec![0xAAu8; 200];
            let hash = blake3::hash(&bytes).to_hex().to_string();
            server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT_SIZE".into(),
                    size_bytes: 200,
                    blake3_hash: hash,
                })
                .await
                .unwrap();

            // Confirm no ACK arrives — the receiver returns Err before
            // touching the stream so the connection drops.
            let ack: Result<SyncMessage, _> = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                server_conn.recv_json::<SyncMessage>(),
            )
            .await
            .unwrap_or_else(|_| Err(AppError::InvalidOperation("recv_json timed out".into())));
            assert!(
                !matches!(ack, Ok(SyncMessage::FileReceived { .. })),
                "M-52: receiver must NOT send FileReceived ACK on size mismatch (got {ack:?})"
            );
        };

        let cancel_init = AtomicBool::new(false);
        let (_, initiator_result) = tokio::join!(
            server_side,
            request_and_receive_files(
                &mut client_conn,
                &initiator_pool,
                initiator_dir.path(),
                &cancel_init
            ),
        );

        let err = initiator_result.expect_err("M-52 must return Err on size mismatch");
        let msg = err.to_string();
        assert!(
            msg.contains("file_offer.size_mismatch"),
            "M-52: error message should be tagged file_offer.size_mismatch, got {msg}"
        );

        // File must NOT have been written.
        assert!(
            !initiator_dir
                .path()
                .join("attachments/sizecheck.bin")
                .exists(),
            "rejected size-mismatched file must not be written to disk"
        );

        server.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_large_file_chunking() {
        let initiator_dir = TempDir::new().unwrap();
        let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
            .await
            .unwrap();

        let responder_dir = TempDir::new().unwrap();
        let responder_pool = init_pool(&responder_dir.path().join("test.db"))
            .await
            .unwrap();

        // File larger than BINARY_FRAME_CHUNK_SIZE (5 MB) → will be chunked.
        // 6 MB total guarantees at least one extra chunk.
        let file_size = BINARY_FRAME_CHUNK_SIZE + 1_000_000;
        // `i % 256` is always in 0..256 so the `as u8` cast is exact, but
        // clippy can't prove that through the modulo on `usize`. Allow the
        // lint narrowly here rather than rewriting the deterministic byte
        // pattern with `try_from(...).expect(...)` boilerplate.
        #[allow(clippy::cast_possible_truncation)]
        let file_data: Vec<u8> = (0..file_size).map(|i| (i % 256) as u8).collect();
        let expected_hash = blake3::hash(&file_data).to_hex().to_string();

        insert_test_attachment(
            &initiator_pool,
            "ATT01",
            "attachments/large.bin",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/large.bin",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;

        write_attachment_file(responder_dir.path(), "attachments/large.bin", &file_data).unwrap();
        assert!(!initiator_dir.path().join("attachments/large.bin").exists());

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let cancel_resp = AtomicBool::new(false);
        let cancel_init = AtomicBool::new(false);
        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(
                &mut server_conn,
                &responder_pool,
                responder_dir.path(),
                &cancel_resp
            ),
            request_and_receive_files(
                &mut client_conn,
                &initiator_pool,
                initiator_dir.path(),
                &cancel_init
            ),
        );

        let sender_stats = responder_result.unwrap();
        let receiver_stats = initiator_result.unwrap();

        // File received correctly despite chunking
        let (data, hash) =
            read_attachment_file(initiator_dir.path(), "attachments/large.bin").unwrap();
        assert_eq!(data.len(), file_data.len());
        assert_eq!(data, file_data);
        assert_eq!(hash, expected_hash);

        // Stats show correct byte counts
        assert_eq!(receiver_stats.files_received, 1);
        assert_eq!(
            receiver_stats.bytes_received,
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64")
        );
        assert_eq!(sender_stats.files_sent, 1);
        assert_eq!(
            sender_stats.bytes_sent,
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64")
        );

        server.shutdown().await;
    }

    // ── find_missing_attachments with all files present ──────────────────

    #[tokio::test]
    async fn find_missing_attachments_all_files_present() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Create both attachment files on disk; `size_bytes` in the DB
        // rows below must match each file's on-disk length so M-48's
        // size check accepts them as present.
        let att_dir = dir.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("att1.png"), b"image data 1").unwrap(); // 12 bytes
        std::fs::write(att_dir.join("att2.png"), b"image data 2").unwrap(); // 12 bytes

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT1', 'BLK1', 'image/png', 'photo1.png', 12, 'attachments/att1.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 12, 'attachments/att2.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        assert!(
            missing.is_empty(),
            "all files present on disk → no missing attachments"
        );
    }

    // ── read_attachment_file hash determinism ─────────────────────────────

    #[test]
    fn read_attachment_file_hash_determinism() {
        let dir = TempDir::new().unwrap();
        let content = b"deterministic hash content";

        // Write the same content to two different paths
        write_attachment_file(dir.path(), "file_a.bin", content).unwrap();
        write_attachment_file(dir.path(), "file_b.bin", content).unwrap();

        let (_, hash_a) = read_attachment_file(dir.path(), "file_a.bin").unwrap();
        let (_, hash_b) = read_attachment_file(dir.path(), "file_b.bin").unwrap();

        assert_eq!(
            hash_a, hash_b,
            "identical content must produce identical blake3 hashes regardless of path"
        );
    }

    // ── write_attachment_file creates deeply nested parent dirs ───────────

    #[test]
    fn write_attachment_file_creates_deeply_nested_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let content = b"deeply nested file content";

        write_attachment_file(dir.path(), "subdir/subdir2/file.bin", content).unwrap();

        let full_path = dir.path().join("subdir/subdir2/file.bin");
        assert!(
            full_path.exists(),
            "deeply nested file should exist after write"
        );
        assert_eq!(std::fs::read(&full_path).unwrap(), content);
    }

    // ── In-memory WebSocket file transfer integration tests ──────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_receive_request_empty_request() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();
        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let client_task = tokio::spawn(async move {
            client_conn
                .send_json(&SyncMessage::FileRequest {
                    attachment_ids: vec![],
                })
                .await
                .unwrap();
            let msg: SyncMessage = client_conn.recv_json().await.unwrap();
            assert!(matches!(msg, SyncMessage::FileTransferComplete));
        });

        let cancel = AtomicBool::new(false);
        let stats = receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        client_task.await.unwrap();

        assert_eq!(stats.files_sent, 0);
        assert_eq!(stats.bytes_sent, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_receive_request_transfer_complete_instead() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();
        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let client_task = tokio::spawn(async move {
            // Send FileTransferComplete instead of FileRequest
            client_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await
                .unwrap();
            // Expect FileTransferComplete back from server
            let msg: SyncMessage = client_conn.recv_json().await.unwrap();
            assert!(matches!(msg, SyncMessage::FileTransferComplete));
        });

        let cancel = AtomicBool::new(false);
        let stats = receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        client_task.await.unwrap();

        assert_eq!(stats.files_sent, 0);
        assert_eq!(stats.bytes_sent, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_receive_request_sends_one_file() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        let file_data = b"attachment content for transfer test";
        let expected_hash = blake3::hash(file_data).to_hex().to_string();
        let expected_size =
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64");

        // Insert block + attachment and create the file on disk
        insert_test_attachment(
            &pool,
            "ATT_S1",
            "attachments/send1.bin",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        write_attachment_file(dir.path(), "attachments/send1.bin", file_data).unwrap();

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let client_task = tokio::spawn(async move {
            // Send FileRequest requesting one attachment
            client_conn
                .send_json(&SyncMessage::FileRequest {
                    attachment_ids: vec!["ATT_S1".into()],
                })
                .await
                .unwrap();

            // Receive FileOffer
            let offer: SyncMessage = client_conn.recv_json().await.unwrap();
            match offer {
                SyncMessage::FileOffer {
                    attachment_id,
                    size_bytes,
                    blake3_hash,
                } => {
                    assert_eq!(attachment_id, "ATT_S1");
                    assert_eq!(size_bytes, expected_size);
                    assert_eq!(blake3_hash, expected_hash);
                }
                other => panic!("expected FileOffer, got {other:?}"),
            }

            // Receive binary data
            let data = client_conn.recv_binary().await.unwrap();
            assert_eq!(data, file_data);

            // Send FileReceived
            client_conn
                .send_json(&SyncMessage::FileReceived {
                    attachment_id: "ATT_S1".into(),
                })
                .await
                .unwrap();

            // Receive FileTransferComplete
            let msg: SyncMessage = client_conn.recv_json().await.unwrap();
            assert!(matches!(msg, SyncMessage::FileTransferComplete));
        });

        let cancel = AtomicBool::new(false);
        let stats = receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        client_task.await.unwrap();

        assert_eq!(stats.files_sent, 1);
        assert_eq!(stats.bytes_sent, expected_size);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_request_receive_no_missing() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        // Insert attachment and create file on disk so nothing is missing
        let file_data = b"already present";
        insert_test_attachment(
            &pool,
            "ATT_P1",
            "attachments/present.bin",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        write_attachment_file(dir.path(), "attachments/present.bin", file_data).unwrap();

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let server_task = tokio::spawn(async move {
            // Receive empty FileRequest
            let msg: SyncMessage = server_conn.recv_json().await.unwrap();
            match msg {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert!(attachment_ids.is_empty());
                }
                other => panic!("expected FileRequest, got {other:?}"),
            }
            // Send FileTransferComplete
            server_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await
                .unwrap();
        });

        let cancel = AtomicBool::new(false);
        let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        server_task.await.unwrap();

        assert_eq!(stats.files_received, 0);
        assert_eq!(stats.bytes_received, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_request_receive_one_file() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        let file_data = b"file content to receive over inmem connection";
        let expected_hash = blake3::hash(file_data).to_hex().to_string();
        let expected_size =
            u64::try_from(file_data.len()).expect("invariant: test fixture file size fits in u64");

        // Insert attachment record but do NOT create the file on disk (so it's missing)
        insert_test_attachment(
            &pool,
            "ATT_R1",
            "attachments/recv1.bin",
            i64::try_from(file_data.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        assert!(!dir.path().join("attachments/recv1.bin").exists());

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let hash_for_offer = expected_hash.clone();
        let server_task = tokio::spawn(async move {
            // Receive FileRequest
            let msg: SyncMessage = server_conn.recv_json().await.unwrap();
            match msg {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert_eq!(attachment_ids, vec!["ATT_R1".to_string()]);
                }
                other => panic!("expected FileRequest, got {other:?}"),
            }

            // Send FileOffer
            server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT_R1".into(),
                    size_bytes: expected_size,
                    blake3_hash: hash_for_offer,
                })
                .await
                .unwrap();

            // Send binary data
            server_conn.send_binary(file_data).await.unwrap();

            // Receive FileReceived
            let ack: SyncMessage = server_conn.recv_json().await.unwrap();
            assert!(matches!(
                ack,
                SyncMessage::FileReceived { attachment_id } if attachment_id == "ATT_R1"
            ));

            // Send FileTransferComplete
            server_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await
                .unwrap();
        });

        let cancel = AtomicBool::new(false);
        let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        server_task.await.unwrap();

        assert_eq!(stats.files_received, 1);
        assert_eq!(stats.bytes_received, expected_size);

        // Verify file was written to disk with correct content and hash
        let (data, hash) = read_attachment_file(dir.path(), "attachments/recv1.bin").unwrap();
        assert_eq!(data, file_data);
        assert_eq!(hash, expected_hash);
    }

    /// L-72: chaos / partial-transfer recovery. The sender drops the
    /// connection mid-binary-frame after delivering an unprocessable
    /// partial chunk; the receiver must:
    ///
    /// (a) return `Err` from `request_and_receive_files`,
    /// (b) leave NO file on disk at the offered `fs_path`
    ///     (write happens only after the full payload + hash verify),
    /// (c) keep the attachment row visible to `find_missing_attachments`
    ///     so the next sync cycle re-tries.
    ///
    /// This pins the M-50 contract that ACK-after-write means a partial
    /// transfer is fully recoverable on the next cycle, not silently
    /// committed as a half-baked file.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_request_receive_partial_transfer_disconnects_mid_frame_l72() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        // Offer an attachment whose declared size is much larger than the
        // single chunk we'll actually send. The receiver expects more
        // bytes than the sender will deliver before dropping; the next
        // `recv_binary` after the partial chunk surfaces EOF as Err.
        let declared_size: u64 = 64 * 1024; // 64 KiB
        let partial_chunk: Vec<u8> = vec![0u8; 4 * 1024]; // only 4 KiB delivered

        // Hash is computed from a *plausible* full payload — never
        // verified in this test because the receiver returns Err before
        // hashing. We compute the hash of zero bytes as a placeholder.
        let placeholder_hash = blake3::hash(b"").to_hex().to_string();

        insert_test_attachment(
            &pool,
            "ATT_L72",
            "attachments/partial.bin",
            i64::try_from(declared_size).expect("invariant: 64 KiB fits in i64"),
        )
        .await;
        let final_path = dir.path().join("attachments/partial.bin");
        assert!(
            !final_path.exists(),
            "pre-condition: file must be missing on disk"
        );

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let server_task = tokio::spawn(async move {
            // Receive FileRequest from the receiver.
            let msg: SyncMessage = server_conn.recv_json().await.unwrap();
            match msg {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert_eq!(attachment_ids, vec!["ATT_L72".to_string()]);
                }
                other => panic!("expected FileRequest, got {other:?}"),
            }

            // Send a FileOffer that promises more bytes than we'll ever
            // deliver — the receiver will loop on `recv_binary` waiting
            // for the rest, and observe EOF when we drop below.
            server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT_L72".into(),
                    size_bytes: declared_size,
                    blake3_hash: placeholder_hash,
                })
                .await
                .unwrap();

            // Send only the partial chunk, then drop the sender side.
            server_conn.send_binary(&partial_chunk).await.unwrap();
            // `drop(server_conn)` happens on task exit, closing the
            // duplex stream and surfacing EOF on the receiver's next
            // `recv_binary`.
        });

        let cancel = AtomicBool::new(false);
        let result =
            request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel).await;
        server_task.await.unwrap();

        // (a) Receive surfaces the disconnection as Err.
        assert!(
            result.is_err(),
            "L-72: mid-frame disconnect must surface as Err; got {result:?}"
        );

        // (b) No half-written file on disk. M-50 guarantees the write
        // happens only after the full hash-verified payload is in
        // memory; an interrupted transfer must leave the path empty.
        assert!(
            !final_path.exists(),
            "L-72: no half-written file may appear on disk after a mid-frame \
             disconnect; found unexpected file at {final_path:?}"
        );

        // (c) The attachment is still classified as missing so the next
        // sync retries it. M-48 (`find_missing_attachments` re-detects
        // truncated files) makes the result deterministic regardless of
        // whether the OS allocated a 0-byte stub on the way.
        let still_missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
        let still_missing_ids: Vec<&str> = still_missing.iter().map(|m| m.id.as_str()).collect();
        assert!(
            still_missing_ids.contains(&"ATT_L72"),
            "L-72: attachment must remain in find_missing_attachments after partial \
             transfer; got {still_missing_ids:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inmem_responder_bidirectional_no_files() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        // Mock the initiator side.
        // Responder does: receive_request_and_send_files then request_and_receive_files
        // So initiator must:
        //   Phase 1: send FileRequest [] -> receive FileTransferComplete
        //   Phase 2: receive FileRequest [] -> send FileTransferComplete
        let initiator_task = tokio::spawn(async move {
            // Phase 1: Initiator sends FileRequest (no missing files)
            client_conn
                .send_json(&SyncMessage::FileRequest {
                    attachment_ids: vec![],
                })
                .await
                .unwrap();
            // Responder receives it, has nothing to send, sends FileTransferComplete
            let msg: SyncMessage = client_conn.recv_json().await.unwrap();
            assert!(matches!(msg, SyncMessage::FileTransferComplete));

            // Phase 2: Responder sends its own FileRequest (no missing files)
            let msg2: SyncMessage = client_conn.recv_json().await.unwrap();
            assert!(matches!(
                msg2,
                SyncMessage::FileRequest { attachment_ids } if attachment_ids.is_empty()
            ));
            // Initiator sends FileTransferComplete
            client_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await
                .unwrap();
        });

        let cancel = AtomicBool::new(false);
        let stats = run_file_transfer_responder(&mut server_conn, &pool, &app_data_dir, &cancel)
            .await
            .unwrap();
        initiator_task.await.unwrap();

        assert_eq!(stats.files_sent, 0);
        assert_eq!(stats.files_received, 0);
        assert_eq!(stats.bytes_sent, 0);
        assert_eq!(stats.bytes_received, 0);
    }

    // ── M-47: cancel signal breaks file transfer between files ────────────

    /// M-47: when `cancel` is set during file 1's transfer, the receiver
    /// must complete file 1 (already in flight) but break out before
    /// reading file 2's `FileOffer`. We rely on the receiver's cancel
    /// check at the **top** of every loop iteration: cancel is set by
    /// the mock responder *during* iteration 1 (between send_json
    /// `FileOffer1` and send_binary), which means iteration 2 starts
    /// AFTER `cancel.store(true)` has happened (because the receiver's
    /// recv_binary blocks for the binary that comes after the store).
    /// The implementation aborts cleanly without writing file 2.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_file_transfer_initiator_breaks_on_cancel_m47() {
        use std::sync::Arc;

        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let app_data_dir = dir.path().to_path_buf();

        let file1: &[u8] = b"first file body content for M-47 test";
        let file2: &[u8] = b"second file body - should NOT be received after cancel";
        let hash1 = blake3::hash(file1).to_hex().to_string();
        let hash2 = blake3::hash(file2).to_hex().to_string();

        // Two attachment rows: both missing on disk so the receiver
        // requests both. Names chosen to be obviously distinguishable.
        insert_test_attachment(
            &pool,
            "ATT_M47_1",
            "attachments/m47_1.bin",
            i64::try_from(file1.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;
        insert_test_attachment(
            &pool,
            "ATT_M47_2",
            "attachments/m47_2.bin",
            i64::try_from(file2.len()).expect("invariant: test fixture file size fits in i64"),
        )
        .await;

        let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_responder = cancel.clone();

        // Mock responder: drives the protocol manually, sets `cancel`
        // synchronously between `FileOffer1` and `send_binary(file1)`.
        // This guarantees the receiver's iteration 2 (after ACK1) reads
        // a `cancel == true` flag — there is no race because the
        // store-release happens before the binary is even on the wire,
        // and the receiver cannot reach iteration 2's load-acquire
        // without first finishing iteration 1's body (recv_binary,
        // write, send ACK).
        let responder_task = tokio::spawn(async move {
            // 1. Receive FileRequest for both files.
            let req: SyncMessage = server_conn.recv_json().await.unwrap();
            match req {
                SyncMessage::FileRequest { attachment_ids } => {
                    assert_eq!(
                        attachment_ids,
                        vec!["ATT_M47_1".to_string(), "ATT_M47_2".to_string()],
                        "M-47 setup: both attachments must be requested"
                    );
                }
                other => panic!("M-47 setup: expected FileRequest, got {other:?}"),
            }

            // 2. Send FileOffer for file 1.
            server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT_M47_1".into(),
                    size_bytes: u64::try_from(file1.len())
                        .expect("invariant: test fixture file size fits in u64"),
                    blake3_hash: hash1.clone(),
                })
                .await
                .unwrap();

            // 3. M-47: store cancel BEFORE sending binary. The receiver
            //    is now blocked in recv_binary; once the binary arrives
            //    and iteration 1's body finishes, iteration 2's
            //    cancel.load() sees the store-released `true`.
            cancel_responder.store(true, Ordering::Release);

            // 4. Send file 1 binary — receiver completes iteration 1.
            server_conn.send_binary(file1).await.unwrap();

            // 5. Receive ACK for file 1.
            let ack: SyncMessage = server_conn.recv_json().await.unwrap();
            assert!(
                matches!(
                    ack,
                    SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_M47_1"
                ),
                "M-47: receiver must ACK file 1 before observing cancel; got {ack:?}"
            );

            // 6. Try to send file 2 — the receiver SHOULD have broken
            //    out at iteration 2's cancel check, so these sends
            //    will hit a closed connection. We swallow errors
            //    (broken pipe is the success case).
            let _ = server_conn
                .send_json(&SyncMessage::FileOffer {
                    attachment_id: "ATT_M47_2".into(),
                    size_bytes: u64::try_from(file2.len())
                        .expect("invariant: test fixture file size fits in u64"),
                    blake3_hash: hash2.clone(),
                })
                .await;
            let _ = server_conn.send_binary(file2).await;
            let _ = server_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await;
        });

        // Initiator (receiver) side: run the production code path.
        let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel)
            .await
            .expect("M-47: receive must return Ok with partial stats on cancel");

        let _ = responder_task.await;

        // M-47 contract:
        // (a) file 1 was successfully received,
        // (b) file 2 was NOT received,
        // (c) cancel flag is still set (cleared only by the daemon's
        //     CancelGuard, not by the file-transfer helper).
        assert_eq!(
            stats.files_received, 1,
            "M-47: exactly one file should be received before cancel takes effect"
        );
        assert!(
            dir.path().join("attachments/m47_1.bin").exists(),
            "M-47: file 1 must be on disk (it completed before cancel was observed)"
        );
        assert!(
            !dir.path().join("attachments/m47_2.bin").exists(),
            "M-47: file 2 must NOT be on disk — receiver must break before processing it"
        );
        assert!(
            cancel.load(Ordering::Acquire),
            "M-47: file-transfer helper does not clear cancel; that is the daemon's job"
        );
    }

    // ── TEST-38 / BUG-35: attachment path traversal validation ────────────
    //
    // These tests pin down `validate_attachment_fs_path` and its sibling
    // `check_attachment_fs_path_shape` against a malformed `fs_path` —
    // regression coverage so the guard cannot silently regress if a future
    // refactor of `read_attachment_file` / `write_attachment_file` / the
    // attachment command layer removes the call.

    #[test]
    fn validate_rejects_parent_dir_traversal() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "../../etc/passwd");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "`../../etc/passwd` must be rejected, got {result:?}"
        );
    }

    #[test]
    fn validate_rejects_single_parent_dir_traversal() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "../other_app/data");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "`../other_app/data` must be rejected, got {result:?}"
        );
    }

    #[test]
    fn validate_rejects_parent_dir_in_middle() {
        let dir = TempDir::new().unwrap();
        // Even if the path starts with a normal component, a `..` anywhere
        // can still escape.
        let result = validate_attachment_fs_path(dir.path(), "attachments/../../escape");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "`..` in the middle must be rejected, got {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_rejects_absolute_path_unix() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "/etc/passwd");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "absolute path `/etc/passwd` must be rejected, got {result:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_absolute_path_windows() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "C:\\Windows\\System32");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "absolute Windows path must be rejected, got {result:?}"
        );
    }

    #[test]
    fn validate_accepts_standard_attachments_path() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "attachments/ABC123");
        let resolved = result.expect("standard attachment path should validate");
        assert!(
            resolved.starts_with(dir.path()),
            "resolved path must start with app_data_dir"
        );
        assert!(resolved.ends_with("attachments/ABC123"));
    }

    #[test]
    fn validate_accepts_single_file_in_attachments() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "attachments/photo.png");
        assert!(result.is_ok(), "nested attachment path should validate");
    }

    #[test]
    fn validate_rejects_empty_fs_path() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty path must be rejected, got {result:?}"
        );
    }

    /// On Linux, Windows-style backslashes in a relative path are treated
    /// as a single opaque file-name component (PathBuf::components()
    /// returns one `Normal` segment for `"..\\..\\secrets"`). That's safe
    /// — no real `..` component is produced — but the behaviour differs
    /// between platforms, so this test documents it explicitly. On
    /// Windows, PathBuf::join parses backslashes as separators and the
    /// `..` components DO surface, which the validator rejects.
    #[test]
    fn validate_windows_style_backslashes_on_current_platform() {
        let dir = TempDir::new().unwrap();
        let result = validate_attachment_fs_path(dir.path(), "..\\..\\secrets");
        #[cfg(unix)]
        {
            assert!(
                result.is_ok(),
                "on Linux, `..\\\\..\\\\secrets` is a single opaque component; \
                 validator accepts it because PathBuf does not parse backslashes \
                 as separators. (Note: any OS later interpreting this path would \
                 still only look in `app_data_dir/..\\..\\secrets` — no escape.)"
            );
        }
        #[cfg(windows)]
        {
            assert!(
                matches!(result, Err(AppError::Validation(_))),
                "on Windows, backslashes ARE separators so `..\\..\\secrets` \
                 must be rejected, got {result:?}"
            );
        }
    }

    // ── shape-only helper: same rules, no app_data_dir join ────────────────

    #[test]
    fn shape_check_matches_full_validator() {
        // Every case the full validator rejects must also be rejected by
        // the shape-only helper, and vice versa. The shape helper is used
        // at the command layer (`add_attachment`) where `app_data_dir` is
        // not directly available.
        let cases = [
            ("", true),
            ("../../etc/passwd", true),
            ("../other", true),
            ("attachments/../escape", true),
            ("attachments/ABC", false),
            ("attachments/photo.png", false),
        ];
        #[cfg(unix)]
        let abs = "/etc/passwd";
        #[cfg(windows)]
        let abs = "C:\\Windows";
        let mut all: Vec<(&str, bool)> = cases.to_vec();
        all.push((abs, true));

        let dir = TempDir::new().unwrap();
        for (input, should_fail) in all {
            let shape = check_attachment_fs_path_shape(input);
            let full = validate_attachment_fs_path(dir.path(), input);
            assert_eq!(
                shape.is_err(),
                should_fail,
                "shape check disagreed on {input:?}: {shape:?}"
            );
            assert_eq!(
                full.is_err(),
                should_fail,
                "full validator disagreed on {input:?}: {full:?}"
            );
        }
    }

    // ── Integration: read_attachment_file enforces the validator ───────────

    #[test]
    fn read_attachment_file_rejects_traversal_without_touching_disk() {
        let dir = TempDir::new().unwrap();
        // Pre-create a file OUTSIDE the app data dir — if the validator is
        // missing, `..` traversal would let us read it.
        let parent = dir.path().parent().unwrap();
        let decoy = parent.join("agaric-bug35-decoy.txt");
        std::fs::write(&decoy, b"secret data").unwrap();

        // Compute a path that, without validation, would resolve into `decoy`.
        let file_name = decoy.file_name().unwrap().to_string_lossy();
        let traversal = format!("../{file_name}");

        let result = read_attachment_file(dir.path(), &traversal);
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "read_attachment_file must reject traversal path `{traversal}`, got {result:?}"
        );

        // Clean up decoy
        let _ = std::fs::remove_file(&decoy);
    }

    #[test]
    fn write_attachment_file_rejects_traversal() {
        let dir = TempDir::new().unwrap();
        let result = write_attachment_file(dir.path(), "../../evil.bin", b"payload");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "write_attachment_file must reject traversal path, got {result:?}"
        );
    }

    #[test]
    fn write_attachment_file_rejects_empty_path() {
        let dir = TempDir::new().unwrap();
        let result = write_attachment_file(dir.path(), "", b"payload");
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "write_attachment_file must reject empty path, got {result:?}"
        );
    }

    // ── Integration: add_attachment_inner enforces the validator ───────────

    #[tokio::test]
    async fn add_attachment_rejects_traversal_at_command_layer() {
        use crate::materializer::Materializer;
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let mat = Materializer::new(pool.clone());

        // Seed a valid block so the block-exists check passes *if the path
        // validator did not exist*. This isolates the test to the path check.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('BLK_OK', 'content', 'ok')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = crate::commands::add_attachment_inner(
            &pool,
            "test-device",
            &mat,
            dir.path(),
            "BLK_OK".to_string(),
            "evil.bin".to_string(),
            "application/octet-stream".to_string(),
            10,
            "../../outside/evil.bin".to_string(),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "add_attachment must reject traversal fs_path at the command layer, got {result:?}"
        );

        // No row inserted
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "bad fs_path must not leave an attachment row");
    }
}
