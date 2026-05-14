//! C-2b: boot-time op-log replay for unmaterialized ops.
//!
//! On boot, walk `op_log WHERE seq > materialized_through_seq` and
//! enqueue each record as an `ApplyOp` task on the materializer's
//! foreground queue. The materializer applies them in order, advancing
//! the cursor as it goes. If the same crash recurs mid-replay, the next
//! boot picks up where this one stopped.
//!
//! Idempotency: every op handler in `materializer/handlers.rs::apply_op_tx`
//! already uses `INSERT OR IGNORE` / UPSERT semantics, so re-applying an
//! op that PARTIALLY succeeded (e.g., the apply landed but the cursor
//! advance got rolled back by a crash before commit) is a no-op for
//! primary state. The cursor's `MAX` semantics make the cursor advance
//! itself idempotent.
//!
//! Ordering: ops are walked in `(seq ASC, device_id ASC)` order so a
//! parent → child causal pair from the same device is always replayed
//! parent-first. Cross-device causal ordering during replay is best-
//! effort — the same idempotency guarantees that protect normal sync
//! ingest also cover replay.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::op_log::OpRecord;

/// Chunk size for the op_log read pass. Bounded so a multi-thousand-op
/// replay does not load the entire op log into memory at once. The
/// foreground queue is drained at the end via a Barrier task, so the
/// per-chunk depth never exceeds `FOREGROUND_CAPACITY`.
const REPLAY_CHUNK_SIZE: i64 = 200;

/// Summary of a single replay pass returned to the caller.
///
/// `ops_replayed` counts every `ApplyOp` enqueued onto the foreground
/// queue. `replay_errors` accumulates non-fatal errors (e.g. a single
/// op failed to enqueue) — fatal errors propagate via `Result::Err`.
/// `ops_skipped_idempotent` is reserved for a future per-record
/// already-applied detection; today it is always zero because
/// per-record idempotency is handled inside `apply_op_tx` itself
/// (every handler is `INSERT OR IGNORE` / UPSERT) rather than via a
/// pre-check from this module.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplayReport {
    /// Number of ops enqueued on the foreground queue for replay.
    pub ops_replayed: u64,
    /// Reserved for future use (per-record already-applied detection).
    /// Always 0 today — see module-level docs for rationale.
    pub ops_skipped_idempotent: u64,
    /// Non-fatal errors during replay (each entry: `"<context>: <err>"`).
    pub replay_errors: Vec<String>,
}

