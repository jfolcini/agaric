//! Persistent retry queue for failed background materializer tasks (BUG-22).
//!
//! In-memory retries (`run_background` in `consumer.rs`) cover transient WAL
//! lock contention, but a cache-rebuild task that keeps failing past the
//! retry budget would historically be silently dropped — leaving per-block
//! caches permanently stale. This module persists exhausted tasks to
//! `materializer_retry_queue` so a periodic sweeper can re-enqueue them on
//! an exponential backoff.
//!
//! Scope: only **idempotent, per-block** tasks are persisted
//! (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`). Global
//! rebuild tasks are triggered by other code paths and don't benefit from
//! persisted retry.
//!
//! Backoff schedule: 1 min → 5 min → 30 min → 1 h (cap).
//!
//! ## Two-tier retry semantics (MAINT-148h)
//!
//! This persistent schedule is the **second tier** of the materializer's
//! retry pipeline. The first tier — the in-memory
//! [`super::consumer::retry_with_backoff`] loop — runs on a much shorter
//! ms-scale budget (foreground: 1 retry × 100 ms; background: 2 retries
//! × 150/300 ms exponential) and clears transient WAL contention before
//! the task ever reaches `materializer_retry_queue`. The handoff:
//!
//! 1. `run_background` invokes the task via `retry_with_backoff` with
//!    its in-memory schedule.
//! 2. On exhaustion (`outcome.succeeded == false`), an idempotent
//!    per-block task is passed to [`record_failure`], which appends or
//!    bumps a row in `materializer_retry_queue`.
//! 3. The boot-time / periodic sweeper reads rows whose
//!    `next_attempt_at <= now()` and re-enqueues them onto the live
//!    background queue, where the first tier runs again.
//!
//! Both tiers are observability-instrumented but otherwise independent:
//! tightening one schedule does not change the other. See the module
//! doc-comment on [`super::consumer`] for the full table.

use crate::error::AppError;
use crate::materializer::MaterializeTask;
use sqlx::SqlitePool;

/// Task kinds that may be persisted to the retry queue. Only idempotent
/// per-block operations belong here — global rebuilds do not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetryKind {
    UpdateFtsBlock,
    ReindexBlockLinks,
    /// UX-250: incremental `#[ULID]` tag-ref reindex for a single block.
    ReindexBlockTagRefs,
}

impl RetryKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::UpdateFtsBlock => "UpdateFtsBlock",
            Self::ReindexBlockLinks => "ReindexBlockLinks",
            Self::ReindexBlockTagRefs => "ReindexBlockTagRefs",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "UpdateFtsBlock" => Some(Self::UpdateFtsBlock),
            "ReindexBlockLinks" => Some(Self::ReindexBlockLinks),
            "ReindexBlockTagRefs" => Some(Self::ReindexBlockTagRefs),
            _ => None,
        }
    }

    pub(crate) fn to_task(self, block_id: String) -> MaterializeTask {
        match self {
            Self::UpdateFtsBlock => MaterializeTask::UpdateFtsBlock { block_id },
            Self::ReindexBlockLinks => MaterializeTask::ReindexBlockLinks { block_id },
            Self::ReindexBlockTagRefs => MaterializeTask::ReindexBlockTagRefs { block_id },
        }
    }

    /// Extract retry kind + block_id from a [`MaterializeTask`] if it is
    /// an idempotent per-block task. Returns `None` for non-retryable
    /// tasks (global rebuilds, barriers, ApplyOp, etc.).
    pub(crate) fn from_task(task: &MaterializeTask) -> Option<(Self, String)> {
        match task {
            MaterializeTask::UpdateFtsBlock { block_id } => {
                Some((Self::UpdateFtsBlock, block_id.clone()))
            }
            MaterializeTask::ReindexBlockLinks { block_id } => {
                Some((Self::ReindexBlockLinks, block_id.clone()))
            }
            MaterializeTask::ReindexBlockTagRefs { block_id } => {
                Some((Self::ReindexBlockTagRefs, block_id.clone()))
            }
            _ => None,
        }
    }
}

