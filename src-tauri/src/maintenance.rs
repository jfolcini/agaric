//! Issue #157 — `MaintenanceDaemon`.
//!
//! A general-purpose maintenance loop for periodic cleanups that do not
//! belong inside the materializer's hot path. Modelled on
//! [`crate::draft::spawn_orphan_drafts_sweeper`] (single `tokio::spawn` +
//! `tokio::time::interval` ticker) but generalised over a vector of
//! [`MaintenanceJob`] entries, so new jobs are added simply by extending
//! the vector at the spawn site (see `lib.rs`) without re-wiring the daemon.
//!
//! Cadence: a fixed [`TICK_INTERVAL`] (60 s). On each tick the daemon
//! walks the job vector; jobs whose individual `interval` has elapsed
//! since their last run AND whose `predicate` returns `true` are run
//! in declared order, with errors logged at warn level (no propagation
//! — a failed job is retried only after its own `interval` elapses again, not on the very next tick). Jobs run sequentially within a
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
//! Registered jobs (wired at the `lib.rs` spawn site; bodies live in
//! this file):
//!   - [`wal_checkpoint_truncate`] — runs `PRAGMA wal_checkpoint(TRUNCATE)`
//!     against the write pool on a 1 h cadence to keep the SQLite WAL
//!     file from growing unbounded (field-observed at 19.8 MB on a 3-month
//!     dev install). Bounded with a TRUNCATE checkpoint rather than the
//!     PASSIVE autocheckpoint that runs at 5000 frames; PASSIVE never
//!     shrinks the WAL file even when it could.
//!   - [`op_log_compact`] — prunes the op log (24 h cadence, idle
//!     predicate, 90-day retention).
//!   - [`pragma_optimize`] — periodic `PRAGMA optimize` (4 h cadence).
//!   - [`tombstone_purge`] — purges expired tombstones (24 h cadence,
//!     idle predicate, 90-day retention).
//!   - `enqueue_cleanup_orphaned_attachments`, `enqueue_fts_idle_optimize`,
//!     [`loro_snapshot_if_dirty`], and `projected_agenda_midnight_tick` —
//!     the remaining materializer-enqueue / snapshot / agenda jobs.

use crate::error::AppError;
use chrono::Datelike;
use sqlx::SqlitePool;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
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

/// Issue #157 sub-item F — enqueue `CleanupOrphanedAttachments`.
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

/// Issue #157 sub-item J — enqueue `FtsOptimize`.
pub async fn enqueue_fts_idle_optimize(
    materializer: &crate::materializer::Materializer,
) -> Result<(), AppError> {
    materializer
        .try_enqueue_background(crate::materializer::MaterializeTask::FtsOptimize)
        .map_err(|e| AppError::Channel(format!("fts_idle_optimize enqueue failed: {e}")))?;
    tracing::debug!("fts_idle_optimize tick enqueued");
    Ok(())
}

/// Issue #157 sub-item E — retention window for soft-deleted blocks.
/// 90 days mirrors `op_log_compact`'s retention.
pub const TOMBSTONE_RETENTION_DAYS: i64 = 90;

/// Per-tick cap matching `MAX_BATCH_BLOCK_IDS`.
const TOMBSTONE_PURGE_BATCH_LIMIT: i64 = 1000;

