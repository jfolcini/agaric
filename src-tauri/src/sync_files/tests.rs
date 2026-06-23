use super::*;
use crate::db::init_pool;
use crate::sync_events::{RecordingEventSink, SyncEvent, SyncEventSink};
use std::sync::Arc;
use tempfile::TempDir;

// ── find_missing_attachments ─────────────────────────────────────────

#[tokio::test]
async fn find_missing_returns_ids_for_missing_files() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();

    // Insert a block first (FK constraint)
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // Insert an attachment whose file does NOT exist on disk
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT1', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/att1.png', 1736942400000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Insert another attachment whose file DOES exist; `size_bytes`
    // Must match the on-disk length so size check accepts it.
    let existing_path = dir.path().join("attachments");
    std::fs::create_dir_all(&existing_path).unwrap();
    let existing_bytes: &[u8] = b"fake image data"; // 15 bytes
    std::fs::write(existing_path.join("att2.png"), existing_bytes).unwrap();

    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 15, 'attachments/att2.png', 1736942400000)",
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

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // Deleted attachment — should NOT appear in missing list
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at) \
         VALUES ('ATT_DEL', 'BLK1', 'image/png', 'deleted.png', 100, 'attachments/deleted.png', 1736942400000, '2025-01-16T00:00:00Z')",
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

/// A non-`NotFoundmetadata()` error (here triggered by routing
/// through a regular file as if it were a directory, which surfaces
/// `ENOTDIR`) must still classify the entry as missing for sync
/// correctness. The accompanying `tracing::warn!` is observed via the
/// global subscriber when run with `RUST_LOG=warn`; this test asserts
/// only the behavioural contract (missing-list inclusion) because
/// `tracing` log capture is not wired into this crate's test harness.
#[tokio::test]
async fn find_missing_classifies_non_not_found_io_error_as_missing() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // Place a regular file where the attachment's parent path expects a
    // directory. `metadata()` on `<dir>/regular_file/under.png` then
    // errors with `ENOTDIR` (kind ≠ `NotFound`) on Linux/macOS — the
    // Exact branch added the warn-level log for. On Windows the
    // same path shape produces a non-`NotFound` error too (the kind
    // varies by version), so the assertion intentionally checks the
    // behavioural outcome rather than the error kind.
    std::fs::write(dir.path().join("regular_file"), b"not a directory").unwrap();

    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT_ENOTDIR', 'BLK1', 'image/png', 'p.png', 1024, 'regular_file/under.png', 1736942400000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
    assert_eq!(
        missing.len(),
        1,
        "non-NotFound IO error must still be classified as missing"
    );
    assert_eq!(missing[0].id, "ATT_ENOTDIR");
    assert_eq!(missing[0].fs_path, "regular_file/under.png");
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

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT1', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/att1.png', 1736942400000)",
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

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // Insert 3 attachments, all with missing files
    for i in 1..=3 {
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, 'BLK1', 'image/png', ?, 100, ?, 1736942400000)",
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

// ── truncated / partial file detection ─────────────────────────

/// A file that exists on disk but is shorter than the DB's
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

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // DB row claims size 1024 bytes...
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT_TRUNC', 'BLK1', 'image/png', 'photo.png', 1024, 'attachments/trunc.png', 1736942400000)",
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
        "truncated file (0 bytes vs DB's 1024) must be re-requested; got {missing:?}",
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
        content_hash: None,
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
        content_hash: None,
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
    let debug = format!("{ma:?}");
    assert!(debug.contains("ATT1"));
}

// ── File transfer protocol integration tests ─────────────────────────

/// Install the `ring` CryptoProvider for rustls (idempotent).
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Set up a TLS server/client pair and return both connections + server handle.
async fn setup_tls_pair() -> (SyncConnection, SyncConnection, crate::sync_net::SyncServer) {
    use crate::sync_net::{SyncServer, connect_to_peer, generate_self_signed_cert};

    install_crypto_provider();
    let server_cert = generate_self_signed_cert("responder").unwrap();
    let client_cert = generate_self_signed_cert("initiator").unwrap();

    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));

    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
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
         VALUES (?, ?, 'application/octet-stream', 'file.bin', ?, ?, unixepoch('now') * 1000)",
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
            &cancel_resp,
            None,
        ),
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let sender_stats = responder_result.unwrap();
    let receiver_stats = initiator_result.unwrap();

    // File now exists in initiator's dir with correct data and hash
    let (data, hash) = read_attachment_file(initiator_dir.path(), "attachments/photo.jpg").unwrap();
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
    // receiver never increments skipped_hash_mismatch/skipped_not_found; drop assertion

    server.shutdown().await;
}

