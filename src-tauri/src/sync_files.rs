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

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum size of a single binary WebSocket frame for file transfer.
/// Chosen to stay well under the 10 MB `MAX_MSG_SIZE` in `SyncConnection`.
const FILE_CHUNK_SIZE: usize = 5_000_000; // 5 MB

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

/// Query the `attachments` table and return entries whose `fs_path` file
/// does not exist on disk under `app_data_dir`.
pub async fn find_missing_attachments(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<Vec<MissingAttachment>, AppError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT id, fs_path FROM attachments WHERE deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;

    let mut missing = Vec::new();
    for (id, fs_path) in rows {
        let full_path = app_data_dir.join(&fs_path);
        if !full_path.exists() {
            missing.push(MissingAttachment { id, fs_path });
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

/// Read an attachment file from disk and compute its blake3 hash.
///
/// Returns `(file_bytes, blake3_hex_hash)`.
pub fn read_attachment_file(
    app_data_dir: &Path,
    fs_path: &str,
) -> Result<(Vec<u8>, String), AppError> {
    let full_path = app_data_dir.join(fs_path);
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
pub fn write_attachment_file(
    app_data_dir: &Path,
    fs_path: &str,
    data: &[u8],
) -> Result<(), AppError> {
    let full_path = app_data_dir.join(fs_path);
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
pub async fn receive_request_and_send_files(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
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

        // Send binary data (chunked if > FILE_CHUNK_SIZE)
        if data.is_empty() {
            conn.send_binary(&[]).await?;
        } else {
            for chunk in data.chunks(FILE_CHUNK_SIZE) {
                conn.send_binary(chunk).await?;
            }
        }

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
pub async fn request_and_receive_files(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
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
    loop {
        let msg: SyncMessage = conn.recv_json().await?;
        match msg {
            SyncMessage::FileOffer {
                attachment_id,
                size_bytes,
                blake3_hash,
            } => {
                // Look up fs_path for this attachment
                let Some(fs_path) = get_attachment_fs_path(pool, &attachment_id).await? else {
                    tracing::warn!(
                        attachment_id,
                        "received file offer for unknown attachment, skipping binary data"
                    );
                    // Still need to consume the binary data
                    consume_binary_data(conn, size_bytes).await?;
                    continue;
                };

                // Receive binary data (may be chunked)
                let data = receive_binary_data(conn, size_bytes).await?;

                // Verify blake3 hash
                let actual_hash = blake3::hash(&data).to_hex().to_string();
                if actual_hash != blake3_hash {
                    tracing::warn!(
                        attachment_id,
                        expected = blake3_hash,
                        actual = actual_hash,
                        "blake3 hash mismatch for received file, skipping"
                    );
                    stats.skipped_hash_mismatch += 1;
                    // Still send FileReceived to keep protocol in sync
                    conn.send_json(&SyncMessage::FileReceived { attachment_id })
                        .await?;
                    continue;
                }

                // Write file to disk
                if let Err(e) = write_attachment_file(app_data_dir, &fs_path, &data) {
                    tracing::warn!(
                        attachment_id,
                        error = %e,
                        "failed to write attachment file"
                    );
                    // Still send FileReceived to keep protocol in sync
                    conn.send_json(&SyncMessage::FileReceived { attachment_id })
                        .await?;
                    continue;
                }

                stats.files_received += 1;
                stats.bytes_received += data.len() as u64;

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
/// size is reached. Rejects data that exceeds the declared size.
async fn receive_binary_data(
    conn: &mut SyncConnection,
    size_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    // size_bytes is a file size; on 32-bit targets large files would saturate
    let capacity = usize::try_from(size_bytes).unwrap_or(usize::MAX);
    let mut data = Vec::with_capacity(capacity);
    while (data.len() as u64) < size_bytes {
        let chunk = conn.recv_binary().await?;
        data.extend_from_slice(&chunk);
        if data.len() as u64 > size_bytes {
            return Err(AppError::InvalidOperation(format!(
                "received {} bytes but expected {}",
                data.len(),
                size_bytes
            )));
        }
    }
    Ok(data)
}

/// Consume and discard binary data for a file we don't need.
async fn consume_binary_data(conn: &mut SyncConnection, size_bytes: u64) -> Result<(), AppError> {
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
pub async fn run_file_transfer_initiator(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // Phase 1: Request our missing files from responder
    let recv_stats = request_and_receive_files(conn, pool, app_data_dir).await?;
    stats.files_received += recv_stats.files_received;
    stats.bytes_received += recv_stats.bytes_received;
    stats.skipped_hash_mismatch += recv_stats.skipped_hash_mismatch;
    stats.skipped_not_found += recv_stats.skipped_not_found;

    // Phase 2: Respond to responder's file request
    let send_stats = receive_request_and_send_files(conn, pool, app_data_dir).await?;
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
pub async fn run_file_transfer_responder(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<FileTransferStats, AppError> {
    let mut stats = FileTransferStats::default();

    // Phase 1: Respond to initiator's file request
    let send_stats = receive_request_and_send_files(conn, pool, app_data_dir).await?;
    stats.files_sent += send_stats.files_sent;
    stats.bytes_sent += send_stats.bytes_sent;
    stats.skipped_not_found += send_stats.skipped_not_found;
    stats.skipped_hash_mismatch += send_stats.skipped_hash_mismatch;

    // Phase 2: Request our missing files from initiator
    let recv_stats = request_and_receive_files(conn, pool, app_data_dir).await?;
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
#[allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]
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

        // Insert another attachment whose file DOES exist
        let existing_path = dir.path().join("attachments");
        std::fs::create_dir_all(&existing_path).unwrap();
        std::fs::write(existing_path.join("att2.png"), b"fake image data").unwrap();

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 512, 'attachments/att2.png', '2025-01-15T12:00:00Z')",
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

    // ── FILE_CHUNK_SIZE constant ─────────────────────────────────────────

    #[test]
    fn file_chunk_size_is_under_max_msg_size() {
        // MAX_MSG_SIZE in SyncConnection is 10_000_000 (10 MB)
        const _: () = assert!(
            FILE_CHUNK_SIZE < 10_000_000,
            "FILE_CHUNK_SIZE must be under the 10 MB WebSocket frame limit"
        );
        assert_eq!(FILE_CHUNK_SIZE, 5_000_000, "FILE_CHUNK_SIZE should be 5 MB");
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

        let client_conn = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
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
            file_data.len() as i64,
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/photo.jpg",
            file_data.len() as i64,
        )
        .await;

        // File exists ONLY on the responder side
        write_attachment_file(responder_dir.path(), "attachments/photo.jpg", file_data).unwrap();
        assert!(!initiator_dir.path().join("attachments/photo.jpg").exists());

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(&mut server_conn, &responder_pool, responder_dir.path(),),
            request_and_receive_files(&mut client_conn, &initiator_pool, initiator_dir.path(),),
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
        assert_eq!(receiver_stats.bytes_received, file_data.len() as u64);
        assert_eq!(sender_stats.files_sent, 1);
        assert_eq!(sender_stats.bytes_sent, file_data.len() as u64);

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
            file_data.len() as i64,
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/photo.jpg",
            file_data.len() as i64,
        )
        .await;

        // File exists on BOTH sides → nothing to transfer
        write_attachment_file(initiator_dir.path(), "attachments/photo.jpg", file_data).unwrap();
        write_attachment_file(responder_dir.path(), "attachments/photo.jpg", file_data).unwrap();

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(&mut server_conn, &responder_pool, responder_dir.path(),),
            request_and_receive_files(&mut client_conn, &initiator_pool, initiator_dir.path(),),
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_hash_mismatch_skips_corrupt_file() {
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
            file_data.len() as i64,
        )
        .await;

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        // Responder side: manually drive the protocol with a bad hash
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
                    size_bytes: file_data.len() as u64,
                    blake3_hash: wrong_hash,
                })
                .await
                .unwrap();

            // 3. Send binary data
            server_conn.send_binary(file_data).await.unwrap();

            // 4. Receive FileReceived ack (sent to keep protocol in sync)
            let ack: SyncMessage = server_conn.recv_json().await.unwrap();
            match ack {
                SyncMessage::FileReceived { attachment_id } => {
                    assert_eq!(attachment_id, "ATT01");
                }
                other => panic!("expected FileReceived, got {other:?}"),
            }

            // 5. Send FileTransferComplete
            server_conn
                .send_json(&SyncMessage::FileTransferComplete)
                .await
                .unwrap();
        };

        let (_, initiator_result) = tokio::join!(
            server_side,
            request_and_receive_files(&mut client_conn, &initiator_pool, initiator_dir.path(),),
        );

        let stats = initiator_result.unwrap();

        // File must NOT have been written (hash mismatch)
        assert!(
            !initiator_dir.path().join("attachments/photo.jpg").exists(),
            "corrupt file must not be written to disk"
        );
        assert_eq!(stats.skipped_hash_mismatch, 1);
        assert_eq!(stats.files_received, 0);
        assert_eq!(stats.bytes_received, 0);

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

        // File larger than FILE_CHUNK_SIZE (5 MB) → will be chunked
        let file_size = FILE_CHUNK_SIZE + 1_000_000; // 6 MB
        let file_data: Vec<u8> = (0..file_size).map(|i| (i % 256) as u8).collect();
        let expected_hash = blake3::hash(&file_data).to_hex().to_string();

        insert_test_attachment(
            &initiator_pool,
            "ATT01",
            "attachments/large.bin",
            file_data.len() as i64,
        )
        .await;
        insert_test_attachment(
            &responder_pool,
            "ATT01",
            "attachments/large.bin",
            file_data.len() as i64,
        )
        .await;

        write_attachment_file(responder_dir.path(), "attachments/large.bin", &file_data).unwrap();
        assert!(!initiator_dir.path().join("attachments/large.bin").exists());

        let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

        let (responder_result, initiator_result) = tokio::join!(
            receive_request_and_send_files(&mut server_conn, &responder_pool, responder_dir.path(),),
            request_and_receive_files(&mut client_conn, &initiator_pool, initiator_dir.path(),),
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
        assert_eq!(receiver_stats.bytes_received, file_data.len() as u64);
        assert_eq!(sender_stats.files_sent, 1);
        assert_eq!(sender_stats.bytes_sent, file_data.len() as u64);

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

        // Create both attachment files on disk
        let att_dir = dir.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("att1.png"), b"image data 1").unwrap();
        std::fs::write(att_dir.join("att2.png"), b"image data 2").unwrap();

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT1', 'BLK1', 'image/png', 'photo1.png', 512, 'attachments/att1.png', '2025-01-15T12:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 512, 'attachments/att2.png', '2025-01-15T12:00:00Z')",
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
}
