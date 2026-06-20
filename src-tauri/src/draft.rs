//! Block draft writer — autosave buffer for in-progress edits.
//!
//! Every ~2 seconds during active typing the frontend calls [`save_draft`] to
//! persist the current editor content into the `block_drafts` table. On
//! blur / window-focus-loss the frontend calls [`flush_draft`] which writes a
//! proper `edit_block` op and removes the draft row.
//!
//! Drafts never participate in sync, undo, or compaction.
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::db::{CommandTx, now_ms};
use crate::error::AppError;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log::{OpRecord, append_local_op_in_tx};
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single draft row from `block_drafts`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, specta::Type)]
pub struct Draft {
    pub block_id: crate::ulid::BlockId,
    pub content: String,
    /// Epoch-ms (block_drafts.updated_at is INTEGER since migration 0082).
    pub updated_at: i64,
    /// #1256: MONOTONIC supersession anchor. The local device's op-log
    /// high-water (`MAX(seq)`) at the moment this draft was saved — "every op
    /// up to this seq is already reflected in the draft's view." Recovery
    /// treats the draft as superseded iff a block-scoped op exists with
    /// `seq > draft_anchor_seq` on the same device (migration 0092).
    /// `0` (the backfill default) means "no local op preceded this draft", so
    /// any existing op supersedes it.
    pub draft_anchor_seq: i64,
    /// #1256: which device's per-device `seq` space `draft_anchor_seq` lives
    /// in. `None` (legacy/backfill) is treated by the recovery query as
    /// "matches the recovering device".
    pub draft_anchor_device: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Insert or replace a draft for the given block.
///
/// Called by the frontend every ~2 s during active typing.
///
/// #1256: alongside `content`/`updated_at`, this records the MONOTONIC
/// supersession anchor — the local device's op-log high-water (`MAX(seq)`) at
/// save time (migration 0092). `updated_at` (a `now_ms()` wall-clock) is kept
/// for display/ordering, but recovery's supersession check now keys on the
/// clock-independent `(draft_anchor_device, draft_anchor_seq)` pair so a
/// backward clock step can no longer resurrect a stale draft.
pub async fn save_draft(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    content: &str,
) -> Result<(), AppError> {
    let updated_at = now_ms();
    // Op-log high-water for THIS device: every op with seq <= this value is
    // already reflected in the editor view this draft was typed against, so
    // only an op with a strictly greater seq is a genuine superseding flush.
    let anchor_seq = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(seq), 0) as "seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(pool)
    .await?;
    sqlx::query(
        "INSERT OR REPLACE INTO block_drafts \
         (block_id, content, updated_at, draft_anchor_seq, draft_anchor_device) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(block_id)
    .bind(content)
    .bind(updated_at)
    .bind(anchor_seq)
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Save a draft only if the content differs from the currently stored draft.
///
/// Returns `Ok(true)` if a write was performed, `Ok(false)` if skipped.
/// This avoids unnecessary writes when the user hasn't changed anything
/// since the last autosave tick.
pub async fn save_draft_if_changed(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    content: &str,
) -> Result<bool, AppError> {
    if let Some(existing) = get_draft(pool, block_id).await?
        && existing.content == content
    {
        return Ok(false);
    }
    save_draft(pool, device_id, block_id, content).await?;
    Ok(true)
}

/// Delete a draft row for the given block (if it exists).
pub async fn delete_draft(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM block_drafts WHERE block_id = ?", block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete a draft row within an existing transaction.
///
/// The caller is responsible for committing the transaction.
/// Used by [`flush_draft`] to atomically delete the draft in the same
/// transaction that appends the op.
pub async fn delete_draft_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    block_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Return a single draft by block ID, or `None` if no draft exists.
pub async fn get_draft(pool: &SqlitePool, block_id: &str) -> Result<Option<Draft>, AppError> {
    let draft = sqlx::query_as!(
        Draft,
        r#"SELECT block_id AS "block_id: crate::ulid::BlockId", content, updated_at, draft_anchor_seq, draft_anchor_device FROM block_drafts WHERE block_id = ?"#,
        block_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(draft)
}

/// Return all draft rows ordered by `updated_at` ascending.
pub async fn get_all_drafts(pool: &SqlitePool) -> Result<Vec<Draft>, AppError> {
    let drafts = sqlx::query_as!(
        Draft,
        r#"SELECT block_id AS "block_id: crate::ulid::BlockId", content, updated_at, draft_anchor_seq, draft_anchor_device FROM block_drafts ORDER BY updated_at ASC"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(drafts)
}

/// Return the number of drafts currently stored.
pub async fn draft_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let rec = sqlx::query!(r#"SELECT COUNT(*) as "count: i64" FROM block_drafts"#)
        .fetch_one(pool)
        .await?;
    Ok(rec.count)
}

/// Delete `block_drafts` rows whose `block_id` no longer maps to a
/// live (non-soft-deleted) block. Returns the count of orphan drafts removed.
///
/// Migration 0038 added a FK from `block_drafts.block_id` to
/// `blocks(id) ON DELETE CASCADE`, so drafts whose parent block has been
/// hard-deleted are now removed by the cascade. This function remains
/// load-bearing for the **soft-deleted** branch: the FK references the
/// `blocks` row itself, not its `deleted_at` column, so a draft for a
/// soft-deleted block survives until this sweeper runs.
///
/// Wired into [`spawn_orphan_drafts_sweeper`], which is invoked from
/// `lib::run` at boot (one-shot) and then every hour for the lifetime
/// of the process.
///
/// The query uses plain `sqlx::query` (not the `query!` macro) because the
/// subquery makes type inference flaky in the macro path.
pub async fn sweep_orphan_drafts(pool: &SqlitePool) -> Result<u64, AppError> {
    let result = sqlx::query(
        "DELETE FROM block_drafts \
         WHERE block_id NOT IN (SELECT id FROM blocks WHERE deleted_at IS NULL)",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Default cadence for the orphan-drafts sweeper after the
/// boot one-shot. Drafts are user-typed, so the rate of orphan creation
/// is bounded by user clicks; an hourly sweep is more than sufficient.
pub const ORPHAN_DRAFTS_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// Spawn a long-lived task that runs [`sweep_orphan_drafts`]
/// once at boot and then every `interval` until `shutdown_flag` is set.
///
/// Mirrors the shape of
/// [`crate::materializer::retry_queue::spawn_sweeper`]:
/// fire-and-forget, polls the shared shutdown flag on each tick, and
/// uses `tauri::async_runtime::spawn` in production builds (so the
/// task is owned by Tauri's runtime) and `tokio::spawn` in tests.
///
/// Logs `rows_affected` at `debug!` when the sweep is a no-op and at
/// `info!` when it removed at least one row — orphans being swept is
/// observable evidence of the schema-edge case (soft-deleted parent
/// block) the function exists to handle.
pub fn spawn_orphan_drafts_sweeper(
    pool: SqlitePool,
    interval: std::time::Duration,
    shutdown_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    #[cfg(not(test))]
    let spawn_fn = tauri::async_runtime::spawn;
    #[cfg(test)]
    let spawn_fn = tokio::spawn;
    // Fire-and-forget: the sweeper runs for the app's lifetime. We
    // intentionally discard the JoinHandle — the task stops when
    // `shutdown_flag` flips.
    let _handle = spawn_fn(async move {
        // Boot one-shot — drains any orphan drafts left by a previous
        // session before the user can encounter "phantom drafts" in the UI.
        run_sweep_once(&pool, "boot").await;

        let mut ticker = tokio::time::interval(interval);
        // skip immediate first tick (we just ran the boot one-shot)
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if shutdown_flag.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            run_sweep_once(&pool, "periodic").await;
        }
    });
}

/// Helper for [`spawn_orphan_drafts_sweeper`]: run one sweep and log
/// the outcome at the appropriate level. Errors are logged at `warn!`
/// and otherwise swallowed — the next tick will retry.
async fn run_sweep_once(pool: &SqlitePool, phase: &'static str) {
    match sweep_orphan_drafts(pool).await {
        Ok(0) => tracing::debug!(phase, "orphan-drafts sweep: no rows affected"),
        Ok(rows_affected) => tracing::info!(
            phase,
            rows_affected,
            "orphan-drafts sweep removed soft-deleted-parent drafts"
        ),
        Err(e) => tracing::warn!(phase, error = %e, "orphan-drafts sweep failed"),
    }
}

/// Flush a draft: write an `edit_block` op and then delete the draft row,
/// using an existing outer transaction.
///
/// The caller is responsible for committing the transaction. Used by
/// [`flush_draft`] (thin wrapper) and by `commands::drafts::flush_draft_inner`,
/// which wraps additional pre-flight validation (target-block existence,
/// content-length cap, `prev_edit` lookup) in the same `BEGIN IMMEDIATE` tx
/// so the entire flush is atomic.
pub async fn flush_draft_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    content: &str,
    prev_edit: Option<(String, i64)>,
) -> Result<OpRecord, AppError> {
    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        to_text: content.to_owned(),
        prev_edit,
    });

    let record = append_local_op_in_tx(tx, device_id, op, now_ms()).await?;
    delete_draft_in_tx(tx, block_id).await?;
    Ok(record)
}

/// Flush a draft: write an `edit_block` op and then delete the draft row.
///
/// This is the blur / window-focus-loss path.
///
/// Both the op append and the draft deletion are wrapped in a single
/// IMMEDIATE transaction. If any step fails the entire transaction is
/// rolled back, preventing orphaned drafts or duplicate ops on retry.
///
/// Thin wrapper around [`flush_draft_in_tx`] that opens its own
/// `BEGIN IMMEDIATE` transaction. Callers that need to combine the flush
/// with additional pre-flight checks (e.g. validating the target block
/// still exists) should drive [`flush_draft_in_tx`] directly on an outer
/// transaction.
// Test-only helper: returns the `OpRecord` for assertions. No production
// caller (the command path is `commands::drafts::flush_draft_inner`), so it
// has nothing to dispatch — kept off the raw `begin_with` via `CommandTx` +
// `commit_without_dispatch`.
pub async fn flush_draft(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    content: &str,
    prev_edit: Option<(String, i64)>,
) -> Result<OpRecord, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "flush_draft").await?;
    let record = flush_draft_in_tx(&mut tx, device_id, block_id, content, prev_edit).await?;
    tx.commit_without_dispatch().await?;
    Ok(record)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Tests live in `draft/tests.rs` — pattern established for `dag.rs` +
// `dag/tests.rs`. Keeping the impl file focused on the ~200-line public
// API while rust-analyzer and cargo test pick up the sibling file via
// the declaration below.

#[cfg(test)]
mod tests;