/// Per-frame file-transfer progress emission.
///
/// Pins the contract that `run_file_transfer_*` emits
/// [`SyncEvent::FileProgress`] events through the supplied event sink:
/// - one initial tick when the phase starts (so the UI gets a
///   denominator immediately),
/// - at least one tick mid-stream whose `bytes_done` is strictly
///   between 0 and `bytes_total` for a multi-frame attachment,
/// - a terminal tick after the file finishes whose
///   `files_done == files_total` and `bytes_done == bytes_total`,
/// - a final `phase: "complete"` tick from the top-level
///   `run_file_transfer_initiator` so the UI can reset.
///
/// Uses a >1-frame file so the per-frame loop fires at least twice;
/// the captured events let us pin "bytes_done grows monotonically."
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_run_file_transfer_emits_per_frame_progress() {
    use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;

    let initiator_dir = TempDir::new().unwrap();
    let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
        .await
        .unwrap();
    let responder_dir = TempDir::new().unwrap();
    let responder_pool = init_pool(&responder_dir.path().join("test.db"))
        .await
        .unwrap();

    // Build a file that spans more than one frame (1.5 × chunk size)
    // so the per-frame callback fires at least twice — that's the
    // whole point of the streaming progress contract.
    let multi_frame_size = BINARY_FRAME_CHUNK_SIZE + BINARY_FRAME_CHUNK_SIZE / 2;
    let file_data: Vec<u8> = (0..multi_frame_size)
        .map(|i| u8::try_from(i % 251).expect("i % 251 < 256 fits in u8"))
        .collect();
    insert_test_attachment(
        &initiator_pool,
        "ATTBIG",
        "attachments/big.bin",
        i64::try_from(file_data.len()).expect("test fixture fits in i64"),
    )
    .await;
    insert_test_attachment(
        &responder_pool,
        "ATTBIG",
        "attachments/big.bin",
        i64::try_from(file_data.len()).expect("test fixture fits in i64"),
    )
    .await;
    write_attachment_file(responder_dir.path(), "attachments/big.bin", &file_data).unwrap();
    assert!(!initiator_dir.path().join("attachments/big.bin").exists());

    let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

    // Capture every SyncEvent emitted on the initiator (receiving) side.
    // Keep the concrete handle for assertions; clone-coerce a trait
    // object handle for the progress hook.
    let init_recorder: Arc<RecordingEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink: Arc<dyn SyncEventSink> = init_recorder.clone();
    let init_progress = FileTransferProgress {
        event_sink: &init_sink,
        remote_device_id: "DEV_RESPONDER",
    };

    let cancel_resp = AtomicBool::new(false);
    let cancel_init = AtomicBool::new(false);
    let (responder_result, initiator_result) = tokio::join!(
        // Responder side: not under test for emission, no progress hook.
        receive_request_and_send_files(
            &mut server_conn,
            &responder_pool,
            responder_dir.path(),
            &cancel_resp,
            None,
        ),
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            Some(&init_progress),
        ),
    );

    let _sender_stats = responder_result.unwrap();
    let receiver_stats = initiator_result.unwrap();
    assert_eq!(receiver_stats.files_received, 1);

    // Pull the file-progress envelope out of the recorded events.
    let recorded = init_recorder.events();
    let file_events: Vec<_> = recorded
        .iter()
        .filter_map(|e| match e {
            SyncEvent::FileProgress {
                phase,
                files_done,
                files_total,
                bytes_done,
                bytes_total,
                ..
            } => Some((
                phase.clone(),
                *files_done,
                *files_total,
                *bytes_done,
                *bytes_total,
            )),
            _ => None,
        })
        .collect();

    // ── Contract assertions ───────────────────────────────────────────
    assert!(
        file_events.len() >= 3,
        "expected at least an initial tick + ≥1 per-frame tick + terminal file tick, got {}",
        file_events.len()
    );

    // Every event is in the "receiving" phase (the receive helper).
    for (phase, _, files_total, _, _) in &file_events {
        assert_eq!(phase, "receiving", "expected only receiving-phase events");
        assert_eq!(*files_total, 1, "files_total should be the requested count");
    }

    // First event: zero progress (the "denominator" tick).
    let (_, first_done, _, first_bytes, first_total) = &file_events[0];
    assert_eq!(*first_done, 0, "first tick: no files done yet");
    assert_eq!(*first_bytes, 0, "first tick: no bytes received yet");
    assert!(
        *first_total > 0,
        "first tick: bytes_total must be advertised"
    );

    // bytes_done grows monotonically across the recorded sequence.
    let mut prev = 0u64;
    for (_, _, _, bytes_done, _) in &file_events {
        assert!(
            *bytes_done >= prev,
            "bytes_done must be monotonically non-decreasing, saw {prev} then {bytes_done}"
        );
        prev = *bytes_done;
    }

    // At least one mid-stream tick (bytes_done > 0 AND < bytes_total).
    // This is what proves the per-frame callback ran rather than just
    // pre/post.
    let saw_midstream = file_events
        .iter()
        .any(|(_, _, _, b, total)| *b > 0 && b < total);
    assert!(
        saw_midstream,
        "expected at least one per-frame mid-stream tick, got {file_events:?}"
    );

    // Terminal file tick: files_done == files_total and bytes_done == bytes_total.
    let last = file_events.last().expect("events non-empty");
    assert_eq!(
        last.1, last.2,
        "terminal file tick: files_done == files_total"
    );
    assert_eq!(
        last.3, last.4,
        "terminal file tick: bytes_done == bytes_total"
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
            &cancel_resp,
            None,
        ),
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let sender_stats = responder_result.unwrap();
    let receiver_stats = initiator_result.unwrap();

    assert_eq!(receiver_stats.files_received, 0);
    assert_eq!(receiver_stats.bytes_received, 0);
    assert_eq!(sender_stats.files_sent, 0);
    assert_eq!(sender_stats.bytes_sent, 0);
    // receiver never increments skipped_hash_mismatch/skipped_not_found; drop assertion

    server.shutdown().await;
}

/// Hash mismatch must NOT ACK and must surface an Err so the
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
                content_hash: None,
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
            "receiver must NOT send FileReceived ACK on hash mismatch (got {ack:?})"
        );
    };

    let cancel_init = AtomicBool::new(false);
    let ((), initiator_result) = tokio::join!(
        server_side,
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    // Receiver returns Err so the daemon's `try_sync_with_peer`
    // records a failure and reconnects.
    assert!(
        initiator_result.is_err(),
        "hash mismatch must surface as Err, got Ok"
    );
    let err = initiator_result.unwrap_err();
    let err_str = err.to_string();
    assert!(
        err_str.to_lowercase().contains("hash"),
        "expected hash-mismatch error, got: {err_str}"
    );

    // File must NOT have been written.
    assert!(
        !initiator_dir.path().join("attachments/photo.jpg").exists(),
        "corrupt file must not be written to disk"
    );

    server.shutdown().await;
}