/// Issue #157 sub-item E — hard-purge soft-deleted blocks whose
/// `deleted_at` is older than [`TOMBSTONE_RETENTION_DAYS`]. Delegates
/// to `purge_blocks_by_ids_inner` so the cascade order, FK-defer,
/// op-log emission, and post-commit dispatch all share one tested
/// code path with the manual "Empty Trash" UI button.
///
/// **Per-run cap:** at most [`TOMBSTONE_PURGE_BATCH_LIMIT`] rows are
/// processed per invocation. Since this job runs on a 24 h cadence, a
/// large accumulated backlog (e.g. after a long offline period) drains
/// over multiple days rather than in a single blocking transaction.
pub async fn tombstone_purge(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &crate::materializer::Materializer,
) -> Result<(), AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS);
    // #109 Phase 2: blocks.deleted_at is INTEGER epoch-ms; compare against the
    // cutoff as ms, not an rfc3339 string.
    let cutoff_ms = cutoff.timestamp_millis();

    let batch_limit = TOMBSTONE_PURGE_BATCH_LIMIT;
    let ids: Vec<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks \
         WHERE deleted_at IS NOT NULL AND deleted_at < ? \
         ORDER BY deleted_at ASC \
         LIMIT ?",
        cutoff_ms,
        batch_limit
    )
    .fetch_all(pool)
    .await?;

    if ids.is_empty() {
        tracing::debug!(
            cutoff = %cutoff_ms,
            "tombstone_purge: nothing eligible past the retention window"
        );
        return Ok(());
    }

    let count = ids.len();
    let _resp = crate::commands::blocks::crud::purge_blocks_by_ids_inner(
        pool,
        device_id,
        materializer,
        ids.into_iter().map(Into::into).collect(),
    )
    .await?;

    tracing::info!(
        purged = count,
        cutoff = %cutoff_ms,
        "tombstone_purge: hard-deleted soft-tombstones past the retention window"
    );
    Ok(())
}

/// Issue #157 sub-item I — persist all Loro engine snapshots when
/// the registry's `dirty_count` proxy indicates at least one engine
/// has been touched since the last save. Predicate gating
/// (`dirty_count > 0 && !is_foreground`) lives at the spawn site;
/// the pass itself resets the dirty counter to 0 on success.
/// `shared::get() == None` (registry not yet initialised) skips
/// the tick.
pub async fn loro_snapshot_if_dirty(write_pool: &SqlitePool) -> Result<(), AppError> {
    let Some(state) = crate::loro::shared::get() else {
        tracing::debug!(
            "loro_snapshot_if_dirty: shared::get() returned None (registry not yet \
             initialised); skipping tick"
        );
        return Ok(());
    };
    let ok = crate::loro::snapshot::save_all_engines(write_pool, &state.registry).await;
    tracing::debug!(saved = ok, "loro_snapshot_if_dirty tick ran");
    Ok(())
}

