//! Issue #157 — `MaintenanceDaemon`.
//!
//! A general-purpose maintenance loop for periodic cleanups that do not
//! belong inside the materializer's hot path. Modelled on
//! [`agaric_engine::draft::spawn_orphan_drafts_sweeper`] (single `tokio::spawn` +
//! `tokio::time::interval` ticker) but generalised over a vector of
//! [`MaintenanceJob`] entries, so new jobs are added simply by extending
//! the vector at the spawn site (see `lib.rs`) without re-wiring the daemon.
//!
//! Cadence: a fixed [`TICK_INTERVAL`] (60 s). On each tick the daemon
//! walks the job vector; jobs whose individual `interval` has elapsed
//! since their last SUCCESSFUL run AND whose `predicate` returns `true`
//! are run in declared order, with errors logged at warn level and never
//! propagated.
//!
//! Retry-on-failure (#3311): a failed job is retried on the very NEXT
//! tick, not after its own `interval` elapses again — `run_tick` advances
//! `last_run` only on `Ok`, so a job that has never succeeded stays
//! permanently due. This is deliberate (and pinned by
//! `run_tick_does_not_advance_last_run_on_failure`): the realistic failure
//! for these jobs is transient — SQLITE_BUSY on the single writer, a
//! momentarily unavailable pool — and rate-limiting the retry to the job's
//! own 1 h / 24 h cadence would delay reclaiming WAL space, op-log rows and
//! tombstones by that long for a failure that would have cleared in
//! seconds. The cost of the other case, a DETERMINISTICALLY failing job, is
//! one predicate-gated attempt plus one warn line per 60 s until it is
//! fixed; there is no failure counter and no backoff. Job bodies that can
//! fail per-item are expected to be poison-tolerant internally (see
//! [`tombstone_purge`]) rather than to rely on the daemon backing off.
//!
//! #4018/#4020 — that expectation has a limit worth stating, because
//! internal poison-tolerance and this next-tick retry pull against each
//! other: a body that swallows EVERY failure into `Ok` also opts itself out
//! of the retry described above, and its next attempt is then gated by its
//! own 24 h interval. [`tombstone_purge`] therefore draws the line at the
//! failure shape named here — a busy writer stays an `Err`, precisely so it
//! keeps the 60 s retry this paragraph promises, while genuinely poison
//! per-item failures are still absorbed internally.
//!
//! Jobs run sequentially within a
//! single tick rather than in parallel because (a) most jobs touch the
//! same DB pool and serialisation kills lock contention, (b) the
//! deferred jobs are cheap relative to the 60 s ticker so a short
//! pile-up never amplifies, and (c) sequential ordering makes the log
//! trace easier to read during an incident.
//!
//! Lifecycle: shutdown via the same shared `AtomicBool` shape used by
//! [`agaric_engine::draft::spawn_orphan_drafts_sweeper`] and
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

use agaric_core::error::AppError;
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
    /// #3311: last time `run` SUCCEEDED, in monotonic instants — NOT the
    /// last time it was invoked. A run that returns `Err` leaves this
    /// untouched, so a failing job stays due and is retried on the very next
    /// tick (see the retry-on-failure note in the module docs). `None`
    /// means "never succeeded in this process" — the first eligible tick
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
#[tracing::instrument(skip_all, err)]
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

/// Per-batch cap matching `MAX_BATCH_BLOCK_IDS`. Each delete
/// transaction processes at most this many rows so a single purge never
/// holds a long write lock.
///
/// Under `cfg(test)` the limit is shrunk to a handful of rows (mirroring
/// the `#[cfg(not(test))]` / `#[cfg(test)]` value-switch already used by
/// `spawn_daemon`'s `spawn_fn`) so a test can drive the batch ceiling and
/// rollover cheaply — driving the production 1000-row batches × 50-batch
/// ceiling would require seeding 50k+ tombstone rows. Production behaviour
/// is unchanged: the `cfg(not(test))` arm keeps the real 1000 / 50 values.
#[cfg(not(test))]
const TOMBSTONE_PURGE_BATCH_LIMIT: i64 = 1000;
#[cfg(test)]
const TOMBSTONE_PURGE_BATCH_LIMIT: i64 = 3;

/// `usize` companion to [`TOMBSTONE_PURGE_BATCH_LIMIT`] for comparing
/// against `Vec::len()` without a lossy cast. Kept in lock-step with the
/// i64 constant under both cfgs.
#[cfg(not(test))]
const TOMBSTONE_PURGE_BATCH_LIMIT_USIZE: usize = 1000;
#[cfg(test)]
const TOMBSTONE_PURGE_BATCH_LIMIT_USIZE: usize = 3;

/// Per-invocation ceiling on the number of bounded batches drained in a
/// single `tombstone_purge` run. With a [`TOMBSTONE_PURGE_BATCH_LIMIT`]
/// of 1000 this caps one run at 50k rows, so even a very large backlog
/// (e.g. after a long offline period) clears within a handful of 24 h
/// ticks instead of ~1 batch/day — while still bounding *each* delete to
/// one short transaction and yielding back to the runtime between
/// batches. Anything beyond the ceiling rolls over to the next tick.
///
/// Under `cfg(test)` the ceiling is shrunk so the per-run cap is reached
/// with a tiny, cheaply-seeded backlog (test batch limit 3 × ceiling 4 =
/// 12 rows purged per run). Production keeps the real 50-batch ceiling.
#[cfg(not(test))]
const TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN: usize = 50;
#[cfg(test)]
const TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN: usize = 4;

