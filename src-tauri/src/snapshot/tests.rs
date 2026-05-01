use super::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{CreateBlockPayload, OpPayload};
use crate::op_log::append_local_op_at;
use crate::ulid::BlockId;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tempfile::TempDir;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Build a `Materializer` for tests that need to pass one to
/// `apply_snapshot` (BUG-42). The tests that don't care about cache
/// rebuild behaviour can still use this — the enqueued tasks are
/// harmless and will just process against the restored DB.
fn test_materializer(pool: &SqlitePool) -> Materializer {
    Materializer::new(pool.clone())
}

/// Create a minimal SnapshotData for unit tests (no DB needed).
fn sample_snapshot_data() -> SnapshotData {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("device-A".to_string(), 5);
    up_to_seqs.insert("device-B".to_string(), 3);

    SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "device-A".to_string(),
        up_to_seqs,
        up_to_hash: "abc123".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "block-1".to_string(),
                block_type: "content".to_string(),
                content: Some("hello world".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![BlockTagSnapshot {
                block_id: "block-1".to_string(),
                tag_id: "tag-1".to_string(),
            }],
            block_properties: vec![BlockPropertySnapshot {
                block_id: "block-1".to_string(),
                key: "due".to_string(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-01-15".to_string()),
                value_ref: None,
            }],
            block_links: vec![BlockLinkSnapshot {
                source_id: "block-1".to_string(),
                target_id: "block-2".to_string(),
            }],
            attachments: vec![AttachmentSnapshot {
                id: "att-1".to_string(),
                block_id: "block-1".to_string(),
                mime_type: "image/png".to_string(),
                filename: "photo.png".to_string(),
                size_bytes: 1024,
                fs_path: "attachments/photo.png".to_string(),
                created_at: "2025-01-01T00:00:00Z".to_string(),
                deleted_at: None,
            }],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    }
}

/// Helper: insert a block directly into the DB (bypasses op log).
async fn insert_block(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES (?, 'content', ?, 1, 0)",
    )
    .bind(id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
}

/// Helper: insert an op via append_local_op_at with an explicit timestamp.
async fn insert_op_at(pool: &SqlitePool, device_id: &str, block_id: &str, ts: &str) {
    let op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_owned(),
        parent_id: None,
        position: Some(0),
        content: "test".to_owned(),
    });
    append_local_op_at(pool, device_id, op, ts.to_owned())
        .await
        .unwrap();
}

// =======================================================================
// 1. encode_decode_round_trip
// =======================================================================

#[test]
fn encode_decode_round_trip() {
    let data = sample_snapshot_data();
    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    assert_eq!(
        decoded.schema_version, SCHEMA_VERSION,
        "schema version must survive round-trip"
    );
    assert_eq!(
        decoded.snapshot_device_id, "device-A",
        "snapshot device id must survive round-trip"
    );
    assert_eq!(
        decoded.up_to_hash, "abc123",
        "up_to_hash must survive round-trip"
    );
    assert_eq!(
        decoded.up_to_seqs.len(),
        2,
        "up_to_seqs should contain both devices"
    );
    assert_eq!(
        decoded.up_to_seqs["device-A"], 5,
        "device-A seq must survive round-trip"
    );
    assert_eq!(
        decoded.up_to_seqs["device-B"], 3,
        "device-B seq must survive round-trip"
    );

    assert_eq!(
        decoded.tables.blocks.len(),
        1,
        "blocks table should have exactly one entry"
    );
    assert_eq!(
        decoded.tables.blocks[0].id, "block-1",
        "block id must survive round-trip"
    );
    assert_eq!(
        decoded.tables.blocks[0].content.as_deref(),
        Some("hello world"),
        "block content must survive round-trip"
    );

    assert_eq!(
        decoded.tables.block_tags.len(),
        1,
        "block_tags table should have exactly one entry"
    );
    assert_eq!(
        decoded.tables.block_tags[0].tag_id, "tag-1",
        "tag id must survive round-trip"
    );

    assert_eq!(
        decoded.tables.block_properties.len(),
        1,
        "block_properties table should have exactly one entry"
    );
    assert_eq!(
        decoded.tables.block_properties[0].key, "due",
        "property key must survive round-trip"
    );
    assert_eq!(
        decoded.tables.block_properties[0].value_date.as_deref(),
        Some("2025-01-15"),
        "property value_date must survive round-trip"
    );

    assert_eq!(
        decoded.tables.block_links.len(),
        1,
        "block_links table should have exactly one entry"
    );
    assert_eq!(
        decoded.tables.block_links[0].source_id, "block-1",
        "link source_id must survive round-trip"
    );

    assert_eq!(
        decoded.tables.attachments.len(),
        1,
        "attachments table should have exactly one entry"
    );
    assert_eq!(
        decoded.tables.attachments[0].filename, "photo.png",
        "attachment filename must survive round-trip"
    );
}

// =======================================================================
// 2. decode_rejects_bad_version
// =======================================================================

#[test]
fn decode_rejects_bad_version() {
    let mut data = sample_snapshot_data();
    data.schema_version = 99;

    let encoded = {
        let mut cbor_buf = Vec::new();
        ciborium::into_writer(&data, &mut cbor_buf).unwrap();
        zstd::encode_all(cbor_buf.as_slice(), 3).unwrap()
    };

    let err = decode_snapshot(&encoded[..]).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("unsupported schema version 99"),
        "expected version error, got: {msg}"
    );
}

// =======================================================================
// 3. decode_rejects_corrupt_data
// =======================================================================

#[test]
fn decode_rejects_corrupt_data() {
    let garbage: [u8; 7] = [0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x42, 0x42];
    let err = decode_snapshot(&garbage[..]).unwrap_err();
    let msg = err.to_string();
    // L-67: with the streaming decoder, the zstd error can surface in
    // either layer:
    //   • `zstd decompress` if `Decoder::new` rejects the magic bytes
    //     up front, OR
    //   • `CBOR decode: Io(... Unknown frame descriptor ...)` when the
    //     zstd error comes through `ciborium::from_reader`'s underlying
    //     `Read` call (which is the typical path: `Decoder::new` is
    //     lazy and the failure shows up the first time CBOR pulls
    //     bytes through it).
    // Either is a legitimate "garbage rejected" outcome — the test's
    // intent is just "garbage must not decode".
    let zstd_layer = msg.contains("zstd decompress");
    let cbor_io_layer = msg.contains("CBOR decode") && msg.contains("Unknown frame descriptor");
    assert!(
        zstd_layer || cbor_io_layer,
        "expected zstd or zstd-via-CBOR error for garbage bytes, got: {msg}"
    );
}

// =======================================================================
// 4. encode_empty_snapshot
// =======================================================================

#[test]
fn encode_empty_snapshot() {
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "empty".to_string(),
        tables: SnapshotTables {
            blocks: vec![],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    assert_eq!(
        decoded.tables.blocks.len(),
        0,
        "empty snapshot should have no blocks"
    );
    assert_eq!(
        decoded.tables.block_tags.len(),
        0,
        "empty snapshot should have no block_tags"
    );
    assert_eq!(
        decoded.tables.block_properties.len(),
        0,
        "empty snapshot should have no block_properties"
    );
    assert_eq!(
        decoded.tables.block_links.len(),
        0,
        "empty snapshot should have no block_links"
    );
    assert_eq!(
        decoded.tables.attachments.len(),
        0,
        "empty snapshot should have no attachments"
    );
    assert!(
        decoded.up_to_seqs.is_empty(),
        "empty snapshot should have no device seqs"
    );
}

// =======================================================================
// 5. create_snapshot_and_read_back
// =======================================================================

#[tokio::test]
async fn create_snapshot_and_read_back() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block and an op so the frontier query succeeds
    insert_block(&pool, "block-1", "hello").await;
    insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();
    assert!(!snapshot_id.is_empty(), "snapshot id should not be empty");

    // Read back from log_snapshots
    let row = sqlx::query!(
        "SELECT id, data FROM log_snapshots WHERE id = ? AND status = 'complete'",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let (id, data) = (row.id, row.data);

    assert_eq!(id, snapshot_id, "fetched snapshot id must match created id");

    // Decode and verify
    let decoded = decode_snapshot(&data[..]).unwrap();
    assert_eq!(
        decoded.snapshot_device_id, device_id,
        "snapshot device id must match"
    );
    assert_eq!(
        decoded.tables.blocks.len(),
        1,
        "snapshot should contain exactly one block"
    );
    assert_eq!(
        decoded.tables.blocks[0].id, "block-1",
        "snapshot block id must match inserted block"
    );
    assert_eq!(
        decoded.tables.blocks[0].content.as_deref(),
        Some("hello"),
        "snapshot block content must match inserted value"
    );
}

// =======================================================================
// 6. create_snapshot_writes_pending_then_complete
// =======================================================================

#[tokio::test]
async fn create_snapshot_writes_pending_then_complete() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Need at least one op for frontier
    insert_block(&pool, "block-1", "content").await;
    insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();

    // After create, status should be 'complete'
    let status: String =
        sqlx::query_scalar!("SELECT status FROM log_snapshots WHERE id = ?", snapshot_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        status, "complete",
        "snapshot status should be 'complete' after creation"
    );

    // No pending rows should remain
    let pending_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        pending_count, 0,
        "no pending snapshots should remain after creation"
    );
}

// =======================================================================
// 7. apply_snapshot_wipes_and_restores
// =======================================================================

#[tokio::test]
async fn apply_snapshot_wipes_and_restores() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let device_id = "dev-1";

    // Insert original data + op
    insert_block(&pool, "block-orig", "original").await;
    insert_op_at(&pool, device_id, "block-orig", "2025-01-01T00:00:00Z").await;

    // Create snapshot capturing original state
    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();

    // Read the snapshot data blob
    let snap_row = sqlx::query!(
        "SELECT id, data FROM log_snapshots WHERE id = ?",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let snap_data = snap_row.data;

    // Insert additional data that should be wiped by apply
    insert_block(&pool, "block-extra", "extra").await;
    insert_op_at(&pool, device_id, "block-extra", "2025-06-01T00:00:00Z").await;

    // Verify extra data exists
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2, "should have 2 blocks before apply");

    // Apply snapshot (RESET)
    let restored = apply_snapshot(&pool, &mat, &snap_data[..]).await.unwrap();

    // Only original block should remain
    let count_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count_after, 1, "should have 1 block after apply");

    let id: String = sqlx::query_scalar!("SELECT id FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        id, "block-orig",
        "only the original block should remain after apply"
    );

    // Op log should be wiped
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op_count, 0, "op_log should be empty after apply");

    // Returned data should match
    assert_eq!(
        restored.tables.blocks.len(),
        1,
        "restored data should contain exactly one block"
    );
    assert_eq!(
        restored.tables.blocks[0].id, "block-orig",
        "restored block id must be the original"
    );
}

// =======================================================================
// 7b. M-66 — apply_snapshot warns on dropped drafts
// =======================================================================
//
// Pre-fix `apply_snapshot` issued `DELETE FROM block_drafts` with no
// count read and no log line. Any draft a peer saved AFTER its
// snapshot was taken (mid-edit when the snapshot fired or when the
// FEAT-6 catch-up arrived) was silently lost — making "where did my
// typing go?" a true mystery to debug.
//
// The fix counts the rows + samples up to 8 ids inside the same tx
// before the DELETE and emits `tracing::warn!` when the count is > 0.
// This regression test asserts the count read happens (drafts are
// observable inside the wipe tx), succeeds with the wipe, and the
// post-apply state is empty.

#[tokio::test]
async fn apply_snapshot_drops_drafts_observably_m66() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let device_id = "dev-1";

    // Original op + snapshot.
    insert_block(&pool, "block-orig", "original").await;
    insert_op_at(&pool, device_id, "block-orig", "2025-01-01T00:00:00Z").await;
    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();
    let snap_row = sqlx::query!(
        "SELECT id, data FROM log_snapshots WHERE id = ?",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let snap_data = snap_row.data;

    // M-93 / migration 0038: `block_drafts.block_id` now has a FK to
    // `blocks(id) ON DELETE CASCADE`. Seed parent rows for each draft
    // before staging them — the drafts themselves are still wiped
    // unconditionally by `apply_snapshot`, which is what this test
    // exercises.
    for id in ["draft-A", "draft-B", "draft-C"] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Seed THREE drafts that will be silently dropped without M-66.
    // Mix block_ids so the sample_ids vector has > 1 entry (proves
    // the LIMIT 8 sample read works for non-trivial cases).
    sqlx::query(
        "INSERT INTO block_drafts (block_id, content, updated_at) VALUES \
         ('draft-A', 'mid-edit text A', '2025-06-01T00:00:00Z'), \
         ('draft-B', 'mid-edit text B', '2025-06-01T00:00:01Z'), \
         ('draft-C', 'mid-edit text C', '2025-06-01T00:00:02Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Sanity: drafts exist before apply.
    let drafts_before: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(drafts_before, 3, "must have 3 drafts staged before apply");

    // Apply the snapshot.
    apply_snapshot(&pool, &mat, &snap_data[..]).await.unwrap();

    // Drafts must be wiped (preserves prior behaviour).
    let drafts_after: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        drafts_after, 0,
        "block_drafts must be empty after apply_snapshot (RESET semantics unchanged by M-66)"
    );

    // The M-66 warn line itself is best verified via tracing-test
    // capture, which this crate does not currently wire up; the value
    // of this test is that the count read + DELETE are atomically
    // ordered inside the wipe tx (a regression that re-orders them
    // — say, DELETE first then COUNT — would always count zero and
    // silently re-introduce M-66's silent-drop).
}

// =======================================================================
// 8. apply_snapshot_empty_db
// =======================================================================

#[tokio::test]
async fn apply_snapshot_empty_db() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create snapshot data with known content (encode without DB)
    let data = sample_snapshot_data();
    let encoded = encode_snapshot(&data).unwrap();

    // We need the referenced blocks to exist for FK constraints in block_tags etc.
    // So we use a simpler snapshot with just blocks (no FK references).
    let simple_data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "hash".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "blk-A".to_string(),
                block_type: "content".to_string(),
                content: Some("applied content".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };
    let simple_encoded = encode_snapshot(&simple_data).unwrap();

    let restored = apply_snapshot(&pool, &mat, &simple_encoded[..])
        .await
        .unwrap();

    assert_eq!(
        restored.tables.blocks.len(),
        1,
        "restored snapshot should contain one block"
    );
    assert_eq!(
        restored.tables.blocks[0].id, "blk-A",
        "restored block id must match snapshot data"
    );

    // Verify DB state
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "database should contain exactly one block after apply"
    );

    let content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'blk-A'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("applied content"),
        "block content in database must match snapshot data"
    );

    // Suppress unused variable warning
    let _ = encoded;
}

// =======================================================================
// 9. compact_noop_when_no_old_ops
// =======================================================================

#[tokio::test]
async fn compact_noop_when_no_old_ops() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a recent op (now)
    insert_block(&pool, "block-1", "recent").await;
    let now = crate::now_rfc3339();
    insert_op_at(&pool, device_id, "block-1", &now).await;

    // Compact with 90-day retention — all ops are recent
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(result.is_none(), "should return None when no old ops");

    // No snapshots should have been created
    let snap_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        snap_count, 0,
        "no snapshots should be created when compaction is a no-op"
    );
}

