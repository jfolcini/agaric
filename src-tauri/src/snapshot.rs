//! Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction.
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
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

const SCHEMA_VERSION: u32 = 2;

/// Maximum number of SQL bind parameters per statement.
/// SQLite default is 999 (conservative; 32766 since 3.32).
const MAX_SQL_PARAMS: usize = 999;

// ---------------------------------------------------------------------------
// Row types (CBOR + DB round-trip)
// ---------------------------------------------------------------------------

/// A single block row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockSnapshot {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub is_conflict: i64,
    pub conflict_source: Option<String>,
    #[serde(default)]
    pub todo_state: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub scheduled_date: Option<String>,
}

/// A block–tag association captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockTagSnapshot {
    pub block_id: String,
    pub tag_id: String,
}

/// A block property row captured in a snapshot (key–value with typed values).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockPropertySnapshot {
    pub block_id: String,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

/// A block-to-block link captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockLinkSnapshot {
    pub source_id: String,
    pub target_id: String,
}

/// A file attachment row captured in a snapshot.
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

/// All core tables bundled together for snapshot serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotTables {
    pub blocks: Vec<BlockSnapshot>,
    pub block_tags: Vec<BlockTagSnapshot>,
    pub block_properties: Vec<BlockPropertySnapshot>,
    pub block_links: Vec<BlockLinkSnapshot>,
    pub attachments: Vec<AttachmentSnapshot>,
}

/// Complete snapshot: schema version, op frontier, and all table data.
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
#[must_use = "encoded bytes must be stored or transmitted"]
pub fn encode_snapshot(data: &SnapshotData) -> Result<Vec<u8>, AppError> {
    let mut cbor_buf = Vec::new();
    ciborium::into_writer(data, &mut cbor_buf)
        .map_err(|e| AppError::Snapshot(format!("CBOR encode: {e}")))?;
    let compressed = zstd::encode_all(cbor_buf.as_slice(), 3)
        .map_err(|e| AppError::Snapshot(format!("zstd compress: {e}")))?;
    Ok(compressed)
}