/// #4018 — is `err` the single SQLite writer being BUSY/LOCKED, rather than
/// a root that cannot be purged?
///
/// The #3311 per-root fallback in [`tombstone_purge`] exists to isolate a
/// POISON root: one whose own rows trip a constraint or a trigger, so
/// retrying it alone costs one root and lets the rest of the batch drain.
/// Lock contention falsifies that premise outright — nothing about any
/// individual root is wrong, and every per-root retry simply re-queues
/// behind the same writer that just refused the batch.
///
/// The cost of getting this wrong is not a wasted branch. At production
/// scale one transient `SQLITE_BUSY` sends the fallback through
/// [`TOMBSTONE_PURGE_BATCH_LIMIT`] (1000) further `BEGIN IMMEDIATE`
/// attempts, and the drain loop then opens the next batch into the same
/// contention, up to `× TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN` (50). Each of
/// those attempts does not fail fast either: the pool sets a 5 s
/// `busy_timeout` (`agaric_store::db::base_connect_options`), so they are
/// SERIALISED multi-second waits against the one writer the foreground UI
/// also needs — hours of self-inflicted contention in response to a
/// condition that would have cleared in seconds.
///
/// Classified on the SQLite PRIMARY result code (`extended & 0xFF`), so
/// every extended `SQLITE_BUSY_*` / `SQLITE_LOCKED_*` variant (261, 262,
/// 517, 518, 773, …) is covered without enumerating a list that a future
/// SQLite release can extend. [`AppError::PoolTimedOut`] is the same signal
/// one layer out — every write connection in the pool is already occupied,
/// so the batch never even reached SQLite.
///
/// Deliberately NOT matched: constraint/trigger failures (the #3311 poison
/// shape, which `tombstone_purge_skips_poison_root_and_drains_the_rest_3311`
/// drives through `RAISE(ABORT)` → `SQLITE_CONSTRAINT_TRIGGER`), which keep
/// the per-root fallback they were written for.
fn is_write_contention(err: &AppError) -> bool {
    /// SQLite primary result code `SQLITE_BUSY`.
    const SQLITE_BUSY: i32 = 5;
    /// SQLite primary result code `SQLITE_LOCKED`.
    const SQLITE_LOCKED: i32 = 6;
    match err {
        AppError::PoolTimedOut => true,
        AppError::Database(sqlx::Error::Database(db_err)) => db_err
            .code()
            .and_then(|code| code.parse::<i32>().ok())
            .is_some_and(|code| matches!(code & 0xFF, SQLITE_BUSY | SQLITE_LOCKED)),
        _ => false,
    }
}

