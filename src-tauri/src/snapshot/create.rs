use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

use super::codec::encode_snapshot;
use super::types::*;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// DB collection helpers
// ---------------------------------------------------------------------------

/// Read all core table rows from the database.
///
/// Accepts a `&mut SqliteConnection` (typically from a read transaction) so
/// that all SELECT queries see a consistent point-in-time view of the database.
pub(crate) async fn collect_tables(
    conn: &mut SqliteConnection,
) -> Result<SnapshotTables, AppError> {
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

    let property_definitions: Vec<PropertyDefinitionSnapshot> =
        sqlx::query_as::<_, PropertyDefinitionSnapshot>(
            "SELECT key, value_type, options, created_at FROM property_definitions",
        )
        .fetch_all(&mut *conn)
        .await?;

    let page_aliases: Vec<PageAliasSnapshot> =
        sqlx::query_as::<_, PageAliasSnapshot>("SELECT page_id, alias FROM page_aliases")
            .fetch_all(&mut *conn)
            .await?;

    Ok(SnapshotTables {
        blocks,
        block_tags,
        block_properties,
        block_links,
        attachments,
        property_definitions,
        page_aliases,
    })
}

/// Compute the op frontier: `device_id → max seq` and the hash of the latest op.
///
/// Returns [`AppError::Snapshot`] if the op_log is empty — a snapshot without
/// any ops to reference is meaningless.
pub(crate) async fn collect_frontier(
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

/// Default retention period for op log compaction (90 days).
pub const DEFAULT_RETENTION_DAYS: u64 = 90;

/// Compact the op log: create a snapshot and purge ops older than `retention_days`.
/// Returns `Some(snapshot_id)` if compaction occurred, `None` if no old ops exist.
///
/// The work is split into three phases to minimise the time the exclusive
/// write-lock is held (PERF-10a):
///
/// 1. **Read phase** — a DEFERRED read transaction collects all table rows
///    and the op frontier (`up_to_seqs`).  No write lock is acquired.
/// 2. **Encode phase** — CBOR + zstd compression runs outside any
///    transaction (pure computation).
/// 3. **Write phase** — a brief `BEGIN IMMEDIATE` transaction inserts the
///    snapshot row, deletes old ops, and cleans up old snapshots.
///
/// **Stale-read safety**: between phases 1 and 3 new ops may arrive.  The
/// DELETE in phase 3 is bounded by *both* `created_at < cutoff` *and*
/// `seq <= up_to_seqs[device_id]`, so ops that were not yet visible during
/// the read phase can never be deleted.
///
/// MAINT-21: instrumented with a `compact_op_log` span that mirrors the
/// `#[instrument]` wrapper on the Tauri command in `commands/compaction.rs`,
/// so the `retention_days`, `eligible_ops`, `ops_deleted`, and timing log
/// lines emitted from this function all share a common span prefix.
#[tracing::instrument(skip(pool), err)]
pub async fn compact_op_log(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<Option<String>, AppError> {
    tracing::info!(retention_days, "compaction starting");
    let start = std::time::Instant::now();

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days.cast_signed());
    // Use to_rfc3339_opts with millis + Z-suffix for consistent comparison
    // with op_log.created_at timestamps (F03).
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // ── Phase 1: Read (DEFERRED read transaction, no write lock) ─────
    // A DEFERRED tx acquires a read-lock on the first SELECT and holds it
    // until commit, giving us a consistent point-in-time view.
    let mut read_tx = pool.begin().await?;

    // Check if any ops exist before the cutoff
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(&mut *read_tx)
    .await?;

    tracing::debug!(eligible_ops = count, "compaction eligible ops identified");

    if count == 0 {
        read_tx.commit().await?;
        tracing::info!(retention_days, "compaction: no eligible ops, nothing to do");
        return Ok(None);
    }

    let snapshot_id = crate::ulid::SnapshotId::new().into_string();

    // Collect tables and frontier within this read transaction for consistency.
    let tables = collect_tables(&mut read_tx).await?;
    let (up_to_seqs, up_to_hash) = collect_frontier(&mut read_tx).await?;

    read_tx.commit().await?;

    // ── Phase 2: Encode (pure computation, no DB) ────────────────────
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: device_id.to_string(),
        up_to_seqs,
        up_to_hash: up_to_hash.clone(),
        tables,
    };

    let encoded = encode_snapshot(&data)?;

    // ── Phase 3: Write (brief BEGIN IMMEDIATE transaction) ───────────
    // Only the INSERT, UPDATE, DELETE, and cleanup happen under the
    // exclusive write lock.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Step 1: INSERT with status='pending'
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
         VALUES (?, 'pending', ?, ?, ?)",
    )
    .bind(&snapshot_id)
    .bind(&up_to_hash)
    .bind(serde_json::to_string(&data.up_to_seqs)?)
    .bind(&encoded)
    .execute(&mut *tx)
    .await?;

    // Step 2: UPDATE to 'complete'
    sqlx::query("UPDATE log_snapshots SET status = 'complete' WHERE id = ?")
        .bind(&snapshot_id)
        .execute(&mut *tx)
        .await?;

    // Purge old ops: bounded by BOTH the time cutoff AND the snapshot
    // frontier.  The seq guard ensures that ops written after the Phase 1
    // read (which would have seq > up_to_seqs[device]) are never deleted,
    // even if their created_at happens to be before the cutoff.
    let mut deleted_count: u64 = 0;
    for (dev_id, max_seq) in &data.up_to_seqs {
        let res = sqlx::query(
            "DELETE FROM op_log WHERE created_at < ?1 AND device_id = ?2 AND seq <= ?3",
        )
        .bind(&cutoff_str)
        .bind(dev_id)
        .bind(max_seq)
        .execute(&mut *tx)
        .await?;
        deleted_count += res.rows_affected();
    }

    // Cleanup old snapshots (inlined to stay within this transaction)
    let keep: i64 = 3;
    sqlx::query(
        "DELETE FROM log_snapshots WHERE status = 'pending' \
         OR id NOT IN \
         (SELECT id FROM log_snapshots WHERE status = 'complete' \
          ORDER BY id DESC LIMIT ?1)",
    )
    .bind(keep)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        snapshot_id = %snapshot_id,
        ops_deleted = deleted_count,
        snapshot_bytes = encoded.len(),
        duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        "compaction completed"
    );

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
    // keep is a small configuration value (typically < 100); safe to cast
    #[allow(clippy::cast_possible_wrap)]
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
