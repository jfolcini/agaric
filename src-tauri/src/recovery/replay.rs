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
async fn read_apply_cursor(pool: &SqlitePool) -> Result<i64, AppError> {
    let row = sqlx::query!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.seq)
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