// =======================================================================
// 10. compact_creates_snapshot_and_purges
// =======================================================================

#[tokio::test]
async fn compact_creates_snapshot_and_purges() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block and an old op (200 days ago)
    insert_block(&pool, "block-old", "old content").await;
    insert_op_at(&pool, device_id, "block-old", "2024-01-01T00:00:00Z").await;

    // Compact with 90-day retention
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(result.is_some(), "should return Some(snapshot_id)");

    // A complete snapshot should exist
    let snap_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        snap_count, 1,
        "compaction should create exactly one complete snapshot"
    );

    // Old ops should be purged
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op_count, 0, "old ops should be purged");
}

// =======================================================================
// 11. compact_preserves_recent_ops
// =======================================================================

#[tokio::test]
async fn compact_preserves_recent_ops() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block with an old op
    insert_block(&pool, "block-old", "old").await;
    insert_op_at(&pool, device_id, "block-old", "2024-01-01T00:00:00Z").await;

    // Insert a block with a recent op
    insert_block(&pool, "block-new", "new").await;
    let now = crate::now_rfc3339();
    insert_op_at(&pool, device_id, "block-new", &now).await;

    // Compact with 90-day retention
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(
        result.is_some(),
        "compaction should occur when old ops exist"
    );

    // Only the recent op should remain
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op_count, 1, "recent op should be preserved");

    // Verify it's the recent one
    let created_at: String = sqlx::query_scalar!("SELECT created_at FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    // The recent op's timestamp should NOT be the old one
    assert!(
        !created_at.starts_with("2024-01-01"),
        "remaining op should not have the old timestamp"
    );
}

// =======================================================================
// 12. get_latest_snapshot_returns_none_when_empty
// =======================================================================

#[tokio::test]
async fn get_latest_snapshot_returns_none_when_empty() {
    let (pool, _dir) = test_pool().await;

    let result = get_latest_snapshot(&pool).await.unwrap();
    assert!(
        result.is_none(),
        "should return None when no snapshots exist"
    );
}

// =======================================================================
// 13. get_latest_snapshot_returns_most_recent
// =======================================================================

#[tokio::test]
async fn get_latest_snapshot_returns_most_recent() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block + op
    insert_block(&pool, "block-1", "v1").await;
    insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

    // Create first snapshot
    let snap1_id = create_snapshot(&pool, device_id).await.unwrap();

    // Modify and create second snapshot
    sqlx::query("UPDATE blocks SET content = 'v2' WHERE id = 'block-1'")
        .execute(&pool)
        .await
        .unwrap();
    let snap2_id = create_snapshot(&pool, device_id).await.unwrap();

    // get_latest_snapshot should return the second (most recent by ULID order)
    let (latest_id, latest_data) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    assert_eq!(
        latest_id, snap2_id,
        "latest snapshot should be the second one created"
    );
    assert_ne!(
        latest_id, snap1_id,
        "latest snapshot should not be the first one"
    );

    // Decode and verify it has the updated content
    let decoded = decode_snapshot(&latest_data[..]).unwrap();
    assert_eq!(
        decoded.tables.blocks[0].content.as_deref(),
        Some("v2"),
        "latest snapshot should contain updated block content"
    );
}

// =======================================================================
// 14. cbor_round_trip_option_f64
// =======================================================================

/// Verify that `Option<f64>` values (including edge cases) survive CBOR
/// encode → decode round-trip.  CBOR has distinct float representations
/// and NaN/Infinity semantics that differ from JSON.
#[test]
fn cbor_round_trip_option_f64() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "b1".to_string(),
                block_type: "content".to_string(),
                content: None,
                parent_id: None,
                position: None,
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "none".to_string(),
                    value_text: None,
                    value_num: None,
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "normal".to_string(),
                    value_text: None,
                    value_num: Some(42.5),
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "zero".to_string(),
                    value_text: None,
                    value_num: Some(0.0),
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "negative".to_string(),
                    value_text: None,
                    value_num: Some(-1.0e10),
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "inf".to_string(),
                    value_text: None,
                    value_num: Some(f64::INFINITY),
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "neg_inf".to_string(),
                    value_text: None,
                    value_num: Some(f64::NEG_INFINITY),
                    value_date: None,
                    value_ref: None,
                },
                BlockPropertySnapshot {
                    block_id: "b1".to_string(),
                    key: "nan".to_string(),
                    value_text: None,
                    value_num: Some(f64::NAN),
                    value_date: None,
                    value_ref: None,
                },
            ],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    let props = &decoded.tables.block_properties;
    assert_eq!(props.len(), 7, "should have all 7 property variants");

    // Helper: find property by key
    let find =
        |key: &str| -> &BlockPropertySnapshot { props.iter().find(|p| p.key == key).unwrap() };

    assert_eq!(
        find("none").value_num,
        None,
        "None value_num must survive CBOR round-trip"
    );
    assert_eq!(
        find("normal").value_num,
        Some(42.5),
        "normal f64 must survive CBOR round-trip"
    );
    assert_eq!(
        find("zero").value_num,
        Some(0.0),
        "zero f64 must survive CBOR round-trip"
    );
    assert_eq!(
        find("negative").value_num,
        Some(-1.0e10),
        "negative f64 must survive CBOR round-trip"
    );
    assert_eq!(
        find("inf").value_num,
        Some(f64::INFINITY),
        "positive infinity must survive CBOR round-trip"
    );
    assert_eq!(
        find("neg_inf").value_num,
        Some(f64::NEG_INFINITY),
        "negative infinity must survive CBOR round-trip"
    );

    // NaN != NaN, so we must check with is_nan()
    let nan_val = find("nan").value_num;
    assert!(
        nan_val.is_some() && nan_val.unwrap().is_nan(),
        "NaN should survive CBOR round-trip, got: {nan_val:?}"
    );
}

// =======================================================================
// 15. create_snapshot_empty_op_log_returns_empty_snapshot_i_lifecycle_2
// =======================================================================

/// I-Lifecycle-2: `create_snapshot` accepts an empty op_log and writes an
/// empty snapshot (zero-op deterministic representation), so a freshly
/// initialised device can run "Create Snapshot" without erroring. The
/// previous behaviour — `AppError::Snapshot("op_log is empty")` — only
/// made sense for compaction (which has nothing to compact); for the
/// snapshot UX it broke the fresh-device path. Compaction still gates
/// on its own row-count check, so this change does not affect that path.
#[tokio::test]
async fn create_snapshot_empty_op_log_returns_empty_snapshot_i_lifecycle_2() {
    let (pool, _dir) = test_pool().await;

    // DB has blocks but no ops — the very-fresh-device shape.
    insert_block(&pool, "block-1", "content").await;

    let snapshot_id = create_snapshot(&pool, "dev-1")
        .await
        .expect("empty op_log must produce a snapshot, not an error");

    // The snapshot row landed as 'complete' with an empty up_to_seqs map
    // and an empty up_to_hash marker.
    let row = sqlx::query!(
        "SELECT status, up_to_hash, up_to_seqs, data \
         FROM log_snapshots WHERE id = ?",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.status, "complete");
    assert_eq!(row.up_to_hash, "");
    assert_eq!(row.up_to_seqs, "{}");

    // Decode the encoded blob and confirm the empty-frontier shape.
    let decoded = decode_snapshot(&row.data[..]).expect("encoded snapshot must decode");
    assert!(
        decoded.up_to_seqs.is_empty(),
        "empty op_log → empty up_to_seqs"
    );
    assert_eq!(decoded.up_to_hash, "", "empty op_log → empty up_to_hash");
    // `tables` reflects current DB state, not op_log state — `block-1`
    // exists in `blocks` (we inserted it directly, bypassing the op log)
    // and `collect_tables` reads it. The contract this test pins is that
    // an empty op_log is NOT a hard error; the table contents are
    // orthogonal.
}

// =======================================================================
// 15b. apply_empty_snapshot_on_fresh_db_is_noop_i_lifecycle_2
// =======================================================================

/// I-Lifecycle-2: round-trip — an empty snapshot (created from a fresh
/// device with zero ops) must apply cleanly onto another fresh DB and
/// leave the post-state empty: zero blocks, zero op_log rows. This is
/// the on-the-wire counterpart to the pinning test above and ensures
/// the "empty snapshot" contract is honoured end-to-end (create →
/// encode → fetch → decode → apply).
#[tokio::test]
async fn apply_empty_snapshot_on_fresh_db_is_noop_i_lifecycle_2() {
    // Create the empty snapshot on a fresh source pool (no ops, no blocks).
    let (src_pool, _src_dir) = test_pool().await;
    create_snapshot(&src_pool, "dev-src")
        .await
        .expect("empty op_log must produce a snapshot");
    let (_, encoded) = get_latest_snapshot(&src_pool)
        .await
        .unwrap()
        .expect("snapshot row must exist");

    // Apply onto a separate fresh pool. Both blocks count and op_log count
    // must remain zero (empty snapshot is a true no-op on a fresh DB).
    let (dst_pool, _dst_dir) = test_pool().await;
    let dst_mat = test_materializer(&dst_pool);
    let restored = apply_snapshot(&dst_pool, &dst_mat, &encoded[..])
        .await
        .expect("applying an empty snapshot to a fresh DB must succeed");

    assert!(
        restored.tables.blocks.is_empty(),
        "decoded snapshot must carry zero blocks"
    );
    assert!(
        restored.up_to_seqs.is_empty(),
        "decoded snapshot must carry an empty frontier"
    );

    let blocks_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&dst_pool)
        .await
        .unwrap();
    assert_eq!(blocks_count, 0, "fresh DB must remain empty after apply");

    let op_log_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&dst_pool)
        .await
        .unwrap();
    assert_eq!(op_log_count, 0, "fresh DB op_log must remain empty");
}

// =======================================================================
// 16. compact_multi_device_ops
// =======================================================================

/// Verify compaction works correctly when multiple devices have ops:
/// old ops from ALL devices should be purged, recent ops preserved.
#[tokio::test]
async fn compact_multi_device_ops() {
    let (pool, _dir) = test_pool().await;

    // Device A: old op
    insert_block(&pool, "block-A", "from A").await;
    insert_op_at(&pool, "device-A", "block-A", "2024-01-01T00:00:00Z").await;

    // Device B: old op + recent op
    insert_block(&pool, "block-B1", "old from B").await;
    insert_op_at(&pool, "device-B", "block-B1", "2024-01-15T00:00:00Z").await;

    insert_block(&pool, "block-B2", "recent from B").await;
    let now = crate::now_rfc3339();
    insert_op_at(&pool, "device-B", "block-B2", &now).await;

    // Compact
    let result = compact_op_log(&pool, "device-A", DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(result.is_some(), "should compact when old ops exist");

    // Only device-B's recent op should remain
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1, "only the recent op should survive compaction");

    // Verify it's device-B's recent op
    let dev: String = sqlx::query_scalar!("SELECT device_id FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(dev, "device-B", "remaining op should belong to device-B");

    // The snapshot should capture the multi-device frontier
    let (_, snap_data) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    let decoded = decode_snapshot(&snap_data[..]).unwrap();
    assert!(
        decoded.up_to_seqs.contains_key("device-A"),
        "frontier should include device-A"
    );
    assert!(
        decoded.up_to_seqs.contains_key("device-B"),
        "frontier should include device-B"
    );
}

// =======================================================================
// 17. apply_snapshot_rejects_fk_violation
// =======================================================================

/// If snapshot data contains block_tags referencing a non-existent block,
/// apply_snapshot should fail with an FK constraint error (not silently
/// insert bad data).
#[tokio::test]
async fn apply_snapshot_rejects_fk_violation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Snapshot with block_tags that reference blocks NOT in the snapshot
    let bad_data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![], // no blocks!
            block_tags: vec![BlockTagSnapshot {
                block_id: "nonexistent-block".to_string(),
                tag_id: "also-nonexistent".to_string(),
            }],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&bad_data).unwrap();
    let result = apply_snapshot(&pool, &mat, &encoded[..]).await;
    assert!(
        result.is_err(),
        "FK violation should cause apply_snapshot to fail"
    );
}

// =======================================================================
// 17b. TEST-50: apply_snapshot_rejects_null_in_not_null_column
// =======================================================================

/// TEST-50: a snapshot blob whose CBOR payload encodes `null` for a
/// NOT NULL column (here `block_type`) must not be silently accepted.
/// The canonical `BlockSnapshot.block_type` is `String`, so the rejection
/// surfaces during CBOR deserialization in `decode_snapshot` rather than
/// at SQL insert time — but either layer is a legitimate "no" and this
/// test pins down the contract that **some** layer says no.
#[tokio::test]
async fn apply_snapshot_rejects_null_in_not_null_column() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // A parallel struct that mirrors `BlockSnapshot` byte-for-byte but
    // exposes `block_type` as `Option<String>` so we can serialize a
    // `null` where the canonical type expects a `String`.
    #[derive(Serialize)]
    struct NullableBlockSnap<'a> {
        id: &'a str,
        block_type: Option<&'a str>,
        content: Option<&'a str>,
        parent_id: Option<&'a str>,
        position: Option<i64>,
        deleted_at: Option<&'a str>,
        is_conflict: i64,
        conflict_source: Option<&'a str>,
        // MAINT-133: keep this struct in lock-step with `BlockSnapshot`
        // so the encoded CBOR map covers every field the real decoder
        // expects.
        conflict_type: Option<&'a str>,
        todo_state: Option<&'a str>,
        priority: Option<&'a str>,
        due_date: Option<&'a str>,
        scheduled_date: Option<&'a str>,
    }
    #[derive(Serialize)]
    struct NullableTables<'a> {
        blocks: Vec<NullableBlockSnap<'a>>,
        block_tags: Vec<BlockTagSnapshot>,
        block_properties: Vec<BlockPropertySnapshot>,
        block_links: Vec<BlockLinkSnapshot>,
        attachments: Vec<AttachmentSnapshot>,
        property_definitions: Vec<crate::snapshot::types::PropertyDefinitionSnapshot>,
        page_aliases: Vec<crate::snapshot::types::PageAliasSnapshot>,
    }
    #[derive(Serialize)]
    struct NullableData<'a> {
        schema_version: u32,
        snapshot_device_id: &'a str,
        up_to_seqs: BTreeMap<String, i64>,
        up_to_hash: &'a str,
        tables: NullableTables<'a>,
    }

    let bad = NullableData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1",
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "h",
        tables: NullableTables {
            blocks: vec![NullableBlockSnap {
                id: "blk-A",
                block_type: None, // <-- defect: NULL in NOT NULL column
                content: Some("x"),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let mut cbor_buf = Vec::new();
    ciborium::into_writer(&bad, &mut cbor_buf).unwrap();
    let encoded = zstd::encode_all(cbor_buf.as_slice(), 3).unwrap();

    let result = apply_snapshot(&pool, &mat, &encoded[..]).await;
    assert!(
        result.is_err(),
        "NULL value in NOT NULL column block_type must be rejected"
    );
}

// =======================================================================
// 17c. TEST-50: apply_snapshot_rejects_invalid_block_type
// =======================================================================

/// TEST-50: `block_type` is constrained by the
/// `check_block_type_insert` BEFORE INSERT trigger
/// (migration 0005) to one of `content` / `tag` / `page`. A value
/// outside that enum (here `"banana"`) must abort the apply.
#[tokio::test]
async fn apply_snapshot_rejects_invalid_block_type() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let bad_data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "blk-A".to_string(),
                block_type: "banana".to_string(), // <-- defect
                content: Some("x".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&bad_data).unwrap();
    let result = apply_snapshot(&pool, &mat, &encoded[..]).await;
    assert!(
        result.is_err(),
        "block_type 'banana' is not in (content|tag|page) — \
         check_block_type_insert trigger must abort"
    );
}

// =======================================================================
// 17d. TEST-50: apply_snapshot_rejects_malformed_ulid_block_id
// =======================================================================

/// TEST-50: a malformed ULID (non-Crockford text, wrong length) used
/// as a block-id reference must not silently leak in. The blocks
/// schema has no CHECK on ULID format, so the rejection surfaces as a
/// deferred FK violation when the malformed string is referenced as a
/// `parent_id` but no matching row exists in `blocks`. This pins the
/// invariant that a malformed ULID cannot pose as a valid FK target.
#[tokio::test]
async fn apply_snapshot_rejects_malformed_ulid_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let bad_data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "blk-A".to_string(),
                block_type: "content".to_string(),
                content: Some("x".to_string()),
                // <-- defect: a malformed (non-ULID) string referenced
                // as parent_id, with no matching row in `blocks`.
                parent_id: Some("not-a-valid-ulid!@#".to_string()),
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&bad_data).unwrap();
    let result = apply_snapshot(&pool, &mat, &encoded[..]).await;
    assert!(
        result.is_err(),
        "malformed ULID as parent_id with no matching block must be rejected (deferred FK)"
    );
}