/// Compute the next attempt timestamp for a task with `attempts` prior
/// failures (including the one we just recorded). Schedule:
///   1 → +1 min, 2 → +5 min, 3 → +30 min, 4+ → +1 hour cap.
pub(crate) fn backoff_delay_for(attempts: i64) -> chrono::Duration {
    match attempts {
        ..=1 => chrono::Duration::minutes(1),
        2 => chrono::Duration::minutes(5),
        3 => chrono::Duration::minutes(30),
        _ => chrono::Duration::hours(1),
    }
}

/// Record a task that failed all in-memory retries. Inserts a new row or
/// updates the existing row (incrementing `attempts`, extending the
/// backoff). Non-retryable tasks are silently ignored.
///
/// L-11: Implemented as a single `INSERT ... ON CONFLICT(block_id,
/// task_type) DO UPDATE` that increments `attempts` SQL-side via
/// `materializer_retry_queue.attempts + 1` (instead of binding the new
/// value from a prior `SELECT`). This eliminates the SELECT-then-INSERT
/// race where two concurrent failure inserts both observe `prior = None`,
/// both compute `attempts = 1`, and both INSERT — the second triggering
/// `ON CONFLICT` and overwriting with the same `excluded.attempts = 1`,
/// silently losing one increment. The backoff schedule depends on
/// `attempts`, so we use `RETURNING attempts` to learn the actual
/// post-update value and (only on the escalation path) issue a
/// follow-up `UPDATE` to set the correct `next_attempt_at`. The
/// common-case first failure stays at one round-trip; the escalation
/// case is two round-trips, matching the previous SELECT+INSERT cost.
pub(crate) async fn record_failure(
    pool: &SqlitePool,
    task: &MaterializeTask,
    last_error: &str,
) -> Result<(), AppError> {
    let Some((kind, block_id)) = RetryKind::from_task(task) else {
        return Ok(());
    };
    let kind_str = kind.as_str();

    // Optimistic next_attempt_at for the INSERT (first-failure) case.
    // The DO UPDATE side reuses this value verbatim; if the SQL-side
    // increment escalates `attempts` past 1 we follow up below to fix
    // it to the correct backoff step.
    let initial_next_attempt = (chrono::Utc::now() + backoff_delay_for(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let attempts_after = sqlx::query_scalar!(
        "INSERT INTO materializer_retry_queue \
             (block_id, task_type, attempts, last_error, next_attempt_at) \
         VALUES (?, ?, 1, ?, ?) \
         ON CONFLICT(block_id, task_type) DO UPDATE SET \
             attempts = materializer_retry_queue.attempts + 1, \
             last_error = excluded.last_error, \
             next_attempt_at = ? \
         RETURNING attempts AS \"attempts!: i64\"",
        block_id,
        kind_str,
        last_error,
        initial_next_attempt,
        initial_next_attempt,
    )
    .fetch_one(pool)
    .await?;

    // For the escalation path (attempts > 1) the optimistic
    // `backoff_delay_for(1)` is too short. Recompute against the
    // actual `attempts_after` returned by the UPSERT and patch the row.
    let next_attempt = if attempts_after > 1 {
        let escalated = (chrono::Utc::now() + backoff_delay_for(attempts_after))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "UPDATE materializer_retry_queue SET next_attempt_at = ? \
             WHERE block_id = ? AND task_type = ?",
            escalated,
            block_id,
            kind_str,
        )
        .execute(pool)
        .await?;
        escalated
    } else {
        initial_next_attempt
    };

    tracing::warn!(
        block_id = %block_id,
        task_type = kind_str,
        attempts = attempts_after,
        next_attempt_at = %next_attempt,
        "persisted failed background task to retry queue"
    );
    Ok(())
}

/// Count of pending retry rows — used for observability (MAINT-24 via
/// `bg_dropped` / `StatusInfo`).
///
/// I-Materializer-2: visibility tightened from `pub` to `pub(crate)` to
/// match the sibling helpers in this module (`record_failure`,
/// `fetch_due`, `clear_entry`, `task_from_row`, `RetryKind`). Only
/// `sweep_once` and `spawn_sweeper` retain `pub` because they are the
/// documented integration points for the rest of the crate. The
/// `cfg_attr(not(test), allow(dead_code))` keeps lib-only builds quiet
/// while preserving the function for the planned `StatusInfo` wiring;
/// it is exercised by the unit tests in this module.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn pending_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let n = sqlx::query_scalar!("SELECT COUNT(*) as \"n!: i64\" FROM materializer_retry_queue")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

/// One due row ready to be retried.
pub(crate) struct DueRow {
    pub block_id: String,
    pub task_type: String,
}

/// Return rows where `next_attempt_at <= now`, up to `limit` entries.
/// Uses the read pool; the sweeper re-enqueues them via the normal
/// background queue path. Cap to avoid flooding the queue.
pub(crate) async fn fetch_due(pool: &SqlitePool, limit: i64) -> Result<Vec<DueRow>, AppError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows = sqlx::query!(
        "SELECT block_id, task_type FROM materializer_retry_queue \
         WHERE next_attempt_at <= ? \
         ORDER BY next_attempt_at ASC LIMIT ?",
        now,
        limit,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| DueRow {
            block_id: r.block_id,
            task_type: r.task_type,
        })
        .collect())
}

