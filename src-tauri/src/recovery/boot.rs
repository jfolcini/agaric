use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::db::MAX_SQL_PARAMS;
use crate::draft::{delete_draft, get_all_drafts};
use crate::error::AppError;
use crate::materializer::Materializer;

use super::draft_recovery::recover_single_draft;
use super::replay::replay_unmaterialized_ops;
use super::RecoveryReport;

// ---------------------------------------------------------------------------
// L-103: once-only guard
// ---------------------------------------------------------------------------

/// L-103 once-only flag. The module docs (`recovery/mod.rs`) state that
/// `recover_at_boot` MUST be called exactly once at application start-up,
/// before any user operations are allowed, and is **not safe** to run
/// concurrently with normal user operations. Today every caller honours
/// the contract — but a future Tauri command "force re-run recovery" or
/// a sloppy refactor could corrupt state by interleaving synthetic
/// edit_block ops with real ops.
///
/// This `AtomicBool` enforces the invariant in code rather than relying
/// on convention. The first call flips the flag from `false` to `true`
/// via `compare_exchange`; subsequent calls observe the flag already
/// set and return [`AppError::InvalidOperation`] BEFORE touching the
/// pool. Returning rather than panicking lets the caller decide whether
/// the second call is recoverable (it should not be — but propagating
/// an error preserves the caller's ability to log + telemetry).
///
/// In tests the guard is reset to `false` via [`reset_recovery_guard`]
/// (also `pub(crate)` and `#[cfg(test)]`-gated) so multiple `tokio::test`
/// fixtures can each run their own `recover_at_boot` against a fresh
/// `test_pool()`.
static RECOVERY_DONE: AtomicBool = AtomicBool::new(false);

/// Reset the L-103 once-only guard. **Test-only.** Production callers
/// must never reset the flag — the contract is "exactly once per
/// process".
#[cfg(test)]
pub(crate) fn reset_recovery_guard() {
    RECOVERY_DONE.store(false, Ordering::Release);
}

// ---------------------------------------------------------------------------
// Helpers (excluded from coverage)
// ---------------------------------------------------------------------------