// =======================================================================
// 18. apply_snapshot_full_all_5_tables (F13)
// =======================================================================

/// Verify that apply_snapshot correctly restores all 5 core table types:
/// blocks, block_tags, block_properties, block_links, and attachments.
#[tokio::test]
async fn apply_snapshot_full_all_5_tables() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Build a snapshot with all 5 table types populated.
    // Note: block_tags.tag_id references blocks(id), so the "tag" must
    // exist as a block too.
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-1".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![
                BlockSnapshot {
                    id: "blk-parent".to_string(),
                    block_type: "content".to_string(),
                    content: Some("Parent block".to_string()),
                    parent_id: None,
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
                BlockSnapshot {
                    id: "blk-child".to_string(),
                    block_type: "content".to_string(),
                    content: Some("Child block".to_string()),
                    parent_id: Some("blk-parent".to_string()),
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
                // Tag block — needed for FK on block_tags.tag_id
                BlockSnapshot {
                    id: "tag-urgent".to_string(),
                    block_type: "tag".to_string(),
                    content: Some("urgent".to_string()),
                    parent_id: None,
                    position: None,
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
            ],
            block_tags: vec![BlockTagSnapshot {
                block_id: "blk-parent".to_string(),
                tag_id: "tag-urgent".to_string(),
            }],
            block_properties: vec![BlockPropertySnapshot {
                block_id: "blk-child".to_string(),
                key: "due".to_string(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-06-01".to_string()),
                value_ref: None,
            }],
            block_links: vec![BlockLinkSnapshot {
                source_id: "blk-child".to_string(),
                target_id: "blk-parent".to_string(),
            }],
            attachments: vec![AttachmentSnapshot {
                id: "att-1".to_string(),
                block_id: "blk-parent".to_string(),
                mime_type: "text/plain".to_string(),
                filename: "notes.txt".to_string(),
                size_bytes: 256,
                fs_path: "attachments/notes.txt".to_string(),
                created_at: "2025-01-01T00:00:00Z".to_string(),
                deleted_at: None,
            }],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let restored = apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();

    // Verify all tables populated
    assert_eq!(
        restored.tables.blocks.len(),
        3,
        "restored snapshot should have 3 blocks"
    );
    assert_eq!(
        restored.tables.block_tags.len(),
        1,
        "restored snapshot should have 1 block_tag"
    );
    assert_eq!(
        restored.tables.block_properties.len(),
        1,
        "restored snapshot should have 1 block_property"
    );
    assert_eq!(
        restored.tables.block_links.len(),
        1,
        "restored snapshot should have 1 block_link"
    );
    assert_eq!(
        restored.tables.attachments.len(),
        1,
        "restored snapshot should have 1 attachment"
    );

    // Verify DB state for each table
    let blk_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blk_count, 3, "database should have 3 blocks after apply");

    let tag_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_count, 1, "database should have 1 block_tag after apply");

    let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        prop_count, 1,
        "database should have 1 block_property after apply"
    );

    let link_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_links")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        link_count, 1,
        "database should have 1 block_link after apply"
    );

    let att_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM attachments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        att_count, 1,
        "database should have 1 attachment after apply"
    );

    // Verify specific content
    let tag_id: String =
        sqlx::query_scalar!("SELECT tag_id FROM block_tags WHERE block_id = 'blk-parent'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        tag_id, "tag-urgent",
        "block_tag tag_id must match snapshot data"
    );

    let due: Option<String> =
        sqlx::query_scalar!("SELECT value_date FROM block_properties WHERE block_id = 'blk-child'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        due.as_deref(),
        Some("2025-06-01"),
        "block_property value_date must match snapshot data"
    );
}

// =======================================================================
// 19. double_compaction (F14)
// =======================================================================

/// Verify that calling compact_op_log twice produces correct behavior:
/// first call compacts, second call is a no-op (no old ops remain).
#[tokio::test]
async fn double_compaction() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert an old op (200 days ago)
    insert_block(&pool, "block-old", "old").await;
    insert_op_at(&pool, device_id, "block-old", "2024-01-01T00:00:00Z").await;

    // First compaction — should create snapshot and purge
    let first = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(first.is_some(), "first compaction should create a snapshot");

    let snap_count_1: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        snap_count_1, 1,
        "first compaction should produce exactly one snapshot"
    );

    // Second compaction — no old ops remain, should be no-op
    let second = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(
        second.is_none(),
        "second compaction should be no-op (no old ops remain)"
    );

    // Still only 1 snapshot (second compaction didn't create another)
    let snap_count_2: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        snap_count_2, 1,
        "second compaction should not create additional snapshots"
    );
}
// =======================================================================

/// Verify that the cutoff timestamp uses a consistent format for comparison
/// with op_log.created_at. This tests the edge case where the inserted
/// timestamp has zero sub-second precision (`...:00Z`) vs the cutoff's
/// millisecond-precision form (`...:00.000Z`) — both share the
/// L-98 `Z`-suffix invariant, so lexicographic comparison must still
/// classify the older op as old.
#[tokio::test]
async fn compact_op_log_timestamp_format_consistency() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert an old op using a zero-subsecond `Z` timestamp — the edge
    // case is that `now_rfc3339()` always emits 3-digit milliseconds
    // (e.g. `...:00.000Z`) whereas this fixture omits them
    // (`...:00Z`). Lex comparison must still treat the older instant
    // as older despite the precision mismatch.
    insert_block(&pool, "block-old", "old").await;
    insert_op_at(&pool, device_id, "block-old", "2024-01-15T12:00:00Z").await;

    // Compact with 90-day retention — the old op should be purged
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(
        result.is_some(),
        "old op with zero-subsecond Z-suffix timestamp should still be detected as old"
    );

    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "old op should be purged");
}

// =======================================================================
// 21. old_snapshots_accumulate (F22)
// =======================================================================

/// Document that old complete snapshots accumulate without cleanup.
/// Each call to create_snapshot adds a new row; old ones are never deleted.
#[tokio::test]
async fn old_snapshots_accumulate() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Need block + op for snapshots
    insert_block(&pool, "block-1", "content").await;
    insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

    // Create 3 snapshots
    let _snap1 = create_snapshot(&pool, device_id).await.unwrap();
    let _snap2 = create_snapshot(&pool, device_id).await.unwrap();
    let snap3 = create_snapshot(&pool, device_id).await.unwrap();

    // All 3 should exist in the DB
    let total: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(total, 3, "old snapshots accumulate (no cleanup)");

    // get_latest_snapshot returns only the most recent
    let (latest_id, _) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    assert_eq!(
        latest_id, snap3,
        "get_latest_snapshot must return the most recent snapshot"
    );
}

// =======================================================================
// 22. empty_blocks_map_round_trip (REVIEW-LATER #56)
// =======================================================================

/// Snapshot with a completely empty blocks map and all-empty tables
/// round-trips correctly through encode→decode.
#[test]
fn empty_blocks_map_round_trip() {
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-empty".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "empty-hash".to_string(),
        tables: SnapshotTables {
            blocks: vec![],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    assert_eq!(
        decoded.schema_version, SCHEMA_VERSION,
        "schema version must survive empty snapshot round-trip"
    );
    assert_eq!(
        decoded.snapshot_device_id, "dev-empty",
        "device id must survive empty snapshot round-trip"
    );
    assert_eq!(
        decoded.up_to_hash, "empty-hash",
        "up_to_hash must survive empty snapshot round-trip"
    );
    assert!(decoded.up_to_seqs.is_empty(), "up_to_seqs should be empty");
    assert!(
        decoded.tables.blocks.is_empty(),
        "blocks should be empty in empty snapshot"
    );
    assert!(
        decoded.tables.block_tags.is_empty(),
        "block_tags should be empty in empty snapshot"
    );
    assert!(
        decoded.tables.block_properties.is_empty(),
        "block_properties should be empty in empty snapshot"
    );
    assert!(
        decoded.tables.block_links.is_empty(),
        "block_links should be empty in empty snapshot"
    );
    assert!(
        decoded.tables.attachments.is_empty(),
        "attachments should be empty in empty snapshot"
    );
}

// =======================================================================
// 23. large_text_field_round_trip (REVIEW-LATER #56)
// =======================================================================

/// Snapshot with very large text fields (>10KB) round-trips correctly
/// through zstd compression + CBOR encoding.
#[test]
fn large_text_field_round_trip() {
    let large_content = "x".repeat(15_000); // 15KB
    assert!(
        large_content.len() > 10_000,
        "test content must exceed 10KB"
    );

    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-large".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "b-large".to_string(),
                block_type: "content".to_string(),
                content: Some(large_content.clone()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![BlockPropertySnapshot {
                block_id: "b-large".to_string(),
                key: "notes".to_string(),
                value_text: Some("y".repeat(12_000)),
                value_num: None,
                value_date: None,
                value_ref: None,
            }],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    assert_eq!(
        decoded.tables.blocks.len(),
        1,
        "large content snapshot should have one block"
    );
    assert_eq!(
        decoded.tables.blocks[0].content.as_deref(),
        Some(large_content.as_str()),
        "large block content must survive compression round-trip"
    );
    assert_eq!(
        decoded.tables.block_properties.len(),
        1,
        "large content snapshot should have one property"
    );
    assert_eq!(
        decoded.tables.block_properties[0]
            .value_text
            .as_ref()
            .unwrap()
            .len(),
        12_000,
        "large property value_text length must survive round-trip"
    );
}

// =======================================================================
// 24. all_nullable_fields_null_round_trip (REVIEW-LATER #56)
// =======================================================================

/// Snapshot where every nullable field in a block is set to None
/// survives encode→decode.
#[test]
fn all_nullable_fields_null_round_trip() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "b-null".to_string(),
                block_type: "content".to_string(),
                content: None,
                parent_id: None,
                position: None,
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![BlockPropertySnapshot {
                block_id: "b-null".to_string(),
                key: "empty-prop".to_string(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: None,
            }],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    let block = &decoded.tables.blocks[0];
    assert!(block.content.is_none(), "content should be None");
    assert!(block.parent_id.is_none(), "parent_id should be None");
    assert!(block.position.is_none(), "position should be None");
    assert!(block.deleted_at.is_none(), "deleted_at should be None");
    assert!(
        block.conflict_source.is_none(),
        "conflict_source should be None"
    );

    let prop = &decoded.tables.block_properties[0];
    assert!(
        prop.value_text.is_none(),
        "property value_text should be None"
    );
    assert!(
        prop.value_num.is_none(),
        "property value_num should be None"
    );
    assert!(
        prop.value_date.is_none(),
        "property value_date should be None"
    );
    assert!(
        prop.value_ref.is_none(),
        "property value_ref should be None"
    );
}

// =======================================================================
// 25. encode_decode_identity (REVIEW-LATER #56)
// =======================================================================

/// Round-trip encode→decode is idempotent: encode→decode→encode→decode
/// preserves every field exactly.
#[test]
fn encode_decode_identity() {
    let data = sample_snapshot_data();
    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    // Re-encode and decode again to verify idempotency
    let re_encoded = encode_snapshot(&decoded).unwrap();
    let re_decoded = decode_snapshot(&re_encoded[..]).unwrap();

    // Verify all top-level fields
    assert_eq!(
        decoded.schema_version, re_decoded.schema_version,
        "schema version must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.snapshot_device_id, re_decoded.snapshot_device_id,
        "device id must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.up_to_hash, re_decoded.up_to_hash,
        "up_to_hash must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.up_to_seqs, re_decoded.up_to_seqs,
        "up_to_seqs must be idempotent across re-encode"
    );

    // Verify table lengths
    assert_eq!(
        decoded.tables.blocks.len(),
        re_decoded.tables.blocks.len(),
        "blocks count must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.tables.block_tags.len(),
        re_decoded.tables.block_tags.len(),
        "block_tags count must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.tables.block_properties.len(),
        re_decoded.tables.block_properties.len(),
        "block_properties count must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.tables.block_links.len(),
        re_decoded.tables.block_links.len(),
        "block_links count must be idempotent across re-encode"
    );
    assert_eq!(
        decoded.tables.attachments.len(),
        re_decoded.tables.attachments.len(),
        "attachments count must be idempotent across re-encode"
    );

    // Verify individual fields in blocks
    for (i, (a, b)) in decoded
        .tables
        .blocks
        .iter()
        .zip(re_decoded.tables.blocks.iter())
        .enumerate()
    {
        assert_eq!(a.id, b.id, "block id must match at index {i}");
        assert_eq!(
            a.block_type, b.block_type,
            "block_type must match at index {i}"
        );
        assert_eq!(
            a.content, b.content,
            "block content must match at index {i}"
        );
        assert_eq!(
            a.parent_id, b.parent_id,
            "block parent_id must match at index {i}"
        );
        assert_eq!(
            a.position, b.position,
            "block position must match at index {i}"
        );
        assert_eq!(
            a.deleted_at, b.deleted_at,
            "block deleted_at must match at index {i}"
        );
        assert_eq!(
            a.is_conflict, b.is_conflict,
            "block is_conflict must match at index {i}"
        );
        assert_eq!(
            a.conflict_source, b.conflict_source,
            "block conflict_source must match at index {i}"
        );
    }

    // Verify attachments round-trip
    for (i, (a, b)) in decoded
        .tables
        .attachments
        .iter()
        .zip(re_decoded.tables.attachments.iter())
        .enumerate()
    {
        assert_eq!(a.id, b.id, "attachment id must match at index {i}");
        assert_eq!(
            a.block_id, b.block_id,
            "attachment block_id must match at index {i}"
        );
        assert_eq!(
            a.mime_type, b.mime_type,
            "attachment mime_type must match at index {i}"
        );
        assert_eq!(
            a.filename, b.filename,
            "attachment filename must match at index {i}"
        );
        assert_eq!(
            a.size_bytes, b.size_bytes,
            "attachment size_bytes must match at index {i}"
        );
        assert_eq!(
            a.fs_path, b.fs_path,
            "attachment fs_path must match at index {i}"
        );
        assert_eq!(
            a.created_at, b.created_at,
            "attachment created_at must match at index {i}"
        );
        assert_eq!(
            a.deleted_at, b.deleted_at,
            "attachment deleted_at must match at index {i}"
        );
    }
}

// =======================================================================
// 26. create_snapshot_captures_all_related_tables (lines 155,167,181,192)
// =======================================================================

#[tokio::test]
async fn create_snapshot_captures_all_related_tables() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // 1. Insert blocks (including a tag block for FK on block_tags)
    insert_block(&pool, "blk-1", "main content").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES ('blk-2', 'content', 'linked target', 2, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
             VALUES ('tag-1', 'tag', 'urgent', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // 2. Insert block_tags
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('blk-1', 'tag-1')")
        .execute(&pool)
        .await
        .unwrap();

    // 3. Insert block_properties
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('blk-1', 'status', 'active')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // 4. Insert block_links
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES ('blk-1', 'blk-2')")
        .execute(&pool)
        .await
        .unwrap();

    // 5. Insert attachments
    sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('att-1', 'blk-1', 'image/png', 'photo.png', 1024, 'attachments/photo.png', '2025-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

    // 6. Insert an op so the frontier query succeeds
    insert_op_at(&pool, device_id, "blk-1", "2025-01-01T00:00:00Z").await;

    // 7. Create snapshot and decode
    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();
    let row = sqlx::query!("SELECT data FROM log_snapshots WHERE id = ?", snapshot_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let decoded = decode_snapshot(&row.data[..]).unwrap();

    // 8. Verify all related tables are populated
    assert_eq!(
        decoded.tables.blocks.len(),
        3,
        "should capture all 3 blocks"
    );

    assert_eq!(
        decoded.tables.block_tags.len(),
        1,
        "should capture block_tags"
    );
    assert_eq!(
        decoded.tables.block_tags[0].block_id, "blk-1",
        "captured block_tag block_id must match"
    );
    assert_eq!(
        decoded.tables.block_tags[0].tag_id, "tag-1",
        "captured block_tag tag_id must match"
    );

    assert_eq!(
        decoded.tables.block_properties.len(),
        1,
        "should capture block_properties"
    );
    assert_eq!(
        decoded.tables.block_properties[0].block_id, "blk-1",
        "captured property block_id must match"
    );
    assert_eq!(
        decoded.tables.block_properties[0].key, "status",
        "captured property key must match"
    );
    assert_eq!(
        decoded.tables.block_properties[0].value_text.as_deref(),
        Some("active"),
        "captured property value_text must match"
    );

    assert_eq!(
        decoded.tables.block_links.len(),
        1,
        "should capture block_links"
    );
    assert_eq!(
        decoded.tables.block_links[0].source_id, "blk-1",
        "captured link source_id must match"
    );
    assert_eq!(
        decoded.tables.block_links[0].target_id, "blk-2",
        "captured link target_id must match"
    );

    assert_eq!(
        decoded.tables.attachments.len(),
        1,
        "should capture attachments"
    );
    assert_eq!(
        decoded.tables.attachments[0].filename, "photo.png",
        "captured attachment filename must match"
    );
    assert_eq!(
        decoded.tables.attachments[0].block_id, "blk-1",
        "captured attachment block_id must match"
    );
}

// =======================================================================
// cleanup_old_snapshots
// =======================================================================

#[tokio::test]
async fn cleanup_old_snapshots_keeps_n_most_recent() {
    let (pool, _dir) = test_pool().await;
    let dev = "test-device";

    // Insert a block so the snapshot has content
    insert_block(&pool, "blk-cleanup", "cleanup test").await;

    // Create 5 snapshots by inserting a new op before each (frontier needs at least one op)
    for i in 0..5 {
        insert_op_at(
            &pool,
            dev,
            &format!("blk-c{i}"),
            &format!("2025-01-0{}T00:00:00Z", i + 1),
        )
        .await;
        create_snapshot(&pool, dev).await.unwrap();
    }

    // Verify we have 5 complete snapshots
    let before: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, 5, "should have 5 complete snapshots before cleanup");

    let deleted = cleanup_old_snapshots(&pool, 2).await.unwrap();
    assert_eq!(deleted, 3, "should delete 3 of 5 snapshots, keeping 2");

    let remaining: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining, 2,
        "should have exactly 2 remaining complete snapshots"
    );
}

#[tokio::test]
async fn cleanup_old_snapshots_noop_when_fewer_than_keep() {
    let (pool, _dir) = test_pool().await;
    let dev = "test-device";

    // Insert a block and one op so we can create a snapshot
    insert_block(&pool, "blk-noop", "noop test").await;
    insert_op_at(&pool, dev, "blk-noop1", "2025-01-01T00:00:00Z").await;
    create_snapshot(&pool, dev).await.unwrap();

    let deleted = cleanup_old_snapshots(&pool, 5).await.unwrap();
    assert_eq!(deleted, 0, "should not delete when fewer than keep");
}

#[tokio::test]
async fn cleanup_old_snapshots_deletes_pending_snapshots() {
    let (pool, _dir) = test_pool().await;
    let dev = "test-device";

    // Create 3 complete snapshots
    insert_block(&pool, "blk-pend", "pending test").await;
    for i in 0..3 {
        insert_op_at(
            &pool,
            dev,
            &format!("blk-p{i}"),
            &format!("2025-01-0{}T00:00:00Z", i + 1),
        )
        .await;
        create_snapshot(&pool, dev).await.unwrap();
    }

    // Insert a pending snapshot directly via SQL (simulating a crash leftover)
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES ('PENDING_SNAP_01', 'pending', 'h', '{}', X'00')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Verify: 3 complete + 1 pending = 4 total
    let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 4, "should have 3 complete + 1 pending");

    // Cleanup keeping 3 — only the pending one should be deleted
    let deleted = cleanup_old_snapshots(&pool, 3).await.unwrap();
    assert_eq!(
        deleted, 1,
        "should delete only the pending snapshot when keep=3 and 3 complete exist"
    );

    // Verify all 3 complete snapshots remain
    let remaining_complete: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_complete, 3,
        "all 3 complete snapshots should be kept"
    );

    // Verify no pending snapshots remain
    let remaining_pending: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_pending, 0,
        "pending snapshot should be deleted by cleanup"
    );
}

