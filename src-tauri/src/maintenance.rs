//! Issue #157 sub-item B — `MaintenanceDaemon` skeleton.
//!
//! A general-purpose maintenance loop for periodic cleanups that do not
//! belong inside the materializer's hot path. Modelled on
//! [`crate::draft::spawn_orphan_drafts_sweeper`] (single `tokio::spawn` +
//! `tokio::time::interval` ticker) but generalised over a vector of
//! [`MaintenanceJob`] entries so subsequent sub-items
//! (`op_log_compact`, `tombstone_purge`, `pragma_optimize_tick`, …) can
//! land as additional jobs without re-wiring the daemon.
//!
//! Cadence: a fixed [`TICK_INTERVAL`] (60 s). On each tick the daemon
//! walks the job vector; jobs whose individual `interval` has elapsed
//! since their last run AND whose `predicate` returns `true` are run
//! in declared order, with errors logged at warn level (no propagation
//! — the next tick retries naturally). Jobs run sequentially within a
//! single tick rather than in parallel because (a) most jobs touch the
//! same DB pool and serialisation kills lock contention, (b) the
//! deferred jobs are cheap relative to the 60 s ticker so a short
//! pile-up never amplifies, and (c) sequential ordering makes the log
//! trace easier to read during an incident.
//!
//! Lifecycle: shutdown via the same shared `AtomicBool` shape used by
//! [`crate::draft::spawn_orphan_drafts_sweeper`] and
//! [`crate::materializer::retry_queue::spawn_sweeper`] — the daemon
//! polls the flag at the top of each tick and exits cleanly. The
//! per-job `predicate` closure is the right hook for app-state gating
//! (e.g. "only run when backgrounded" via `LifecycleHooks::is_foreground`,
//! "only when the writer pool is idle", etc.) — see `wal_checkpoint_truncate`
//! below for the canonical pattern.
//!
//! Initial job set (this sub-item, B):
//!   - [`wal_checkpoint_truncate`] — runs `PRAGMA wal_checkpoint(TRUNCATE)`
//!     against the write pool on a 1 h cadence to keep the SQLite WAL
//!     file from growing unbounded (field-observed at 19.8 MB on a 3-month
//!     dev install). Bounded with a TRUNCATE checkpoint rather than the
//!     PASSIVE autocheckpoint that runs at 5000 frames; PASSIVE never
//!     shrinks the WAL file even when it could.

use crate::error::AppError;
use sqlx::SqlitePool;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// Type alias for a maintenance job's async body. Factored out to
/// satisfy clippy's `type_complexity` lint at the `MaintenanceJob.run`
/// field.
type JobFuture = Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>>;

/// Type alias for a maintenance job's body closure. Returns a
/// [`JobFuture`] each invocation so callers can take ownership of a
/// fresh future per tick.
type JobRunFn = Box<dyn Fn() -> JobFuture + Send + Sync>;

/// Type alias for a maintenance job's gating predicate. Sync because
/// every predicate in the v1 job set is a cheap atomic / counter check.
type JobPredicate = Box<dyn Fn() -> bool + Send + Sync>;

/// Daemon cadence — the outer ticker fires every [`TICK_INTERVAL`] and
/// the daemon walks every job, running the ones whose individual
/// `interval` has elapsed since their `last_run`. A 60 s outer tick is
/// fast enough that the longest-cadence job (`op_log_compact` at 24 h)
/// fires within ~1 min of its target time, and slow enough that the
/// tick itself is invisible cost.
pub const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// Issue #157 — one periodic maintenance task.
///
/// `predicate` gates the per-tick decision: returning `false` skips
/// this job for the tick without updating `last_run`, so the job
/// "catches up" as soon as the predicate returns true again. Both
/// `predicate` and `run` are owned closures, so a job can capture any
/// state it needs (DB pools, lifecycle hooks, materializer handles,
/// flags) at construction time.
pub struct MaintenanceJob {
    /// Static name used in the structured log fields.
    pub name: &'static str,
    /// Wall-clock target between successful runs.
    pub interval: Duration,
    /// Last time `run` was invoked, in monotonic instants. `None`
    /// means "never run in this process" — the first eligible tick
    /// fires the job immediately rather than waiting one `interval`.
    pub last_run: Option<Instant>,
    /// Gating predicate. Returning `false` skips the job for this
    /// tick without bumping `last_run`.
    pub predicate: JobPredicate,
    /// Job body. Returns `Result<(), AppError>` so a failure logs at
    /// warn with the job name + error; the daemon does not propagate.
    pub run: JobRunFn,
}

