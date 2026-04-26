//! Op log compaction command handlers (F-20).

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;

use super::*;

/// Minimum retention period accepted by [`compact_op_log_cmd_inner`].
///
/// M-38: Hard floor at the IPC boundary so a buggy Settings tab or malformed
/// IPC payload supplying `0` cannot purge the entire op log down to the
/// snapshot frontier in one shot. AGENTS.md invariant 1 ("op log is strictly
/// append-only … except compaction") relies on the user explicitly opting
/// in to a retention window; this guard is the second line of defence.
pub const MIN_RETENTION_DAYS: u64 = 7;

/// A link between two pages (for graph visualization).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, sqlx::FromRow, specta::Type)]
pub struct PageLink {
    pub source_id: String,
    pub target_id: String,
    pub ref_count: i64,
}

/// Result of a point-in-time restore operation.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RestoreToOpResult {
    /// Number of ops that were successfully reverted.
    pub ops_reverted: u64,
    /// Number of non-reversible ops (purge_block, delete_attachment) skipped.
    pub non_reversible_skipped: u64,
    /// Individual undo results for each reverted op.
    pub results: Vec<UndoResult>,
}

/// Statistics about the op log, returned by [`get_compaction_status`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
pub struct CompactionStatus {
    pub total_ops: i64,
    pub oldest_op_date: Option<String>,
    pub eligible_ops: i64,
    pub retention_days: u64,
}

/// Result of an op log compaction, returned by [`compact_op_log_cmd`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
pub struct CompactionResult {
    pub snapshot_id: Option<String>,
    pub ops_deleted: i64,
}

/// Inner implementation for [`get_compaction_status`], testable without Tauri state.
#[instrument(skip(pool), err)]
pub async fn get_compaction_status_inner(pool: &SqlitePool) -> Result<CompactionStatus, AppError> {
    let total_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await?;

    let oldest_op_date: Option<String> = sqlx::query_scalar!("SELECT MIN(created_at) FROM op_log")
        .fetch_one(pool)
        .await?;

    let cutoff = chrono::Utc::now()
        - chrono::Duration::days(crate::snapshot::DEFAULT_RETENTION_DAYS.cast_signed());
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let eligible_ops: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(pool)
    .await?;

    Ok(CompactionStatus {
        total_ops,
        oldest_op_date,
        eligible_ops,
        retention_days: crate::snapshot::DEFAULT_RETENTION_DAYS,
    })
}

/// Tauri command: return op log compaction statistics for the UI.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_compaction_status(
    pool: State<'_, ReadPool>,
) -> Result<CompactionStatus, AppError> {
    get_compaction_status_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Inner implementation for [`compact_op_log_cmd`], testable without Tauri state.
///
/// L-43: this function takes a `BEGIN IMMEDIATE` lock purely to perform
/// a TOCTOU recount of eligible ops under the writer lock — it does
/// **not** provide atomicity for the compaction itself.
/// `snapshot::compact_op_log` (`snapshot/create.rs:243-295`) wraps its
/// own write phase in `BEGIN IMMEDIATE`, so the actual delete is
/// already atomic. The wrapper tx exists so we can serve the
/// fast-path early-return when no ops match the cutoff and emit a
/// `warn` log via `begin_immediate_logged` if writers are contending.
/// See L-42 for the related "stale `ops_deleted`" follow-up.
pub async fn compact_op_log_cmd_inner(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<CompactionResult, AppError> {
    // M-38: reject pathologically small retention windows at the IPC boundary
    // before any DB work. retention_days = 0 would otherwise set cutoff = now()
    // and purge the entire op log down to the snapshot frontier.
    if retention_days < MIN_RETENTION_DAYS {
        return Err(AppError::Validation("retention_days.too_small".into()));
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days.cast_signed());
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // Count eligible ops before compaction
    let eligible: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(pool)
    .await?;

    if eligible == 0 {
        return Ok(CompactionResult {
            snapshot_id: None,
            ops_deleted: 0,
        });
    }

    // L-43: this BEGIN IMMEDIATE is *not* providing atomicity for the
    // compaction itself. `snapshot::compact_op_log`
    // (`snapshot/create.rs:243-295`) already wraps its own write phase
    // in BEGIN IMMEDIATE, so the inner call owns its tx end-to-end.
    //
    // What this wrapper tx is actually doing is a TOCTOU recount: it
    // takes the writer lock, re-counts eligible ops under that lock,
    // commits, and uses the recounted figure (`eligible_in_tx`) to drive
    // the early-return path and — currently — the reported
    // `ops_deleted` value. That second use is stale by the time
    // `compact_op_log` runs (more ops can be appended between commit
    // and the inner write phase, and the snapshot-frontier guard inside
    // `compact_op_log` may also skip some); see L-42 for the proper fix
    // (propagate the real `deleted_count` from `compact_op_log`). Do
    // not assume this wrapper tx adds atomicity over the actual
    // delete — it does not.
    //
    // MAINT-30: slow-acquire timed via `begin_immediate_logged` so a
    // recount that blocks on the write lock surfaces as a `warn` log
    // instead of disappearing into the 5s busy_timeout.
    let mut tx = crate::db::begin_immediate_logged(pool, "cmd_compact_op_log").await?;

    // Recount inside the transaction (TOCTOU recount, not atomicity —
    // see comment above and L-42 / L-43 in REVIEW-LATER).
    let eligible_in_tx: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(&mut *tx)
    .await?;

    if eligible_in_tx == 0 {
        tx.rollback().await?;
        return Ok(CompactionResult {
            snapshot_id: None,
            ops_deleted: 0,
        });
    }

    // Release the recount tx before calling `compact_op_log`. The inner
    // function opens its own BEGIN IMMEDIATE for the actual delete, so
    // holding ours longer would only serialise the writer lock for no
    // gain. `compact_op_log` re-verifies eligibility under its own tx.
    tx.commit().await?;

    let snapshot_id = crate::snapshot::compact_op_log(pool, device_id, retention_days).await?;

    Ok(CompactionResult {
        snapshot_id,
        // L-42: stale figure — `eligible_in_tx` is the recount taken
        // before `compact_op_log` ran, not the actual delete count.
        // Tracked separately; do not "fix" this here.
        ops_deleted: eligible_in_tx,
    })
}

/// Tauri command: trigger op log compaction.
///
/// The frontend is responsible for confirming with the user before calling
/// this command. `retention_days` controls how far back ops are retained.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn compact_op_log_cmd(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    retention_days: u64,
) -> Result<CompactionResult, AppError> {
    compact_op_log_cmd_inner(&pool.0, device_id.as_str(), retention_days)
        .await
        .map_err(sanitize_internal_error)
}