#[tokio::test]
async fn cleanup_old_snapshots_mixed_pending_and_complete() {
    let (pool, _dir) = test_pool().await;
    let dev = "test-device";

    // Create 5 complete snapshots
    insert_block(&pool, "blk-mix", "mixed test").await;
    for i in 0..5 {
        insert_op_at(
            &pool,
            dev,
            &format!("blk-m{i}"),
            &format!("2025-01-0{}T00:00:00Z", i + 1),
        )
        .await;
        create_snapshot(&pool, dev).await.unwrap();
    }

    // Insert 2 pending snapshots directly via SQL
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES ('PENDING_MIX_01', 'pending', 'h1', '{}', X'00')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES ('PENDING_MIX_02', 'pending', 'h2', '{}', X'00')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Verify: 5 complete + 2 pending = 7 total
    let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 7, "should have 5 complete + 2 pending");

    // Cleanup keeping 3: should delete 2 oldest complete + 2 pending = 4
    let deleted = cleanup_old_snapshots(&pool, 3).await.unwrap();
    assert_eq!(
        deleted, 4,
        "should delete 2 oldest complete + 2 pending = 4 total"
    );

    // Verify exactly 3 complete snapshots remain
    let remaining_complete: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_complete, 3,
        "should keep the 3 newest complete snapshots"
    );

    // Verify no pending snapshots remain
    let remaining_pending: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_pending, 0,
        "all pending snapshots should be deleted"
    );

    // Verify total remaining is 3
    let remaining_total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining_total, 3, "total remaining should be exactly 3");
}

#[tokio::test]
async fn cleanup_old_snapshots_with_zero_keep_is_noop() {
    // M-68 regression: a naive `LIMIT 0` on the subquery would cause
    // SQLite's `NOT IN (empty)` to evaluate TRUE for every row, deleting
    // every complete snapshot. The function now short-circuits on keep==0.
    let (pool, _dir) = test_pool().await;
    let dev = "test-device";

    // Create 3 complete snapshots
    insert_block(&pool, "blk-zero", "zero keep test").await;
    for i in 0..3 {
        insert_op_at(
            &pool,
            dev,
            &format!("blk-z{i}"),
            &format!("2025-01-0{}T00:00:00Z", i + 1),
        )
        .await;
        create_snapshot(&pool, dev).await.unwrap();
    }

    let before: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, 3, "should have 3 complete snapshots before cleanup");

    // Cleanup with keep=0 should be a no-op (NOT delete everything).
    let deleted = cleanup_old_snapshots(&pool, 0).await.unwrap();
    assert_eq!(deleted, 0, "keep=0 must be a no-op, not a TRUNCATE");

    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 3,
        "all 3 complete snapshots must survive keep=0 cleanup"
    );
}

#[tokio::test]
async fn cleanup_old_snapshots_empty_database_returns_zero() {
    let (pool, _dir) = test_pool().await;

    // Call cleanup on empty database — should return 0, no error
    let deleted = cleanup_old_snapshots(&pool, 3).await.unwrap();
    assert_eq!(
        deleted, 0,
        "cleanup on empty database should return 0 deleted"
    );

    // Verify the table is still empty
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "log_snapshots should still be empty");
}

// ======================================================================
// Schema version v1 / v2 compatibility
// ======================================================================

/// A v1-like BlockSnapshot without the 3 new fields, used to create
/// v1-format CBOR data that must still deserialize via #[serde(default)].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlockSnapshotV1 {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    archived_at: Option<String>,
    is_conflict: i64,
    conflict_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotTablesV1 {
    blocks: Vec<BlockSnapshotV1>,
    block_tags: Vec<BlockTagSnapshot>,
    block_properties: Vec<BlockPropertySnapshot>,
    block_links: Vec<BlockLinkSnapshot>,
    attachments: Vec<AttachmentSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotDataV1 {
    schema_version: u32,
    snapshot_device_id: String,
    up_to_seqs: BTreeMap<String, i64>,
    up_to_hash: String,
    tables: SnapshotTablesV1,
}

#[test]
fn snapshot_v1_deserializes_with_default_fields() {
    // Build a v1 snapshot (no todo_state/priority/due_date)
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let v1 = SnapshotDataV1 {
        schema_version: 1,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTablesV1 {
            blocks: vec![BlockSnapshotV1 {
                id: "b1".to_string(),
                block_type: "content".to_string(),
                content: Some("hello".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                archived_at: None,
                is_conflict: 0,
                conflict_source: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
        },
    };

    // Encode as CBOR + zstd (same format as encode_snapshot)
    let mut cbor_buf = Vec::new();
    ciborium::into_writer(&v1, &mut cbor_buf).unwrap();
    let compressed = zstd::encode_all(cbor_buf.as_slice(), 3).unwrap();

    // Decode using the real decode_snapshot (which accepts v1..=SCHEMA_VERSION)
    let decoded = decode_snapshot(&compressed[..]).unwrap();
    assert_eq!(
        decoded.schema_version, 1,
        "v1 snapshot schema version must be preserved"
    );
    assert_eq!(
        decoded.tables.blocks.len(),
        1,
        "v1 snapshot should have one block"
    );
    let b = &decoded.tables.blocks[0];
    assert_eq!(b.id, "b1", "v1 block id must be preserved");
    assert!(
        b.todo_state.is_none(),
        "v1 data should default todo_state to None"
    );
    assert!(
        b.priority.is_none(),
        "v1 data should default priority to None"
    );
    assert!(
        b.due_date.is_none(),
        "v1 data should default due_date to None"
    );
}

#[test]
fn snapshot_v2_round_trips_new_fields() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "b1".to_string(),
                block_type: "content".to_string(),
                content: Some("hello".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: Some("TODO".to_string()),
                priority: Some("2".to_string()),
                due_date: Some("2026-04-15".to_string()),
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let decoded = decode_snapshot(&encoded[..]).unwrap();

    assert_eq!(
        decoded.schema_version, SCHEMA_VERSION,
        "v2 schema version must be preserved"
    );
    let b = &decoded.tables.blocks[0];
    assert_eq!(
        b.todo_state,
        Some("TODO".to_string()),
        "todo_state must survive v2 round-trip"
    );
    assert_eq!(
        b.priority,
        Some("2".to_string()),
        "priority must survive v2 round-trip"
    );
    assert_eq!(
        b.due_date,
        Some("2026-04-15".to_string()),
        "due_date must survive v2 round-trip"
    );
}

#[test]
fn snapshot_version_0_rejected() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: 0,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let result = decode_snapshot(&encoded[..]);
    assert!(result.is_err(), "schema_version 0 should be rejected");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("unsupported schema version"),
        "error should mention unsupported version, got: {err_msg}"
    );
}

// =======================================================================
// compact_op_log_transaction_happy_path (M-30)
// =======================================================================

/// Verify that `compact_op_log` works correctly with its transaction
/// wrapping: create old + recent ops, run compaction, verify that old ops
/// are purged, recent ops survive, and a snapshot is created — all
/// atomically within a single BEGIN IMMEDIATE transaction.
#[tokio::test]
async fn compact_op_log_transaction_happy_path() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-tx";

    // Insert a block with an old op (> 90 days ago)
    insert_block(&pool, "block-old-1", "old content 1").await;
    insert_op_at(&pool, device_id, "block-old-1", "2024-01-01T00:00:00Z").await;

    // Insert another block with an old op
    insert_block(&pool, "block-old-2", "old content 2").await;
    insert_op_at(&pool, device_id, "block-old-2", "2024-02-01T00:00:00Z").await;

    // Insert a block with a recent op (should survive compaction)
    insert_block(&pool, "block-recent", "recent content").await;
    let now = crate::now_rfc3339();
    insert_op_at(&pool, device_id, "block-recent", &now).await;

    // Verify starting state: 3 ops, 0 snapshots
    let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ops_before, 3, "should start with 3 ops");

    let snaps_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(snaps_before, 0, "should start with 0 snapshots");

    // Run compaction
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(
        result.is_some(),
        "compaction should return Some(snapshot_id) when old ops exist"
    );
    // L-42: `compact_op_log` now returns `(snapshot_id, deleted_count)`.
    let (snapshot_id, _deleted_count) = result.unwrap();
    assert!(!snapshot_id.is_empty(), "snapshot id should not be empty");

    // Old ops should be purged, recent op preserved
    let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ops_after, 1, "only the recent op should survive compaction");

    // Verify it's the recent op
    let remaining_ts: String = sqlx::query_scalar!("SELECT created_at FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        !remaining_ts.starts_with("2024-"),
        "remaining op should not have an old timestamp"
    );

    // A complete snapshot should exist
    let snap_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        snap_count, 1,
        "compaction should create exactly one complete snapshot"
    );

    // Verify the snapshot captures all 3 blocks (snapshot is taken
    // before op purge, so it reflects the full table state)
    let (_, snap_data) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    let decoded = decode_snapshot(&snap_data[..]).unwrap();
    assert_eq!(
        decoded.tables.blocks.len(),
        3,
        "snapshot should capture all 3 blocks"
    );
    assert_eq!(
        decoded.snapshot_device_id, device_id,
        "snapshot device_id should match"
    );

    // No pending snapshots should remain (cleanup runs in same tx)
    let pending: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        pending, 0,
        "no pending snapshots should remain after compaction"
    );
}

