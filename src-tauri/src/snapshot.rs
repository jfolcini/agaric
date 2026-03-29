//! Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction (ADR-07).
//!
//! Snapshots capture the full state of all core tables (blocks, block_tags,
//! block_properties, block_links, attachments) as zstd-compressed CBOR blobs
//! stored in the `log_snapshots` table.
//!
//! # Crash-safe write protocol
//!
//! 1. INSERT with `status = 'pending'` (includes the compressed data).
//! 2. UPDATE to `status = 'complete'`.
//!
//! If a crash occurs between steps 1 and 2, boot recovery
//! ([`crate::recovery::recover_at_boot`]) deletes all pending rows.
//!
//! # Compaction
//!
//! [`compact_op_log`] creates a snapshot and then purges `op_log` rows older
//! than the configured retention window (default 90 days).

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::BTreeMap;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

const SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Row types (CBOR + DB round-trip)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockSnapshot {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub archived_at: Option<String>,
    pub is_conflict: i64,
    pub conflict_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockTagSnapshot {
    pub block_id: String,
    pub tag_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockPropertySnapshot {
    pub block_id: String,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockLinkSnapshot {
    pub source_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AttachmentSnapshot {
    pub id: String,
    pub block_id: String,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Aggregate types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotTables {
    pub blocks: Vec<BlockSnapshot>,
    pub block_tags: Vec<BlockTagSnapshot>,
    pub block_properties: Vec<BlockPropertySnapshot>,
    pub block_links: Vec<BlockLinkSnapshot>,
    pub attachments: Vec<AttachmentSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotData {
    pub schema_version: u32,
    pub snapshot_device_id: String,
    pub up_to_seqs: BTreeMap<String, i64>,
    pub up_to_hash: String,
    pub tables: SnapshotTables,
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/// Encode SnapshotData to zstd-compressed CBOR bytes.
pub fn encode_snapshot(data: &SnapshotData) -> Result<Vec<u8>, AppError> {
    let mut cbor_buf = Vec::new();
    ciborium::into_writer(data, &mut cbor_buf)
        .map_err(|e| AppError::Snapshot(format!("CBOR encode: {e}")))?;
    let compressed = zstd::encode_all(cbor_buf.as_slice(), 3)
        .map_err(|e| AppError::Snapshot(format!("zstd compress: {e}")))?;
    Ok(compressed)
}

/// Decode zstd-compressed CBOR bytes to SnapshotData.
pub fn decode_snapshot(data: &[u8]) -> Result<SnapshotData, AppError> {
    let decompressed =
        zstd::decode_all(data).map_err(|e| AppError::Snapshot(format!("zstd decompress: {e}")))?;
    let snapshot: SnapshotData = ciborium::from_reader(decompressed.as_slice())
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    if snapshot.schema_version != SCHEMA_VERSION {
        return Err(AppError::Snapshot(format!(
            "unsupported schema version {} (expected {SCHEMA_VERSION})",
            snapshot.schema_version
        )));
    }
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// DB collection helpers
// ---------------------------------------------------------------------------

/// Read all core table rows from the database.
async fn collect_tables(pool: &SqlitePool) -> Result<SnapshotTables, AppError> {
    let blocks: Vec<BlockSnapshot> = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict, conflict_source FROM blocks",
    )
    .fetch_all(pool)
    .await?;

    let block_tags: Vec<BlockTagSnapshot> =
        sqlx::query_as("SELECT block_id, tag_id FROM block_tags")
            .fetch_all(pool)
            .await?;

    let block_properties: Vec<BlockPropertySnapshot> = sqlx::query_as(
        "SELECT block_id, key, value_text, value_num, value_date, value_ref FROM block_properties",
    )
    .fetch_all(pool)
    .await?;

    let block_links: Vec<BlockLinkSnapshot> =
        sqlx::query_as("SELECT source_id, target_id FROM block_links")
            .fetch_all(pool)
            .await?;

    let attachments: Vec<AttachmentSnapshot> = sqlx::query_as(
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at FROM attachments",
    )
    .fetch_all(pool)
    .await?;

    Ok(SnapshotTables {
        blocks,
        block_tags,
        block_properties,
        block_links,
        attachments,
    })
}

/// Compute the op frontier: `device_id → max seq` and the hash of the latest op.
///
/// Returns [`AppError::Snapshot`] if the op_log is empty — a snapshot without
/// any ops to reference is meaningless.
async fn collect_frontier(pool: &SqlitePool) -> Result<(BTreeMap<String, i64>, String), AppError> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT device_id, MAX(seq) as max_seq FROM op_log GROUP BY device_id")
            .fetch_all(pool)
            .await?;

    if rows.is_empty() {
        return Err(AppError::Snapshot(
            "cannot create snapshot: op_log is empty".to_string(),
        ));
    }

    let mut frontier = BTreeMap::new();
    for (device_id, max_seq) in &rows {
        frontier.insert(device_id.clone(), *max_seq);
    }

    // Get the hash of the overall latest op (by created_at DESC, then device_id, seq)
    // Safe to use fetch_one here: we verified above that at least one row exists.
    let latest_hash: (String,) = sqlx::query_as(
        "SELECT hash FROM op_log ORDER BY created_at DESC, device_id DESC, seq DESC LIMIT 1",
    )
    .fetch_one(pool)
    .await?;

    Ok((frontier, latest_hash.0))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a snapshot of all core tables. Crash-safe: pending → write → complete.
/// Returns the snapshot ULID on success.
pub async fn create_snapshot(pool: &SqlitePool, device_id: &str) -> Result<String, AppError> {
    let snapshot_id = crate::ulid::SnapshotId::new().into_string();

    // Collect tables and frontier
    let tables = collect_tables(pool).await?;
    let (up_to_seqs, up_to_hash) = collect_frontier(pool).await?;

    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: device_id.to_string(),
        up_to_seqs,
        up_to_hash: up_to_hash.clone(),
        tables,
    };

    let encoded = encode_snapshot(&data)?;

    // Step 1: INSERT with status='pending'
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
         VALUES (?, 'pending', ?, ?, ?)",
    )
    .bind(&snapshot_id)
    .bind(&up_to_hash)
    .bind(serde_json::to_string(&data.up_to_seqs)?)
    .bind(&encoded)
    .execute(pool)
    .await?;

    // Step 2: UPDATE to 'complete'
    // If we crash before this, boot cleanup deletes the pending row.
    sqlx::query("UPDATE log_snapshots SET status = 'complete' WHERE id = ?")
        .bind(&snapshot_id)
        .execute(pool)
        .await?;

    Ok(snapshot_id)
}

/// Apply a snapshot (RESET path). Wipes all core + cache tables and inserts
/// snapshot data. Caller is responsible for triggering cache rebuilds and FTS
/// optimize after this returns.
pub async fn apply_snapshot(
    pool: &SqlitePool,
    compressed_data: &[u8],
) -> Result<SnapshotData, AppError> {
    let data = decode_snapshot(compressed_data)?;

    // Use a transaction for atomicity
    let mut tx = pool.begin().await?;

    // Wipe all tables (order matters for FK constraints — children first)
    // Cache tables
    sqlx::query("DELETE FROM agenda_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;
    // FTS5
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;
    // Core tables (children before parents due to FK)
    sqlx::query("DELETE FROM block_links")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM block_properties")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM block_tags")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM attachments")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM op_log").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM block_drafts")
        .execute(&mut *tx)
        .await?;
    // blocks last (parent of all FK references)
    sqlx::query("DELETE FROM blocks").execute(&mut *tx).await?;

    // Insert snapshot data
    for b in &data.tables.blocks {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, \
             deleted_at, archived_at, is_conflict, conflict_source) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&b.id)
        .bind(&b.block_type)
        .bind(&b.content)
        .bind(&b.parent_id)
        .bind(b.position)
        .bind(&b.deleted_at)
        .bind(&b.archived_at)
        .bind(b.is_conflict)
        .bind(&b.conflict_source)
        .execute(&mut *tx)
        .await?;
    }

    for bt in &data.tables.block_tags {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&bt.block_id)
            .bind(&bt.tag_id)
            .execute(&mut *tx)
            .await?;
    }

    for bp in &data.tables.block_properties {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&bp.block_id)
        .bind(&bp.key)
        .bind(&bp.value_text)
        .bind(bp.value_num)
        .bind(&bp.value_date)
        .bind(&bp.value_ref)
        .execute(&mut *tx)
        .await?;
    }

    for bl in &data.tables.block_links {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&bl.source_id)
            .bind(&bl.target_id)
            .execute(&mut *tx)
            .await?;
    }

    for a in &data.tables.attachments {
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, \
             fs_path, created_at, deleted_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&a.id)
        .bind(&a.block_id)
        .bind(&a.mime_type)
        .bind(&a.filename)
        .bind(a.size_bytes)
        .bind(&a.fs_path)
        .bind(&a.created_at)
        .bind(&a.deleted_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(data)
}