/// Read the current `materialized_through_seq` from the cursor table.
///
/// Migration `0040` seeds the row at boot, so this lookup always
/// returns a value (defaulting to 0 on a fresh install).
///
/// # SQL-review H-4 — boot-time sanity check
///
/// The cursor advance path (`materializer/handlers.rs::advance_apply_cursor`)
/// is gated by `MAX(materialized_through_seq, ?)` and only ever bumps the
/// cursor up to `op_log.seq` values that exist. Therefore the invariant
/// `cursor <= MAX(op_log.seq)` holds for every successful apply. If at
/// boot we observe `cursor > MAX(op_log.seq)`, the cursor is in an
/// impossible state — most likely a hand-edit, a partial restore, or a
/// rolled-back op_log without a matching rolled-back cursor. Left alone,
/// the next `replay_unmaterialized_ops` walk would silently do nothing
/// and any unmaterialized ops would never be applied. Worse, an
/// adversarially corrupted *under*-shoot value (e.g. 0) would trigger a
/// full op_log replay at boot — not data loss, but a multi-second
/// boot-stall.
///
/// This function therefore performs one cheap impossible-state check on
/// the read path: if `cursor > MAX(op_log.seq)` we reset the cursor to
/// `MAX(op_log.seq)` (or 0 if the log is empty), log a warning, and
/// return the corrected value. We deliberately do NOT try to detect
/// under-shoot corruption: there is no surviving "expected cursor"
/// signal to compare against (the cursor row has no timestamp-of-last-op
/// field), and `MAX(materialized_through_seq, ?)` per-op idempotency
/// already prevents an under-shoot from causing incorrect state — only
/// the wasted boot time.
async fn read_apply_cursor(pool: &SqlitePool) -> Result<i64, AppError> {
    let row = sqlx::query!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await?;
    let cursor = row.seq;

    // SQL-review H-4: sanity-check against MAX(op_log.seq). The op_log
    // is append-only per AGENTS.md invariant #1, so MAX(seq) is the
    // strict upper bound for any legitimate cursor value.
    let max_seq: Option<i64> =
        sqlx::query_scalar!(r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log"#,)
            .fetch_one(pool)
            .await?;
    let max_seq = max_seq.unwrap_or(0);

    if cursor > max_seq {
        tracing::warn!(
            cursor,
            max_seq,
            "replay: materializer_apply_cursor exceeds MAX(op_log.seq) — \
             impossible-state corruption; resetting cursor to MAX(op_log.seq)"
        );
        let updated_at = crate::now_rfc3339();
        sqlx::query!(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = ?, \
                 updated_at = ? \
             WHERE id = 1",
            max_seq,
            updated_at,
        )
        .execute(pool)
        .await?;
        return Ok(max_seq);
    }

    Ok(cursor)
}

/// Walk `op_log WHERE seq > cursor` and enqueue each row as an
/// `ApplyOp` task on the materializer's foreground queue.
///
/// Returns a [`ReplayReport`] summarising the pass. The function blocks
/// until every enqueued op has been processed (via a foreground
/// `Barrier` task), so callers see a fully-drained queue on return.
///
/// `pool` is a `SqlitePool` — typically the writer pool, since the
/// boot sequence runs before reader-pool consumers wake up. Reading
/// from the writer is fine here: we are pre-UI and have exclusive
/// access.
///
/// No-op when the op log has no rows past the cursor.
pub async fn replay_unmaterialized_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
) -> Result<ReplayReport, AppError> {
    let cursor = read_apply_cursor(pool).await?;

    // Count first so we can log the size before kicking off the walk.
    // The reader pool would be marginally cheaper but the writer pool
    // is the one we own at boot — see fn-level docs.
    let total: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM op_log WHERE seq > ?"#,
        cursor,
    )
    .fetch_one(pool)
    .await?;

    if total == 0 {
        tracing::debug!(cursor, "replay: no unmaterialized ops");
        return Ok(ReplayReport::default());
    }

    tracing::info!(
        cursor,
        ops_to_replay = total,
        "replay: enqueuing unmaterialized ops on foreground queue"
    );

    let mut report = ReplayReport::default();
    let mut last_seen: i64 = cursor;

    // Walk the op log in seq-ascending chunks. We re-read each chunk
    // by `seq > last_seen` so the iteration is stateless across chunks
    // — no offset cursor to drift if a concurrent writer (there is
    // none at boot, but defence in depth) committed mid-walk.
    loop {
        let rows: Vec<OpRecord> = sqlx::query_as!(
            OpRecord,
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
             FROM op_log \
             WHERE seq > ? \
             ORDER BY seq ASC, device_id ASC \
             LIMIT ?",
            last_seen,
            REPLAY_CHUNK_SIZE,
        )
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            break;
        }

        for record in rows {
            last_seen = last_seen.max(record.seq);
            let task = MaterializeTask::ApplyOp(Arc::new(record));
            match materializer.enqueue_foreground(task).await {
                Ok(()) => {
                    report.ops_replayed += 1;
                }
                Err(e) => {
                    // Enqueue failure is non-fatal — log and continue.
                    // The next boot's replay will re-attempt because
                    // the cursor only advances on successful apply.
                    tracing::warn!(
                        error = %e,
                        "replay: failed to enqueue ApplyOp — will retry on next boot"
                    );
                    report.replay_errors.push(format!("enqueue: {e}"));
                }
            }
        }
    }

    // Drain the foreground queue via a Barrier so the caller observes
    // a fully-applied state on return. Without this, recover_at_boot's
    // step 2 (drafts) could enqueue synthetic edit_block ops that
    // interleave with the replayed real ops.
    materializer.flush_foreground().await?;

    tracing::info!(
        ops_replayed = report.ops_replayed,
        replay_errors = report.replay_errors.len(),
        "replay: complete"
    );

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// SQL-review H-4: when the cursor row stores a `materialized_through_seq`
    /// value greater than `MAX(op_log.seq)` (which the apply path
    /// guarantees can never happen by `MAX(materialized_through_seq, ?)`
    /// semantics, but could arise from a hand-edit / partial restore /
    /// rolled-back op_log), `read_apply_cursor` must detect the
    /// impossible state, log a warning, and reset the cursor down to
    /// `MAX(op_log.seq)` so the next replay walk does not silently miss
    /// unmaterialized ops.
    #[tokio::test]
    async fn apply_cursor_sanity_resets_when_cursor_exceeds_max_seq() {
        let (pool, _dir) = test_pool().await;

        // Insert 3 op_log rows (seqs 1..=3) directly. We bypass
        // `append_local_op` because this test is about cursor sanity, not
        // op-log construction — raw INSERTs with valid column values are
        // simpler and don't drag in OpPayload fixtures.
        for seq in 1..=3i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', '2026-01-01T00:00:00.000Z')",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Corrupt the cursor: set it well past MAX(op_log.seq) = 3.
        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = ?, \
                 updated_at = '2026-01-01T00:00:00.000Z' \
             WHERE id = 1",
        )
        .bind(9999i64)
        .execute(&pool)
        .await
        .unwrap();

        // Call the function under test.
        let returned = read_apply_cursor(&pool).await.unwrap();
        assert_eq!(
            returned, 3,
            "read_apply_cursor should clamp an over-shoot cursor down to MAX(op_log.seq)"
        );

        // The DB row must have been rewritten — otherwise the next boot
        // would observe the same corruption.
        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 3,
            "materializer_apply_cursor row must be reset to MAX(op_log.seq) on disk, \
             not just in the return value"
        );
    }
}