/// Log and record a draft-recovery error. Extracted so the defensive error
/// paths (which require injecting DB failures into individual draft rows) can
/// be excluded from tarpaulin's line count without hiding the surrounding
/// logic.
#[cfg(not(tarpaulin_include))]
fn log_draft_error(draft_errors: &mut Vec<String>, block_id: &str, e: &AppError, context: &str) {
    tracing::error!(block_id, context, error = %e, "draft recovery failed");
    if context == "deleting" {
        draft_errors.push(format!("{block_id} (delete): {e}"));
    } else {
        draft_errors.push(format!("{block_id}: {e}"));
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run crash-recovery checks. Must be called **before** any user-visible UI.
///
/// See module-level docs for the full sequence and contract.
///
/// # Coverage note
///
/// The per-draft error handling paths (draft recovery failure, draft
/// deletion failure) require database-level failures to trigger and are
/// not exercised in unit tests. These are intentionally defensive and
/// represent 5 of the remaining uncovered lines in tarpaulin reports.
pub async fn recover_at_boot(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<RecoveryReport, AppError> {
    // L-103: enforce the once-per-process contract. `compare_exchange`
    // atomically flips `false -> true` on the first call; subsequent
    // calls see `true` and return `InvalidOperation` BEFORE touching
    // the pool. The guard is reset in tests via `reset_recovery_guard`.
    if RECOVERY_DONE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::InvalidOperation(
            "recover_at_boot called more than once per process — \
             must be called exactly once at start-up before any user \
             operations (L-103)"
                .to_string(),
        ));
    }

    let start = Instant::now();

    // -----------------------------------------------------------------
    // Step 1: Delete pending snapshots
    // -----------------------------------------------------------------
    let delete_result = sqlx::query("DELETE FROM log_snapshots WHERE status = 'pending'")
        .execute(pool)
        .await?;
    let pending_snapshots_deleted = delete_result.rows_affected();

    // -----------------------------------------------------------------
    // Step 1.5: C-2b — replay unmaterialized ops before draft recovery.
    //
    // Drafts emit synthetic edit_block ops; running drafts before
    // replay would interleave the synthetic ops with the unmaterialized
    // real ops, breaking the sequential apply order. The replay function
    // drains the foreground queue via a Barrier before returning, so
    // step 2's draft path observes a fully-applied state.
    //
    // Replay failures (e.g. a corrupted `op_log` or a stuck foreground
    // queue) are captured into `replay_errors` rather than aborting
    // boot — the same "log + continue" philosophy that the draft loop
    // uses for individual-draft errors. Boot must succeed so the user
    // can at least open the app and recover via UI.
    // -----------------------------------------------------------------
    let replay_report = match replay_unmaterialized_ops(pool, materializer).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "C-2b replay failed — continuing with draft recovery");
            super::ReplayReport {
                ops_replayed: 0,
                ops_skipped_idempotent: 0,
                replay_errors: vec![format!("replay aborted: {e}")],
            }
        }
    };

    // -----------------------------------------------------------------
    // Step 2: Walk block_drafts and recover unflushed drafts
    // -----------------------------------------------------------------
    let drafts = get_all_drafts(pool).await?;

    let mut drafts_recovered: Vec<String> = Vec::new();
    let mut drafts_already_flushed: u64 = 0;
    let mut draft_errors: Vec<String> = Vec::new();

    // Batch-check which draft block_ids still exist (not soft-deleted) in the
    // blocks table. This replaces per-draft SELECT COUNT(*) queries (N+1)
    // with a single IN-clause query.
    //
    // NOTE: sqlx compile-time macros (query!, query_scalar!) don't support
    // dynamic IN clauses, so we use runtime sqlx::query() here. This is
    // acceptable — the query is straightforward and only runs once at boot.
    //
    // L-104: SQLite caps bind parameters at `MAX_SQL_PARAMS` (999) per query.
    // A multi-thousand-block paste crash can leave > 999 rows in
    // `block_drafts`; building one giant IN clause would fail with "too many
    // SQL variables". Chunk the IN clause and accumulate the result set
    // across chunks. `MAX_SQL_PARAMS - 1` leaves headroom for any future
    // non-IN bind on this query.
    let existing_block_ids: HashSet<String> = if drafts.is_empty() {
        HashSet::new()
    } else {
        const CHUNK: usize = MAX_SQL_PARAMS - 1;
        let mut acc: HashSet<String> = HashSet::new();
        for chunk in drafts.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT id FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL"
            );
            let mut q = sqlx::query_scalar::<_, String>(&sql);
            for draft in chunk {
                q = q.bind(&draft.block_id);
            }
            acc.extend(q.fetch_all(pool).await?);
        }
        acc
    };

    for draft in &drafts {
        match recover_single_draft(pool, device_id, draft, &existing_block_ids).await {
            Ok(true) => {
                drafts_recovered.push(draft.block_id.clone());
            }
            Ok(false) => {
                drafts_already_flushed += 1;
            }
            Err(e) => {
                log_draft_error(&mut draft_errors, &draft.block_id, &e, "recovering");
            }
        }

        // Delete the draft row regardless of outcome. If this fails, we log
        // but still continue — the draft will be retried on next boot.
        if let Err(e) = delete_draft(pool, &draft.block_id).await {
            log_draft_error(&mut draft_errors, &draft.block_id, &e, "deleting");
        }
    }

    // Elapsed millis for boot recovery won't exceed u64; saturate on overflow.
    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    tracing::info!(
        duration_ms,
        pending_snapshots_deleted,
        drafts_recovered = drafts_recovered.len(),
        already_flushed = drafts_already_flushed,
        errors = draft_errors.len(),
        ops_replayed = replay_report.ops_replayed,
        replay_errors = replay_report.replay_errors.len(),
        "recovery completed"
    );

    Ok(RecoveryReport {
        pending_snapshots_deleted,
        drafts_recovered,
        drafts_already_flushed,
        duration_ms,
        draft_errors,
        ops_replayed: replay_report.ops_replayed,
        ops_skipped_idempotent: replay_report.ops_skipped_idempotent,
        replay_errors: replay_report.replay_errors,
    })
}