/// A `FileOffer` whose `size_bytes` disagrees with the local
/// `attachments.size_bytes` row must be rejected without an ACK.
/// The function returns `Err` and no file is written to disk.
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
                content_hash: None,
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
            "receiver must NOT send FileReceived ACK on size mismatch (got {ack:?})"
        );
    };

    let cancel_init = AtomicBool::new(false);
    let ((), initiator_result) = tokio::join!(
        server_side,
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let err = initiator_result.expect_err(" must return Err on size mismatch");
    let msg = err.to_string();
    assert!(
        msg.contains("file_offer.size_mismatch"),
        "error message should be tagged file_offer.size_mismatch, got {msg}"
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

/// #638: an offer for an attachment with no local DB row must NOT stall
/// the sender. The receiver drains the offered bytes and ALWAYS sends a
/// `FileReceived` ACK on the skip path; the sender then unblocks and the
/// *next* file in the same round still transfers. Without the fix the
/// sender would block on `recv_json` until the 180s `RECV_TIMEOUT`,
/// erroring the file phase and losing the round's remaining files.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_unknown_attachment_acks_and_round_continues() {
    let initiator_dir = TempDir::new().unwrap();
    let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
        .await
        .unwrap();

    // The receiver only knows about ATT_KNOWN. The first offer is for
    // ATT_UNKNOWN (no DB row) — the skip path — followed by a valid
    // offer for ATT_KNOWN that must still land.
    let known_bytes = b"the second file in the round must still arrive";
    let known_hash = blake3::hash(known_bytes).to_hex().to_string();
    insert_test_attachment(
        &initiator_pool,
        "ATT_KNOWN",
        "attachments/known.bin",
        i64::try_from(known_bytes.len()).expect("invariant: test fixture file size fits in i64"),
    )
    .await;

    let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

    let server_side = async move {
        // 1. Receive FileRequest (only ATT_KNOWN is missing locally).
        let msg: SyncMessage = server_conn.recv_json().await.unwrap();
        match msg {
            SyncMessage::FileRequest { attachment_ids } => {
                assert_eq!(attachment_ids, vec!["ATT_KNOWN".to_string()]);
            }
            other => panic!("expected FileRequest, got {other:?}"),
        }

        // 2. Offer a file the receiver has no row for, then ship bytes.
        let unknown_bytes = b"bytes for a file the receiver does not track";
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_UNKNOWN".into(),
                size_bytes: u64::try_from(unknown_bytes.len())
                    .expect("invariant: test fixture file size fits in u64"),
                blake3_hash: blake3::hash(unknown_bytes).to_hex().to_string(),
                content_hash: None,
            })
            .await
            .unwrap();
        server_conn.send_binary(unknown_bytes).await.unwrap();

        // 3. The fix: the receiver MUST ACK the skipped file promptly so
        //    we don't block here until RECV_TIMEOUT. Bound the wait so a
        //    regression fails fast instead of hanging the test.
        let ack: SyncMessage = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            server_conn.recv_json::<SyncMessage>(),
        )
        .await
        .expect("#638: receiver must ACK the skipped unknown attachment (no stall)")
        .expect("recv_json for skip ACK failed");
        assert!(
            matches!(
                ack,
                SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_UNKNOWN"
            ),
            "#638: expected FileReceived ACK for the skipped offer, got {ack:?}"
        );

        // 4. Now offer the known file — it must still transfer in the
        //    same round (the sender was not derailed by the skip).
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_KNOWN".into(),
                size_bytes: u64::try_from(known_bytes.len())
                    .expect("invariant: test fixture file size fits in u64"),
                blake3_hash: known_hash,
                content_hash: None,
            })
            .await
            .unwrap();
        server_conn.send_binary(known_bytes).await.unwrap();

        let ack2: SyncMessage = server_conn.recv_json().await.unwrap();
        assert!(
            matches!(
                ack2,
                SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_KNOWN"
            ),
            "expected FileReceived ACK for the known file, got {ack2:?}"
        );

        // 5. Conclude this half of the round.
        server_conn
            .send_json(&SyncMessage::FileTransferComplete)
            .await
            .unwrap();
    };

    let cancel_init = AtomicBool::new(false);
    let ((), initiator_result) = tokio::join!(
        server_side,
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let stats = initiator_result.expect("receive must succeed despite the skipped offer");
    // The known file landed; the unknown one was deliberately discarded.
    assert_eq!(
        stats.files_received, 1,
        "only the known file should be counted as received"
    );
    let (data, hash) = read_attachment_file(initiator_dir.path(), "attachments/known.bin").unwrap();
    assert_eq!(data, known_bytes);
    assert_eq!(hash, blake3::hash(known_bytes).to_hex().to_string());

    server.shutdown().await;
}

/// #638: the temp-writer reject path (writer open fails, e.g. a
/// `create_dir_all` collision) has the same no-ACK shape as the
/// unknown-attachment path. It must drain the offered bytes and ACK so
/// the sender unblocks and the round's next file still transfers, rather
/// than stalling until the 180s `RECV_TIMEOUT`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_temp_writer_reject_acks_and_round_continues() {
    let initiator_dir = TempDir::new().unwrap();
    let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
        .await
        .unwrap();

    // ATT_BAD's fs_path needs a parent dir `attachments/blocked` — we
    // plant a *regular file* at that path so `create_dir_all` fails with
    // NotADirectory, forcing `write_attachment_streaming` to error and
    // exercising the temp-writer reject path.
    let bad_bytes = b"bytes for a file whose temp writer cannot open";
    insert_test_attachment(
        &initiator_pool,
        "ATT_BAD",
        "attachments/blocked/bad.bin",
        i64::try_from(bad_bytes.len()).expect("invariant: test fixture file size fits in i64"),
    )
    .await;

    let good_bytes = b"the file after the writer-reject must still arrive";
    let good_hash = blake3::hash(good_bytes).to_hex().to_string();
    insert_test_attachment(
        &initiator_pool,
        "ATT_GOOD",
        "attachments/good.bin",
        i64::try_from(good_bytes.len()).expect("invariant: test fixture file size fits in i64"),
    )
    .await;

    // Plant the colliding regular file so the temp writer for ATT_BAD
    // fails to create its parent directory.
    std::fs::create_dir_all(initiator_dir.path().join("attachments")).unwrap();
    std::fs::write(
        initiator_dir.path().join("attachments/blocked"),
        b"not a dir",
    )
    .unwrap();

    let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

    let server_side = async move {
        // 1. Receive FileRequest. Both files are missing locally; the
        //    order is DB-driven, so accept either ordering and remember
        //    which we'll offer first.
        let msg: SyncMessage = server_conn.recv_json().await.unwrap();
        let ids = match msg {
            SyncMessage::FileRequest { attachment_ids } => attachment_ids,
            other => panic!("expected FileRequest, got {other:?}"),
        };
        assert!(ids.contains(&"ATT_BAD".to_string()));
        assert!(ids.contains(&"ATT_GOOD".to_string()));

        // 2. Always offer ATT_BAD (the writer-reject) FIRST.
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_BAD".into(),
                size_bytes: u64::try_from(bad_bytes.len())
                    .expect("invariant: test fixture file size fits in u64"),
                blake3_hash: blake3::hash(bad_bytes).to_hex().to_string(),
                content_hash: None,
            })
            .await
            .unwrap();
        server_conn.send_binary(bad_bytes).await.unwrap();

        // 3. The fix: ACK must arrive promptly (no RECV_TIMEOUT stall).
        let ack: SyncMessage = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            server_conn.recv_json::<SyncMessage>(),
        )
        .await
        .expect("#638: receiver must ACK after a temp-writer reject (no stall)")
        .expect("recv_json for writer-reject ACK failed");
        assert!(
            matches!(
                ack,
                SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_BAD"
            ),
            "#638: expected FileReceived ACK for the writer-rejected offer, got {ack:?}"
        );

        // 4. Offer the good file — it must still transfer.
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_GOOD".into(),
                size_bytes: u64::try_from(good_bytes.len())
                    .expect("invariant: test fixture file size fits in u64"),
                blake3_hash: good_hash,
                content_hash: None,
            })
            .await
            .unwrap();
        server_conn.send_binary(good_bytes).await.unwrap();

        let ack2: SyncMessage = server_conn.recv_json().await.unwrap();
        assert!(
            matches!(
                ack2,
                SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_GOOD"
            ),
            "expected FileReceived ACK for the good file, got {ack2:?}"
        );

        server_conn
            .send_json(&SyncMessage::FileTransferComplete)
            .await
            .unwrap();
    };

    let cancel_init = AtomicBool::new(false);
    let ((), initiator_result) = tokio::join!(
        server_side,
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let stats = initiator_result.expect("receive must succeed despite the temp-writer reject");
    assert_eq!(
        stats.files_received, 1,
        "only the good file should be counted as received"
    );
    let (data, hash) = read_attachment_file(initiator_dir.path(), "attachments/good.bin").unwrap();
    assert_eq!(data, good_bytes);
    assert_eq!(hash, blake3::hash(good_bytes).to_hex().to_string());

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
            &cancel_resp,
            None,
        ),
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None,
        ),
    );

    let sender_stats = responder_result.unwrap();
    let receiver_stats = initiator_result.unwrap();

    // File received correctly despite chunking
    let (data, hash) = read_attachment_file(initiator_dir.path(), "attachments/large.bin").unwrap();
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

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // Create both attachment files on disk; `size_bytes` in the DB
    // Rows below must match each file's on-disk length so
    // size check accepts them as present.
    let att_dir = dir.path().join("attachments");
    std::fs::create_dir_all(&att_dir).unwrap();
    std::fs::write(att_dir.join("att1.png"), b"image data 1").unwrap(); // 12 bytes
    std::fs::write(att_dir.join("att2.png"), b"image data 2").unwrap(); // 12 bytes

    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT1', 'BLK1', 'image/png', 'photo1.png', 12, 'attachments/att1.png', 1736942400000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES ('ATT2', 'BLK1', 'image/png', 'photo2.png', 12, 'attachments/att2.png', 1736942400000)",
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