impl std::fmt::Debug for MaintenanceJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MaintenanceJob")
            .field("name", &self.name)
            .field("interval", &self.interval)
            .field("last_run", &self.last_run)
            .finish_non_exhaustive()
    }
}

/// Issue #157 — the first job: TRUNCATE-checkpoint the WAL on a 1 h
/// cadence. SQLite's `PRAGMA wal_autocheckpoint` (default 1000, our
/// pool sets it to 5000 in `db::init_pool`) only fires PASSIVE
/// checkpoints, which copy pages back to the main DB but never resize
/// the WAL file. TRUNCATE actively shrinks the WAL when a clean
/// snapshot exists. The 19.8 MB WAL footprint observed on the
/// 3-month dev install (per #157's forensic table) is what this
/// trims.
///
/// `PRAGMA wal_checkpoint(TRUNCATE)` returns one row `(busy, log,
/// checkpointed)`. `busy != 0` indicates a concurrent reader/writer
/// held the WAL open; we log at debug and skip — the next tick
/// retries. Errors log at warn with the underlying sqlx message.
pub async fn wal_checkpoint_truncate(write_pool: &SqlitePool) -> Result<(), AppError> {
    let row: (i64, i64, i64) =
        sqlx::query_as::<_, (i64, i64, i64)>("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(write_pool)
            .await?;
    let (busy, log_pages, checkpointed) = row;
    if busy != 0 {
        tracing::debug!(
            busy,
            log_pages,
            checkpointed,
            "wal_checkpoint(TRUNCATE) skipped — concurrent reader/writer holds the WAL"
        );
    } else {
        tracing::info!(log_pages, checkpointed, "wal_checkpoint(TRUNCATE) ran");
    }
    Ok(())
}

/// Issue #157 sub-item C — periodic op-log compaction, 24 h cadence,
/// idle predicate.
///
/// Delegates to [`crate::commands::compaction::compact_op_log_cmd_inner`]
/// with the 90-day retention window — matches the figure named in the
/// #157 plan table. The inner function is what the user's manual
/// "Compact op log" UI button calls (`commands/compaction.rs:259`); the
/// only differences here are (a) the daemon supplies a fixed
/// `retention_days = 90` so no UI is involved, and (b) the
/// daemon's idle predicate prevents the compaction (which writes
/// op-log DELETEs + a snapshot row) from contending with active
/// editing.
pub async fn op_log_compact(write_pool: &SqlitePool, device_id: &str) -> Result<(), AppError> {
    let result =
        crate::commands::compaction::compact_op_log_cmd_inner(write_pool, device_id, 90).await?;
    if result.ops_deleted > 0 {
        tracing::info!(
            ops_deleted = result.ops_deleted,
            snapshot_id = ?result.snapshot_id,
            "op_log_compact (daemon, 90d retention) deleted op-log rows"
        );
    } else {
        tracing::debug!("op_log_compact (daemon, 90d retention): nothing eligible");
    }
    Ok(())
}

/// Issue #157 sub-item G — periodic `PRAGMA optimize` tick, 4 h
/// cadence, always-on predicate.
pub async fn pragma_optimize(write_pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query("PRAGMA optimize").execute(write_pool).await?;
    tracing::debug!("pragma_optimize tick ran");
    Ok(())
}

/// Issue #157 sub-item F — enqueue `CleanupOrphanedAttachments` on a
/// 24 h cadence (closes MAINT-229). The materializer's
/// `cleanup_orphaned_attachments` handler walks the `attachments/`
/// subtree and reconciles it against the `attachments` table. Prior
/// to this job the task was only enqueued from the post-compaction
/// code path and the boot-time shim, so installs that never ran
/// manual compact accumulated orphan files. Enqueue failures bubble
/// out as `AppError::Channel`; the bg queue's saturation path
/// persists shed tasks to `materializer_retry_queue` so nothing is
/// dropped silently.
pub async fn enqueue_cleanup_orphaned_attachments(
    materializer: &crate::materializer::Materializer,
) -> Result<(), AppError> {
    materializer
        .try_enqueue_background(crate::materializer::MaterializeTask::CleanupOrphanedAttachments)
        .map_err(|e| {
            AppError::Channel(format!("cleanup_orphaned_attachments enqueue failed: {e}"))
        })?;
    tracing::debug!("cleanup_orphaned_attachments tick enqueued");
    Ok(())
}

/// Issue #157 sub-item J — enqueue `FtsOptimize` on a 24 h cadence,
/// gated on `fts_edits_since_optimize > 0`. FTS5 indexes fragment on
/// delete-/update-heavy workloads; `dispatch.rs` only optimizes on
/// write paths so a read-only session after some deletes never runs
/// it. Metric resets in the handler so subsequent ticks see false
/// until more edits accumulate.
pub async fn enqueue_fts_idle_optimize(
    materializer: &crate::materializer::Materializer,
) -> Result<(), AppError> {
    materializer
        .try_enqueue_background(crate::materializer::MaterializeTask::FtsOptimize)
        .map_err(|e| AppError::Channel(format!("fts_idle_optimize enqueue failed: {e}")))?;
    tracing::debug!("fts_idle_optimize tick enqueued");
    Ok(())
}

/// Spawn the maintenance daemon. Mirrors the shape of
/// [`crate::draft::spawn_orphan_drafts_sweeper`] and
/// [`crate::materializer::retry_queue::spawn_sweeper`]: fire-and-forget,
/// polls a shared shutdown flag on each tick, sequential job execution.
///
/// `jobs` is the per-process job set. The daemon takes ownership of
/// each entry's predicate/run closures. The closures themselves can
/// hold any state they need (pools, materializer handles, etc.) and
/// the daemon doesn't introspect their captures.
#[cfg(not(tarpaulin_include))]
pub fn spawn_daemon(jobs: Vec<MaintenanceJob>, shutdown_flag: Arc<AtomicBool>) {
    #[cfg(not(test))]
    let spawn_fn = tauri::async_runtime::spawn;
    #[cfg(test)]
    let spawn_fn = tokio::spawn;

    let _handle = spawn_fn(async move {
        let mut jobs = jobs;
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        // skip the immediate first tick — match the
        // spawn_orphan_drafts_sweeper convention so cold-start doesn't
        // double-fire a job that the surrounding boot sequence may
        // already be running.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if shutdown_flag.load(Ordering::Acquire) {
                break;
            }
            run_tick(&mut jobs).await;
        }
    });
}