/// Decode zstd-compressed CBOR bytes to SnapshotData.
#[must_use = "decoded snapshot data must be applied or inspected"]
pub fn decode_snapshot(data: &[u8]) -> Result<SnapshotData, AppError> {
    let decompressed =
        zstd::decode_all(data).map_err(|e| AppError::Snapshot(format!("zstd decompress: {e}")))?;
    let snapshot: SnapshotData = ciborium::from_reader(decompressed.as_slice())
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    if snapshot.schema_version < 1 || snapshot.schema_version > SCHEMA_VERSION {
        return Err(AppError::Snapshot(format!(
            "unsupported schema version {} (expected 1..={SCHEMA_VERSION})",
            snapshot.schema_version
        )));
    }
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// DB collection helpers
// ---------------------------------------------------------------------------

/// Read all core table rows from the database.
///
/// Accepts a `&mut SqliteConnection` (typically from a read transaction) so
/// that all SELECT queries see a consistent point-in-time view of the database.
async fn collect_tables(conn: &mut SqliteConnection) -> Result<SnapshotTables, AppError> {
    let blocks: Vec<BlockSnapshot> = sqlx::query_as!(
        BlockSnapshot,
        "SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict, conflict_source, todo_state, priority, due_date, scheduled_date FROM blocks"
    )
    .fetch_all(&mut *conn)
    .await?;

    let block_tags: Vec<BlockTagSnapshot> =
        sqlx::query_as!(BlockTagSnapshot, "SELECT block_id, tag_id FROM block_tags")
            .fetch_all(&mut *conn)
            .await?;

    let block_properties: Vec<BlockPropertySnapshot> = sqlx::query_as!(
        BlockPropertySnapshot,
        "SELECT block_id, key, value_text, value_num, value_date, value_ref FROM block_properties"
    )
    .fetch_all(&mut *conn)
    .await?;

    let block_links: Vec<BlockLinkSnapshot> = sqlx::query_as!(
        BlockLinkSnapshot,
        "SELECT source_id, target_id FROM block_links"
    )
    .fetch_all(&mut *conn)
    .await?;

    let attachments: Vec<AttachmentSnapshot> = sqlx::query_as!(
        AttachmentSnapshot,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at FROM attachments"
    )
    .fetch_all(&mut *conn)
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
async fn collect_frontier(
    conn: &mut SqliteConnection,
) -> Result<(BTreeMap<String, i64>, String), AppError> {
    let rows = sqlx::query!("SELECT device_id, MAX(seq) as max_seq FROM op_log GROUP BY device_id")
        .fetch_all(&mut *conn)
        .await?;

    if rows.is_empty() {
        return Err(AppError::Snapshot(
            "cannot create snapshot: op_log is empty".to_string(),
        ));
    }

    let mut frontier = BTreeMap::new();
    for row in &rows {
        // device_id is NOT NULL but sqlx infers Option in GROUP BY context
        if let Some(ref device_id) = row.device_id {
            frontier.insert(device_id.clone(), row.max_seq);
        }
    }

    // Get the hash of the overall latest op (by created_at DESC, then device_id, seq)
    // Safe to use fetch_one here: we verified above that at least one row exists.
    let latest_hash: String = sqlx::query_scalar!(
        "SELECT hash FROM op_log ORDER BY created_at DESC, device_id DESC, seq DESC LIMIT 1"
    )
    .fetch_one(&mut *conn)
    .await?;

    Ok((frontier, latest_hash))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a snapshot of all core tables. Crash-safe: pending → write → complete.
/// Returns the snapshot ULID on success.
///
/// Table and frontier collection is wrapped in a **read transaction** (F01) so
/// that all SELECT queries see a consistent point-in-time view, even if
/// concurrent writes occur.
pub async fn create_snapshot(pool: &SqlitePool, device_id: &str) -> Result<String, AppError> {
    let snapshot_id = crate::ulid::SnapshotId::new().into_string();

    // F01: Read transaction for consistent snapshot collection.
    // A DEFERRED tx is fine here — it only needs read isolation. SQLite
    // promotes to a read-lock on the first SELECT and holds it until commit.
    let mut read_tx = pool.begin().await?;
    let tables = collect_tables(&mut read_tx).await?;
    let (up_to_seqs, up_to_hash) = collect_frontier(&mut read_tx).await?;
    read_tx.commit().await?;

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
///
/// Uses `BEGIN IMMEDIATE` (F04) to acquire the write lock upfront and
/// `PRAGMA defer_foreign_keys = ON` (F02) so that block inserts succeed
/// regardless of parent/child ordering in the snapshot data.
pub async fn apply_snapshot(
    pool: &SqlitePool,
    compressed_data: &[u8],
) -> Result<SnapshotData, AppError> {
    let data = decode_snapshot(compressed_data)?;

    // F04: BEGIN IMMEDIATE — acquire write lock upfront (consistent with
    // every other write path in the codebase).
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // F02: Defer FK checks until COMMIT — snapshot block order is arbitrary,
    // so a child block may be inserted before its parent. All FK references
    // will be satisfied by commit time.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

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

    // Insert snapshot data using multi-row INSERT batches.
    // Each table uses a chunk size derived from MAX_SQL_PARAMS / num_columns
    // to stay within SQLite's bind-parameter limit.

    // -- blocks (12 columns) --
    const BLOCKS_COLS: usize = 12;
    const BLOCKS_CHUNK: usize = MAX_SQL_PARAMS / BLOCKS_COLS; // 83
    for chunk in data.tables.blocks.chunks(BLOCKS_CHUNK) {
        let placeholders: Vec<&str> = chunk
            .iter()
            .map(|_| "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .collect();
        let sql = format!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_source, \
             todo_state, priority, due_date, scheduled_date) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for b in chunk {
            query = query
                .bind(&b.id)
                .bind(&b.block_type)
                .bind(&b.content)
                .bind(&b.parent_id)
                .bind(b.position)
                .bind(&b.deleted_at)
                .bind(b.is_conflict)
                .bind(&b.conflict_source)
                .bind(&b.todo_state)
                .bind(&b.priority)
                .bind(&b.due_date)
                .bind(&b.scheduled_date);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_tags (2 columns) --
    const BLOCK_TAGS_COLS: usize = 2;
    const BLOCK_TAGS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_TAGS_COLS; // 499
    for chunk in data.tables.block_tags.chunks(BLOCK_TAGS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bt in chunk {
            query = query.bind(&bt.block_id).bind(&bt.tag_id);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_properties (6 columns) --
    const BLOCK_PROPS_COLS: usize = 6;
    const BLOCK_PROPS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_PROPS_COLS; // 166
    for chunk in data.tables.block_properties.chunks(BLOCK_PROPS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, \
             value_date, value_ref) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bp in chunk {
            query = query
                .bind(&bp.block_id)
                .bind(&bp.key)
                .bind(&bp.value_text)
                .bind(bp.value_num)
                .bind(&bp.value_date)
                .bind(&bp.value_ref);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_links (2 columns) --
    const BLOCK_LINKS_COLS: usize = 2;
    const BLOCK_LINKS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_LINKS_COLS; // 499
    for chunk in data.tables.block_links.chunks(BLOCK_LINKS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_links (source_id, target_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bl in chunk {
            query = query.bind(&bl.source_id).bind(&bl.target_id);
        }
        query.execute(&mut *tx).await?;
    }

    // -- attachments (8 columns) --
    const ATTACH_COLS: usize = 8;
    const ATTACH_CHUNK: usize = MAX_SQL_PARAMS / ATTACH_COLS; // 124
    for chunk in data.tables.attachments.chunks(ATTACH_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, \
             fs_path, created_at, deleted_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for a in chunk {
            query = query
                .bind(&a.id)
                .bind(&a.block_id)
                .bind(&a.mime_type)
                .bind(&a.filename)
                .bind(a.size_bytes)
                .bind(&a.fs_path)
                .bind(&a.created_at)
                .bind(&a.deleted_at);
        }
        query.execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(data)
}

/// Default retention period for op log compaction (90 days).
pub const DEFAULT_RETENTION_DAYS: u64 = 90;

/// Compact the op log: create a snapshot and purge ops older than `retention_days`.
/// Returns `Some(snapshot_id)` if compaction occurred, `None` if no old ops exist.
///
/// # Safety note
///
/// This function does NOT wrap its steps in an explicit transaction.
/// Currently it relies on serialisation from the sync daemon's task
/// scheduling.  With the write pool at `max_connections(2)`, concurrent
/// calls could interleave between the count check, snapshot creation,
/// and op purge.  If compaction is ever exposed as a user-facing command
/// or run from a concurrent background task, wrap the body in
/// `BEGIN IMMEDIATE` to make the atomicity explicit.
pub async fn compact_op_log(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<Option<String>, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    // Use to_rfc3339_opts with millis + Z-suffix for consistent comparison
    // with op_log.created_at timestamps (F03).
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // Check if any ops exist before the cutoff
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(pool)
    .await?;

    if count == 0 {
        return Ok(None);
    }

    // Create snapshot first
    let snapshot_id = create_snapshot(pool, device_id).await?;

    // Purge old ops (only those before the cutoff)
    sqlx::query("DELETE FROM op_log WHERE created_at < ?")
        .bind(&cutoff_str)
        .execute(pool)
        .await?;

    cleanup_old_snapshots(pool, 3).await?;

    Ok(Some(snapshot_id))
}

/// Fetch the most recent complete snapshot's compressed data.
pub async fn get_latest_snapshot(pool: &SqlitePool) -> Result<Option<(String, Vec<u8>)>, AppError> {
    let row = sqlx::query!(
        "SELECT id, data FROM log_snapshots WHERE status = 'complete' ORDER BY id DESC LIMIT 1"
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.id, r.data)))
}

/// Delete old complete snapshots, keeping only the `keep` most recent.
/// Also deletes any lingering 'pending' snapshots (crash leftovers).
/// Returns the number of deleted rows.
pub async fn cleanup_old_snapshots(pool: &SqlitePool, keep: usize) -> Result<u64, AppError> {
    let keep_i64 = keep as i64;
    let result = sqlx::query(
        "DELETE FROM log_snapshots WHERE status = 'pending' \
         OR id NOT IN \
         (SELECT id FROM log_snapshots WHERE status = 'complete' \
          ORDER BY id DESC LIMIT ?1)",
    )
    .bind(keep_i64)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
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
    use crate::ulid::BlockId;
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
        let row = sqlx::query!(
            "SELECT id, data FROM log_snapshots WHERE id = ? AND status = 'complete'",
            snapshot_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let (id, data) = (row.id, row.data);

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
        let status: String =
            sqlx::query_scalar!("SELECT status FROM log_snapshots WHERE id = ?", snapshot_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(status, "complete");

        // No pending rows should remain
        let pending_count: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
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
        assert_eq!(id, "block-orig");

        // Op log should be wiped
        let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
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
            },
        };
        let simple_encoded = encode_snapshot(&simple_data).unwrap();

        let restored = apply_snapshot(&pool, &simple_encoded).await.unwrap();

        assert_eq!(restored.tables.blocks.len(), 1);
        assert_eq!(restored.tables.blocks[0].id, "blk-A");

        // Verify DB state
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        let content: Option<String> =
            sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'blk-A'")
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
        let snap_count: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(snap_count, 1);

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
        assert!(result.is_some());

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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let restored = apply_snapshot(&pool, &encoded).await.unwrap();

        // Verify all tables populated
        assert_eq!(restored.tables.blocks.len(), 3);
        assert_eq!(restored.tables.block_tags.len(), 1);
        assert_eq!(restored.tables.block_properties.len(), 1);
        assert_eq!(restored.tables.block_links.len(), 1);
        assert_eq!(restored.tables.attachments.len(), 1);

        // Verify DB state for each table
        let blk_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blk_count, 3);

        let tag_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tag_count, 1);

        let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(prop_count, 1);

        let link_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_links")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(link_count, 1);

        let att_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(att_count, 1);

        // Verify specific content
        let tag_id: String =
            sqlx::query_scalar!("SELECT tag_id FROM block_tags WHERE block_id = 'blk-parent'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tag_id, "tag-urgent");

        let due: Option<String> = sqlx::query_scalar!(
            "SELECT value_date FROM block_properties WHERE block_id = 'blk-child'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(due.as_deref(), Some("2025-06-01"));
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
        assert_eq!(snap_count_1, 1);

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
        assert_eq!(snap_count_2, 1);
    }

    // =======================================================================
    // 20. compact_op_log_timestamp_format_consistency (F03)
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
        assert_eq!(latest_id, snap3);
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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let decoded = decode_snapshot(&encoded).unwrap();

        assert_eq!(decoded.schema_version, SCHEMA_VERSION);
        assert_eq!(decoded.snapshot_device_id, "dev-empty");
        assert_eq!(decoded.up_to_hash, "empty-hash");
        assert!(decoded.up_to_seqs.is_empty(), "up_to_seqs should be empty");
        assert!(decoded.tables.blocks.is_empty());
        assert!(decoded.tables.block_tags.is_empty());
        assert!(decoded.tables.block_properties.is_empty());
        assert!(decoded.tables.block_links.is_empty());
        assert!(decoded.tables.attachments.is_empty());
    }

    // =======================================================================
    // 23. large_text_field_round_trip (REVIEW-LATER #56)
    // =======================================================================

    /// Snapshot with very large text fields (>10KB) round-trips correctly
    /// through zstd compression + CBOR encoding.
    #[test]
    fn large_text_field_round_trip() {
        let large_content = "x".repeat(15_000); // 15KB
        assert!(large_content.len() > 10_000);

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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let decoded = decode_snapshot(&encoded).unwrap();

        assert_eq!(decoded.tables.blocks.len(), 1);
        assert_eq!(
            decoded.tables.blocks[0].content.as_deref(),
            Some(large_content.as_str())
        );
        assert_eq!(decoded.tables.block_properties.len(), 1);
        assert_eq!(
            decoded.tables.block_properties[0]
                .value_text
                .as_ref()
                .unwrap()
                .len(),
            12_000,
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
        assert!(prop.value_text.is_none());
        assert!(prop.value_num.is_none());
        assert!(prop.value_date.is_none());
        assert!(prop.value_ref.is_none());
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
        assert_eq!(decoded.schema_version, re_decoded.schema_version);
        assert_eq!(decoded.snapshot_device_id, re_decoded.snapshot_device_id);
        assert_eq!(decoded.up_to_hash, re_decoded.up_to_hash);
        assert_eq!(decoded.up_to_seqs, re_decoded.up_to_seqs);

        // Verify table lengths
        assert_eq!(decoded.tables.blocks.len(), re_decoded.tables.blocks.len());
        assert_eq!(
            decoded.tables.block_tags.len(),
            re_decoded.tables.block_tags.len()
        );
        assert_eq!(
            decoded.tables.block_properties.len(),
            re_decoded.tables.block_properties.len()
        );
        assert_eq!(
            decoded.tables.block_links.len(),
            re_decoded.tables.block_links.len()
        );
        assert_eq!(
            decoded.tables.attachments.len(),
            re_decoded.tables.attachments.len()
        );

        // Verify individual fields in blocks
        for (a, b) in decoded
            .tables
            .blocks
            .iter()
            .zip(re_decoded.tables.blocks.iter())
        {
            assert_eq!(a.id, b.id);
            assert_eq!(a.block_type, b.block_type);
            assert_eq!(a.content, b.content);
            assert_eq!(a.parent_id, b.parent_id);
            assert_eq!(a.position, b.position);
            assert_eq!(a.deleted_at, b.deleted_at);
            assert_eq!(a.is_conflict, b.is_conflict);
            assert_eq!(a.conflict_source, b.conflict_source);
        }

        // Verify attachments round-trip
        for (a, b) in decoded
            .tables
            .attachments
            .iter()
            .zip(re_decoded.tables.attachments.iter())
        {
            assert_eq!(a.id, b.id);
            assert_eq!(a.block_id, b.block_id);
            assert_eq!(a.mime_type, b.mime_type);
            assert_eq!(a.filename, b.filename);
            assert_eq!(a.size_bytes, b.size_bytes);
            assert_eq!(a.fs_path, b.fs_path);
            assert_eq!(a.created_at, b.created_at);
            assert_eq!(a.deleted_at, b.deleted_at);
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
        assert_eq!(decoded.tables.block_tags[0].block_id, "blk-1");
        assert_eq!(decoded.tables.block_tags[0].tag_id, "tag-1");

        assert_eq!(
            decoded.tables.block_properties.len(),
            1,
            "should capture block_properties"
        );
        assert_eq!(decoded.tables.block_properties[0].block_id, "blk-1");
        assert_eq!(decoded.tables.block_properties[0].key, "status");
        assert_eq!(
            decoded.tables.block_properties[0].value_text.as_deref(),
            Some("active")
        );

        assert_eq!(
            decoded.tables.block_links.len(),
            1,
            "should capture block_links"
        );
        assert_eq!(decoded.tables.block_links[0].source_id, "blk-1");
        assert_eq!(decoded.tables.block_links[0].target_id, "blk-2");

        assert_eq!(
            decoded.tables.attachments.len(),
            1,
            "should capture attachments"
        );
        assert_eq!(decoded.tables.attachments[0].filename, "photo.png");
        assert_eq!(decoded.tables.attachments[0].block_id, "blk-1");
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
        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.tables.blocks.len(), 1);
        let b = &decoded.tables.blocks[0];
        assert_eq!(b.id, "b1");
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
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let decoded = decode_snapshot(&encoded).unwrap();

        assert_eq!(decoded.schema_version, SCHEMA_VERSION);
        let b = &decoded.tables.blocks[0];
        assert_eq!(b.todo_state, Some("TODO".to_string()));
        assert_eq!(b.priority, Some("2".to_string()));
        assert_eq!(b.due_date, Some("2026-04-15".to_string()));
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

    #[test]
    fn snapshot_version_3_rejected() {
        let mut up_to_seqs = BTreeMap::new();
        up_to_seqs.insert("dev".to_string(), 1);

        let data = SnapshotData {
            schema_version: 3,
            snapshot_device_id: "dev".to_string(),
            up_to_seqs,
            up_to_hash: "h".to_string(),
            tables: SnapshotTables {
                blocks: vec![],
                block_tags: vec![],
                block_properties: vec![],
                block_links: vec![],
                attachments: vec![],
            },
        };

        let encoded = encode_snapshot(&data).unwrap();
        let result = decode_snapshot(&encoded);
        assert!(result.is_err(), "schema_version 3 should be rejected");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("unsupported schema version"),
            "error should mention unsupported version, got: {err_msg}"
        );
    }
}