/// #1993 regression: a DANGLING `attachment_blobs` row (the blob is
/// registered but its on-disk file has vanished) must NOT suppress a transfer.
/// `local_blob_path_if_present`'s `try_exists` check is what guards this — a
/// blob whose file is gone is treated as not-present, so the row whose own
/// file is also missing is still classified as missing and a full transfer is
/// requested. Without the on-disk check the bytes would be lost forever.
#[tokio::test]
async fn find_missing_attachments_not_skipped_when_blob_file_absent_1993() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    // No file is written to disk: neither the row's own fs_path nor the blob's
    // on_disk_path exist. The attachments dir does not even need to exist.
    let hash = "abc123def456deadbeefcafe";

    // Attachment row whose own file is absent, carrying a content_hash.
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
         VALUES ('ATT1', 'BLK1', 'image/png', 'photo.png', 12, 'attachments/att1.png', 1736942400000, ?)",
    )
    .bind(hash)
    .execute(&pool)
    .await
    .unwrap();

    // A DANGLING blob row for the same hash: registered, but its on_disk_path
    // file does not exist.
    sqlx::query(
        "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
         VALUES (?, 'attachments/blob_gone.png', 12, 1736942400000)",
    )
    .bind(hash)
    .execute(&pool)
    .await
    .unwrap();

    let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();

    // The dangling blob row must NOT suppress the request: ATT1 is missing.
    assert_eq!(
        missing.len(),
        1,
        "a blob row whose file is absent must not suppress the transfer"
    );
    assert_eq!(missing[0].id, "ATT1");

    // And the row must NOT have been repointed at the (non-existent) blob path.
    let fs_path: String = sqlx::query_scalar("SELECT fs_path FROM attachments WHERE id = 'ATT1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        fs_path, "attachments/att1.png",
        "row must not be repointed at a blob whose file is absent"
    );
}

// ── find_missing_attachments concurrent probe (#112 sub-item 4) ───────

/// Issue #112 sub-item 4: with the `buffer_unordered(16)` rewrite the
/// per-row `tokio::fs::metadata` probes run concurrently and may complete
/// in any order. This test seeds ~100 attachments (mix of present /
/// missing / truncated) and asserts the returned set matches the expected
/// IDs **order-independently** — the previous serial loop happened to
/// preserve `SELECT` row order, but callers never relied on that and the
/// new shape no longer guarantees it.
#[tokio::test]
async fn find_missing_attachments_concurrent_probe_set_equality() {
    use std::collections::HashSet;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();

    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK1', 'content', 'test')")
        .execute(&pool)
        .await
        .unwrap();

    let att_dir = dir.path().join("attachments");
    std::fs::create_dir_all(&att_dir).unwrap();

    // 100 attachments total. Classification by id mod 3:
    //   0 → present on disk with matching size_bytes (NOT missing)
    //   1 → row in DB, file absent on disk            (missing, NotFound)
    // 2 → file present but truncated (size mismatch) (missing)
    const TOTAL: usize = 100;
    let mut expected_missing: HashSet<String> = HashSet::new();
    let payload: &[u8] = b"concurrent-probe-payload"; // 24 bytes
    let truncated: &[u8] = b"short"; // 5 bytes ≠ stored size_bytes (24)

    for i in 0..TOTAL {
        let id = format!("ATT{i:03}");
        let fs_path = format!("attachments/att{i:03}.bin");
        let on_disk = att_dir.join(format!("att{i:03}.bin"));
        match i % 3 {
            0 => {
                std::fs::write(&on_disk, payload).unwrap();
            }
            1 => {
                // intentionally no file on disk
                expected_missing.insert(id.clone());
            }
            _ => {
                std::fs::write(&on_disk, truncated).unwrap();
                expected_missing.insert(id.clone());
            }
        }

        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, 'BLK1', 'application/octet-stream', ?, 24, ?, 1736942400000)",
        )
        .bind(&id)
        .bind(format!("att{i:03}.bin"))
        .bind(&fs_path)
        .execute(&pool)
        .await
        .unwrap();
    }

    let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();

    let got: HashSet<String> = missing.into_iter().map(|m| m.id).collect();
    assert_eq!(
        got, expected_missing,
        "buffer_unordered(16) probe must return the same set as the serial loop \
         regardless of completion order"
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
    let stats =
        receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel, None)
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
    let stats =
        receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel, None)
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
                ..
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
    let stats =
        receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel, None)
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
    let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel, None)
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
                content_hash: None,
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
    let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel, None)
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

