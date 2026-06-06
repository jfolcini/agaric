//! #535 — boot replay of leftover write-ahead Loro-sync inbox slots.
//!
//! [`apply_remote`](crate::sync_protocol::loro_sync::apply_remote) durably
//! INSERTs each inbound message's raw bytes into `loro_sync_inbox` BEFORE
//! importing them into the engine, and DELETEs the row inside the SAME tx as
//! the SQL projection. A crash in that window leaves a row behind: the engine
//! (and the periodically-persisted `loro_doc_state`) may be ahead of SQL, but
//! `op_log` never carries remote Loro-only data, so the op-log replay step
//! cannot reconstruct it. This step re-runs the import+project for each
//! leftover slot, which both reconciles SQL and clears the slot.
//!
//! Re-import is idempotent (Loro import is idempotent; SQL projections are
//! upserts), so replaying a slot whose projection had actually committed
//! before the crash — or replaying the same slot across two boots — is safe.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::loro::registry::LoroEngineRegistry;

/// Replay every leftover row in `loro_sync_inbox`, oldest first.
///
/// For each row, re-runs the sync import+project path (which deletes the row
/// in-tx on success). Per-row errors are logged and collected; processing
/// continues with the remaining rows — the same "log + continue" philosophy
/// the op-log replay and draft-recovery steps use, so a single poison slot
/// cannot block boot.
///
/// Returns the number of slots successfully replayed (and thereby cleared).
pub async fn replay_sync_inbox(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
) -> Result<u64, AppError> {
    // FIFO by the AUTOINCREMENT id (authoritative insert order).
    let rows = sqlx::query!("SELECT id, space_id, bytes FROM loro_sync_inbox ORDER BY id ASC")
        .fetch_all(pool)
        .await?;

    let mut replayed: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    for row in rows {
        match crate::sync_protocol::loro_sync::replay_inbox_row(
            pool,
            registry,
            device_id,
            &row.space_id,
            &row.bytes,
            row.id,
        )
        .await
        {
            Ok(_changed) => {
                replayed += 1;
            }
            Err(e) => {
                tracing::error!(
                    inbox_id = row.id,
                    space_id = %row.space_id,
                    error = %e,
                    "sync-inbox replay failed for a slot — leaving it for a later boot"
                );
                errors.push(format!("inbox {}: {e}", row.id));
            }
        }
    }

    if replayed > 0 || !errors.is_empty() {
        tracing::info!(
            replayed,
            errors = errors.len(),
            "#535: replayed leftover Loro-sync inbox slots at boot"
        );
    }

    Ok(replayed)
}