/// Issue #157 sub-item E — hard-purge soft-deleted blocks whose
/// `deleted_at` is older than [`TOMBSTONE_RETENTION_DAYS`]. Delegates
/// to `purge_blocks_by_ids_inner` so the cascade order, FK-defer,
/// op-log emission, and post-commit dispatch all share one tested
/// code path with the manual "Empty Trash" UI button.
///
/// **Bounded catch-up drain:** each delete transaction processes at most
/// [`TOMBSTONE_PURGE_BATCH_LIMIT`] rows (so no single purge holds a long
/// write lock), but a run loops over successive batches — re-querying
/// eligible rows after each — until the backlog is empty or the
/// [`TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN`] ceiling is hit. This lets a
/// large accumulated backlog drain within a few 24 h ticks rather than
/// at ~1000 rows/day, while keeping every individual delete batched and
/// bounded. The eligibility predicate (`deleted_at < cutoff`) is
/// unchanged; only the per-run throughput grows.
///
/// **Poison tolerance (#3311):** a batch that fails to purge no longer
/// aborts the run. This is the same contract every other unattended loop
/// in this domain already honours — `replay_unmaterialized_ops` logs and
/// continues per op, `replay_sync_inbox` advances its cursor past poison
/// slots, `save_all_engines` logs and continues per space — and it matters
/// most here because this is the only unattended disk-space-reclaiming
/// path: a single bad root used to leave `blocks` growing monotonically
/// with tombstones that were never reclaimed. On a batch error the run
/// retries that batch ONE ROOT AT A TIME, so only the genuinely poison
/// roots are skipped, and those roots are then excluded for the remainder
/// of the run (which is what keeps the drain loop from re-selecting them
/// forever). Skipped roots stay eligible and are retried on the next run,
/// because the exclusion list is per-invocation and holds nothing durable.
///
/// **Contention is not poison (#4018):** the per-root fallback above is
/// entered ONLY for a failure that could plausibly belong to one root. A
/// busy/locked writer is the one failure shape that provably does not (see
/// [`is_write_contention`]), and it is the shape these jobs actually hit —
/// so it abandons the run with `Err` instead of re-queueing every root
/// behind the same lock. Returning `Err` rather than `Ok` is load-bearing
/// twice over: it is what stops the drain loop from opening the NEXT
/// batch into the same contention, and it is what re-arms `run_tick`'s
/// retry-on-failure (this module's header) so the retry lands on the next
/// 60 s tick instead of 24 h from now — the cadence a transient
/// `SQLITE_BUSY` deserves. Rows purged before the contention stay purged:
/// every batch commits in its own transaction.
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
    let mut total_purged: usize = 0;
    let mut batches: usize = 0;
    // #3311 — roots that failed to purge during THIS run. Excluded from
    // later batches so the drain loop keeps making progress instead of
    // re-selecting the same poison rows forever. Nothing durable is
    // written: the next run retries them from scratch.
    //
    // A SET, not a Vec: this is scanned once per fetched id and `fetch_limit`
    // grows with it, so in the worst case (every root fails — pool down, a
    // persistent `SQLITE_BUSY`) the last batch filters ~`batch_limit +
    // poisoned.len()` ids against ~`poisoned.len()` entries. Linear `contains`
    // makes that quadratic in the batch ceiling for no reason.
    let mut poisoned: std::collections::HashSet<String> = std::collections::HashSet::new();

    loop {
        // #3311 — widen the read window by the number of known-poison roots
        // so that dropping them below still leaves a FULL batch of live
        // candidates. At most `poisoned.len()` of the fetched rows can be
        // poison, so this cannot under-fill a batch (which the
        // short-batch-means-backlog-exhausted break below relies on).
        let fetch_limit = batch_limit
            .saturating_add(i64::try_from(poisoned.len()).unwrap_or(i64::MAX - batch_limit));
        let ids: Vec<String> = sqlx::query_scalar!(
            "SELECT id FROM blocks \
             WHERE deleted_at IS NOT NULL AND deleted_at < ? \
             ORDER BY deleted_at ASC \
             LIMIT ?",
            cutoff_ms,
            fetch_limit
        )
        .fetch_all(pool)
        .await?;

        let ids: Vec<String> = ids
            .into_iter()
            .filter(|id| !poisoned.contains(id))
            .take(TOMBSTONE_PURGE_BATCH_LIMIT_USIZE)
            .collect();

        if ids.is_empty() {
            break;
        }

        let batch_count = ids.len();
        match crate::commands::blocks::crud::purge_blocks_by_ids_inner(
            pool,
            device_id,
            materializer,
            ids.iter().cloned().map(Into::into).collect(),
        )
        .await
        {
            Ok(_resp) => total_purged += batch_count,
            // #4018 — the writer is busy, not the batch. Bail out BEFORE the
            // per-root fallback: see [`is_write_contention`] for why retrying
            // each root would be up to `batch_limit` serialised `busy_timeout`
            // waits against the writer that just refused the whole batch, and
            // why the run must end with `Err` (next-tick retry) rather than
            // `Ok` (24 h).
            Err(e) if is_write_contention(&e) => {
                tracing::warn!(
                    error = %e,
                    batch_count,
                    batches,
                    purged = total_purged,
                    skipped = poisoned.len(),
                    "tombstone_purge: the SQLite writer is busy/locked — abandoning this \
                     run instead of retrying the batch one root at a time (#4018). \
                     Contention is not a poison root, so per-root isolation buys nothing \
                     and costs one serialised busy_timeout wait per root. Already-purged \
                     batches are committed; the daemon retries on the next tick"
                );
                return Err(e);
            }
            Err(e) => {
                // #3311 — the whole batch rolled back. Retry it one root at
                // a time so a single poison root costs only itself, and
                // record the roots that still fail so the loop advances.
                tracing::warn!(
                    error = %e,
                    batch_count,
                    first = ids.first().map_or("", String::as_str),
                    last = ids.last().map_or("", String::as_str),
                    "tombstone_purge: batch purge failed; falling back to one root at a time"
                );
                purge_roots_one_at_a_time(
                    pool,
                    device_id,
                    materializer,
                    ids,
                    &mut poisoned,
                    &mut total_purged,
                )
                .await?;
            }
        }

        batches += 1;

        // Short batch (< limit) means the backlog is exhausted; stop
        // without an extra empty probe query.
        if batch_count < TOMBSTONE_PURGE_BATCH_LIMIT_USIZE {
            break;
        }
        // Bound total work per invocation so a huge backlog can't hold the
        // daemon in a single run; the remainder rolls over to the next tick.
        if batches >= TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN {
            tracing::info!(
                purged = total_purged,
                batches,
                skipped = poisoned.len(),
                cutoff = %cutoff_ms,
                "tombstone_purge: hit per-run batch ceiling; remaining backlog rolls to next tick"
            );
            return Ok(());
        }
    }

    if !poisoned.is_empty() {
        tracing::warn!(
            skipped = poisoned.len(),
            purged = total_purged,
            cutoff = %cutoff_ms,
            "tombstone_purge: some roots could not be purged and were skipped for this run \
             (#3311); they remain eligible and are retried on the next run"
        );
    }
    if total_purged == 0 {
        tracing::debug!(
            cutoff = %cutoff_ms,
            "tombstone_purge: nothing eligible past the retention window"
        );
    } else {
        tracing::info!(
            purged = total_purged,
            batches,
            skipped = poisoned.len(),
            cutoff = %cutoff_ms,
            "tombstone_purge: hard-deleted soft-tombstones past the retention window"
        );
    }
    Ok(())
}