/// Chaos / partial-transfer recovery. The sender drops the
/// connection mid-binary-frame after delivering an unprocessable
/// partial chunk; the receiver must:
///
/// (a) return `Err` from `request_and_receive_files`,
/// (b) leave NO file on disk at the offered `fs_path`
///     (write happens only after the full payload + hash verify),
/// (c) keep the attachment row visible to `find_missing_attachments`
///     so the next sync cycle re-tries.
///
/// This pins the contract that ACK-after-write means a partial
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
                content_hash: None,
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
        request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel, None).await;
    server_task.await.unwrap();

    // (a) Receive surfaces the disconnection as Err.
    assert!(
        result.is_err(),
        "mid-frame disconnect must surface as Err; got {result:?}"
    );

    // (b) No half-written file on disk. guarantees the write
    // happens only after the full hash-verified payload is in
    // memory; an interrupted transfer must leave the path empty.
    assert!(
        !final_path.exists(),
        "no half-written file may appear on disk after a mid-frame \
         disconnect; found unexpected file at {final_path:?}"
    );

    // (c) The attachment is still classified as missing so the next
    // Sync retries it. (`find_missing_attachments` re-detects
    // truncated files) makes the result deterministic regardless of
    // whether the OS allocated a 0-byte stub on the way.
    let still_missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
    let still_missing_ids: Vec<&str> = still_missing.iter().map(|m| m.id.as_str()).collect();
    assert!(
        still_missing_ids.contains(&"ATT_L72"),
        "attachment must remain in find_missing_attachments after partial \
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
    let stats = run_file_transfer_responder(&mut server_conn, &pool, &app_data_dir, &cancel, None)
        .await
        .unwrap();
    initiator_task.await.unwrap();

    assert_eq!(stats.files_sent, 0);
    assert_eq!(stats.files_received, 0);
    assert_eq!(stats.bytes_sent, 0);
    assert_eq!(stats.bytes_received, 0);
}

// ── cancel signal breaks file transfer between files ────────────

/// (#317): when `cancel` is set after file 1's transfer, the
/// receiver must keep file 1 (already received + ACKed) but break out
/// before processing file 2.
///
/// Ordering is made deterministic to kill the prior flake: the mock
/// responder sends `FileOffer1` + file1 binary, then **receives ACK1**,
/// and only THEN stores `cancel = true`. Because the store is causally
/// after ACK1 (which the receiver sends at the *end* of iteration 1),
/// the receiver provably enters iteration 1 with `cancel == false`,
/// fully processes file 1, and observes the cancel no earlier than
/// iteration 2. The responder then sends NOTHING further, so the
/// receiver breaks via either the top-of-loop check (if the store is
/// already visible) or the cancel-aware wait in `request_and_receive_files`
/// (#317 fix): a bare `recv_json` would otherwise block forever here
/// because the peer never sends another message.
///
/// (The old version stored cancel *between* `FileOffer1` and the file1
/// binary and claimed a happens-before against iteration 1's top check.
/// That claim was false — both merely happened after `FileRequest` — so
/// under scheduling pressure the receiver could break at iteration 1's
/// top before consuming file1, leaving the responder blocked on ACK1
/// until the nextest timeout. That was the bug.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_file_transfer_initiator_breaks_on_cancel_m47() {
    use std::sync::Arc;

    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    let app_data_dir = dir.path().to_path_buf();

    let file1: &[u8] = b"first file body content for  test";
    let file2: &[u8] = b"second file body - should NOT be received after cancel";
    let hash1 = blake3::hash(file1).to_hex().to_string();
    // file2's hash is intentionally unused: file2 is never offered to the
    // receiver (the responder stops after ACK1), so there is no FileOffer2
    // to carry a blake3_hash. file2's *bytes* are still used to size its
    // attachment row so the receiver requests it (and we assert it never
    // lands on disk).

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

    // Mock responder: drives the protocol manually. It sets `cancel`
    // only AFTER receiving ACK1, so the cancel store is causally after
    // the receiver has finished iteration 1 (recv_binary, write, ACK).
    // The receiver therefore cannot observe cancel before iteration 2,
    // and `files_received` is deterministically 1.
    let responder_task = tokio::spawn(async move {
        // 1. Receive FileRequest for both files. `find_missing_attachments`
        //    fans the per-row metadata probe through `buffer_unordered(16)`
        //    (sync_files.rs:237) so the request order is non-deterministic
        //    in concurrent runs — assert set membership, not order (#162).
        let req: SyncMessage = server_conn.recv_json().await.unwrap();
        match req {
            SyncMessage::FileRequest { mut attachment_ids } => {
                attachment_ids.sort();
                assert_eq!(
                    attachment_ids,
                    vec!["ATT_M47_1".to_string(), "ATT_M47_2".to_string()],
                    " setup: both attachments must be requested"
                );
            }
            other => panic!(" setup: expected FileRequest, got {other:?}"),
        }

        // 2. Send FileOffer for file 1.
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_M47_1".into(),
                size_bytes: u64::try_from(file1.len())
                    .expect("invariant: test fixture file size fits in u64"),
                blake3_hash: hash1.clone(),
                content_hash: None,
            })
            .await
            .unwrap();

        // 3. Send file 1 binary — receiver processes iteration 1.
        server_conn.send_binary(file1).await.unwrap();

        // 4. Receive ACK for file 1. The receiver sends this at the END
        //    of iteration 1, so everything below is causally after the
        //    receiver fully processed file 1.
        let ack: SyncMessage = server_conn.recv_json().await.unwrap();
        assert!(
            matches!(
                ack,
                SyncMessage::FileReceived { ref attachment_id } if attachment_id == "ATT_M47_1"
            ),
            "receiver must ACK file 1 before observing cancel; got {ack:?}"
        );

        // 5. (#317): store cancel ONLY after ACK1. This makes the
        //    cancel observation deterministic — the receiver has provably
        //    completed iteration 1, so it can only see cancel at/after
        //    iteration 2's start.
        cancel_responder.store(true, Ordering::Release);

        // 6. Send NOTHING further. file2 (`hash2`) must never be offered:
        //    the receiver breaks at iteration 2 — either at the top-of-loop
        //    cancel check (store already visible) or via the cancel-aware
        //    wait in `request_and_receive_files` (#317). Sending a second
        //    FileOffer here would reintroduce a race, so we deliberately
        //    leave the connection idle until the receiver returns and the
        //    test drops it.
    });

    // Initiator (receiver) side: run the production code path.
    let stats = request_and_receive_files(&mut client_conn, &pool, &app_data_dir, &cancel, None)
        .await
        .expect("receive must return Ok with partial stats on cancel");

    let _ = responder_task.await;

    // Contract:
    // (a) file 1 was successfully received,
    // (b) file 2 was NOT received,
    // (c) cancel flag is still set (cleared only by the daemon's
    //     CancelGuard, not by the file-transfer helper).
    assert_eq!(
        stats.files_received, 1,
        "exactly one file should be received before cancel takes effect"
    );
    assert!(
        dir.path().join("attachments/m47_1.bin").exists(),
        "file 1 must be on disk (it completed before cancel was observed)"
    );
    assert!(
        !dir.path().join("attachments/m47_2.bin").exists(),
        "file 2 must NOT be on disk — receiver must break before processing it"
    );
    assert!(
        cancel.load(Ordering::Acquire),
        "file-transfer helper does not clear cancel; that is the daemon's job"
    );
}

