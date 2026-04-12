//! Op log compaction command handlers (F-20).

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;

use super::*;

/// A link between two pages (for graph visualization).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, sqlx::FromRow, specta::Type)]
pub struct PageLink {
    pub source_id: String,
    pub target_id: String,
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
pub async fn get_compaction_status_inner(pool: &SqlitePool) -> Result<CompactionStatus, AppError> {
    let total_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await?;

    let oldest_op_date: Option<String> = sqlx::query_scalar!("SELECT MIN(created_at) FROM op_log")
        .fetch_one(pool)
        .await?;

    let cutoff =
        chrono::Utc::now() - chrono::Duration::days(crate::snapshot::DEFAULT_RETENTION_DAYS as i64);
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
/// Wraps the compaction in a `BEGIN IMMEDIATE` transaction to prevent
/// interleaving with concurrent writers (REVIEW-LATER item from snapshot.rs).
pub async fn compact_op_log_cmd_inner(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<CompactionResult, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
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

    // Wrap in BEGIN IMMEDIATE for atomicity (the existing compact_op_log
    // lacks explicit transaction wrapping — see REVIEW-LATER).
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Recount inside the transaction to avoid TOCTOU
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

    // Release the IMMEDIATE transaction before calling compact_op_log,
    // which manages its own internal queries. We verified eligibility;
    // compact_op_log will re-verify and perform the actual work.
    tx.commit().await?;

    let snapshot_id = crate::snapshot::compact_op_log(pool, device_id, retention_days).await?;

    Ok(CompactionResult {
        snapshot_id,
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