/// #3311 — the per-root fallback for a batch that rolled back. Retries each
/// root on its own so a single poison root costs only itself: roots that
/// still fail go into `poisoned` (excluded from the rest of the run), roots
/// that succeed are added to `total_purged`.
///
/// Split out of [`tombstone_purge`] (#4018) so the contention bail-out can be
/// driven by a test. Reaching it through `tombstone_purge` would need the
/// writer to go busy BETWEEN two per-root retries, which nothing in-process
/// can schedule deterministically — hold the write lock from the start and
/// the BATCH fails busy, which is handled by the caller's own arm and never
/// enters this loop at all.
///
/// # Errors
///
/// The writer going busy/locked part-way through a fallback that started for
/// a genuine poison root (see [`is_write_contention`]). Every remaining root
/// would pay a full `busy_timeout` for a failure that belongs to none of
/// them, so the error is returned and the caller's `?` abandons the run —
/// which is also what re-arms `run_tick`'s next-tick retry. The un-attempted
/// roots are deliberately left OUT of `poisoned`: they were never shown to be
/// unpurgeable.
async fn purge_roots_one_at_a_time(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &crate::materializer::Materializer,
    ids: Vec<String>,
    poisoned: &mut std::collections::HashSet<String>,
    total_purged: &mut usize,
) -> Result<(), AppError> {
    for id in ids {
        match crate::commands::blocks::crud::purge_blocks_by_ids_inner(
            pool,
            device_id,
            materializer,
            vec![id.clone().into()],
        )
        .await
        {
            Ok(_resp) => *total_purged += 1,
            Err(e) if is_write_contention(&e) => {
                tracing::warn!(
                    error = %e,
                    block_id = %id,
                    purged = *total_purged,
                    "tombstone_purge: the SQLite writer went busy/locked during \
                     the per-root fallback — abandoning the rest of this run \
                     (#4018); the daemon retries on the next tick"
                );
                return Err(e);
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    block_id = %id,
                    "tombstone_purge: root could not be purged; skipping it for the \
                     rest of this run (it stays eligible for the next run)"
                );
                poisoned.insert(id);
            }
        }
    }
    Ok(())
}

