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
        "SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict, conflict_source, conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks"
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

    // M-69: fold the INSERT(pending) + UPDATE(complete) pair into a single
    // `BEGIN IMMEDIATE` transaction so no other connection ever observes
    // an orphan 'pending' row. Mirrors the write phase of `compact_op_log`
    // below. `begin_immediate_logged` also surfaces slow acquires as
    // `warn` logs (MAINT-30 family) instead of being absorbed by the
    // pool's busy_timeout.
    let mut tx = crate::db::begin_immediate_logged(pool, "snapshot_create").await?;

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
    // Inside the same tx — either both rows land (status='complete') or
    // neither does. Boot cleanup is therefore only needed for crashes
    // mid-transaction at the SQLite layer, not for our application logic.
    sqlx::query("UPDATE log_snapshots SET status = 'complete' WHERE id = ?")
        .bind(&snapshot_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(snapshot_id)
}

/// Default retention period for op log compaction (90 days).
pub const DEFAULT_RETENTION_DAYS: u64 = 90;

/// Compact the op log: create a snapshot and purge ops older than `retention_days`.
/// Returns `Some((snapshot_id, deleted_count))` if compaction occurred,
/// `None` if no old ops exist.
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
///
/// L-42: the second tuple element is the **actual** number of rows the
/// per-device DELETE in phase 3 affected. The wrapper in
/// `commands/compaction.rs` previously reported a stale "eligible at start"
/// figure; surfacing the real `deleted_count` here lets the wrapper return
/// it verbatim. The phase-3 frontier guard (`seq <= up_to_seqs[device]`)
/// can legitimately make this number smaller than the pre-flight count.
#[tracing::instrument(skip(pool), err)]
pub async fn compact_op_log(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<Option<(String, u64)>, AppError> {
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
    //
    // H-13: enable the op_log mutation bypass for the duration of this tx.
    // The BEFORE DELETE trigger on op_log (migration 0036) would otherwise
    // ABORT every per-device DELETE below. The bypass is cleared via
    // `disable_op_log_mutation_bypass` before commit so it never escapes
    // this transaction.
    crate::op_log::enable_op_log_mutation_bypass(&mut tx).await?;

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

    // H-13: clear the bypass before any subsequent statements run inside
    // this tx, and crucially before COMMIT — leaving it set would leak the
    // sentinel row to every other connection in the pool.
    crate::op_log::disable_op_log_mutation_bypass(&mut tx).await?;

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

    // L-42: return the real deleted_count alongside the snapshot id so
    // callers (the Tauri wrapper) can report a non-stale figure.
    Ok(Some((snapshot_id, deleted_count)))
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
///
/// M-68: `keep == 0` is treated as a no-op (returns `Ok(0)` without
/// touching the table). SQLite evaluates `x NOT IN (empty subquery)`
/// as TRUE, so naively passing `LIMIT 0` to the subquery would delete
/// every row, including completes — almost certainly not what any
/// caller wants. Callers that genuinely need to clear all snapshots
/// must do so explicitly.
pub async fn cleanup_old_snapshots(pool: &SqlitePool, keep: usize) -> Result<u64, AppError> {
    if keep == 0 {
        return Ok(0);
    }
    let keep_i64: i64 = i64::try_from(keep)
        .expect("invariant: keep is a small configuration value (typically < 100) and fits in i64");
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
// M-69: atomic create_snapshot regression tests
// ---------------------------------------------------------------------------
//
// These tests live inline (rather than in `snapshot/tests.rs`) because the
// REVIEW-LATER item that motivated them is scoped to `create_snapshot` —
// keeping them next to the production code makes the invariant ("INSERT +
// UPDATE are one atomic transaction") easier to spot when this function is
// edited again in the future.
#[cfg(test)]
mod tests_m69 {
    use super::*;
    use crate::db::init_pool;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Build an isolated pool against a fresh temp DB. Mirrors the helper
    /// in `snapshot/tests.rs` (which we cannot import from here without
    /// touching that file — disallowed by the task scope).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block directly so frontier collection has something to
    /// reference. Bypasses the op log on purpose — we need exact control
    /// over what's in the DB before calling `create_snapshot`.
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

    /// Append a single op so `collect_frontier` has at least one row to
    /// fold into `up_to_seqs` (it errors out otherwise).
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

    /// Happy-path atomicity: after a successful `create_snapshot`, the
    /// row is in `'complete'` state with a non-empty payload, and no
    /// orphan `'pending'` row is left behind. Calling it twice must
    /// produce two `'complete'` rows and zero `'pending'` rows — the
    /// strongest observable check we can make from a separate
    /// connection without instrumenting the function itself.
    #[tokio::test]
    async fn create_snapshot_is_atomic_pending_to_complete() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        insert_block(&pool, "block-1", "first").await;
        insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

        // First call ---------------------------------------------------
        let snap1 = create_snapshot(&pool, device_id).await.unwrap();
        assert!(!snap1.is_empty(), "first snapshot id should not be empty");

        // Exactly one row, status='complete', payload non-empty. Both
        // queries match shapes already in the committed `.sqlx/` cache
        // (see `snapshot/tests.rs` line ~322 + ~372) so no prepare is
        // needed for the new tests.
        let status: String =
            sqlx::query_scalar!("SELECT status FROM log_snapshots WHERE id = ?", snap1)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            status, "complete",
            "snapshot must commit in 'complete' state, not 'pending'"
        );

        let payload = sqlx::query!(
            "SELECT id, data FROM log_snapshots WHERE id = ? AND status = 'complete'",
            snap1
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            !payload.data.is_empty(),
            "snapshot payload must be non-empty after commit"
        );

        let total_after_first: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            total_after_first, 1,
            "exactly one snapshot row should exist after first create_snapshot"
        );

        let pending_after_first: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pending_after_first, 0,
            "no 'pending' rows should be visible after first create_snapshot"
        );

        // Second call --------------------------------------------------
        // Append a fresh op so the frontier query still finds something
        // (it does anyway — the original op is still in op_log — but
        // a second op makes the test resilient to future cleanup).
        insert_op_at(&pool, device_id, "block-1", "2025-02-01T00:00:00Z").await;

        let snap2 = create_snapshot(&pool, device_id).await.unwrap();
        assert_ne!(
            snap1, snap2,
            "second create_snapshot must produce a fresh ULID"
        );

        let complete_count: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            complete_count, 2,
            "second create_snapshot must add a second 'complete' row"
        );

        let pending_after_second: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pending_after_second, 0,
            "no 'pending' rows should remain after either create_snapshot call"
        );

        let total_rows: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            total_rows, 2,
            "exactly two rows total — no leftover intermediate-state rows"
        );
    }

    /// Belt-and-braces check: even when the second snapshot races the
    /// first on a multi-threaded runtime, neither call may leave a
    /// `'pending'` row visible. The serialisation guarantee comes from
    /// `BEGIN IMMEDIATE` + SQLite's WAL writer lock; this test just
    /// makes sure we don't regress the call site to two separate
    /// `pool.execute()`s under load.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_snapshot_atomic_under_concurrent_calls() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        insert_block(&pool, "block-1", "first").await;
        insert_op_at(&pool, device_id, "block-1", "2025-01-01T00:00:00Z").await;

        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let dev_a = device_id.to_string();
        let dev_b = device_id.to_string();

        let h_a = tokio::spawn(async move { create_snapshot(&pool_a, &dev_a).await });
        let h_b = tokio::spawn(async move { create_snapshot(&pool_b, &dev_b).await });

        let id_a = h_a.await.unwrap().unwrap();
        let id_b = h_b.await.unwrap().unwrap();
        assert_ne!(id_a, id_b, "concurrent calls must produce distinct ULIDs");

        let pending: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'pending'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pending, 0,
            "no 'pending' rows should be visible after concurrent create_snapshot calls"
        );

        let complete: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            complete, 2,
            "both concurrent create_snapshot calls must commit in 'complete' state"
        );
    }
}