// ──: attachment path traversal validation ────────────
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
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('BLK_OK', 'content', 'ok')")
        .execute(&pool)
        .await
        .unwrap();

    let result = crate::commands::add_attachment_inner(
        &pool,
        "test-device",
        &mat,
        dir.path(),
        "BLK_OK".into(),
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

// ===========================================================================
// Streaming attachment transfer regression suite
// ===========================================================================
//
// These tests pin the low-memory streaming path introduced in:
//
//   • Sender uses `read_attachment_file_metadata` + streaming
//     `send_binary_streaming` (no `Vec<u8>` of the full file on the
//     heap).
//   • Receiver uses `TempAttachmentWriter` (writes to
//     `<final>.tmp-<rand>`, hashes mid-write, atomic rename on
//     `commit`, drop unlinks the temp).
//
// The buffered-shape helpers (`read_attachment_file`,
// `write_attachment_file`) are still around for utility callers; the
// existing tests above continue to exercise them.

/// Sender streams a 50 MB attachment frame-by-frame to the
/// wire and the receiver lands the bytes via a temp-file writer.
/// Asserts streaming byte-equality (received bytes match sent bytes),
/// correct transfer stats (files/bytes counts), and that the
/// metadata helper computes the same blake3 the receiver's commit does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_send_streams_without_full_vec_materialization_m51() {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    let app_data_dir = dir.path().to_path_buf();

    // 50 MB attachment — large enough to span ~10 binary frames at
    // BINARY_FRAME_CHUNK_SIZE = 5 MB. Deterministic byte pattern so
    // the hash check is exact.
    let file_size: usize = 50 * 1024 * 1024;
    #[allow(clippy::cast_possible_truncation)]
    let file_data: Vec<u8> = (0..file_size).map(|i| (i % 251) as u8).collect();
    let expected_hash = blake3::hash(&file_data).to_hex().to_string();
    let expected_size = u64::try_from(file_size).expect("test fixture size fits in u64");

    insert_test_attachment(
        &pool,
        "ATT_M51_BIG",
        "attachments/m51_big.bin",
        i64::try_from(file_size).expect("test fixture size fits in i64"),
    )
    .await;
    write_attachment_file(dir.path(), "attachments/m51_big.bin", &file_data).unwrap();

    // Cross-check: the streaming metadata helper computes the same
    // hash + size as the buffered shape — the exact equality is the
    // Contract that lets the sender keep the existing
    // `FileOffer` wire shape.
    let (meta_size, meta_hash) =
        read_attachment_file_metadata(dir.path(), "attachments/m51_big.bin")
            .await
            .unwrap();
    assert_eq!(meta_size, expected_size);
    assert_eq!(meta_hash, expected_hash);

    let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

    // Initiator: request the file, drive the receive side.
    let init_dir = TempDir::new().unwrap();
    let init_pool = init_pool(&init_dir.path().join("init.db")).await.unwrap();
    let init_app = init_dir.path().to_path_buf();
    insert_test_attachment(
        &init_pool,
        "ATT_M51_BIG",
        "attachments/m51_big.bin",
        i64::try_from(file_size).expect("test fixture size fits in i64"),
    )
    .await;

    let cancel_resp = AtomicBool::new(false);
    let cancel_init = AtomicBool::new(false);
    let (resp_result, init_result) = tokio::join!(
        receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel_resp, None),
        request_and_receive_files(&mut client_conn, &init_pool, &init_app, &cancel_init, None),
    );
    let send_stats = resp_result.expect(" streaming send must succeed");
    let recv_stats = init_result.expect(" streaming receive must succeed");

    assert_eq!(send_stats.files_sent, 1);
    assert_eq!(send_stats.bytes_sent, expected_size);
    assert_eq!(recv_stats.files_received, 1);
    assert_eq!(recv_stats.bytes_received, expected_size);

    // The received file matches byte-for-byte and produces the same
    // blake3 hash on the receiver side.
    let received = std::fs::read(init_dir.path().join("attachments/m51_big.bin")).unwrap();
    assert_eq!(received.len(), file_size);
    assert_eq!(blake3::hash(&received).to_hex().to_string(), expected_hash);
    assert_eq!(received, file_data);
}

/// Confirm the receiver writes through a `<final>.tmp-<rand>`
/// path and the final filename only appears post-commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_receive_writes_to_temp_then_renames_m51() {
    let dir = TempDir::new().unwrap();
    let mut writer = write_attachment_streaming(dir.path(), "attachments/probe.bin")
        .await
        .expect("opening temp writer must succeed");

    // The temp path is a sibling of the final path with a
    // `.tmp-<32-hex>` suffix, and it exists on disk before any data
    // has been written through the writer.
    let final_path = dir.path().join("attachments/probe.bin");
    let temp_path = writer.temp_path().to_path_buf();
    assert!(
        temp_path.starts_with(dir.path().join("attachments")),
        "temp path must live in the same directory as the final path"
    );
    assert!(
        temp_path.exists(),
        "temp file must exist on disk before commit, got missing {temp_path:?}"
    );
    assert!(
        !final_path.exists(),
        "final file must NOT exist before commit"
    );

    // Drive bytes through the writer.
    let payload: &[u8] = b"some attachment bytes for the temp-file probe";
    writer.write_all(payload).await.unwrap();
    writer.flush().await.unwrap();

    // Mid-write: temp still present, final still absent.
    assert!(temp_path.exists());
    assert!(!final_path.exists());

    // Commit with the right hash → atomic rename, temp gone.
    let expected_hash = blake3::hash(payload).to_hex().to_string();
    writer.commit(&expected_hash).await.unwrap();

    assert!(
        !temp_path.exists(),
        "temp file must be gone after commit (rename consumed it)"
    );
    assert!(final_path.exists(), "final file must exist after commit");
    assert_eq!(std::fs::read(&final_path).unwrap(), payload);
}

/// Hash mismatch on commit must unlink the temp and surface
/// an `AppError::InvalidOperation("hash_mismatch: …")`. The final
/// file must NOT exist.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_receive_hash_mismatch_unlinks_temp_m51() {
    let dir = TempDir::new().unwrap();
    let mut writer = write_attachment_streaming(dir.path(), "attachments/bad.bin")
        .await
        .unwrap();
    let temp_path = writer.temp_path().to_path_buf();

    writer.write_all(b"actual bytes").await.unwrap();
    writer.flush().await.unwrap();

    let wrong_hash = blake3::hash(b"different bytes").to_hex().to_string();
    let err = writer.commit(&wrong_hash).await.unwrap_err();
    match err {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("hash_mismatch"),
                "hash mismatch error must mention `hash_mismatch`, got {msg:?}"
            );
        }
        other => panic!("expected InvalidOperation(hash_mismatch), got {other:?}"),
    }

    assert!(
        !temp_path.exists(),
        "temp file must be unlinked after a hash-mismatch commit failure"
    );
    let final_path = dir.path().join("attachments/bad.bin");
    assert!(
        !final_path.exists(),
        "final file must not exist after a failed commit"
    );
}