/// Issue #157 sub-item H — fire `RebuildProjectedAgendaCache` at most
/// once per UTC calendar day. The daemon's outer ticker fires every
/// `TICK_INTERVAL` (60 s); this body keeps a "last-fired UTC
/// day-number" in a shared atomic, compares it to today's day-number,
/// and enqueues only when the value advances. Sentinel `i32::MIN` =
/// "never fired" so the first tick post-boot always fires (the
/// projected agenda may be stale if the previous session ended
/// before its own midnight tick). CAS-on-update prevents double-
/// enqueue under concurrent ticks racing across midnight.
pub async fn projected_agenda_midnight_tick(
    materializer: &crate::materializer::Materializer,
    last_fired_day: &AtomicI32,
) -> Result<(), AppError> {
    let today = chrono::Utc::now().date_naive().num_days_from_ce();
    let previous = last_fired_day.load(Ordering::Acquire);
    if previous == today {
        return Ok(());
    }
    if last_fired_day
        .compare_exchange(previous, today, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    materializer
        .try_enqueue_background(crate::materializer::MaterializeTask::RebuildProjectedAgendaCache)
        .map_err(|e| AppError::Channel(format!("projected_agenda_midnight enqueue failed: {e}")))?;
    tracing::info!(
        previous_day = previous,
        today,
        "projected_agenda_midnight: UTC day rolled — RebuildProjectedAgendaCache enqueued"
    );
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
/// loop is a fire-and-forget `tokio::spawn` wrapper, but `run_tick` is a
/// pure function over a `&mut Vec<MaintenanceJob>` and is exercised
/// directly by the unit tests below.
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
        match result {
            Ok(()) => {
                job.last_run = Some(Instant::now());
                tracing::debug!(job = job.name, "maintenance job ran");
            }
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

    /// A failing job must NOT advance `last_run`, so it is retried on the
    /// next tick (as soon as its `interval` elapses from the *previous*
    /// successful run, or immediately if it has never succeeded). Pins the
    /// corrected retry-on-failure behavior: `last_run` is updated only on
    /// `Ok`, never on `Err`.
    #[tokio::test]
    async fn run_tick_does_not_advance_last_run_on_failure() {
        let job = MaintenanceJob {
            name: "failing_job",
            interval: Duration::from_secs(3600),
            last_run: None,
            predicate: dummy_predicate_true(),
            run: Box::new(|| {
                Box::pin(async { Err(AppError::Validation("simulated job failure".into())) })
            }),
        };
        let mut jobs = vec![job];
        run_tick(&mut jobs).await;
        assert!(
            jobs[0].last_run.is_none(),
            "last_run must stay None after a failing job so it is retried immediately on the next tick"
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

    /// Issue #157 sub-item C — `op_log_compact` smoke test.
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

    /// Issue #157 sub-item F — `enqueue_cleanup_orphaned_attachments` smoke test.
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

    /// Issue #157 sub-item J — `enqueue_fts_idle_optimize` smoke test.
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

    /// Issue #157 sub-item E — `tombstone_purge` is a no-op when no
    /// rows are past the retention cutoff.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_purge_skips_when_nothing_eligible_157_e() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let recent_deleted_at = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES ('AAAA', 'content', 'alive', NULL, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES ('BBBB', 'content', 'recently soft-deleted', NULL, 2, ?)",
        )
        .bind(recent_deleted_at)
        .execute(&pool)
        .await
        .unwrap();

        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("tombstone_purge must succeed when nothing is eligible");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 2,
            "neither the alive row nor the recent tombstone may be purged"
        );
    }

    /// Issue #157 sub-item E — `tombstone_purge` hard-deletes
    /// soft-tombstones whose `deleted_at` is past the retention cutoff.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_purge_removes_aged_tombstones_157_e() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();
        let recent_deleted_at = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES ('AGED', 'content', 'aged tombstone', NULL, 1, ?)",
        )
        .bind(aged_deleted_at)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES ('REC0', 'content', 'recent tombstone', NULL, 2, ?)",
        )
        .bind(recent_deleted_at)
        .execute(&pool)
        .await
        .unwrap();

        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("tombstone_purge must succeed");

        let aged_present: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'AGED'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(aged_present, 0, "aged tombstone must be hard-purged");

        let recent_present: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'REC0'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            recent_present, 1,
            "recent tombstone must stay (still inside retention window)"
        );
    }

    /// Issue #157 sub-item I — `loro_snapshot_if_dirty` is safe to
    /// call when the loro shared state has not been initialised.
    #[tokio::test]
    async fn loro_snapshot_if_dirty_smoke_test_no_shared_state_157_i() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        loro_snapshot_if_dirty(&pool)
            .await
            .expect("loro_snapshot_if_dirty must succeed when shared::get() returns None");
    }

    /// Issue #157 sub-item H — first call post-boot fires (sentinel
    /// `i32::MIN`), and the atomic advances to today's day-number.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_midnight_fires_on_first_call_157_h() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        let last_day = AtomicI32::new(i32::MIN);

        projected_agenda_midnight_tick(&mat, &last_day)
            .await
            .expect("first call must succeed (enqueue path)");

        let today = chrono::Utc::now().date_naive().num_days_from_ce();
        assert_eq!(
            last_day.load(Ordering::Acquire),
            today,
            "last_fired_day must be updated to today's day-number after the first enqueue"
        );
    }

    /// Issue #157 sub-item H — same-day tick is a no-op.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_midnight_skips_same_day_157_h() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        let today = chrono::Utc::now().date_naive().num_days_from_ce();
        let last_day = AtomicI32::new(today);

        projected_agenda_midnight_tick(&mat, &last_day)
            .await
            .expect("same-day tick must succeed (short-circuit path)");

        assert_eq!(
            last_day.load(Ordering::Acquire),
            today,
            "last_fired_day must NOT change on a same-day tick"
        );
    }

    /// Issue #157 sub-item H — day-rollover tick fires and advances
    /// the atomic to today.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_midnight_fires_on_day_rollover_157_h() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        let today = chrono::Utc::now().date_naive().num_days_from_ce();
        let yesterday = today - 1;
        let last_day = AtomicI32::new(yesterday);

        projected_agenda_midnight_tick(&mat, &last_day)
            .await
            .expect("day-rollover tick must succeed (enqueue path)");

        assert_eq!(
            last_day.load(Ordering::Acquire),
            today,
            "last_fired_day must advance to today after the rollover enqueue"
        );
    }
}