/// Delete a retry row after a successful re-run.
pub(crate) async fn clear_entry(
    pool: &SqlitePool,
    block_id: &str,
    task_type: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "DELETE FROM materializer_retry_queue WHERE block_id = ? AND task_type = ?",
        block_id,
        task_type,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Build a [`MaterializeTask`] from a persisted row. Returns `None` for
/// unknown task_type strings (migration-forward safety).
pub(crate) fn task_from_row(row: &DueRow) -> Option<MaterializeTask> {
    RetryKind::from_str(&row.task_type).map(|kind| kind.to_task(row.block_id.clone()))
}

/// Scan the retry queue once: fetch due rows, re-enqueue each via the
/// materializer's normal background queue, and on successful enqueue
/// delete the row. Failures to enqueue leave the row in place so the next
/// sweep can try again.
///
/// Returns the number of rows re-enqueued.
pub async fn sweep_once(
    pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
) -> Result<usize, AppError> {
    const SWEEP_BATCH_LIMIT: i64 = 64;
    let due = fetch_due(pool, SWEEP_BATCH_LIMIT).await?;
    let mut re_enqueued = 0usize;
    for row in &due {
        let Some(task) = task_from_row(row) else {
            // Unknown task_type — drop the row so the table doesn't grow
            // unbounded with orphaned entries from a future version.
            tracing::warn!(
                block_id = %row.block_id,
                task_type = %row.task_type,
                "dropping retry row for unknown task_type"
            );
            clear_entry(pool, &row.block_id, &row.task_type).await?;
            continue;
        };
        match materializer.try_enqueue_background(task) {
            Ok(()) => {
                // Re-enqueued. Clear the row — the consumer will re-persist
                // the entry with incremented attempts if it fails again.
                clear_entry(pool, &row.block_id, &row.task_type).await?;
                re_enqueued += 1;
            }
            Err(e) => {
                tracing::warn!(
                    block_id = %row.block_id,
                    task_type = %row.task_type,
                    error = %e,
                    "failed to re-enqueue retry row — will try again next sweep"
                );
            }
        }
    }
    if re_enqueued > 0 {
        tracing::info!(re_enqueued, "materializer retry queue sweep");
    }
    Ok(re_enqueued)
}

/// Spawn a long-lived task that sweeps the retry queue every 60 seconds
/// and exits when `shutdown_flag` is set.
#[cfg(not(tarpaulin_include))]
pub fn spawn_sweeper(
    pool: SqlitePool,
    materializer: crate::materializer::Materializer,
    shutdown_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    #[cfg(not(test))]
    let spawn_fn = tauri::async_runtime::spawn;
    #[cfg(test)]
    let spawn_fn = tokio::spawn;
    // Fire-and-forget: the sweeper runs for the app's lifetime. We intentionally
    // discard the JoinHandle — the task stops when `shutdown_flag` flips.
    let _handle = spawn_fn(async move {
        // First pass at boot to drain entries left by a previous session.
        if let Err(e) = sweep_once(&pool, &materializer).await {
            tracing::warn!(error = %e, "boot-time retry queue sweep failed");
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        // skip immediate first tick
        interval.tick().await;
        loop {
            interval.tick().await;
            if shutdown_flag.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            if let Err(e) = sweep_once(&pool, &materializer).await {
                tracing::warn!(error = %e, "periodic retry queue sweep failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[test]
    fn backoff_schedule_escalates_then_caps() {
        assert_eq!(backoff_delay_for(1), chrono::Duration::minutes(1));
        assert_eq!(backoff_delay_for(2), chrono::Duration::minutes(5));
        assert_eq!(backoff_delay_for(3), chrono::Duration::minutes(30));
        assert_eq!(backoff_delay_for(4), chrono::Duration::hours(1));
        assert_eq!(backoff_delay_for(10), chrono::Duration::hours(1));
        // 0 or negative treated as first attempt
        assert_eq!(backoff_delay_for(0), chrono::Duration::minutes(1));
    }

    #[test]
    fn from_task_only_matches_idempotent_per_block_tasks() {
        let t = MaterializeTask::UpdateFtsBlock {
            block_id: "B1".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::UpdateFtsBlock, _))
        ));

        let t = MaterializeTask::ReindexBlockLinks {
            block_id: "B2".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::ReindexBlockLinks, _))
        ));

        let t = MaterializeTask::ReindexBlockTagRefs {
            block_id: "B3".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::ReindexBlockTagRefs, _))
        ));

        let t = MaterializeTask::RebuildTagsCache;
        assert!(RetryKind::from_task(&t).is_none());

        let t = MaterializeTask::RebuildFtsIndex;
        assert!(RetryKind::from_task(&t).is_none());

        let t = MaterializeTask::RebuildBlockTagRefsCache;
        assert!(
            RetryKind::from_task(&t).is_none(),
            "RebuildBlockTagRefsCache is a global rebuild, not a per-block task"
        );
    }

    #[test]
    fn retry_kind_reindex_block_tag_refs_roundtrip() {
        let kind = RetryKind::ReindexBlockTagRefs;
        assert_eq!(kind.as_str(), "ReindexBlockTagRefs");
        assert_eq!(RetryKind::from_str("ReindexBlockTagRefs"), Some(kind));
        let task = kind.to_task("BLK_RTR".into());
        assert!(matches!(
            task,
            MaterializeTask::ReindexBlockTagRefs { ref block_id } if block_id == "BLK_RTR"
        ));
    }

    #[tokio::test]
    async fn record_failure_inserts_row_for_retryable_task() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_R1".into(),
        };
        record_failure(&pool, &task, "boom").await.unwrap();

        let row = sqlx::query!(
            "SELECT attempts, last_error FROM materializer_retry_queue \
             WHERE block_id = ? AND task_type = ?",
            "BLK_R1",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.attempts, 1);
        assert_eq!(row.last_error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn record_failure_increments_attempts_on_repeat() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_R2".into(),
        };
        record_failure(&pool, &task, "err1").await.unwrap();
        record_failure(&pool, &task, "err2").await.unwrap();
        record_failure(&pool, &task, "err3").await.unwrap();

        let row = sqlx::query!(
            "SELECT attempts, last_error FROM materializer_retry_queue \
             WHERE block_id = ? AND task_type = ?",
            "BLK_R2",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.attempts, 3, "attempts must accumulate across failures");
        assert_eq!(
            row.last_error.as_deref(),
            Some("err3"),
            "last_error must be overwritten with the most recent message"
        );
    }

    #[tokio::test]
    async fn record_failure_ignores_non_retryable_tasks() {
        let (pool, _dir) = test_pool().await;
        record_failure(&pool, &MaterializeTask::RebuildTagsCache, "boom")
            .await
            .unwrap();

        let n = pending_count(&pool).await.unwrap();
        assert_eq!(
            n, 0,
            "non-retryable tasks must not be persisted to the retry queue"
        );
    }

    #[tokio::test]
    async fn fetch_due_and_clear_entry_round_trip() {
        let (pool, _dir) = test_pool().await;
        // Insert a row with an already-past next_attempt_at
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_type, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_FD",
            "UpdateFtsBlock",
            1_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = fetch_due(&pool, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "due row should be returned");
        assert_eq!(rows[0].block_id, "BLK_FD");
        assert_eq!(rows[0].task_type, "UpdateFtsBlock");

        clear_entry(&pool, "BLK_FD", "UpdateFtsBlock")
            .await
            .unwrap();
        let n = pending_count(&pool).await.unwrap();
        assert_eq!(n, 0, "cleared entry should vanish from the queue");
    }

    #[tokio::test]
    async fn fetch_due_skips_future_entries() {
        let (pool, _dir) = test_pool().await;
        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_type, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_F1",
            "UpdateFtsBlock",
            1_i64,
            future,
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = fetch_due(&pool, 10).await.unwrap();
        assert!(
            rows.is_empty(),
            "future-dated entries must not be returned by fetch_due"
        );
    }

    #[tokio::test]
    async fn task_from_row_roundtrip() {
        let row = DueRow {
            block_id: "BLK_TR".into(),
            task_type: "UpdateFtsBlock".into(),
        };
        let t = task_from_row(&row).unwrap();
        assert!(
            matches!(t, MaterializeTask::UpdateFtsBlock { ref block_id } if block_id == "BLK_TR")
        );

        let unknown = DueRow {
            block_id: "x".into(),
            task_type: "SomeFutureTaskType".into(),
        };
        assert!(
            task_from_row(&unknown).is_none(),
            "unknown task_type rows must be silently skipped for migration-forward safety"
        );
    }

    /// L-11 regression: the SQL-side `attempts = materializer_retry_queue.attempts + 1`
    /// increment must be atomic vs. concurrent callers. Two `record_failure`
    /// invocations issued in parallel for the same `(block_id, task_type)`
    /// MUST produce `attempts == 2` — never `attempts == 1` (which would
    /// happen with the old SELECT-then-INSERT, where both readers see
    /// `prior = None`, both compute `attempts = 1`, and the second
    /// triggers `ON CONFLICT` overwriting with `excluded.attempts = 1`).
    ///
    /// SQLite serialises writers, but the test still pins the invariant
    /// at the SQL level so any future attempt to swap the increment back
    /// to a Rust-side computation gets caught by the join semantics
    /// alone (no need for genuine wall-clock interleaving).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn record_failure_concurrent_calls_accumulate_attempts() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_RACE".into(),
        };

        // Fire two failures back-to-back from independent tasks. The
        // SQL-side increment guarantees the second call observes the
        // first's INSERT/UPDATE atomically.
        let p1 = pool.clone();
        let t1 = task.clone();
        let h1 = tokio::spawn(async move { record_failure(&p1, &t1, "err-A").await });
        let p2 = pool.clone();
        let t2 = task.clone();
        let h2 = tokio::spawn(async move { record_failure(&p2, &t2, "err-B").await });
        h1.await.unwrap().unwrap();
        h2.await.unwrap().unwrap();

        let attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_type = ?",
            "BLK_RACE",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            attempts, 2,
            "L-11: SQL-side increment must accumulate across concurrent record_failure calls; \
             a regression to SELECT-then-INSERT would race and drop one increment (attempts == 1)"
        );
    }

    #[tokio::test]
    async fn record_failure_escalates_next_attempt_at() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_EX".into(),
        };

        record_failure(&pool, &task, "e1").await.unwrap();
        let first = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_type = ?",
            "BLK_EX",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        record_failure(&pool, &task, "e2").await.unwrap();
        let second = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_type = ?",
            "BLK_EX",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert!(
            second > first,
            "second failure must schedule a later next_attempt_at (got first={first}, second={second})"
        );
    }

    // --- sweeper ---

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_reenqueues_due_rows_and_removes_them() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a due row
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_type, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SW1",
            "UpdateFtsBlock",
            2_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &mat).await.unwrap();
        assert_eq!(n, 1, "one due row must be re-enqueued");
        // Clear: after re-enqueue, row is deleted (consumer will re-add on failure).
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "swept row must be deleted after successful enqueue"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_skips_future_rows() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_type, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SWF",
            "UpdateFtsBlock",
            1_i64,
            future,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &mat).await.unwrap();
        assert_eq!(n, 0, "future-dated rows must NOT be swept");
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(remaining, 1, "future row must remain in the queue");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_drops_unknown_task_type_rows() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_type, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SWU",
            "SomeFutureTaskType",
            1_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "unknown task_type rows are NOT counted as re-enqueued"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "unknown task_type rows must be dropped so the table does not grow unbounded"
        );
    }
}