/// Dropping a `TempAttachmentWriter` mid-stream (no commit
/// reached, e.g. peer disconnect / cancel) must unlink the temp so
/// abandoned transfers do not leak `*.tmp-*` orphans.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_receive_drop_unlinks_temp_m51() {
    let dir = TempDir::new().unwrap();
    let temp_path = {
        let mut writer = write_attachment_streaming(dir.path(), "attachments/abandoned.bin")
            .await
            .unwrap();
        let p = writer.temp_path().to_path_buf();
        writer.write_all(b"some partial bytes").await.unwrap();
        // Drop the writer without commit (mid-stream abandonment).
        drop(writer);
        p
    };

    assert!(
        !temp_path.exists(),
        "dropping a writer without commit must unlink the temp file"
    );
    let final_path = dir.path().join("attachments/abandoned.bin");
    assert!(
        !final_path.exists(),
        "final file must never have appeared on an abandoned transfer"
    );
}

/// Empty (zero-byte) attachments must still round-trip via a
/// single empty binary frame, matching the
/// `send_binary_streaming` / `receive_binary_streaming` zero-byte
/// contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_send_empty_file_uses_single_empty_frame_m51() {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    let app_data_dir = dir.path().to_path_buf();

    // Empty attachment.
    insert_test_attachment(&pool, "ATT_M51_EMPTY", "attachments/empty.bin", 0).await;
    write_attachment_file(dir.path(), "attachments/empty.bin", b"").unwrap();

    let init_dir = TempDir::new().unwrap();
    let init_pool = init_pool(&init_dir.path().join("init.db")).await.unwrap();
    insert_test_attachment(&init_pool, "ATT_M51_EMPTY", "attachments/empty.bin", 0).await;

    let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

    let cancel_resp = AtomicBool::new(false);
    let cancel_init = AtomicBool::new(false);
    let (resp_result, init_result) = tokio::join!(
        receive_request_and_send_files(&mut server_conn, &pool, &app_data_dir, &cancel_resp, None),
        request_and_receive_files(
            &mut client_conn,
            &init_pool,
            init_dir.path(),
            &cancel_init,
            None
        ),
    );
    let send_stats = resp_result.unwrap();
    let recv_stats = init_result.unwrap();

    assert_eq!(send_stats.files_sent, 1);
    assert_eq!(send_stats.bytes_sent, 0);
    assert_eq!(recv_stats.files_received, 1);
    assert_eq!(recv_stats.bytes_received, 0);

    // Final file exists and is empty.
    let path = init_dir.path().join("attachments/empty.bin");
    assert!(path.exists());
    let received = std::fs::read(&path).unwrap();
    assert_eq!(received.len(), 0);
}

/// Verifies `TempAttachmentWriter`'s running hasher matches
/// `read_attachment_file_metadata` parity — no wire transfer.
/// Feeds bytes directly into the writer and asserts that the hash
/// recorded by the writer on `commit` equals the hash computed by
/// `read_attachment_file_metadata` for the same payload.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_streaming_writer_hasher_matches_file_metadata_m51() {
    let dir = TempDir::new().unwrap();
    // Mid-sized payload (a few chunks worth) with a non-trivial byte
    // distribution.
    let payload_len = 12 * 1024 * 1024 + 17; // 12 MB + change
    #[allow(clippy::cast_possible_truncation)]
    let payload: Vec<u8> = (0..payload_len)
        .map(|i: usize| (i.wrapping_mul(31) % 256) as u8)
        .collect();
    let expected_hash = blake3::hash(&payload).to_hex().to_string();

    // Write the file via the buffered helper, then read its metadata
    // via the streaming helper.
    write_attachment_file(dir.path(), "attachments/round_trip.bin", &payload).unwrap();
    let (meta_size, meta_hash) =
        read_attachment_file_metadata(dir.path(), "attachments/round_trip.bin")
            .await
            .unwrap();
    assert_eq!(meta_size, payload_len as u64);
    assert_eq!(meta_hash, expected_hash);

    // Drive the bytes through TempAttachmentWriter (the receiver
    // shape) and confirm the running hasher matches.
    let dest_dir = TempDir::new().unwrap();
    let mut writer = write_attachment_streaming(dest_dir.path(), "attachments/round_trip.bin")
        .await
        .unwrap();
    writer.write_all(&payload).await.unwrap();
    writer.flush().await.unwrap();
    writer.commit(&expected_hash).await.unwrap();

    let dest = dest_dir.path().join("attachments/round_trip.bin");
    let dest_bytes = std::fs::read(&dest).unwrap();
    assert_eq!(dest_bytes, payload);
    assert_eq!(
        blake3::hash(&dest_bytes).to_hex().to_string(),
        expected_hash
    );
}

/// The wire-level streaming helpers in `SyncConnection`
/// (`send_binary_streaming` / `receive_binary_streaming`) must
/// round-trip an `AsyncRead` source straight into an `AsyncWrite`
/// sink without ever materialising the full payload as a Vec on
/// the heap. Probe with a `tokio::io::Cursor` source + `Vec<u8>`
/// sink and confirm exact byte equality.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_helpers_streaming_round_trip_m51() {
    let payload: Vec<u8> = (0..(BINARY_FRAME_CHUNK_SIZE * 2 + 7))
        // wrap-around byte pattern; clippy-narrowed truncation per the
        // existing protocol_large_file_chunking convention.
        .map(|i| {
            #[allow(clippy::cast_possible_truncation)]
            let b = (i % 256) as u8;
            b
        })
        .collect();
    let expected_size = u64::try_from(payload.len()).unwrap();

    let (mut server_conn, mut client_conn) = crate::sync_net::test_connection_pair().await;

    let payload_clone = payload.clone();
    let server_task = tokio::spawn(async move {
        let cursor = std::io::Cursor::new(payload_clone);
        server_conn
            .send_binary_streaming(cursor, expected_size, BINARY_FRAME_CHUNK_SIZE)
            .await
            .unwrap();
    });

    let mut sink: Vec<u8> = Vec::with_capacity(payload.len());
    client_conn
        .receive_binary_streaming(&mut sink, expected_size)
        .await
        .unwrap();
    server_task.await.unwrap();

    assert_eq!(sink.len(), payload.len());
    assert_eq!(sink, payload);
}

// ── #1993 Phase 2: content-addressed skip-transfer ───────────────────

/// Insert an `attachment_blobs` row (the local content-addressed blob store).
async fn insert_blob_row(pool: &SqlitePool, content_hash: &str, on_disk_path: &str, size: i64) {
    sqlx::query(
        "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
         VALUES (?, ?, ?, unixepoch('now') * 1000)",
    )
    .bind(content_hash)
    .bind(on_disk_path)
    .bind(size)
    .execute(pool)
    .await
    .unwrap();
}