/// Issue #157 sub-item I — persist all Loro engine snapshots when
/// the registry's `dirty_count` proxy indicates at least one engine
/// has been touched since the last save. Predicate gating
/// (`dirty_count > 0 && !is_foreground`) lives at the spawn site;
/// the pass itself resets the dirty counter to 0 on success.
/// #2249: engine state is threaded in by the spawn site (a clone of the
/// materializer's `Arc<LoroState>`) — it exists by construction, so
/// there is no "registry not yet initialised" skip arm anymore.
pub async fn loro_snapshot_if_dirty(
    write_pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
) -> Result<(), AppError> {
    let ok = agaric_engine::loro::snapshot::save_all_engines(write_pool, &state.registry).await;
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
/// [`agaric_engine::draft::spawn_orphan_drafts_sweeper`] and
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
            // #3311: `last_run` is deliberately NOT advanced here — the job
            // stays due and is retried on the very next tick. See the
            // retry-on-failure note in the module docs for why this is the
            // policy and not an oversight.
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
                Box::pin(async { Err(AppError::validation("simulated job failure".into())) })
            }),
        };
        let mut jobs = vec![job];
        run_tick(&mut jobs).await;
        assert!(
            jobs[0].last_run.is_none(),
            "last_run must stay None after a failing job so it is retried immediately on the next tick"
        );
    }

    /// #3311 — the CONSEQUENCE of the `last_run`-only-on-`Ok` rule that
    /// `run_tick_does_not_advance_last_run_on_failure` pins as state: a
    /// failed job actually re-runs on the very NEXT tick, without waiting
    /// for its own (24 h here) `interval`. This is the contract the module
    /// docs used to deny; the docs were the defect, not the code.
    ///
    /// The third tick is the other half of the pair: once the job SUCCEEDS,
    /// its own interval gates it again — "always due" must not be sticky.
    #[tokio::test]
    async fn run_tick_retries_a_failed_job_on_the_very_next_tick_3311() {
        let calls = Arc::new(AtomicUsize::new(0));
        let job = MaintenanceJob {
            name: "flaky_job",
            interval: Duration::from_secs(24 * 3600),
            last_run: None,
            predicate: dummy_predicate_true(),
            run: {
                let calls = calls.clone();
                Box::new(move || {
                    let calls = calls.clone();
                    Box::pin(async move {
                        // Fail once, then succeed — the transient-failure
                        // shape these jobs actually hit (SQLITE_BUSY on the
                        // single writer).
                        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                            Err(AppError::validation("transient job failure".into()))
                        } else {
                            Ok(())
                        }
                    })
                })
            },
        };
        let mut jobs = vec![job];

        run_tick(&mut jobs).await;
        assert_eq!(calls.load(Ordering::Relaxed), 1, "first tick runs the job");
        // (`last_run` after the failure is pinned by
        // `run_tick_does_not_advance_last_run_on_failure`; this test pins
        // what that state actually BUYS.)

        // No time has elapsed — far less than the job's 24 h interval.
        run_tick(&mut jobs).await;
        assert_eq!(
            calls.load(Ordering::Relaxed),
            2,
            "a failed job must be retried on the very next tick, not after its own \
             interval elapses again (#3311)"
        );
        assert!(
            jobs[0].last_run.is_some(),
            "the successful retry records last_run"
        );

        run_tick(&mut jobs).await;
        assert_eq!(
            calls.load(Ordering::Relaxed),
            2,
            "after a success the job's own interval gates it again — the \
             retry-immediately state must not be sticky"
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

    /// #3311 — one root that cannot be purged must cost only itself: the run
    /// still returns `Ok`, every other aged tombstone drains, and the poison
    /// root survives (staying eligible for the next run) instead of aborting
    /// the whole pass and leaving `blocks` growing monotonically forever.
    ///
    /// The poison is injected with a `BEFORE DELETE` trigger that aborts the
    /// hard-delete of one specific root, so the batch transaction containing
    /// it rolls back exactly as a real per-root failure would.
    ///
    /// Uses the `cfg(test)` batch limit of 3, and gives the poison root the
    /// OLDEST `deleted_at` so it lands in the first batch (`ORDER BY
    /// deleted_at ASC`) — i.e. the failure happens with backlog still to
    /// drain, which is the case the old bare `?` aborted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_purge_skips_poison_root_and_drains_the_rest_3311() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES ('POISON00', 'content', 'unpurgeable', NULL, 0, ?)",
        )
        .bind(aged_deleted_at - 1000)
        .execute(&pool)
        .await
        .unwrap();

        // More than one batch of healthy tombstones behind the poison root.
        let healthy = TOMBSTONE_PURGE_BATCH_LIMIT_USIZE + 2;
        for i in 0..healthy {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'aged tombstone', NULL, ?, ?)",
            )
            .bind(format!("AGED{i:04}"))
            .bind(i64::try_from(i).unwrap() + 1)
            .bind(aged_deleted_at)
            .execute(&pool)
            .await
            .unwrap();
        }

        sqlx::query(
            "CREATE TRIGGER poison_block_delete \
             BEFORE DELETE ON blocks WHEN OLD.id = 'POISON00' \
             BEGIN SELECT RAISE(ABORT, 'simulated unpurgeable root'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("one poison root must not abort the whole run (#3311)");

        let healthy_remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE id LIKE 'AGED%' AND deleted_at IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            healthy_remaining, 0,
            "every healthy aged tombstone must still drain despite the poison root (#3311)"
        );

        let poison_present: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'POISON00'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            poison_present, 1,
            "the poison root survives — it is skipped, not silently reported purged"
        );
    }

    /// Issue #1644 — a backlog larger than [`TOMBSTONE_PURGE_BATCH_LIMIT`]
    /// drains fully in a single `tombstone_purge` invocation via the
    /// bounded catch-up loop (rather than ~1 batch/day). Inserts
    /// `batch_limit + 5` aged tombstones plus one recent tombstone; after
    /// one run every aged row is gone (proving the loop ran multiple
    /// batches) and the recent row survives (eligibility predicate
    /// unchanged).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_purge_drains_backlog_over_batch_limit_1644() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();
        let recent_deleted_at = chrono::Utc::now().timestamp_millis();

        // A backlog strictly larger than one batch forces the drain loop
        // to issue more than a single purge transaction.
        let backlog = TOMBSTONE_PURGE_BATCH_LIMIT_USIZE + 5;
        for i in 0..backlog {
            let position = i64::try_from(i).unwrap();
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'aged tombstone', NULL, ?, ?)",
            )
            .bind(format!("A{i:08}"))
            .bind(position)
            .bind(aged_deleted_at)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES ('RECENT00', 'content', 'recent tombstone', NULL, ?, ?)",
        )
        .bind(i64::try_from(backlog).unwrap())
        .bind(recent_deleted_at)
        .execute(&pool)
        .await
        .unwrap();

        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("tombstone_purge must drain a backlog larger than one batch");

        let aged_remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE id LIKE 'A%' AND deleted_at IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            aged_remaining, 0,
            "all aged tombstones must drain in one invocation via the bounded loop"
        );

        let recent_present: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'RECENT00'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            recent_present, 1,
            "recent tombstone must stay (eligibility predicate unchanged)"
        );
    }

    /// Issue #2051 — `tombstone_purge` enforces its per-run batch ceiling
    /// and rolls the remainder over to the next run.
    ///
    /// Drives the `cfg(test)`-shrunk constants (batch limit 3 × ceiling 4 =
    /// 12 rows/run) so the test is cheap: seeding the production 50k-row
    /// ceiling directly would be prohibitive. The `cfg(not(test))` build
    /// keeps the real 1000 / 50 values, so this changes nothing in
    /// production.
    ///
    /// Seeds `ceiling * batch_limit + remainder` aged tombstones. After the
    /// FIRST run, exactly `ceiling * batch_limit` rows must be gone (the
    /// ceiling fired and bailed mid-backlog); the remainder must still be
    /// present. After the SECOND run, the remainder drains too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tombstone_purge_hits_batch_ceiling_then_rolls_over_2051() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let per_run_cap = TOMBSTONE_PURGE_MAX_BATCHES_PER_RUN * TOMBSTONE_PURGE_BATCH_LIMIT_USIZE;
        // A remainder strictly smaller than one batch so the second run
        // drains it in a single short batch and stops.
        let remainder = TOMBSTONE_PURGE_BATCH_LIMIT_USIZE - 1;
        let total_aged = per_run_cap + remainder;

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();

        for i in 0..total_aged {
            let position = i64::try_from(i).unwrap();
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'aged tombstone', NULL, ?, ?)",
            )
            .bind(format!("C{i:08}"))
            .bind(position)
            .bind(aged_deleted_at)
            .execute(&pool)
            .await
            .unwrap();
        }

        let aged_remaining = || async {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM blocks WHERE id LIKE 'C%' AND deleted_at IS NOT NULL",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };

        // --- First run: the ceiling fires, exactly per_run_cap purged. ---
        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("first tombstone_purge run must succeed");
        assert_eq!(
            aged_remaining().await,
            i64::try_from(remainder).unwrap(),
            "first run must purge EXACTLY ceiling * batch_limit rows and roll the rest over"
        );

        // --- Second run: the leftover backlog drains. ---
        tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect("second tombstone_purge run must succeed");
        assert_eq!(
            aged_remaining().await,
            0,
            "second run must drain the rolled-over remainder"
        );
    }

    /// Thread-safe buffered writer for in-process log capture (mirrors the
    /// helper in `commands/blocks/crud.rs`; per tests/AGENTS.md "Test helper
    /// duplication is intentional"). Paired with a current-thread runtime
    /// (`#[tokio::test]`) so `set_default`'s thread-local guard covers every
    /// `.await` point.
    #[derive(Clone, Default)]
    struct WarnBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for WarnBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnBuf {
        type Writer = WarnBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    fn capture_warns() -> (WarnBuf, tracing::subscriber::DefaultGuard) {
        use tracing_subscriber::layer::SubscriberExt;
        let buf = WarnBuf::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(buf.clone())
                    .with_ansi(false),
            );
        let guard = tracing::subscriber::set_default(subscriber);
        (buf, guard)
    }
    fn logged(buf: &WarnBuf) -> String {
        String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned()
    }

    /// #4018 — [`is_write_contention`] must split the two failure shapes the
    /// `tombstone_purge` fallback branches on, and it must do it against the
    /// errors sqlx ACTUALLY produces (the classifier parses a driver-formatted
    /// extended result code, so a hand-built error would not test the thing
    /// that can break).
    ///
    /// Both directions in one walk, because either alone is worthless: a
    /// classifier that says "yes" to everything passes the contention half,
    /// and one that says "no" to everything passes the poison half.
    #[tokio::test]
    async fn is_write_contention_splits_busy_from_poison_4018() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).await.unwrap();

        // --- Poison: a trigger ABORT, the #3311 shape. ---
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES ('POISON00', 'content', 'unpurgeable', NULL, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER poison_block_delete \
             BEFORE DELETE ON blocks WHEN OLD.id = 'POISON00' \
             BEGIN SELECT RAISE(ABORT, 'simulated unpurgeable root'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let poison: AppError = sqlx::query("DELETE FROM blocks WHERE id = 'POISON00'")
            .execute(&pool)
            .await
            .expect_err("the trigger must abort the delete")
            .into();
        assert!(
            !is_write_contention(&poison),
            "a trigger ABORT is a poison root, not contention — it must keep the \
             #3311 per-root fallback; got {poison}"
        );

        // --- Contention: a real BUSY from the single SQLite writer. ---
        // A short busy_timeout so the wait is a test cost, not a 5 s one.
        let busy_opts = agaric_store::db::base_connect_options(&db_path)
            .busy_timeout(std::time::Duration::from_millis(50));
        let contender = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(busy_opts)
            .await
            .unwrap();
        let holder = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let busy: AppError = contender
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect_err("the write lock is held; BEGIN IMMEDIATE must report BUSY")
            .into();
        drop(holder);
        assert!(
            is_write_contention(&busy),
            "a busy/locked writer must be classified as contention so the per-root \
             fallback is skipped (#4018); got {busy}"
        );

        // --- The same signal one layer out: every write connection in the
        // pool is already occupied, so the batch never reached SQLite. Not
        // reachable from the walk above (it needs an exhausted pool, not a
        // held file lock), so it is asserted directly.
        assert!(
            is_write_contention(&AppError::PoolTimedOut),
            "an exhausted write pool is the same 'the writer is busy' condition and \
             must not send the run into the per-root fallback either (#4018)"
        );

        // …and the conservative default for everything that is not a database
        // error at all. `purge_blocks_by_ids_inner` refuses a live root with
        // exactly this shape, and that IS a per-root failure: classifying it
        // as contention would abandon the run over one bad id.
        assert!(
            !is_write_contention(&AppError::InvalidOperation(
                "block 'X' must be soft-deleted before purging".into()
            )),
            "a non-database refusal belongs to the root that provoked it and must keep \
             the #3311 per-root fallback (#4018)"
        );
    }

    /// #4018 — the OTHER half of the contention bail-out: the writer going
    /// busy part-way through a per-root fallback that started for a genuine
    /// poison root.
    ///
    /// Driven against [`purge_roots_one_at_a_time`] directly, because that
    /// interleaving cannot be scheduled through `tombstone_purge`: holding the
    /// write lock from the start makes the BATCH fail busy, which the caller's
    /// own arm handles without ever entering this loop (that path is
    /// `tombstone_purge_abandons_the_run_on_writer_contention_4018`).
    ///
    /// Pins both directions. Under contention: `Err`, nothing recorded as
    /// poison, nothing counted as purged. The poison direction — a root that
    /// genuinely cannot be purged is recorded and the loop keeps going — is
    /// `tombstone_purge_skips_poison_root_and_drains_the_rest_3311`.
    #[tokio::test]
    async fn per_root_fallback_stops_when_the_writer_goes_busy_4018() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let setup = crate::db::init_pool(&db_path).await.unwrap();

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();
        for i in 0..2i64 {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'aged tombstone', NULL, ?, ?)",
            )
            .bind(format!("AGED{i:04}"))
            .bind(i)
            .bind(aged_deleted_at)
            .execute(&setup)
            .await
            .unwrap();
        }

        let busy_opts = agaric_store::db::base_connect_options(&db_path)
            .busy_timeout(std::time::Duration::from_millis(50));
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(busy_opts)
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let holder = setup.begin_with("BEGIN IMMEDIATE").await.unwrap();

        let mut poisoned: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut total_purged: usize = 0;
        let (buf, guard) = capture_warns();
        let err = purge_roots_one_at_a_time(
            &pool,
            "test-device",
            &mat,
            vec!["AGED0000".to_string(), "AGED0001".to_string()],
            &mut poisoned,
            &mut total_purged,
        )
        .await
        .expect_err(
            "a busy writer met mid-fallback must abandon the run with Err (#4018), not \
             plough through the remaining roots at one busy_timeout each",
        );
        drop(guard);
        drop(holder);

        assert!(
            is_write_contention(&err),
            "the surfaced error must be the contention itself; got {err}"
        );
        assert!(
            poisoned.is_empty(),
            "a root the writer never let us try is not a poison root — recording it \
             would exclude it from the rest of the run for someone else's failure; \
             got {poisoned:?}"
        );
        assert_eq!(total_purged, 0, "nothing committed, nothing counted");
        let out = logged(&buf);
        assert!(
            out.contains("went busy/locked during the per-root fallback"),
            "the abandoned fallback must say why, naming contention rather than poison. \
             Captured logs:\n{out}"
        );
        assert!(
            !out.contains("root could not be purged"),
            "…and must not also log the poison line for the same root. Captured logs:\n{out}"
        );
    }

    /// #4018 — one busy writer must not turn into a write-lock storm.
    ///
    /// `tombstone_purge`'s #3311 fallback retries a failed batch ONE ROOT AT A
    /// TIME. That isolates a poison root, but under lock contention it is pure
    /// amplification: nothing is wrong with any root, and each retry pays a
    /// full `busy_timeout` against the writer that just refused the batch — at
    /// production scale up to 1000 per batch and 50 batches per run.
    ///
    /// Drives a REAL `SQLITE_BUSY` by holding the single write lock from
    /// another connection, and pins all three halves of the new contract: the
    /// per-root fallback does not run, the run ends, and it ends with `Err` so
    /// `run_tick` retries on the next 60 s tick instead of in 24 h.
    ///
    /// The other side of the split — a genuine poison root still gets its
    /// per-root isolation and the run still returns `Ok` — is
    /// `tombstone_purge_skips_poison_root_and_drains_the_rest_3311`, which must
    /// stay green alongside this.
    #[tokio::test]
    async fn tombstone_purge_abandons_the_run_on_writer_contention_4018() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let setup = crate::db::init_pool(&db_path).await.unwrap();

        let aged_deleted_at = (chrono::Utc::now()
            - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS + 5))
        .timestamp_millis();
        // Two aged tombstones: fewer than the `cfg(test)` batch limit of 3, so
        // this is exactly ONE batch and the per-root fallback (if it runs) is
        // exactly two extra attempts — countable in the log.
        for i in 0..2i64 {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'aged tombstone', NULL, ?, ?)",
            )
            .bind(format!("AGED{i:04}"))
            .bind(i)
            .bind(aged_deleted_at)
            .execute(&setup)
            .await
            .unwrap();
        }

        // The pool the purge runs on: same file, short busy_timeout so the
        // contention is observed in milliseconds rather than 5 s per attempt.
        let busy_opts = agaric_store::db::base_connect_options(&db_path)
            .busy_timeout(std::time::Duration::from_millis(50));
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(busy_opts)
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        // Another writer holds the single SQLite write lock. WAL keeps readers
        // unaffected, so the eligibility SELECT still succeeds and the failure
        // lands exactly where production's would: `BEGIN IMMEDIATE`.
        let holder = setup.begin_with("BEGIN IMMEDIATE").await.unwrap();

        let (buf, guard) = capture_warns();
        let err = tombstone_purge(&pool, "test-device", &mat)
            .await
            .expect_err(
                "a busy writer must ABANDON the run with Err (#4018) so the maintenance \
                 daemon retries on the next 60 s tick — swallowing it into Ok defers the \
                 retry to the job's own 24 h interval",
            );
        drop(guard);
        drop(holder);

        let out = logged(&buf);
        // The load-bearing negative assertion: the fallback must not be
        // ENTERED. Asserting only the absence of the per-root "could not be
        // purged" line would be satisfied by a run that enters the fallback
        // and bails on its FIRST root — which is the amplification this
        // change exists to prevent, one root shy of the full storm.
        assert!(
            !out.contains("falling back to one root at a time"),
            "the per-root fallback must NOT be entered under contention — it would cost \
             one serialised busy_timeout wait per root for a failure that belongs to none \
             of them (#4018). Captured logs:\n{out}"
        );
        assert!(
            !out.contains("root could not be purged"),
            "and no root may be recorded as poison for a failure that was the writer's. \
             Captured logs:\n{out}"
        );
        assert!(
            out.contains("abandoning this run instead of retrying the batch one root at a time"),
            "the abandoned run must say why, naming contention rather than poison. \
             Captured logs:\n{out}"
        );
        assert!(
            is_write_contention(&err),
            "the surfaced error must be the contention itself, not a rewrapped or \
             synthesised one; got {err}"
        );

        // Nothing was purged and nothing was marked poison: the tombstones are
        // still eligible for the retry this Err buys.
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE id LIKE 'AGED%' AND deleted_at IS NOT NULL",
        )
        .fetch_one(&setup)
        .await
        .unwrap();
        assert_eq!(
            remaining, 2,
            "no tombstone may be reported purged when the writer never let a batch commit"
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
        loro_snapshot_if_dirty(&pool, &agaric_engine::loro::shared::LoroState::new())
            .await
            .expect("loro_snapshot_if_dirty must succeed on a fresh, empty registry");
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

    /// Issue #2051 — a single midnight tick must actually ENQUEUE exactly
    /// one `RebuildProjectedAgendaCache` (the existing #157-H tests only
    /// asserted the atomic day-number advance, never that the rebuild task
    /// lands on the background queue).
    ///
    /// Observed via `bg_processed`. A `flush_background()` barrier is
    /// itself a background task that increments `bg_processed` by exactly
    /// one (consumer.rs counts the Barrier), so we first measure that
    /// fixed barrier cost with a bare drain (the control), then measure a
    /// tick + drain and subtract — the residual is exactly the rebuild.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_midnight_enqueues_exactly_one_rebuild_2051() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        let last_day = AtomicI32::new(i32::MIN);

        let load = || {
            mat.metrics()
                .bg_processed
                .load(std::sync::atomic::Ordering::Relaxed)
        };

        // Control: a bare drain with no tick. Its delta is the per-flush
        // Barrier cost (exactly 1) with no rebuild mixed in.
        let c0 = load();
        mat.flush_background().await.expect("control drain");
        let barrier_cost = load() - c0;
        assert_eq!(barrier_cost, 1, "a flush barrier must count as one bg task");

        // Measurement: one midnight tick, then drain.
        let before = load();
        projected_agenda_midnight_tick(&mat, &last_day)
            .await
            .expect("midnight tick must enqueue successfully");
        mat.flush_background().await.expect("drain after tick");
        let rebuilds = (load() - before) - barrier_cost;

        assert_eq!(
            rebuilds, 1,
            "a single midnight tick must enqueue exactly one RebuildProjectedAgendaCache"
        );
        mat.shutdown();
    }

    /// Issue #2051 — N concurrent midnight ticks racing across the same
    /// day rollover must land EXACTLY ONE `RebuildProjectedAgendaCache`.
    /// This is the invariant the CAS in `projected_agenda_midnight_tick`
    /// exists to enforce: only the thread that wins the
    /// `compare_exchange` on `last_fired_day` proceeds to enqueue; the
    /// losers short-circuit. Without the CAS, several ticks would observe
    /// the stale `previous` value and each enqueue a duplicate.
    ///
    /// Verified two ways: (1) the day atomic advances to today exactly
    /// once, and (2) after draining, `bg_processed` reflects a single
    /// rebuild.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_midnight_cas_prevents_double_enqueue_2051() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = crate::materializer::Materializer::new(pool);
        let today = chrono::Utc::now().date_naive().num_days_from_ce();
        // Start one day behind so EVERY tick sees a rollover and contends
        // for the CAS.
        let last_day = Arc::new(AtomicI32::new(today - 1));

        let load = || {
            mat.metrics()
                .bg_processed
                .load(std::sync::atomic::Ordering::Relaxed)
        };

        // Control: fixed per-flush Barrier cost (see the single-tick test).
        let c0 = load();
        mat.flush_background().await.expect("control drain");
        let barrier_cost = load() - c0;
        assert_eq!(barrier_cost, 1, "a flush barrier must count as one bg task");

        let before = load();
        const N: usize = 16;
        let mut handles = Vec::with_capacity(N);
        for _ in 0..N {
            let mat = mat.clone();
            let last_day = last_day.clone();
            handles.push(tokio::spawn(async move {
                projected_agenda_midnight_tick(&mat, &last_day).await
            }));
        }
        for h in handles {
            h.await
                .expect("tick task must not panic")
                .expect("each concurrent tick must return Ok (winner enqueues, losers no-op)");
        }

        // The CAS winner advanced the atomic to today; all losers observed
        // `previous == today` (or lost the swap) and short-circuited.
        assert_eq!(
            last_day.load(Ordering::Acquire),
            today,
            "the day atomic must advance to today exactly once under contention"
        );

        mat.flush_background().await.expect("drain after ticks");
        let rebuilds = (load() - before) - barrier_cost;
        assert_eq!(
            rebuilds, 1,
            "EXACTLY ONE RebuildProjectedAgendaCache must land despite {N} concurrent ticks (CAS)"
        );
        mat.shutdown();
    }
}