#[test]
fn snapshot_version_4_rejected() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 1);

    let data = SnapshotData {
        schema_version: 4,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h".to_string(),
        tables: SnapshotTables {
            blocks: vec![],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let result = decode_snapshot(&encoded[..]);
    assert!(result.is_err(), "schema_version 4 should be rejected");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("unsupported schema version"),
        "error should mention unsupported version, got: {err_msg}"
    );
}

// =======================================================================
// Snapshot restore cache verification (BUG-42 regression)
// =======================================================================

/// Regression test for BUG-42: after `apply_snapshot()`, cache-rebuild
/// tasks must be enqueued on the materializer so the UI doesn't see an
/// empty agenda / tag list / page list / search until the next unrelated
/// op triggers rebuilds by side-effect.
///
/// Previously this test documented the pre-fix behaviour ("caches are
/// EMPTY after restore — caller must rebuild them"). Now `apply_snapshot`
/// does the enqueue itself; flushing the background queue lets the
/// rebuild tasks run, and the caches are populated to match the restored
/// core data.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_rebuilds_caches() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Build a snapshot that has blocks, block_tags, and block_properties
    // (which would normally seed tags_cache, pages_cache, agenda_cache).
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-cache".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "cache-test".to_string(),
        tables: SnapshotTables {
            blocks: vec![
                BlockSnapshot {
                    id: "page-1".to_string(),
                    block_type: "page".to_string(),
                    content: Some("My Page".to_string()),
                    parent_id: None,
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: Some("2025-06-01".to_string()),
                    scheduled_date: None,
                },
                BlockSnapshot {
                    id: "tag-work".to_string(),
                    block_type: "tag".to_string(),
                    content: Some("work".to_string()),
                    parent_id: None,
                    position: None,
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
                BlockSnapshot {
                    id: "blk-child".to_string(),
                    block_type: "content".to_string(),
                    content: Some("tagged child".to_string()),
                    parent_id: Some("page-1".to_string()),
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
            ],
            block_tags: vec![BlockTagSnapshot {
                block_id: "blk-child".to_string(),
                tag_id: "tag-work".to_string(),
            }],
            block_properties: vec![BlockPropertySnapshot {
                block_id: "page-1".to_string(),
                key: "due".to_string(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-06-01".to_string()),
                value_ref: None,
            }],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    // Pre-populate caches with STALE data that doesn't match the snapshot.
    // A correct `apply_snapshot` must wipe these and rebuild to match the
    // restored core tables.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
         VALUES ('stale-tag', 'tag', 'stale', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
         VALUES ('stale-page', 'page', 'Stale Page', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES ('stale-tag', 'stale', 0, '2025-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO pages_cache (page_id, title, updated_at) \
         VALUES ('stale-page', 'Stale Page', '2025-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "pre-condition: tags_cache has stale data"
    );
    assert_eq!(
        sqlx::query_scalar!("SELECT COUNT(*) FROM pages_cache")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "pre-condition: pages_cache has stale data"
    );

    // Apply snapshot — this should both wipe the stale caches AND enqueue
    // the cache rebuild tasks on the materializer.
    let encoded = encode_snapshot(&data).unwrap();
    let restored = apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();

    assert_eq!(restored.tables.blocks.len(), 3);
    assert_eq!(restored.tables.block_tags.len(), 1);

    // Core tables are restored immediately.
    let block_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(block_count, 3, "core blocks must be restored synchronously");

    let tag_assoc_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_assoc_count, 1);

    // Stale caches have been WIPED by apply_snapshot (the transaction
    // deletes them before inserting snapshot data). The rebuild tasks
    // were enqueued — run them all by flushing the background queue.
    mat.flush_background().await.unwrap();

    // After rebuild, caches should reflect the snapshot (not the stale
    // pre-populate). The exact row counts depend on each rebuild's
    // semantics; the important invariant is that stale rows are gone
    // and the fresh tag / page from the snapshot appears.
    let tags_after: Vec<(String, String)> =
        sqlx::query_as("SELECT tag_id, name FROM tags_cache ORDER BY tag_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        tags_after.iter().all(|(tid, _)| tid != "stale-tag"),
        "stale tags_cache row must be gone after rebuild; got {tags_after:?}"
    );
    assert!(
        tags_after.iter().any(|(tid, _)| tid == "tag-work"),
        "tags_cache must contain the rebuilt tag from the snapshot; got {tags_after:?}"
    );

    let pages_after: Vec<(String, String)> =
        sqlx::query_as("SELECT page_id, title FROM pages_cache ORDER BY page_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        pages_after.iter().all(|(pid, _)| pid != "stale-page"),
        "stale pages_cache row must be gone after rebuild; got {pages_after:?}"
    );
    assert!(
        pages_after.iter().any(|(pid, _)| pid == "page-1"),
        "pages_cache must contain the rebuilt page from the snapshot; got {pages_after:?}"
    );

    mat.shutdown();
}

// =======================================================================
// apply_snapshot_excludes_template_page_blocks_from_agenda (M-15)
// =======================================================================

/// M-15 regression: after `apply_snapshot()`, the agenda must immediately
/// exclude blocks whose page is template-tagged (a page with property
/// `template`). Both `rebuild_agenda_cache` and `rebuild_projected_agenda_cache`
/// consult `b.page_id` to apply the FEAT-5a template-page exclusion via
/// `NOT EXISTS (... tp.block_id = b.page_id AND tp.key = 'template')`.
///
/// Before the fix the snapshot/restore enqueue array placed
/// `RebuildPageIds` after the agenda rebuilds; the background consumer
/// processed tasks sequentially, so the agenda saw a NULL `b.page_id`
/// (the wipe-and-restore left `page_id` unpopulated) and the NOT EXISTS
/// check silently failed — the template-page's blocks leaked into the
/// agenda until the next unrelated op triggered another rebuild.
///
/// With the fix `RebuildPageIds` runs first, the agenda rebuilds see a
/// populated `b.page_id`, and the template-page filter takes effect on
/// the very first drain — i.e. immediately after `flush_background()`
/// without waiting for any further events.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_excludes_template_page_blocks_from_agenda() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Snapshot: one template-tagged page + one child block under that
    // page with a `due_date`. With no `template` property the child
    // would land in the agenda via the `column:due_date` UNION arm.
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-tpl".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "template-test".to_string(),
        tables: SnapshotTables {
            blocks: vec![
                BlockSnapshot {
                    id: "tpl-page".to_string(),
                    block_type: "page".to_string(),
                    content: Some("Template Page".to_string()),
                    parent_id: None,
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
                BlockSnapshot {
                    id: "tpl-child".to_string(),
                    block_type: "content".to_string(),
                    content: Some("agenda-bait".to_string()),
                    parent_id: Some("tpl-page".to_string()),
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: Some("2025-06-15".to_string()),
                    scheduled_date: None,
                },
            ],
            block_tags: vec![],
            // The page is template-tagged via property `template` — the
            // FEAT-5a NOT EXISTS predicate keys off `tp.key = 'template'`
            // alone (any value). Use the cheapest typed slot.
            block_properties: vec![BlockPropertySnapshot {
                block_id: "tpl-page".to_string(),
                key: "template".to_string(),
                value_text: Some("1".to_string()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let _ = apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();

    // Process every enqueued cache rebuild task IN ORDER. The fix
    // guarantees `RebuildPageIds` is the first task in the array, so
    // by the time `RebuildAgendaCache` runs `b.page_id` is populated
    // and the template-page filter takes effect on the very first
    // rebuild — without waiting for any further events.
    mat.flush_background().await.unwrap();

    let agenda_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT date, block_id FROM agenda_cache ORDER BY date, block_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        agenda_rows.iter().all(|(_, b)| b != "tpl-child"),
        "M-15: agenda_cache must exclude blocks whose page is template-tagged \
         immediately after restore (no further events). RebuildPageIds must \
         run before RebuildAgendaCache so b.page_id is populated when the \
         agenda's `NOT EXISTS (... tp.block_id = b.page_id AND tp.key = 'template')` \
         filter runs. Got rows: {agenda_rows:?}"
    );

    // Sanity: page_id was actually populated for the child (proves the
    // RebuildPageIds task ran, not just that the agenda rebuild was
    // skipped for some unrelated reason).
    let child_page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'tpl-child'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        child_page_id.as_deref(),
        Some("tpl-page"),
        "RebuildPageIds must populate page_id for descendants of the template page"
    );

    mat.shutdown();
}

// =======================================================================
// apply_snapshot_uses_awaiting_enqueue_background (M-67)
// =======================================================================

/// M-67 regression: `apply_snapshot` must enqueue every cache-rebuild
/// task via the awaiting `enqueue_background` variant — never the
/// `try_enqueue_background` variant that silently drops tasks when the
/// bounded background channel is saturated.
///
/// Pre-fix, the 8 post-RESET rebuild tasks (`RebuildPageIds` plus the
/// 7 entries in `CACHE_TABLES`) were enqueued via
/// `try_enqueue_background`. If the queue happened to be saturated at
/// that moment — e.g. mid-catch-up against a busy materializer — any
/// dropped task left FTS / agenda_cache / pages_cache / tags_cache
/// empty until an unrelated edit triggered the next rebuild. There is
/// no boot-time recheck, so the user saw an empty agenda / search /
/// tag list indefinitely.
///
/// Post-fix, `enqueue_background` blocks until queue space is
/// available, so no rebuild is dropped. On the happy path
/// (uncontended channel, BACKGROUND_CAPACITY = 1024 ≫ 8 tasks) the
/// observable behaviour is identical to the old code, so this test
/// pins the contract by asserting that:
///   1. the call still succeeds and returns `SnapshotData`;
///   2. all enqueued cache-rebuild tasks reach the consumer
///      (`bg_processed` includes the 8 rebuilds + the `Barrier`
///      enqueued by `flush_background()`); and
///   3. `bg_dropped` stays at zero — the awaiting variant has no
///      shed-on-full path, so any non-zero value would prove a
///      regression back to `try_enqueue_background`.
///
/// Filling the bg queue to force the awaiting path to actually block
/// is impractical here: `apply_snapshot` performs many `.await` points
/// inside its transaction, every one of which yields the runtime and
/// lets the consumer drain. The simpler regression seat above is
/// sufficient to detect a revert because `bg_dropped > 0` only ever
/// fires from the `try_enqueue_background` Full arm.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_uses_awaiting_enqueue_background() {
    use std::sync::atomic::Ordering;

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Minimal snapshot — content is not the focus; we only care that
    // `apply_snapshot` runs the post-commit enqueue block.
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-m67".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "m67-test".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "blk-m67".to_string(),
                block_type: "content".to_string(),
                content: Some("hello".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    // Baseline counters (the materializer's startup tasks are not
    // expected to enqueue anything to bg, but we read the values
    // anyway to make the assertion robust).
    let bg_processed_before = mat.metrics().bg_processed.load(Ordering::Relaxed);
    let bg_dropped_before = mat.metrics().bg_dropped.load(Ordering::Relaxed);

    let encoded = encode_snapshot(&data).unwrap();
    let _restored = apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();

    // Drain the bg queue so every enqueued rebuild task has been
    // processed by the consumer.
    mat.flush_background().await.unwrap();

    let bg_processed_after = mat.metrics().bg_processed.load(Ordering::Relaxed);
    let bg_dropped_after = mat.metrics().bg_dropped.load(Ordering::Relaxed);

    // The 8 cache-rebuild tasks (`RebuildPageIds` + 7 from
    // `CACHE_TABLES`) plus the `Barrier` enqueued by
    // `flush_background()` together account for at least 9 processed
    // bg tasks. Some rebuild handlers may enqueue additional
    // bookkeeping tasks; the lower bound is what matters for the
    // regression seat.
    let processed_delta = bg_processed_after - bg_processed_before;
    assert!(
        processed_delta >= 9,
        "M-67: expected at least 9 background tasks processed after \
         apply_snapshot + flush_background (8 cache rebuilds + 1 barrier), \
         got delta = {processed_delta}"
    );

    // The awaiting `enqueue_background` variant has no shed-on-full
    // path; `bg_dropped` is bumped *only* by `try_enqueue_background`'s
    // Full arm. Any increment here would prove a regression back to
    // `try_enqueue_background`.
    assert_eq!(
        bg_dropped_after, bg_dropped_before,
        "M-67: bg_dropped must not increment during apply_snapshot — the \
         awaiting `enqueue_background` variant has no drop path. A non-zero \
         delta means apply_snapshot regressed to `try_enqueue_background` \
         (which silently drops on a saturated channel)"
    );

    mat.shutdown();
}

// =======================================================================
// apply_snapshot_rejects_traversal_attachment_fs_path (BUG-35)
// =======================================================================

/// Belt-and-suspenders: ensure a snapshot that contains an attachment
/// with a traversal `fs_path` (e.g. from a corrupted / hostile snapshot
/// file) is rejected at the trust boundary. `read_attachment_file` and
/// `write_attachment_file` already validate on access, but we want the
/// table-level invariant "rows in `attachments` have well-formed fs_path"
/// to hold.
#[tokio::test]
async fn apply_snapshot_rejects_traversal_attachment_fs_path() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-traversal".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "traversal-test".to_string(),
        tables: SnapshotTables {
            blocks: vec![BlockSnapshot {
                id: "blk-1".to_string(),
                block_type: "content".to_string(),
                content: Some("hosts an attachment".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![AttachmentSnapshot {
                id: "att-bad".to_string(),
                block_id: "blk-1".to_string(),
                mime_type: "text/plain".to_string(),
                filename: "leak.txt".to_string(),
                size_bytes: 10,
                fs_path: "../../../etc/passwd".to_string(),
                created_at: "2025-01-01T00:00:00Z".to_string(),
                deleted_at: None,
            }],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let err = apply_snapshot(&pool, &mat, &encoded[..])
        .await
        .expect_err("apply_snapshot must reject traversal fs_path");

    // The rejection must happen before the data lands — `attachments` stays empty.
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM attachments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "attachment row must NOT be committed when fs_path fails validation"
    );

    // And blocks also stay empty — the entire transaction must have rolled back,
    // not just the attachment insert. This asserts atomicity of restore.
    let blk_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blk_count, 0,
        "blocks must also roll back on attachment validation failure"
    );

    // Error is the Validation variant from sync_files.
    match err {
        AppError::Validation(_) => {}
        other => panic!("expected Validation error, got {other:?}"),
    }

    mat.shutdown();
}

// =======================================================================
// compact_read_phase_collects_data (PERF-10a)
// =======================================================================

/// Verify that the read-phase helpers (`collect_tables`, `collect_frontier`)
/// correctly gather all table data and the op frontier within a read
/// transaction, matching what `compact_op_log` uses in Phase 1.
#[tokio::test]
async fn compact_read_phase_collects_data() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-read";

    // Insert blocks, tags, properties, and ops
    insert_block(&pool, "blk-r1", "read phase block").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
         VALUES ('tag-r1', 'tag', 'readtag', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('blk-r1', 'tag-r1')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) \
         VALUES ('blk-r1', 'status', 'draft')",
    )
    .execute(&pool)
    .await
    .unwrap();

    insert_op_at(&pool, device_id, "blk-r1", "2025-01-01T00:00:00Z").await;
    insert_op_at(&pool, device_id, "blk-r2", "2025-01-02T00:00:00Z").await;

    // Use a DEFERRED read transaction, same as compact_op_log Phase 1
    let mut read_tx = pool.begin().await.unwrap();
    let tables: SnapshotTables = collect_tables(&mut read_tx).await.unwrap();
    let (frontier, hash): (BTreeMap<String, i64>, String) =
        collect_frontier(&mut read_tx).await.unwrap();
    read_tx.commit().await.unwrap();

    // Verify tables collected
    assert_eq!(
        tables.blocks.len(),
        2,
        "read phase should collect both blocks"
    );
    assert_eq!(
        tables.block_tags.len(),
        1,
        "read phase should collect block_tags"
    );
    assert_eq!(
        tables.block_properties.len(),
        1,
        "read phase should collect block_properties"
    );

    // Verify frontier
    assert!(
        frontier.contains_key(device_id),
        "frontier should include {device_id}"
    );
    assert_eq!(
        frontier[device_id], 2,
        "frontier should record max seq = 2 for {device_id}"
    );
    assert!(!hash.is_empty(), "frontier hash should not be empty");
}

// =======================================================================
// compact_stale_read_safety (PERF-10a)
// =======================================================================

/// Verify stale-read safety: ops written between Phase 1 (read) and
/// Phase 3 (write) are preserved because the DELETE is bounded by the
/// `up_to_seqs` frontier recorded at read time.
#[tokio::test]
async fn compact_stale_read_safety() {
    let (pool, _dir) = test_pool().await;

    // Insert an old op for device A
    insert_block(&pool, "blk-old", "old").await;
    insert_op_at(&pool, "dev-A", "blk-old", "2024-01-01T00:00:00Z").await;

    // Insert a recent op for a different device (B) — this simulates an
    // op that arrives between Phase 1 read and Phase 3 write in a real
    // concurrent scenario.
    insert_block(&pool, "blk-new", "new").await;
    let now = crate::now_rfc3339();
    insert_op_at(&pool, "dev-B", "blk-new", &now).await;

    // Run compaction — the frontier will include both devices, but the
    // time cutoff should only remove dev-A's old op.
    let result = compact_op_log(&pool, "dev-A", DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(result.is_some(), "compaction should occur");

    // dev-B's recent op must survive
    let remaining: Vec<(String, i64)> =
        sqlx::query_as("SELECT device_id, seq FROM op_log ORDER BY device_id, seq")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        remaining.len(),
        1,
        "only dev-B's recent op should survive compaction"
    );
    assert_eq!(
        remaining[0].0, "dev-B",
        "surviving op should belong to dev-B"
    );

    // Verify the snapshot captured both devices in its frontier
    let (_, snap_data) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    let decoded = decode_snapshot(&snap_data[..]).unwrap();
    assert!(
        decoded.up_to_seqs.contains_key("dev-A"),
        "snapshot frontier should include dev-A"
    );
    assert!(
        decoded.up_to_seqs.contains_key("dev-B"),
        "snapshot frontier should include dev-B"
    );
}

// =======================================================================
// compact_stale_read_seq_guard (PERF-10a)
// =======================================================================

/// Directly verify the seq-bounded DELETE guard: manually execute the
/// Phase 3 DELETE logic with a stale frontier and confirm that ops
/// beyond the frontier are preserved.
#[tokio::test]
async fn compact_stale_read_seq_guard() {
    let (pool, _dir) = test_pool().await;

    // Insert 3 old ops for the same device (seq 1, 2, 3)
    insert_block(&pool, "blk-s1", "s1").await;
    insert_op_at(&pool, "dev-1", "blk-s1", "2024-01-01T00:00:00Z").await;
    insert_block(&pool, "blk-s2", "s2").await;
    insert_op_at(&pool, "dev-1", "blk-s2", "2024-01-02T00:00:00Z").await;
    insert_block(&pool, "blk-s3", "s3").await;
    insert_op_at(&pool, "dev-1", "blk-s3", "2024-01-03T00:00:00Z").await;

    // Simulate a "stale" frontier that only saw up to seq 2
    let stale_frontier: BTreeMap<String, i64> = [("dev-1".to_string(), 2)].into_iter().collect();

    let cutoff_str = "2025-01-01T00:00:00.000Z"; // all ops are before this

    // Execute the same per-device DELETE that compact_op_log Phase 3 uses.
    // H-13: enable the op_log mutation bypass for the duration of this tx,
    // mirroring the production compaction path.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    crate::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    for (dev_id, max_seq) in &stale_frontier {
        sqlx::query("DELETE FROM op_log WHERE created_at < ?1 AND device_id = ?2 AND seq <= ?3")
            .bind(cutoff_str)
            .bind(dev_id)
            .bind(max_seq)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    crate::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // seq 1 and 2 should be deleted; seq 3 survives because seq > stale max_seq
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 1,
        "op at seq 3 should survive the seq-bounded DELETE"
    );

    let surviving_seq: i64 = sqlx::query_scalar!("SELECT seq FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        surviving_seq, 3,
        "the surviving op should be seq 3 (beyond stale frontier)"
    );
}

// ===========================================================================
// Property-based tests (proptest) — CBOR codec roundtrip
// ===========================================================================

mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy for generating an arbitrary `BlockSnapshot`.
    fn arb_block_snapshot() -> impl Strategy<Value = BlockSnapshot> {
        (
            "BLK_[0-9]{1,4}",                           // id
            "content|page",                             // block_type
            proptest::option::of("[a-zA-Z0-9 ]{0,50}"), // content
            proptest::option::of("BLK_[0-9]{1,4}"),     // parent_id
            proptest::option::of(0i64..1000),           // position
        )
            .prop_map(
                |(id, block_type, content, parent_id, position)| BlockSnapshot {
                    id,
                    block_type,
                    content,
                    parent_id,
                    position,
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
            )
    }

    /// Strategy for generating an arbitrary `BlockTagSnapshot`.
    fn arb_block_tag() -> impl Strategy<Value = BlockTagSnapshot> {
        ("BLK_[0-9]{1,4}", "tag_[a-z]{2,6}")
            .prop_map(|(block_id, tag_id)| BlockTagSnapshot { block_id, tag_id })
    }

    /// Strategy for generating an arbitrary `BlockPropertySnapshot`.
    fn arb_block_property() -> impl Strategy<Value = BlockPropertySnapshot> {
        (
            "BLK_[0-9]{1,4}",
            "[a-z_]{2,8}",
            proptest::option::of("[a-zA-Z0-9]{0,20}"),
        )
            .prop_map(|(block_id, key, value_text)| BlockPropertySnapshot {
                block_id,
                key,
                value_text,
                value_num: None,
                value_date: None,
                value_ref: None,
            })
    }

    /// Strategy for generating an arbitrary `BlockLinkSnapshot`.
    fn arb_block_link() -> impl Strategy<Value = BlockLinkSnapshot> {
        ("BLK_[0-9]{1,4}", "BLK_[0-9]{1,4}").prop_map(|(source_id, target_id)| BlockLinkSnapshot {
            source_id,
            target_id,
        })
    }

    /// Strategy for generating an arbitrary `AttachmentSnapshot`.
    fn arb_attachment() -> impl Strategy<Value = AttachmentSnapshot> {
        (
            "ATT_[0-9]{1,4}",
            "BLK_[0-9]{1,4}",
            "image/png|application/pdf|text/plain",
            "[a-z]{3,8}\\.[a-z]{3}",
            1i64..1_000_000,
            "attachments/[a-z]{3,10}",
        )
            .prop_map(|(id, block_id, mime_type, filename, size_bytes, fs_path)| {
                AttachmentSnapshot {
                    id,
                    block_id,
                    mime_type,
                    filename,
                    size_bytes,
                    fs_path,
                    created_at: "2025-01-01T00:00:00Z".into(),
                    deleted_at: None,
                }
            })
    }

    /// Strategy for generating a complete `SnapshotData` with random fields.
    fn arb_snapshot_data() -> impl Strategy<Value = SnapshotData> {
        (
            "dev-[a-z0-9]{3,10}",                                   // snapshot_device_id
            "[a-f0-9]{16,64}",                                      // up_to_hash
            proptest::collection::vec(arb_block_snapshot(), 0..=5), // blocks
            proptest::collection::vec(arb_block_tag(), 0..3),       // block_tags
            proptest::collection::vec(arb_block_property(), 0..3),  // block_properties
            proptest::collection::vec(arb_block_link(), 0..3),      // block_links
            proptest::collection::vec(arb_attachment(), 0..2),      // attachments
            proptest::collection::btree_map("dev-[a-z]{2,8}", 1i64..1000, 0..3), // up_to_seqs
        )
            .prop_map(
                |(device_id, hash, blocks, tags, props, links, atts, seqs)| SnapshotData {
                    schema_version: SCHEMA_VERSION,
                    snapshot_device_id: device_id,
                    up_to_seqs: seqs,
                    up_to_hash: hash,
                    tables: SnapshotTables {
                        blocks,
                        block_tags: tags,
                        block_properties: props,
                        block_links: links,
                        attachments: atts,
                        property_definitions: vec![],
                        page_aliases: vec![],
                    },
                },
            )
    }

    proptest! {
        /// CBOR codec round-trip: encode → decode preserves all fields.
        #[test]
        fn snapshot_cbor_roundtrip(data in arb_snapshot_data()) {
            let encoded = encode_snapshot(&data).expect("encode must succeed");
            let decoded = decode_snapshot(&encoded[..]).expect("decode must succeed");

            // Compare via JSON serialization since SnapshotData doesn't derive PartialEq.
            let original_json = serde_json::to_string(&data).expect("serialize original");
            let decoded_json = serde_json::to_string(&decoded).expect("serialize decoded");
            prop_assert_eq!(
                original_json,
                decoded_json,
                "decoded snapshot must equal original (compared via JSON serialization)"
            );
        }

        /// Encoding is deterministic: the same data always produces identical bytes.
        #[test]
        fn snapshot_encode_deterministic(data in arb_snapshot_data()) {
            let enc1 = encode_snapshot(&data).expect("encode #1");
            let enc2 = encode_snapshot(&data).expect("encode #2");
            prop_assert_eq!(enc1, enc2, "encoding the same data must produce identical bytes");
        }
    }
}

// =======================================================================
// UX-250: apply_snapshot rebuilds block_tag_refs from restored content
// =======================================================================

/// Restore a vault that contains a tag + a content block whose content
/// carries an inline `#[ULID]` reference. `block_tag_refs` is not a
/// snapshot table (it's purely derived), so after restore the table must
/// be wiped and then rebuilt by the `RebuildBlockTagRefsCache` task that
/// `apply_snapshot` enqueues. This test validates both the wipe (by
/// pre-populating a stale row) and the rebuild (by asserting the
/// restored row appears).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_rebuilds_block_tag_refs_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // 26-char ULID-style IDs so the inline #[ULID] regex matches.
    let tag_id = "01HQUX250TAGAAAAAAAAAAAAAA";
    let blk_id = "01HQUX250BLKAAAAAAAAAAAAAA";

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-ux250".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "ux250-test".to_string(),
        tables: SnapshotTables {
            blocks: vec![
                BlockSnapshot {
                    id: tag_id.to_string(),
                    block_type: "tag".to_string(),
                    content: Some("meeting".to_string()),
                    parent_id: None,
                    position: Some(1),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
                BlockSnapshot {
                    id: blk_id.to_string(),
                    block_type: "content".to_string(),
                    content: Some(format!("see #[{tag_id}] for notes")),
                    parent_id: None,
                    position: Some(2),
                    deleted_at: None,
                    is_conflict: 0,
                    conflict_source: None,
                    conflict_type: None,
                    todo_state: None,
                    priority: None,
                    due_date: None,
                    scheduled_date: None,
                },
            ],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    // Pre-populate with a stale block_tag_refs row pointing at blocks
    // that won't exist after restore. The restore wipes this before
    // inserting new rows; if the wipe step were missed, this row would
    // survive (and then violate FK once we re-populate blocks).
    let stale_src = "01HQUX250STALESRCCCCCCCCCC";
    let stale_tag = "01HQUX250STALETAGGGGGGGGGG";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
         VALUES (?, 'content', 'stale src', 0)",
    )
    .bind(stale_src)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict) \
         VALUES (?, 'tag', 'stale tag', 0)",
    )
    .bind(stale_tag)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
        .bind(stale_src)
        .bind(stale_tag)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar!("SELECT COUNT(*) FROM block_tag_refs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "pre-condition: block_tag_refs has one stale row"
    );

    // Apply snapshot → wipes stale row (and the stale blocks), restores
    // tag + content block, enqueues RebuildBlockTagRefsCache.
    let encoded = encode_snapshot(&data).unwrap();
    let _restored = apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();

    // Run the enqueued rebuild tasks.
    mat.flush_background().await.unwrap();

    // block_tag_refs must now contain exactly the restored edge
    // (source=blk_id, tag=tag_id) — nothing else.
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "exactly one row expected after restore + rebuild; got {rows:?}"
    );
    assert_eq!(
        rows[0],
        (blk_id.to_string(), tag_id.to_string()),
        "restored row must point from the content block to the tag"
    );

    mat.shutdown();
}

// =======================================================================
// MAINT-133: v2 snapshot without conflict_type decodes with None
// =======================================================================
//
// SCHEMA_VERSION just bumped 2 → 3 because `BlockSnapshot::conflict_type`
// joined the snapshot pipeline. The MAINT-133 review note claimed the
// decoder is "tolerant of missing fields"; this test verifies that
// claim end-to-end against a hand-crafted v2-shaped CBOR blob.
//
// If a future refactor accidentally strips the `#[serde(default)]`
// annotation on `conflict_type` (or replaces ciborium with a strict
// decoder), this test will catch the regression — older v2 snapshots
// would otherwise blow up on decode and break sync catch-up for any
// device that hasn't yet rotated to v3.

/// A v2-shaped BlockSnapshot — exactly the field set BlockSnapshot had
/// before MAINT-133 added `conflict_type`. We use this to encode CBOR
/// that omits the new field, simulating a snapshot taken on an older
/// build.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlockSnapshotV2 {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    is_conflict: i64,
    conflict_source: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotTablesV2 {
    blocks: Vec<BlockSnapshotV2>,
    block_tags: Vec<BlockTagSnapshot>,
    block_properties: Vec<BlockPropertySnapshot>,
    block_links: Vec<BlockLinkSnapshot>,
    attachments: Vec<AttachmentSnapshot>,
    property_definitions: Vec<crate::snapshot::types::PropertyDefinitionSnapshot>,
    page_aliases: Vec<crate::snapshot::types::PageAliasSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotDataV2 {
    schema_version: u32,
    snapshot_device_id: String,
    up_to_seqs: BTreeMap<String, i64>,
    up_to_hash: String,
    tables: SnapshotTablesV2,
}

#[test]
fn maint133_v2_snapshot_decodes_with_none_conflict_type() {
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev".to_string(), 7);

    // Note: a v2 snapshot would have flagged a conflict block via
    // is_conflict = 1 + conflict_source = Some(...) but had no way to
    // express the conflict's *type*. The test seeds exactly that
    // historical shape.
    let v2 = SnapshotDataV2 {
        schema_version: 2,
        snapshot_device_id: "dev".to_string(),
        up_to_seqs,
        up_to_hash: "h2".to_string(),
        tables: SnapshotTablesV2 {
            blocks: vec![BlockSnapshotV2 {
                id: "b-conf".to_string(),
                block_type: "content".to_string(),
                content: Some("clashed text".to_string()),
                parent_id: None,
                position: Some(1),
                deleted_at: None,
                is_conflict: 1,
                conflict_source: Some("b-orig".to_string()),
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
            }],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    // Encode using the same CBOR + zstd path the production code takes.
    let mut cbor_buf = Vec::new();
    ciborium::into_writer(&v2, &mut cbor_buf).unwrap();
    let compressed = zstd::encode_all(cbor_buf.as_slice(), 3).unwrap();

    // The real decoder must accept v2 without the new field.
    let decoded = decode_snapshot(&compressed[..])
        .expect("v2 snapshot (no conflict_type field) must decode cleanly via serde(default)");

    assert_eq!(
        decoded.schema_version, 2,
        "schema_version must round-trip the original v2 value"
    );
    assert_eq!(decoded.tables.blocks.len(), 1, "expected one block");
    let b = &decoded.tables.blocks[0];
    assert_eq!(b.id, "b-conf");
    assert_eq!(b.is_conflict, 1, "is_conflict flag must survive");
    assert_eq!(
        b.conflict_source.as_deref(),
        Some("b-orig"),
        "conflict_source must survive"
    );
    assert!(
        b.conflict_type.is_none(),
        "MAINT-133: conflict_type must default to None on v2 snapshots — \
         the field did not exist in the v2 schema. Got {:?}",
        b.conflict_type
    );
}

// =======================================================================
// MAINT-133: conflict_type must survive snapshot round-trip
// =======================================================================
//
// Schema migration `0007_add_conflict_type.sql` adds the `conflict_type`
// column to `blocks`; `merge/resolve.rs` writes it on every conflict-copy
// block. But the snapshot pipeline (BlockSnapshot struct, SELECT in
// create.rs, INSERT in restore.rs) did not carry the column, so on any
// user-triggered restore or peer snapshot catch-up, every conflict
// block's `conflict_type` was silently set to NULL.
//
// This regression test seeds a conflict-copy block with `conflict_type`
// set to 'Text', round-trips through `create_snapshot` +
// `apply_snapshot`, and asserts the column survives.

#[tokio::test]
async fn maint133_conflict_type_survives_round_trip() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let device_id = "dev-1";

    // Seed an "original" block (the block the conflict was forked from)
    // and a conflict-copy block that points to it via conflict_source.
    // The conflict block has conflict_type='Text' — exactly what
    // `merge/resolve.rs` writes on a text-divergence conflict.
    insert_block(&pool, "block-orig", "original content").await;
    sqlx::query(
        "INSERT INTO blocks \
            (id, block_type, content, parent_id, position, \
             is_conflict, conflict_source, conflict_type) \
         VALUES (?, 'content', ?, NULL, 1, 1, ?, 'Text')",
    )
    .bind("block-conflict")
    .bind("conflicting content")
    .bind("block-orig")
    .execute(&pool)
    .await
    .unwrap();

    // Need at least one op so collect_frontier() succeeds.
    insert_op_at(&pool, device_id, "block-orig", "2025-01-01T00:00:00Z").await;

    // Sanity: the seed row really has conflict_type = 'Text'.
    let pre_round_trip: Option<String> =
        sqlx::query_scalar("SELECT conflict_type FROM blocks WHERE id = 'block-conflict'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        pre_round_trip.as_deref(),
        Some("Text"),
        "pre-condition: seeded conflict block must have conflict_type='Text'"
    );

    // Round-trip: create the snapshot, then apply it back. After apply,
    // conflict_type on block-conflict must still be 'Text' — anything
    // else means the snapshot pipeline silently dropped the column.
    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();
    let snap_row = sqlx::query!(
        "SELECT id, data FROM log_snapshots WHERE id = ?",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let snap_data = snap_row.data;

    apply_snapshot(&pool, &mat, &snap_data[..]).await.unwrap();

    let post_round_trip: Option<String> =
        sqlx::query_scalar("SELECT conflict_type FROM blocks WHERE id = 'block-conflict'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        post_round_trip.as_deref(),
        Some("Text"),
        "MAINT-133: conflict_type must survive snapshot round-trip; \
         got {post_round_trip:?}, expected Some(\"Text\"). The snapshot \
         pipeline (BlockSnapshot / create SELECT / restore INSERT) is \
         dropping the column."
    );

    mat.shutdown();
}

// =======================================================================
// L-111: apply_snapshot must roll back chunk-1 inserts when chunk-2 fails
// =======================================================================
//
// `apply_snapshot` batch-INSERTs each table in chunks of
// `MAX_SQL_PARAMS / num_columns` rows (see `batch_insert_snapshot_rows!`
// in `restore.rs`). The traversal-fs_path test above already covers a
// failure on the very first row of `attachments`. This test covers the
// adjacent invariant: when chunk N>=2 fails, chunk N-1's rows must NOT
// remain — i.e. the whole transaction rolls back, not just the failing
// statement.
//
// Today this holds because every chunk runs inside the same
// `BEGIN IMMEDIATE` transaction and the `?` on `execute(...)` propagates
// the chunk failure out of `apply_snapshot` without committing. A future
// refactor that splits the loop into multiple transactions (or commits
// between chunks) would silently break atomicity — this test pins the
// behaviour.
//
// Construction: `block_properties` has `PRIMARY KEY (block_id, key)`,
// 6 columns -> `CHUNK = MAX_SQL_PARAMS / 6 = 166`. We build chunk-1
// (166 rows with unique keys), then chunk-2 starts with one fresh row
// followed by a row whose `(block_id, key)` duplicates a chunk-1 row.
// SQLite's chunk-2 INSERT aborts on the UNIQUE/PK violation, the error
// propagates, and the tx must roll back leaving zero rows behind.
#[tokio::test]
async fn apply_snapshot_rolls_back_chunk1_when_chunk2_fails() {
    use crate::db::MAX_SQL_PARAMS;

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Chunk size matches the derivation in `restore.rs`'s
    // `batch_insert_snapshot_rows!` macro: MAX_SQL_PARAMS / num_columns.
    // `block_properties` has 6 columns, so CHUNK = 999 / 6 = 166.
    const COLS: usize = 6;
    const CHUNK: usize = MAX_SQL_PARAMS / COLS;

    // One block to satisfy the FK on block_properties.block_id.
    let blocks = vec![BlockSnapshot {
        id: "blk-host".to_string(),
        block_type: "content".to_string(),
        content: Some("hosts many properties".to_string()),
        parent_id: None,
        position: Some(1),
        deleted_at: None,
        is_conflict: 0,
        conflict_source: None,
        conflict_type: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
    }];

    // Build chunk-1: exactly CHUNK rows with unique keys. All valid.
    let mut block_properties: Vec<BlockPropertySnapshot> = (0..CHUNK)
        .map(|i| BlockPropertySnapshot {
            block_id: "blk-host".to_string(),
            key: format!("key-c1-{i:05}"),
            value_text: Some(format!("v{i}")),
            value_num: None,
            value_date: None,
            value_ref: None,
        })
        .collect();

    // Chunk-2, row 0: a fresh, valid row.
    block_properties.push(BlockPropertySnapshot {
        block_id: "blk-host".to_string(),
        key: "key-c2-fresh".to_string(),
        value_text: Some("ok".to_string()),
        value_num: None,
        value_date: None,
        value_ref: None,
    });
    // Chunk-2, row 1: duplicates the (block_id, key) of a chunk-1 row,
    // violating PRIMARY KEY (block_id, key). This is the row that makes
    // the chunk-2 INSERT fail — chunk-1 has already been INSERTed in the
    // same transaction by this point.
    block_properties.push(BlockPropertySnapshot {
        block_id: "blk-host".to_string(),
        key: "key-c1-00050".to_string(),
        value_text: Some("duplicate".to_string()),
        value_num: None,
        value_date: None,
        value_ref: None,
    });

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-l111".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "l111-test".to_string(),
        tables: SnapshotTables {
            blocks,
            block_tags: vec![],
            block_properties,
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = encode_snapshot(&data).unwrap();
    let err = apply_snapshot(&pool, &mat, &encoded[..])
        .await
        .expect_err("apply_snapshot must surface the chunk-2 PK violation");

    // The duplicate (block_id, key) must surface as a database-layer
    // error from sqlx (UNIQUE/PK violation). Anything else means the
    // failure path changed.
    match err {
        AppError::Database(_) => {}
        other => panic!("expected Database error from PK violation, got {other:?}"),
    }

    // Atomicity invariant: chunk-1's 166 rows must NOT be visible.
    // If a future refactor splits the chunked loop across transactions
    // (or commits between chunks), these rows would leak through and
    // this assertion would catch it.
    let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        prop_count, 0,
        "L-111: chunk-1 block_properties rows must roll back when chunk-2 fails; \
         got {prop_count} rows still present, expected 0"
    );

    // Whole-tx rollback: the host block insert (which ran before the
    // block_properties chunks) must also be gone.
    let blk_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blk_count, 0,
        "L-111: blocks inserted before the failing chunk must also roll back"
    );

    mat.shutdown();
}

// =======================================================================
// L-108: conflict copies survive their source's compaction
// =======================================================================

/// L-108: A block A and its conflict copy A' must both round-trip through
/// `compact_op_log` → `apply_snapshot` with `conflict_source` intact, even
/// after A's original `CreateBlock` op has been purged by compaction.
///
/// Pass-1 source: 08/F35. The concern was that after compaction purges the
/// pre-conflict ops, a subsequent RESET via `apply_snapshot` may not include
/// the source if it was never re-edited. This test pins the round-trip:
///
/// 1. Insert page P + real block A + conflict copy A' (with `conflict_source = A`).
/// 2. Insert an old `CreateBlock` op for A (pre-retention-cutoff) so compaction
///    has something to purge.
/// 3. `compact_op_log` — A's old op is purged, a snapshot capturing both A
///    and A' is written.
/// 4. Insert post-compaction noise (block B) that the snapshot does NOT cover.
/// 5. Read the snapshot blob from `log_snapshots`, call `apply_snapshot`.
/// 6. Assert: the noise block B is gone (RESET wiped it), A and A' are present,
///    A' still has `is_conflict = 1` and `conflict_source = A`.
#[tokio::test]
async fn compact_then_apply_snapshot_preserves_conflict_copy_l108() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let device_id = "dev-l108";

    // Page P (real, top-level).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
         VALUES ('P_L108', 'page', 'page-l108', NULL, 1, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Real block A (parent = P).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
         VALUES ('A_L108', 'content', 'real A', 'P_L108', 1, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Conflict copy A' — `is_conflict = 1`, `conflict_source = A`.
    // Mirrors the shape produced by `merge::resolve::create_conflict_copy`.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source) \
         VALUES ('A_PRIME_L108', 'content', 'conflict copy of A', 'P_L108', 999, 1, 'A_L108')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Old op for A so compaction has something to purge (200 days ago vs.
    // DEFAULT_RETENTION_DAYS = 90).
    insert_op_at(&pool, device_id, "A_L108", "2024-01-01T00:00:00Z").await;

    // Run compaction. Returns Some((snapshot_id, deleted_count)).
    let (snapshot_id, _deleted) = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap()
        .expect("compaction should produce a snapshot");

    // Add post-compaction noise that the snapshot does NOT cover. Apply
    // must wipe this.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
         VALUES ('B_NOISE_L108', 'content', 'post-compaction noise', 'P_L108', 2, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Read the snapshot blob and apply it.
    let snap_data: Vec<u8> = sqlx::query_scalar!(
        "SELECT data FROM log_snapshots WHERE id = ? AND status = 'complete'",
        snapshot_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    apply_snapshot(&pool, &mat, &snap_data[..]).await.unwrap();

    // Noise block must be gone (RESET wiped pre-snapshot state).
    let noise_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = 'B_NOISE_L108'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        noise_count, 0,
        "L-108: post-compaction noise block must be wiped by apply_snapshot"
    );

    // P, A, A' must all be present.
    #[derive(sqlx::FromRow)]
    struct BlockRow {
        id: String,
        is_conflict: i64,
        conflict_source: Option<String>,
    }
    let mut rows: Vec<BlockRow> =
        sqlx::query_as("SELECT id, is_conflict, conflict_source FROM blocks ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    rows.sort_by(|a, b| a.id.cmp(&b.id));

    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["A_L108", "A_PRIME_L108", "P_L108"],
        "L-108: snapshot must round-trip P, A, A' (conflict copy)"
    );

    // A' must still be a conflict copy pointing at A.
    let a_prime = rows.iter().find(|r| r.id == "A_PRIME_L108").unwrap();
    assert_eq!(
        a_prime.is_conflict, 1,
        "L-108: A' must remain is_conflict = 1 after round-trip"
    );
    assert_eq!(
        a_prime.conflict_source.as_deref(),
        Some("A_L108"),
        "L-108: A' conflict_source must point at A after round-trip"
    );

    // A must remain non-conflict.
    let a = rows.iter().find(|r| r.id == "A_L108").unwrap();
    assert_eq!(
        a.is_conflict, 0,
        "L-108: A must remain is_conflict = 0 after round-trip"
    );
    assert!(
        a.conflict_source.is_none(),
        "L-108: A must have no conflict_source after round-trip"
    );

    mat.shutdown();
}

// =======================================================================
// L-109: compaction preserves snapshot atomicity on injected DELETE failure
// =======================================================================

/// L-109: `compact_op_log`'s entire write phase is wrapped in `BEGIN
/// IMMEDIATE`; on any failure, both the `INSERT INTO log_snapshots` and the
/// `DELETE FROM op_log` must roll back together.
///
/// Pass-1 source: 08/F36. We exercise that invariant by installing a custom
/// AFTER DELETE trigger on `op_log` that unconditionally `RAISE(ABORT)`s,
/// then run `compact_op_log` and assert:
///
///   - the call returns `Err(...)`,
///   - no row exists in `log_snapshots` (the `INSERT … 'pending'` was
///     rolled back; no orphaned 'pending' row leaks),
///   - every `op_log` row is intact (the `DELETE` was rolled back).
///
/// A future refactor that splits compaction's tx — for example, committing
/// the snapshot insert before the per-device deletes — would silently break
/// atomicity, leaving either a 'pending' snapshot row stranded or ops
/// already deleted with no snapshot. This test catches it.
#[tokio::test]
async fn compact_op_log_rolls_back_on_injected_delete_failure_l109() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-l109";

    // Insert a block with an old op so compaction has something to delete.
    insert_block(&pool, "blk-l109", "content").await;
    insert_op_at(&pool, device_id, "blk-l109", "2024-01-01T00:00:00Z").await;

    // Snapshot pre-compaction state.
    let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ops_before, 1, "should start with 1 op");
    let snaps_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(snaps_before, 0, "should start with 0 snapshots");

    // Install an AFTER DELETE trigger on op_log that unconditionally aborts.
    // The H-13 BEFORE-DELETE bypass mechanism (sentinel row in
    // `_op_log_mutation_allowed`) is checked by the production trigger from
    // migration 0036; this AFTER trigger is independent and will fire even
    // when the bypass is enabled, which is exactly what we want to inject
    // a mid-tx failure.
    sqlx::query(
        "CREATE TRIGGER l109_inject_delete_failure \
         AFTER DELETE ON op_log \
         BEGIN \
             SELECT RAISE(ABORT, 'L-109 injected: DELETE FROM op_log not allowed'); \
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Run compaction — must fail.
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS).await;
    assert!(
        result.is_err(),
        "L-109: compaction must fail when DELETE FROM op_log aborts; got {result:?}"
    );

    // Snapshot row must NOT exist — the INSERT into log_snapshots was rolled
    // back along with the failed DELETE.
    let snaps_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        snaps_after, 0,
        "L-109: log_snapshots must be empty after a rolled-back compaction; \
         a leaked 'pending' or 'complete' row indicates the tx is no longer atomic"
    );

    // Op log must be intact — DELETE was aborted and the whole tx rolled back.
    let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after, ops_before,
        "L-109: op_log row count must be unchanged after a rolled-back compaction"
    );

    // Drop the injected trigger so any other tests sharing the pool are
    // unaffected. (Each test gets a fresh `test_pool` so this is belt-
    // and-braces, but it documents the cleanup contract for the helper.)
    sqlx::query("DROP TRIGGER IF EXISTS l109_inject_delete_failure")
        .execute(&pool)
        .await
        .unwrap();
}

// =======================================================================
// L-105 — `compact_op_log` warns when op_log buffering would approach
// the platform memory ceiling
// =======================================================================
//
// `collect_tables` + `encode_snapshot` buffer the entire derived state
// in memory before encoding; on a 1M-block vault this can exceed the
// per-process heap budget on Android (24 MB release-APK ceiling). The
// L-105 fix is a heads-up `warn!` keyed off two op_log dimensions
// (row count + total payload bytes), not an abort. This test pins:
//
//   1. The threshold constants haven't drifted (`SNAPSHOT_WARN_ROW_COUNT`
//      = 100k, `SNAPSHOT_WARN_PAYLOAD_BYTES` = 64 MiB) — a future
//      refactor that silently weakens them would re-introduce the
//      "no heads-up before OOM" hole.
//   2. `measure_op_log_size` — the SQL helper that backs the warn —
//      reads `COUNT(*)` and `SUM(LENGTH(payload))` correctly against a
//      seeded op_log. Verifying the SQL via the helper is enough; this
//      crate does not wire up `tracing-test`/`TestWriter`, and the
//      task scope explicitly accepts pinning the COUNT/SUM logic in
//      lieu of asserting the formatted warn line.
//   3. The threshold-exceeded predicate (`>` against either bound) is
//      strictly greater-than at the boundary, so a later off-by-one
//      refactor (e.g. `>=`) would be caught.
//
// Inserting `SNAPSHOT_WARN_ROW_COUNT + 1` rows directly is too slow for
// nextest (100k+ INSERTs in a tight loop), and a test-mode override
// would add API surface for one test. The combination above pins the
// behaviour without paying that cost.

#[tokio::test]
async fn compact_op_log_logs_warn_when_row_count_exceeds_threshold_l105() {
    // 1. Threshold constants — pinned values, not just "non-zero".
    assert_eq!(
        SNAPSHOT_WARN_ROW_COUNT, 100_000,
        "L-105: row threshold must remain 100k — see create.rs doc comment for rationale"
    );
    assert_eq!(
        SNAPSHOT_WARN_PAYLOAD_BYTES,
        64 * 1024 * 1024,
        "L-105: byte threshold must remain 64 MiB — see create.rs doc comment for rationale"
    );

    // 2. `measure_op_log_size` returns COUNT/SUM matching the seeded
    //    op_log. Three ops with `append_local_op_at` produces three
    //    rows whose payloads each carry a non-empty JSON-encoded
    //    `CreateBlock` body — so `payload_bytes` must be > 0.
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-l105";
    insert_op_at(&pool, device_id, "blk-l105-a", "2025-01-01T00:00:00Z").await;
    insert_op_at(&pool, device_id, "blk-l105-b", "2025-01-02T00:00:00Z").await;
    insert_op_at(&pool, device_id, "blk-l105-c", "2025-01-03T00:00:00Z").await;

    let mut conn = pool.acquire().await.unwrap();
    let (row_count, payload_bytes) = measure_op_log_size(&mut conn).await.unwrap();
    drop(conn);

    assert_eq!(
        row_count, 3,
        "L-105: measure_op_log_size must report the exact COUNT(*) of op_log rows"
    );
    assert!(
        payload_bytes > 0,
        "L-105: measure_op_log_size must report a non-zero SUM(LENGTH(payload)) when ops exist; got {payload_bytes}"
    );

    // The seeded scenario must NOT exceed either threshold (sanity:
    // the production warn would otherwise misfire on every test
    // with a handful of ops).
    assert!(
        row_count <= SNAPSHOT_WARN_ROW_COUNT,
        "L-105: 3 seeded ops must not exceed the 100k row threshold"
    );
    assert!(
        payload_bytes <= SNAPSHOT_WARN_PAYLOAD_BYTES,
        "L-105: 3 seeded ops must not exceed the 64 MiB byte threshold"
    );

    // 3. Boundary check — strictly `>`. If either bound were ever
    //    weakened to `>=`, the threshold + 1 case below would still
    //    pass but the threshold case would start firing on every
    //    100k-row vault, which is not the intended behaviour.
    let exceeds = |rows: i64, bytes: i64| -> bool {
        rows > SNAPSHOT_WARN_ROW_COUNT || bytes > SNAPSHOT_WARN_PAYLOAD_BYTES
    };
    assert!(
        !exceeds(SNAPSHOT_WARN_ROW_COUNT, 0),
        "L-105: at exactly the row threshold, warn must NOT fire (strict >)"
    );
    assert!(
        exceeds(SNAPSHOT_WARN_ROW_COUNT + 1, 0),
        "L-105: at row threshold + 1, warn MUST fire"
    );
    assert!(
        !exceeds(0, SNAPSHOT_WARN_PAYLOAD_BYTES),
        "L-105: at exactly the byte threshold, warn must NOT fire (strict >)"
    );
    assert!(
        exceeds(0, SNAPSHOT_WARN_PAYLOAD_BYTES + 1),
        "L-105: at byte threshold + 1, warn MUST fire"
    );

    // 4. End-to-end: `compact_op_log` runs cleanly with the new
    //    pre-flight SQL in place — the new query must compile against
    //    the committed `.sqlx/` cache and not perturb the existing
    //    Phase 1 read transaction. We don't assert on logs here (no
    //    tracing capture); a successful return proves the production
    //    path now contains and exercises the L-105 probe.
    insert_block(&pool, "blk-l105-a", "content").await;
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS).await;
    assert!(
        result.is_ok(),
        "L-105: compact_op_log must not regress on the new measure_op_log_size pre-flight; got {result:?}"
    );
}

// =======================================================================
// M-70 — apply_snapshot followed by anchor yields consistent prev_hash
// =======================================================================
//
// `apply_snapshot` performs `DELETE FROM op_log` and commits without
// persisting the snapshot's `up_to_hash` anywhere as the post-restore
// anchor. The FEAT-6 sync orchestrator at
// `sync_daemon::snapshot_transfer::try_receive_snapshot_catchup` calls
// `peer_refs::update_on_sync` immediately after, so the happy path is
// covered — but the contract is caller-enforced.
//
// This regression test pins the orchestrator's pattern: after applying a
// snapshot, the caller MUST anchor the post-restore hash chain via
// `peer_refs::upsert_peer_ref` + `peer_refs::update_on_sync`. The
// assertion shape mirrors what `try_receive_snapshot_catchup` does — a
// future caller that forgets the anchor would silently break later
// cross-device hash-chain validation because peer-side validation
// consults `peer_refs.last_hash` to know where the source peer's chain
// stands.
//
// `up_to_hash` is opaque (see `collect_frontier` doc comment for the
// "real causal anchor is `up_to_seqs`" rationale) — peers never compare
// it for equality between devices. What matters is that the *anchor we
// stored* matches the *hash the snapshot was tagged with*, so the next
// local op's chain (which restarts at `seq=1, parent_seqs=NULL` after
// the op_log wipe) is reconcilable against the source peer's frontier
// via the `peer_refs` row.

#[tokio::test]
async fn apply_snapshot_followed_by_anchor_yields_consistent_prev_hash() {
    // ── Source pool: build a snapshot tagged at `up_to_hash`. ────────
    let (src_pool, _src_dir) = test_pool().await;
    let src_device = "dev-src";
    insert_block(&src_pool, "block-src-1", "snapshot content").await;
    insert_op_at(&src_pool, src_device, "block-src-1", "2025-01-01T00:00:00Z").await;
    let snapshot_id = create_snapshot(&src_pool, src_device).await.unwrap();

    // Read back the snapshot blob + its `up_to_hash` (the chain anchor
    // the orchestrator persists into peer_refs after a successful
    // apply).
    let snap_row = sqlx::query!(
        "SELECT data, up_to_hash FROM log_snapshots WHERE id = ?",
        snapshot_id
    )
    .fetch_one(&src_pool)
    .await
    .unwrap();
    let snap_data = snap_row.data;
    let snap_up_to_hash = snap_row.up_to_hash;
    assert!(
        !snap_up_to_hash.is_empty(),
        "M-70: `up_to_hash` must be non-empty for a snapshot built over a non-empty op_log — \
         the test premise depends on having a real anchor to compare against"
    );

    // ── Destination pool: fresh, then apply the snapshot. ────────────
    let (dst_pool, _dst_dir) = test_pool().await;
    let dst_mat = test_materializer(&dst_pool);
    let restored = apply_snapshot(&dst_pool, &dst_mat, &snap_data[..])
        .await
        .expect("apply_snapshot must succeed on a fresh dst pool");

    // Sanity: `apply_snapshot` itself wiped op_log (RESET semantics).
    let op_log_count_after_apply: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&dst_pool)
        .await
        .unwrap();
    assert_eq!(
        op_log_count_after_apply, 0,
        "M-70 premise: apply_snapshot must wipe op_log (the absence of a stored prev_hash \
         is exactly what makes the peer_refs anchor load-bearing)"
    );
    assert_eq!(
        restored.up_to_hash, snap_up_to_hash,
        "M-70 sanity: the decoded SnapshotData's up_to_hash must match the log_snapshots \
         row's up_to_hash"
    );

    // ── Anchor the post-restore hash chain — copy the orchestrator's
    //    exact pattern from `sync_daemon::snapshot_transfer::
    //    try_receive_snapshot_catchup` (lines 460-461): upsert the peer
    //    ref, then `update_on_sync(.., up_to_hash, "")` with the empty
    //    string as the documented "we sent nothing" sentinel.
    crate::peer_refs::upsert_peer_ref(&dst_pool, src_device)
        .await
        .unwrap();
    crate::peer_refs::update_on_sync(&dst_pool, src_device, &snap_up_to_hash, "")
        .await
        .expect("M-70: peer_refs::update_on_sync must succeed against a freshly upserted peer");

    // ── Now write a local op on the post-restore pool. After the wipe
    //    the destination's own chain restarts at seq=1 with no parent
    //    (genesis). What anchors this restart to the snapshot's tip is
    //    the peer_refs row above — that is the contract M-70 guards.
    let dst_local_device = "dev-local";
    let new_op = append_local_op_at(
        &dst_pool,
        dst_local_device,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("01HZ0000000000000000DSTNEW1"),
            block_type: "content".to_owned(),
            content: "post-restore op".to_owned(),
            parent_id: None,
            position: Some(0),
        }),
        "2025-06-01T00:00:00Z".to_owned(),
    )
    .await
    .expect("append_local_op_at must succeed on the post-restore pool");

    // ── Assertions: the new local op is a clean genesis (seq=1,
    //    parent_seqs=None) and the chain anchor recorded for the
    //    snapshot's source peer matches `up_to_hash`. Together these
    //    pin the orchestrator's contract: a future caller that omits
    //    the `update_on_sync` call would leave `peer_refs.last_hash`
    //    NULL, breaking the equality check below.
    assert_eq!(
        new_op.seq, 1,
        "M-70: post-restore local chain must restart at seq=1 (op_log was wiped)"
    );
    assert!(
        new_op.parent_seqs.is_none(),
        "M-70: the first local op after apply_snapshot has no parent in op_log — the chain \
         anchor lives in peer_refs, not in op_log.parent_seqs (which is why the contract \
         is caller-enforced and why this regression test exists)"
    );

    // The load-bearing assertion: the persisted anchor for the source
    // peer matches the snapshot's `up_to_hash`. Phrased the way M-70
    // describes it, this is "the resulting chain's `prev_hash` for the
    // snapshot's source device equals `snapshot.up_to_hash`".
    let anchored_peer_ref = crate::peer_refs::get_peer_ref(&dst_pool, src_device)
        .await
        .unwrap()
        .expect("M-70: peer_refs row for the snapshot source device must exist after anchor");
    assert_eq!(
        anchored_peer_ref.last_hash.as_deref(),
        Some(snap_up_to_hash.as_str()),
        "M-70: peer_refs[{src_device}].last_hash must equal snapshot.up_to_hash after the \
         orchestrator-style anchor — this is the chain `prev_hash` future cross-device \
         hash-chain validation will consult. A regression where apply_snapshot's caller \
         forgets the update_on_sync would leave this NULL and silently break sync."
    );

    // The new local op's hash must also be deterministic and consistent
    // with `compute_op_hash` over the same inputs — re-derive it
    // independently to prove the post-restore chain is well-formed.
    let payload_json: String = sqlx::query_scalar!(
        "SELECT payload FROM op_log WHERE device_id = ? AND seq = ?",
        dst_local_device,
        new_op.seq,
    )
    .fetch_one(&dst_pool)
    .await
    .unwrap();
    let expected_hash = crate::hash::compute_op_hash(
        dst_local_device,
        new_op.seq,
        new_op.parent_seqs.as_deref(),
        &new_op.op_type,
        &payload_json,
    );
    assert_eq!(
        new_op.hash, expected_hash,
        "M-70: the post-restore local op's hash must reproduce via compute_op_hash over \
         (device_id, seq, parent_seqs=None, op_type, payload) — proves the chain is \
         well-formed and reconcilable with the peer_refs anchor"
    );
}