/// Single-tick body, factored out for testability — `spawn_daemon`'s
/// loop is `#[cfg(not(tarpaulin_include))]` (it's a fire-and-forget
/// `tokio::spawn` wrapper) but `run_tick` is a pure function over a
/// `&mut Vec<MaintenanceJob>` and is exercised directly by the unit
/// tests below.
pub async fn run_tick(jobs: &mut [MaintenanceJob]) {
    let now = Instant::now();
    for job in jobs.iter_mut() {
        let due = match job.last_run {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= job.interval,
        };
        if !due {
            continue;
        }
        if !(job.predicate)() {
            tracing::debug!(job = job.name, "maintenance job skipped — predicate false");
            continue;
        }
        let result = (job.run)().await;
        job.last_run = Some(Instant::now());
        match result {
            Ok(()) => tracing::debug!(job = job.name, "maintenance job ran"),
            Err(e) => tracing::warn!(job = job.name, error = %e, "maintenance job failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn dummy_predicate_true() -> JobPredicate {
        Box::new(|| true)
    }

    fn dummy_predicate_false() -> JobPredicate {
        Box::new(|| false)
    }

    fn counter_job(
        name: &'static str,
        interval: Duration,
        counter: Arc<AtomicUsize>,
        predicate: JobPredicate,
    ) -> MaintenanceJob {
        MaintenanceJob {
            name,
            interval,
            last_run: None,
            predicate,
            run: Box::new(move || {
                let counter = counter.clone();
                Box::pin(async move {
                    counter.fetch_add(1, Ordering::Relaxed);
                    Ok(())
                })
            }),
        }
    }

    /// First tick fires every job whose predicate is true — `last_run`
    /// starts at `None` so the daemon treats the job as immediately
    /// due. Pins the "no warm-up wait on cold start" behaviour the
    /// surrounding boot sequence relies on.
    #[tokio::test]
    async fn run_tick_fires_jobs_with_no_prior_run_when_predicate_true() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut jobs = vec![counter_job(
            "test_job",
            Duration::from_secs(3600),
            counter.clone(),
            dummy_predicate_true(),
        )];
        run_tick(&mut jobs).await;
        assert_eq!(
            counter.load(Ordering::Relaxed),
            1,
            "first tick must fire a job whose last_run is None"
        );
        assert!(
            jobs[0].last_run.is_some(),
            "last_run must be set after the job ran"
        );
    }

    /// A job whose predicate returns false is skipped and `last_run`
    /// is NOT updated, so the job "catches up" as soon as the
    /// predicate returns true. Pins the "skip without bumping" rule.
    #[tokio::test]
    async fn run_tick_skips_when_predicate_false_and_preserves_last_run() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut jobs = vec![counter_job(
            "skipped_job",
            Duration::from_secs(3600),
            counter.clone(),
            dummy_predicate_false(),
        )];
        run_tick(&mut jobs).await;
        assert_eq!(
            counter.load(Ordering::Relaxed),
            0,
            "predicate-false job must not run"
        );
        assert!(
            jobs[0].last_run.is_none(),
            "last_run must stay None so the job runs on the next true predicate"
        );
    }

    /// A job whose interval has not yet elapsed is skipped without
    /// re-running. Pins the per-job-interval guard.
    #[tokio::test]
    async fn run_tick_skips_jobs_whose_interval_has_not_elapsed() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut jobs = vec![counter_job(
            "interval_guarded_job",
            // Long interval so the second tick is still NOT due even
            // immediately after the first.
            Duration::from_secs(3600),
            counter.clone(),
            dummy_predicate_true(),
        )];
        run_tick(&mut jobs).await;
        assert_eq!(counter.load(Ordering::Relaxed), 1, "first tick runs job");
        run_tick(&mut jobs).await;
        assert_eq!(
            counter.load(Ordering::Relaxed),
            1,
            "second tick (well within interval) must NOT re-run the job"
        );
    }

    /// `wal_checkpoint_truncate` returns Ok on a freshly-initialised
    /// in-memory pool (no WAL traffic ⇒ trivial busy=0 result).
    /// Smoke-tests the PRAGMA invocation shape against the real sqlx
    /// driver so a future SQLite/sqlx upgrade that changes the
    /// `PRAGMA wal_checkpoint(TRUNCATE)` return shape surfaces here.
    #[tokio::test]
    async fn wal_checkpoint_truncate_smoke_test() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        wal_checkpoint_truncate(&pool)
            .await
            .expect("wal_checkpoint(TRUNCATE) must succeed on a clean pool");
    }

    /// Issue #157 sub-item G — `pragma_optimize` smoke test.
    #[tokio::test]
    async fn pragma_optimize_smoke_test_157_g() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        pragma_optimize(&pool)
            .await
            .expect("PRAGMA optimize must succeed on a clean pool");
    }

    /// Issue #157 sub-item C — `op_log_compact` smoke test (no-op
    /// path on a clean pool with no aged op-log rows).
    #[tokio::test]
    async fn op_log_compact_smoke_test_157_c() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        op_log_compact(&pool, "test-device")
            .await
            .expect("op_log_compact must succeed on a clean pool with no aged op-log rows");
    }

    /// Issue #157 sub-item F — `enqueue_cleanup_orphaned_attachments`
    /// puts a task on the materializer background queue.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enqueue_cleanup_orphaned_attachments_smoke_test_157_f() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        enqueue_cleanup_orphaned_attachments(&mat)
            .await
            .expect("enqueue must succeed on a fresh Materializer with empty bg queue");
    }

    /// Issue #157 sub-item J — `enqueue_fts_idle_optimize` puts a
    /// task on the materializer background queue. Predicate gating
    /// lives at the spawn site in lib.rs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enqueue_fts_idle_optimize_smoke_test_157_j() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        enqueue_fts_idle_optimize(&mat)
            .await
            .expect("enqueue must succeed on a fresh Materializer with empty bg queue");
    }
}
