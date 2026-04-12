use super::*;
use crate::db::init_pool;
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
    let decoded = decode_snapshot(&encoded).unwrap();

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

    let err = decode_snapshot(&encoded).unwrap_err();
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
    let garbage = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x42, 0x42];
    let err = decode_snapshot(&garbage).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("zstd decompress"),
        "expected zstd error, got: {msg}"
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
    let decoded = decode_snapshot(&encoded).unwrap();

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
    let decoded = decode_snapshot(&data).unwrap();
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
    let restored = apply_snapshot(&pool, &snap_data).await.unwrap();

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
// 8. apply_snapshot_empty_db
// =======================================================================

#[tokio::test]
async fn apply_snapshot_empty_db() {
    let (pool, _dir) = test_pool().await;

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

    let restored = apply_snapshot(&pool, &simple_encoded).await.unwrap();

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
    let decoded = decode_snapshot(&latest_data).unwrap();
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
    let decoded = decode_snapshot(&encoded).unwrap();

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
// 15. create_snapshot_empty_op_log
// =======================================================================

/// `create_snapshot` must return a clear Snapshot error when op_log is
/// empty — not a cryptic RowNotFound.
#[tokio::test]
async fn create_snapshot_empty_op_log() {
    let (pool, _dir) = test_pool().await;

    // DB has blocks but no ops
    insert_block(&pool, "block-1", "content").await;

    let err = create_snapshot(&pool, "dev-1").await.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("op_log is empty"),
        "expected 'op_log is empty' error, got: {msg}"
    );
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
    let decoded = decode_snapshot(&snap_data).unwrap();
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
    let result = apply_snapshot(&pool, &encoded).await;
    assert!(
        result.is_err(),
        "FK violation should cause apply_snapshot to fail"
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
    let restored = apply_snapshot(&pool, &encoded).await.unwrap();

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
/// with op_log.created_at. This tests the edge case where timestamps use
/// the `+00:00` suffix (from to_rfc3339) vs `.000Z` suffix.
#[tokio::test]
async fn compact_op_log_timestamp_format_consistency() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert an old op using a zero-subsecond timestamp (the edge case
    // that was previously problematic with format() vs to_rfc3339()).
    insert_block(&pool, "block-old", "old").await;
    insert_op_at(&pool, device_id, "block-old", "2024-01-15T12:00:00+00:00").await;

    // Compact with 90-day retention — the old op should be purged
    let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap();
    assert!(
        result.is_some(),
        "old op with +00:00 suffix should still be detected as old"
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
    let decoded = decode_snapshot(&encoded).unwrap();

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
    let decoded = decode_snapshot(&encoded).unwrap();

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
    let decoded = decode_snapshot(&encoded).unwrap();

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
    let decoded = decode_snapshot(&encoded).unwrap();

    // Re-encode and decode again to verify idempotency
    let re_encoded = encode_snapshot(&decoded).unwrap();
    let re_decoded = decode_snapshot(&re_encoded).unwrap();

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
    let decoded = decode_snapshot(&row.data).unwrap();

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
async fn cleanup_old_snapshots_with_zero_keep_deletes_all() {
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

    // Cleanup with keep=0 should delete all
    let deleted = cleanup_old_snapshots(&pool, 0).await.unwrap();
    assert_eq!(deleted, 3, "keep=0 should delete all 3 snapshots");

    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "no snapshots should remain after keep=0");
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

    // Decode using the real decode_snapshot (which now accepts v1..=v2)
    let decoded = decode_snapshot(&compressed).unwrap();
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
    let decoded = decode_snapshot(&encoded).unwrap();

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
    let result = decode_snapshot(&encoded);
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
    let snapshot_id = result.unwrap();
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
    let decoded = decode_snapshot(&snap_data).unwrap();
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
    let result = decode_snapshot(&encoded);
    assert!(result.is_err(), "schema_version 4 should be rejected");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("unsupported schema version"),
        "error should mention unsupported version, got: {err_msg}"
    );
}

// =======================================================================
// Snapshot restore cache verification (T-11 / B-57)
// =======================================================================

/// After `apply_snapshot()`, cache tables should be EMPTY because the
/// restore wipes them and does NOT trigger a cache rebuild — the caller
/// is expected to rebuild caches after restore. This test documents the
/// current behavior; see B-57 for the follow-up to trigger automatic
/// cache rebuilds after restore.
#[tokio::test]
async fn apply_snapshot_caches_are_empty_after_restore() {
    let (pool, _dir) = test_pool().await;

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

    // Pre-populate caches so we can verify they get wiped.
    // (Simulate state before a restore where caches had data.)
    // First, insert dummy blocks that the cache FKs reference.
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

    // Verify pre-populate worked
    let tags_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tags_before, 1, "pre-condition: tags_cache has stale data");

    let pages_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM pages_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pages_before, 1, "pre-condition: pages_cache has stale data");

    // Apply snapshot
    let encoded = encode_snapshot(&data).unwrap();
    let restored = apply_snapshot(&pool, &encoded).await.unwrap();

    // Verify core tables are restored correctly
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

    // Verify blocks are in the DB
    let block_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        block_count, 3,
        "database should have 3 blocks after restore"
    );

    // Verify block_tags are in the DB
    let tag_assoc_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        tag_assoc_count, 1,
        "database should have 1 block_tag after restore"
    );

    // === Cache verification ===
    // tags_cache should be EMPTY after restore (wiped, not rebuilt).
    // Cache rebuild should be triggered by caller — see B-57.
    let tags_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        tags_after, 0,
        "tags_cache must be empty after restore (cache rebuild not triggered — B-57)"
    );

    // pages_cache should be EMPTY after restore (wiped, not rebuilt).
    // Cache rebuild should be triggered by caller — see B-57.
    let pages_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM pages_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        pages_after, 0,
        "pages_cache must be empty after restore (cache rebuild not triggered — B-57)"
    );

    // agenda_cache should be EMPTY after restore (wiped, not rebuilt).
    // Cache rebuild should be triggered by caller — see B-57.
    let agenda_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM agenda_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        agenda_after, 0,
        "agenda_cache must be empty after restore (cache rebuild not triggered — B-57)"
    );

    // block_tag_inherited should be EMPTY (no materializer has run).
    let inherited_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tag_inherited")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        inherited_after, 0,
        "block_tag_inherited must be empty after restore (no materializer run)"
    );

    // projected_agenda_cache should be EMPTY (no materializer has run).
    let projected_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM projected_agenda_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        projected_after, 0,
        "projected_agenda_cache must be empty after restore (no materializer run)"
    );
}