/// #1993: when the RECEIVER already holds a local blob for the attachment's
/// content_hash (file present on disk + blob row), `find_missing_attachments`
/// classifies the row as NOT missing — so no FileRequest is issued for it and
/// no binary transfer occurs. The row is also repointed at the local blob.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_missing_skips_when_local_blob_present_1993() {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();

    let bytes = b"already-held bytes for skip transfer".to_vec();
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = i64::try_from(bytes.len()).unwrap();

    // The attachment row's OWN fs_path file is missing, but the bytes exist
    // under a DIFFERENT path that the blob owns.
    std::fs::create_dir_all(dir.path().join("attachments")).unwrap();
    let blob_path = "attachments/blob_canonical.bin";
    std::fs::write(dir.path().join(blob_path), &bytes).unwrap();
    insert_blob_row(&pool, &hash, blob_path, size).await;

    // Row points at a missing path but carries the matching content_hash.
    let blk = "BLK_SKIP";
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'x')")
        .bind(blk)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
         VALUES ('ATT_SKIP', ?, 'application/octet-stream', 'f.bin', ?, 'attachments/missing.bin', unixepoch('now')*1000, ?)",
    )
    .bind(blk)
    .bind(size)
    .bind(&hash)
    .execute(&pool)
    .await
    .unwrap();

    let missing = find_missing_attachments(&pool, dir.path()).await.unwrap();
    assert!(
        missing.is_empty(),
        "row whose content_hash has a present local blob must NOT be missing: {missing:?}"
    );

    // The row was repointed at the canonical blob file.
    let fs_path: String =
        sqlx::query_scalar("SELECT fs_path FROM attachments WHERE id = 'ATT_SKIP'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        fs_path, blob_path,
        "row must be repointed at the local blob"
    );
}

/// #1993 end-to-end skip: the receiver already has the blob → it issues NO
/// FileRequest for that attachment, so the sender transfers ZERO files.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_skip_transfer_when_receiver_has_blob_1993() {
    let initiator_dir = TempDir::new().unwrap();
    let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
        .await
        .unwrap();
    let responder_dir = TempDir::new().unwrap();
    let responder_pool = init_pool(&responder_dir.path().join("test.db"))
        .await
        .unwrap();

    let file_data = b"bytes the initiator already holds via a blob".to_vec();
    let hash = blake3::hash(&file_data).to_hex().to_string();
    let size = i64::try_from(file_data.len()).unwrap();

    // Both sides know the attachment row.
    insert_test_attachment(&initiator_pool, "ATT01", "attachments/photo.jpg", size).await;
    insert_test_attachment(&responder_pool, "ATT01", "attachments/photo.jpg", size).await;
    // Set the initiator row's content_hash so the skip path can match.
    sqlx::query("UPDATE attachments SET content_hash = ? WHERE id = 'ATT01'")
        .bind(&hash)
        .execute(&initiator_pool)
        .await
        .unwrap();

    // Responder has the file; initiator does NOT at the row's path but DOES
    // hold it under a local blob (different path).
    write_attachment_file(responder_dir.path(), "attachments/photo.jpg", &file_data).unwrap();
    std::fs::create_dir_all(initiator_dir.path().join("attachments")).unwrap();
    let blob_path = "attachments/held_blob.bin";
    std::fs::write(initiator_dir.path().join(blob_path), &file_data).unwrap();
    insert_blob_row(&initiator_pool, &hash, blob_path, size).await;

    let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;
    let cancel_resp = AtomicBool::new(false);
    let cancel_init = AtomicBool::new(false);
    let (responder_result, initiator_result) = tokio::join!(
        receive_request_and_send_files(
            &mut server_conn,
            &responder_pool,
            responder_dir.path(),
            &cancel_resp,
            None
        ),
        request_and_receive_files(
            &mut client_conn,
            &initiator_pool,
            initiator_dir.path(),
            &cancel_init,
            None
        ),
    );
    let sender_stats = responder_result.unwrap();
    let receiver_stats = initiator_result.unwrap();

    assert_eq!(
        sender_stats.files_sent, 0,
        "sender must transfer NO files (receiver had the blob)"
    );
    assert_eq!(
        receiver_stats.files_received, 0,
        "receiver must receive NO files"
    );
    assert_eq!(receiver_stats.bytes_received, 0);

    server.shutdown().await;
}

/// #1993 back-compat: a `FileOffer` WITHOUT `content_hash` (old-peer
/// simulation) still transfers correctly — the receiver falls back to the
/// mandatory `blake3_hash` for verification and writes the file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_offer_without_content_hash_still_transfers_1993() {
    let initiator_dir = TempDir::new().unwrap();
    let initiator_pool = init_pool(&initiator_dir.path().join("test.db"))
        .await
        .unwrap();

    let file_data = b"old-peer bytes without content_hash field".to_vec();
    let hash = blake3::hash(&file_data).to_hex().to_string();
    let size_u64 = u64::try_from(file_data.len()).unwrap();
    insert_test_attachment(
        &initiator_pool,
        "ATT_OLD",
        "attachments/old.bin",
        i64::try_from(file_data.len()).unwrap(),
    )
    .await;

    let (mut server_conn, mut client_conn, server) = setup_tls_pair().await;

    // Old-peer sender: send a FileOffer with content_hash explicitly None,
    // then stream the bytes, then await the ack.
    let data_clone = file_data.clone();
    let hash_clone = hash.clone();
    let sender = tokio::spawn(async move {
        server_conn
            .send_json(&SyncMessage::FileOffer {
                attachment_id: "ATT_OLD".into(),
                size_bytes: size_u64,
                blake3_hash: hash_clone,
                content_hash: None,
            })
            .await
            .unwrap();
        let cursor = std::io::Cursor::new(data_clone);
        server_conn
            .send_binary_streaming(
                cursor,
                size_u64,
                crate::sync_constants::BINARY_FRAME_CHUNK_SIZE,
            )
            .await
            .unwrap();
        let _ack: SyncMessage = server_conn.recv_json().await.unwrap();
        server_conn
            .send_json(&SyncMessage::FileTransferComplete)
            .await
            .unwrap();
    });

    let cancel = AtomicBool::new(false);
    let recv_stats = request_and_receive_files(
        &mut client_conn,
        &initiator_pool,
        initiator_dir.path(),
        &cancel,
        None,
    )
    .await
    .unwrap();
    sender.await.unwrap();

    assert_eq!(
        recv_stats.files_received, 1,
        "old-peer offer must transfer normally"
    );
    let (data, got_hash) =
        read_attachment_file(initiator_dir.path(), "attachments/old.bin").unwrap();
    assert_eq!(data, file_data);
    assert_eq!(got_hash, hash);

    server.shutdown().await;
}