/// Default retention period for op log compaction (90 days).
pub const DEFAULT_RETENTION_DAYS: u64 = 90;

/// Compact the op log: create a snapshot and purge ops older than `retention_days`.
/// Returns `Some(snapshot_id)` if compaction occurred, `None` if no old ops exist.
pub async fn compact_op_log(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<Option<String>, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_str = cutoff.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    // Check if any ops exist before the cutoff
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE created_at < ?")
        .bind(&cutoff_str)
        .fetch_one(pool)
        .await?;

    if count.0 == 0 {
        return Ok(None);
    }

    // Create snapshot first
    let snapshot_id = create_snapshot(pool, device_id).await?;

    // Purge old ops (only those before the cutoff)
    sqlx::query("DELETE FROM op_log WHERE created_at < ?")
        .bind(&cutoff_str)
        .execute(pool)
        .await?;

    Ok(Some(snapshot_id))
}

/// Fetch the most recent complete snapshot's compressed data.
pub async fn get_latest_snapshot(pool: &SqlitePool) -> Result<Option<(String, Vec<u8>)>, AppError> {
    let row: Option<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT id, data FROM log_snapshots WHERE status = 'complete' ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use sqlx::SqlitePool;
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
                    archived_at: None,
                    is_conflict: 0,
                    conflict_source: None,
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
            block_id: block_id.to_owned(),
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

        assert_eq!(decoded.schema_version, SCHEMA_VERSION);
        assert_eq!(decoded.snapshot_device_id, "device-A");
        assert_eq!(decoded.up_to_hash, "abc123");
        assert_eq!(decoded.up_to_seqs.len(), 2);
        assert_eq!(decoded.up_to_seqs["device-A"], 5);
        assert_eq!(decoded.up_to_seqs["device-B"], 3);

        assert_eq!(decoded.tables.blocks.len(), 1);
        assert_eq!(decoded.tables.blocks[0].id, "block-1");
        assert_eq!(
            decoded.tables.blocks[0].content.as_deref(),
            Some("hello world")
        );

        assert_eq!(decoded.tables.block_tags.len(), 1);
        assert_eq!(decoded.tables.block_tags[0].tag_id, "tag-1");

        assert_eq!(decoded.tables.block_properties.len(), 1);
        assert_eq!(decoded.tables.block_properties[0].key, "due");
        assert_eq!(
            decoded.tables.block_properties[0].value_date.as_deref(),
            Some("2025-01-15")
        );

        assert_eq!(decoded.tables.block_links.len(), 1);
        assert_eq!(decoded.tables.block_links[0].source_id, "block-1");

        assert_eq!(decoded.tables.attachments.len(), 1);
        assert_eq!(decoded.tables.attachments[0].filename, "photo.png");
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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let decoded = decode_snapshot(&encoded).unwrap();

        assert_eq!(decoded.tables.blocks.len(), 0);
        assert_eq!(decoded.tables.block_tags.len(), 0);
        assert_eq!(decoded.tables.block_properties.len(), 0);
        assert_eq!(decoded.tables.block_links.len(), 0);
        assert_eq!(decoded.tables.attachments.len(), 0);
        assert!(decoded.up_to_seqs.is_empty());
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
        assert!(!snapshot_id.is_empty());

        // Read back from log_snapshots
        let (id, data): (String, Vec<u8>) = sqlx::query_as(
            "SELECT id, data FROM log_snapshots WHERE id = ? AND status = 'complete'",
        )
        .bind(&snapshot_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(id, snapshot_id);

        // Decode and verify
        let decoded = decode_snapshot(&data).unwrap();
        assert_eq!(decoded.snapshot_device_id, device_id);
        assert_eq!(decoded.tables.blocks.len(), 1);
        assert_eq!(decoded.tables.blocks[0].id, "block-1");
        assert_eq!(decoded.tables.blocks[0].content.as_deref(), Some("hello"));
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
        let (status,): (String,) = sqlx::query_as("SELECT status FROM log_snapshots WHERE id = ?")
            .bind(&snapshot_id)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(status, "complete");

        // No pending rows should remain
        let (pending_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(pending_count, 0);
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
        let (_, snap_data): (String, Vec<u8>) =
            sqlx::query_as("SELECT id, data FROM log_snapshots WHERE id = ?")
                .bind(&snapshot_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        // Insert additional data that should be wiped by apply
        insert_block(&pool, "block-extra", "extra").await;
        insert_op_at(&pool, device_id, "block-extra", "2025-06-01T00:00:00Z").await;

        // Verify extra data exists
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2, "should have 2 blocks before apply");

        // Apply snapshot (RESET)
        let restored = apply_snapshot(&pool, &snap_data).await.unwrap();

        // Only original block should remain
        let (count_after,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count_after, 1, "should have 1 block after apply");

        let (id,): (String,) = sqlx::query_as("SELECT id FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(id, "block-orig");

        // Op log should be wiped
        let (op_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(op_count, 0, "op_log should be empty after apply");

        // Returned data should match
        assert_eq!(restored.tables.blocks.len(), 1);
        assert_eq!(restored.tables.blocks[0].id, "block-orig");
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
        let simple_encoded = encode_snapshot(&simple_data).unwrap();

        let restored = apply_snapshot(&pool, &simple_encoded).await.unwrap();

        assert_eq!(restored.tables.blocks.len(), 1);
        assert_eq!(restored.tables.blocks[0].id, "blk-A");

        // Verify DB state
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        let (content,): (Option<String>,) =
            sqlx::query_as("SELECT content FROM blocks WHERE id = 'blk-A'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(content.as_deref(), Some("applied content"));

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
        let now = chrono::Utc::now().to_rfc3339();
        insert_op_at(&pool, device_id, "block-1", &now).await;

        // Compact with 90-day retention — all ops are recent
        let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
            .await
            .unwrap();
        assert!(result.is_none(), "should return None when no old ops");

        // No snapshots should have been created
        let (snap_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM log_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(snap_count, 0);
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
        let (snap_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(snap_count, 1);

        // Old ops should be purged
        let (op_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
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
        let now = chrono::Utc::now().to_rfc3339();
        insert_op_at(&pool, device_id, "block-new", &now).await;

        // Compact with 90-day retention
        let result = compact_op_log(&pool, device_id, DEFAULT_RETENTION_DAYS)
            .await
            .unwrap();
        assert!(result.is_some());

        // Only the recent op should remain
        let (op_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(op_count, 1, "recent op should be preserved");

        // Verify it's the recent one
        let (created_at,): (String,) = sqlx::query_as("SELECT created_at FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        // The recent op's timestamp should NOT be the old one
        assert!(!created_at.starts_with("2024-01-01"));
    }

    // =======================================================================
    // 12. get_latest_snapshot_returns_none_when_empty
    // =======================================================================

    #[tokio::test]
    async fn get_latest_snapshot_returns_none_when_empty() {
        let (pool, _dir) = test_pool().await;

        let result = get_latest_snapshot(&pool).await.unwrap();
        assert!(result.is_none());
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
        assert_eq!(latest_id, snap2_id);
        assert_ne!(latest_id, snap1_id);

        // Decode and verify it has the updated content
        let decoded = decode_snapshot(&latest_data).unwrap();
        assert_eq!(decoded.tables.blocks[0].content.as_deref(), Some("v2"));
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
                    archived_at: None,
                    is_conflict: 0,
                    conflict_source: None,
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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let decoded = decode_snapshot(&encoded).unwrap();

        let props = &decoded.tables.block_properties;
        assert_eq!(props.len(), 7);

        // Helper: find property by key
        let find =
            |key: &str| -> &BlockPropertySnapshot { props.iter().find(|p| p.key == key).unwrap() };

        assert_eq!(find("none").value_num, None);
        assert_eq!(find("normal").value_num, Some(42.5));
        assert_eq!(find("zero").value_num, Some(0.0));
        assert_eq!(find("negative").value_num, Some(-1.0e10));
        assert_eq!(find("inf").value_num, Some(f64::INFINITY));
        assert_eq!(find("neg_inf").value_num, Some(f64::NEG_INFINITY));

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
        let now = chrono::Utc::now().to_rfc3339();
        insert_op_at(&pool, "device-B", "block-B2", &now).await;

        // Compact
        let result = compact_op_log(&pool, "device-A", DEFAULT_RETENTION_DAYS)
            .await
            .unwrap();
        assert!(result.is_some(), "should compact when old ops exist");

        // Only device-B's recent op should remain
        let (remaining,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 1, "only the recent op should survive compaction");

        // Verify it's device-B's recent op
        let (dev,): (String,) = sqlx::query_as("SELECT device_id FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dev, "device-B");

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
            },
        };

        let encoded = encode_snapshot(&bad_data).unwrap();
        let result = apply_snapshot(&pool, &encoded).await;
        assert!(
            result.is_err(),
            "FK violation should cause apply_snapshot to fail"
        );
    }
}
