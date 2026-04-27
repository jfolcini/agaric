//! Consumer loops for the materializer foreground and background queues.
//!
//! ## Two-tier retry semantics (MAINT-148h)
//!
//! Both consumers run failed tasks through the shared
//! [`retry_with_backoff`] helper, but the **schedule** and **observability
//! contract** differ:
//!
//! | Tier | Site | Tasks routed here | Retries | Backoff | On exhaustion |
//! |------|------|-------------------|---------|---------|---------------|
//! | Foreground (fg) | [`process_single_foreground_task`] | `ApplyOp`, `BatchApplyOps`, `Barrier` | 1 | constant 100 ms | Bump `fg_errors` (and, for Apply / BatchApplyOps, `fg_apply_dropped` plus a divergence warn carrying op coords). The op is **silently dropped** — there is no persistent retry queue for the apply path because re-applying a failed op out of order would break the op-log invariant. Sync replay is the recovery mechanism. |
//! | Background (bg) | [`run_background`] | All cache rebuilds, FTS reindex, attachment cleanup | 2 | exponential 150 ms / 300 ms | Bump `bg_errors` / `bg_panics`. Idempotent per-block tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`) are then **persisted** to `materializer_retry_queue` for re-enqueue on the much-longer minute-to-hour schedule from [`super::retry_queue::backoff_delay_for`] (BUG-22). Global rebuilds are not persisted because they're re-dispatched by other code paths. |
//!
//! The in-memory backoffs (this module) handle transient WAL-lock
//! contention; the persistent retry queue handles harder failures
//! (corrupt snapshot, missing block) that need operator-scale recovery
//! time. The two schedules are independent — see the cross-references on
//! [`retry_with_backoff`] and the `INITIAL_BACKOFF_MS` constant in
//! [`run_background`].

use sqlx::SqlitePool;
use std::mem;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::mpsc;
use tracing::Instrument;

use super::dedup::dedup_tasks;
use super::handlers::{handle_background_task, handle_foreground_task};
use super::metrics::QueueMetrics;
use super::MaterializeTask;
use super::FOREGROUND_CAPACITY;
use crate::gcal_push::connector::GcalConnectorHandle;

#[cfg(not(tarpaulin_include))]
pub(super) fn log_consumer_result(
    label: &str,
    result: &Result<Result<(), crate::error::AppError>, tokio::task::JoinError>,
) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::error!(label, error = %e, "error processing materializer task");
        }
        Err(e) => {
            tracing::error!(label, error = %e, "materializer task panicked");
        }
    }
}

/// Outcome of a [`retry_with_backoff`] loop.
///
/// Captures enough state for the caller to bump the right metric counters
/// and emit retry-exhaustion warnings without re-running the task. The
/// values are mutually consistent:
/// * `succeeded = true` ⇒ `panicked = false`, `last_error_msg = None`
/// * `panicked = true` ⇒ `succeeded = false`
#[derive(Debug)]
pub(super) struct RetryOutcome {
    pub succeeded: bool,
    pub panicked: bool,
    pub last_error_msg: Option<String>,
}

/// Run an async task, retrying up to `max_retries` times on failure with
/// the backoff returned by `backoff_for(attempt)`. Each invocation runs
/// inside a freshly spawned `tokio::task` so a panic in the handler does
/// not crash the consumer loop.
///
/// MAINT-148f — extracted from the formerly-duplicated retry loops in
/// [`process_single_foreground_task`] (single retry, 100 ms constant
/// backoff) and [`run_background`] (2 retries, exponential 150 ms /
/// 300 ms backoff). The constant-vs-exponential schedule is the only
/// numerical difference between the two sites and is parameterised via
/// the `backoff_for` callback.
///
/// In-memory backoff (this helper) covers transient WAL-lock contention
/// at ms-scale; persistent retry-queue scheduling for *exhausted*
/// background tasks is a separate, minutes-to-hours schedule and lives
/// in [`super::retry_queue::backoff_delay_for`]. The two schedules are
/// independent — see the doc comment on `INITIAL_BACKOFF_MS` and
/// `retry_queue::backoff_delay_for` for the cross-reference.
pub(super) async fn retry_with_backoff<S, Fut>(
    label: &str,
    max_retries: u32,
    backoff_for: impl Fn(u32) -> std::time::Duration,
    mut spawn_attempt: S,
) -> RetryOutcome
where
    S: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), crate::error::AppError>> + Send + 'static,
{
    let mut outcome = RetryOutcome {
        succeeded: false,
        panicked: false,
        last_error_msg: None,
    };

    let first = tokio::task::spawn(spawn_attempt()).await;
    match &first {
        Ok(Ok(())) => {
            outcome.succeeded = true;
            return outcome;
        }
        Ok(Err(e)) => {
            outcome.last_error_msg = Some(format!("{e:?}"));
            log_consumer_result(label, &first);
        }
        Err(e) => {
            outcome.last_error_msg = Some(format!("panic: {e:?}"));
            log_consumer_result(label, &first);
            outcome.panicked = true;
            return outcome;
        }
    }

    for attempt in 1..=max_retries {
        let backoff = backoff_for(attempt);
        let backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX);
        tracing::warn!(
            label,
            retry = attempt,
            backoff_ms,
            "retrying failed materializer task after {backoff_ms}ms backoff"
        );
        tokio::time::sleep(backoff).await;
        let retry = tokio::task::spawn(spawn_attempt()).await;
        let retry_label = format!("{label}-retry-{attempt}");
        match &retry {
            Ok(Ok(())) => {
                outcome.succeeded = true;
                outcome.last_error_msg = None;
                return outcome;
            }
            Ok(Err(e)) => {
                outcome.last_error_msg = Some(format!("{e:?}"));
                log_consumer_result(&retry_label, &retry);
            }
            Err(e) => {
                outcome.last_error_msg = Some(format!("panic: {e:?}"));
                log_consumer_result(&retry_label, &retry);
                outcome.panicked = true;
                return outcome;
            }
        }
    }

    outcome
}

pub(super) async fn run_foreground(
    pool: SqlitePool,
    mut rx: mpsc::Receiver<MaterializeTask>,
    shutdown_flag: Arc<AtomicBool>,
    metrics: Arc<QueueMetrics>,
    gcal_handle: Arc<OnceLock<GcalConnectorHandle>>,
) {
    loop {
        let Some(first_task) = rx.recv().await else {
            break;
        };
        let mut batch = vec![first_task];
        while let Ok(task) = rx.try_recv() {
            batch.push(task);
            if batch.len() >= FOREGROUND_CAPACITY {
                break;
            }
        }
        // MAINT-21: enter a `mat_batch` span for the duration of this drained
        // batch so every log line emitted during processing shares the prefix
        // (`mat_batch{kind="fg",size=N}`) for correlation.
        let batch_size = batch.len();
        let batch_span = tracing::info_span!("mat_batch", kind = "fg", size = batch_size);
        async {
            let mut segment: Vec<MaterializeTask> = Vec::new();
            for task in batch {
                if matches!(task, MaterializeTask::Barrier(_)) {
                    if !segment.is_empty() {
                        process_foreground_segment(
                            &pool,
                            mem::take(&mut segment),
                            &metrics,
                            &gcal_handle,
                        )
                        .await;
                    }
                    process_single_foreground_task(&pool, task, &metrics, &gcal_handle).await;
                } else {
                    segment.push(task);
                }
            }
            if !segment.is_empty() {
                process_foreground_segment(&pool, segment, &metrics, &gcal_handle).await;
            }
            // MAINT-24: Record "we just finished a batch" timestamp so status
            // consumers can detect stalled materializers.
            record_last_materialize(&metrics);
        }
        .instrument(batch_span)
        .await;
        if shutdown_flag.load(Ordering::Acquire) {
            break;
        }
    }
    tracing::info!("foreground queue closed");
}

/// Stamp the current wall-clock millisecond on `metrics.last_materialize_ms`
/// after a successful batch. Reads via `load(Relaxed)` in `StatusInfo`
/// rendering. Monotonicity is not required — we record the most recent
/// successful batch time.
fn record_last_materialize(metrics: &QueueMetrics) {
    // Millis since epoch fits in u64 for millions of years; saturate on overflow.
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    metrics.last_materialize_ms.store(now_ms, Ordering::Relaxed);
}

async fn process_foreground_segment(
    pool: &SqlitePool,
    tasks: Vec<MaterializeTask>,
    metrics: &Arc<QueueMetrics>,
    gcal_handle: &Arc<OnceLock<GcalConnectorHandle>>,
) {
    // H-5 / H-6 (2026-04): the foreground segment used to bucket tasks
    // by `extract_block_id(task)` and dispatch each bucket in parallel
    // via `tokio::task::JoinSet`. That was unsafe for two reasons:
    //
    //   H-5: a `CreateBlock` cascade — parent op + immediate child op in
    //        the same segment — split into two buckets (key = parent.id
    //        vs. key = child.id). The buckets ran concurrently; if the
    //        child bucket's apply raced ahead of the parent bucket's
    //        apply, SQLite rejected the child's `INSERT` on the
    //        `blocks.parent_id` FK. Production masked this because the
    //        consumer retries once after a 100 ms backoff, but the race
    //        is reproducible under normal sync replay.
    //
    //   H-6: `BatchApplyOps` used only `records[0].block_id` as its
    //        grouping key, so a batch whose first record targeted `X`
    //        but whose remaining records touched `Y, Z, …` could run in
    //        parallel with an independent `ApplyOp` for one of those
    //        non-first block_ids, racing to mutate the same row.
    //
    // The fix is to drop the bucketing entirely and run tasks strictly
    // FIFO. SQLite serialises writes at the engine level (WAL, single
    // writer), so the JoinSet branch never actually gained throughput —
    // one transaction always waited on the other. Serial execution
    // preserves insertion order across both `ApplyOp` and `BatchApplyOps`
    // variants, guarantees parent-before-child ordering, and collapses
    // the "which bucket does this land in" question the batch grouping
    // key could not answer correctly.
    for task in tasks {
        process_single_foreground_task(pool, task, metrics, gcal_handle).await;
    }
}

pub(super) async fn process_single_foreground_task(
    pool: &SqlitePool,
    task: MaterializeTask,
    metrics: &Arc<QueueMetrics>,
    gcal_handle: &Arc<OnceLock<GcalConnectorHandle>>,
) {
    // L-10: Barriers carry a `tokio::sync::Notify`; the only work is
    // `notify.notify_one()`. There is no DB read, no fallible step, no
    // retry semantic worth preserving — wrapping it in `tokio::spawn`
    // (with the pool / metrics / gcal Arc clones the rest of this
    // function needs) was leftover panic-isolation scaffolding from
    // the real handler arms. Inline it here, mirroring the bg-side
    // pattern at `run_background` (consumer.rs ~217-223).
    if let MaterializeTask::Barrier(notify) = task {
        notify.notify_one();
        metrics.fg_processed.fetch_add(1, Ordering::Relaxed);
        return;
    }

    // Foreground retry schedule: a single retry after a 100 ms constant
    // backoff. See ARCHITECTURE.md §5 ("Materializer / Retry behaviour"
    // — Foreground backoff schedule). Background uses an exponential
    // schedule (150 ms / 300 ms) — the difference is encoded in the
    // backoff closures here vs. in `run_background`.
    let outcome = {
        let pool = pool.clone();
        let gcal_handle = Arc::clone(gcal_handle);
        let task = task.clone();
        retry_with_backoff(
            "fg",
            1,
            |_| std::time::Duration::from_millis(100),
            move || {
                let pool = pool.clone();
                let gcal_handle = Arc::clone(&gcal_handle);
                let task = task.clone();
                async move { handle_foreground_task(&pool, &task, &gcal_handle).await }
            },
        )
        .await
    };

    if outcome.panicked {
        metrics.fg_panics.fetch_add(1, Ordering::Relaxed);
    } else if !outcome.succeeded {
        metrics.fg_errors.fetch_add(1, Ordering::Relaxed);
        // REVIEW-LATER C-2a: defense-in-depth observability for
        // materializer divergence. `ApplyOp` / `BatchApplyOps` tasks
        // that exhaust the foreground retry are otherwise dropped
        // silently — `fg_errors` alone lumps every fg failure
        // together, so a non-Apply error masks a real apply
        // divergence. Bump a dedicated counter and emit a warn line
        // carrying the op coordinates (kind, seq, device_id,
        // op_type) so the drop is searchable in logs and surfaceable
        // via `StatusInfo` in the status banner. Non-Apply foreground
        // failures (Barrier and legacy non-Apply variants — none of
        // which are routed through the foreground queue today, but
        // the match arm is exhaustive for safety) keep their
        // existing single-counter behavior.
        let err_msg = outcome.last_error_msg.as_deref().unwrap_or("unknown error");
        match &task {
            MaterializeTask::ApplyOp(record) => {
                tracing::warn!(
                    kind = "ApplyOp",
                    seq = record.seq,
                    device_id = %record.device_id,
                    op_type = %record.op_type,
                    error = %err_msg,
                    "foreground apply-op dropped after retry exhausted — materializer divergence"
                );
                metrics.fg_apply_dropped.fetch_add(1, Ordering::Relaxed);
            }
            MaterializeTask::BatchApplyOps(records) => {
                if let Some(first) = records.first() {
                    tracing::warn!(
                        kind = "BatchApplyOps",
                        seq = first.seq,
                        device_id = %first.device_id,
                        op_type = %first.op_type,
                        batch_size = records.len(),
                        error = %err_msg,
                        "foreground batch-apply-ops dropped after retry exhausted — materializer divergence (rest of batch implicitly dropped)"
                    );
                } else {
                    tracing::warn!(
                        kind = "BatchApplyOps",
                        batch_size = 0,
                        error = %err_msg,
                        "foreground batch-apply-ops dropped after retry exhausted — empty batch"
                    );
                }
                metrics.fg_apply_dropped.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
    metrics.fg_processed.fetch_add(1, Ordering::Relaxed);
}

pub(super) async fn run_background(
    pool: SqlitePool,
    mut rx: mpsc::Receiver<MaterializeTask>,
    shutdown_flag: Arc<AtomicBool>,
    metrics: Arc<QueueMetrics>,
    read_pool: Option<SqlitePool>,
    app_data_dir: Arc<OnceLock<PathBuf>>,
) {
    loop {
        let Some(first) = rx.recv().await else {
            break;
        };
        let mut batch = vec![first];
        while let Ok(task) = rx.try_recv() {
            batch.push(task);
        }
        let total_before = batch.len();
        let deduped = dedup_tasks(batch);
        let dedup_count = (total_before - deduped.len()) as u64;
        // MAINT-21: wrap the per-batch work in a `mat_batch` span (kind="bg")
        // so every log line emitted during processing of this drained batch
        // shares the prefix for correlation.
        let batch_span = tracing::info_span!(
            "mat_batch",
            kind = "bg",
            size = total_before,
            deduped = dedup_count
        );
        async {
            let mut pending_barriers: Vec<Arc<tokio::sync::Notify>> = Vec::new();
            for task in deduped {
                let rp_ref = read_pool.as_ref();
                if let MaterializeTask::Barrier(ref notify) = task {
                    pending_barriers.push(Arc::clone(notify));
                    metrics.bg_processed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                const MAX_RETRIES: u32 = 2;
                // Increased from 50ms to reduce retry churn on transient WAL
                // lock contention; background tasks tolerate longer delays.
                // docs: ARCHITECTURE.md §5 ("Materializer / Retry behaviour"
                // — Background backoff schedule: 150ms, 300ms).
                //
                // Cross-reference (BUG-22 / MAINT-148h): this is the
                // *in-memory* per-batch retry budget. Tasks that exhaust
                // this loop and are idempotent per-block (UpdateFtsBlock,
                // ReindexBlockLinks, ReindexBlockTagRefs) get persisted to
                // `materializer_retry_queue` and re-scheduled on the
                // separate, persistent minute-to-hour backoff defined in
                // [`super::retry_queue::backoff_delay_for`]. The two
                // schedules are independent — bumping `INITIAL_BACKOFF_MS`
                // only changes how long the consumer thread spins on a
                // failing task before persisting it.
                const INITIAL_BACKOFF_MS: u64 = 150;
                let outcome = {
                    let pool = pool.clone();
                    let rp = rp_ref.cloned();
                    let app_data_dir = app_data_dir.clone();
                    let task = task.clone();
                    retry_with_backoff(
                        "bg",
                        MAX_RETRIES,
                        |attempt| {
                            let backoff_ms = INITIAL_BACKOFF_MS * (1 << (attempt - 1));
                            std::time::Duration::from_millis(backoff_ms)
                        },
                        move || {
                            let pool = pool.clone();
                            let rp = rp.clone();
                            let app_data_dir = app_data_dir.clone();
                            let task = task.clone();
                            async move {
                                let dir = app_data_dir.get().map(PathBuf::as_path);
                                handle_background_task(&pool, &task, rp.as_ref(), dir).await
                            }
                        },
                    )
                    .await
                };
                let succeeded = outcome.succeeded;
                let panicked = outcome.panicked;
                let last_error_msg = outcome.last_error_msg;
                if panicked {
                    metrics.bg_panics.fetch_add(1, Ordering::Relaxed);
                } else if !succeeded {
                    metrics.bg_errors.fetch_add(1, Ordering::Relaxed);
                }
                // BUG-22: Persist exhausted failures for retryable tasks to
                // `materializer_retry_queue` so the boot-time / periodic sweeper
                // can re-enqueue them later. Only idempotent per-block tasks
                // (UpdateFtsBlock, ReindexBlockLinks) are persisted — global
                // rebuild tasks are retriggered by other code paths.
                if !succeeded {
                    if super::retry_queue::RetryKind::from_task(&task).is_some() {
                        let err_msg = last_error_msg.as_deref().unwrap_or("unknown error");
                        if let Err(persist_err) =
                            super::retry_queue::record_failure(&pool, &task, err_msg).await
                        {
                            tracing::error!(
                                error = %persist_err,
                                "failed to persist task to materializer_retry_queue — task dropped"
                            );
                        } else {
                            metrics.bg_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    } else {
                        // Non-retryable global task (RebuildTagsCache, etc.):
                        // these are re-dispatched by other code paths, so
                        // silently count the drop without persisting.
                        metrics.bg_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                metrics.bg_processed.fetch_add(1, Ordering::Relaxed);
            }
            for barrier in pending_barriers {
                barrier.notify_one();
            }
            metrics.bg_deduped.fetch_add(dedup_count, Ordering::Relaxed);
            // MAINT-24: Update last-batch timestamp after every drain (even if
            // some tasks failed — the consumer itself is alive).
            record_last_materialize(&metrics);
        }
        .instrument(batch_span)
        .await;
        if shutdown_flag.load(Ordering::Acquire) {
            break;
        }
    }
    tracing::info!("background queue closed");
}

#[cfg(test)]
mod m10_tests {
    use super::*;
    use crate::op_log::OpRecord;

    fn make_op_record(seq: i64) -> OpRecord {
        OpRecord {
            device_id: "dev-A".into(),
            seq,
            parent_seqs: None,
            hash: "deadbeef".into(),
            op_type: "create_block".into(),
            payload: "{}".into(),
            created_at: "2025-01-15T12:00:00Z".into(),
        }
    }

    /// M-10: the `BatchApplyOps` variant wraps its `Vec<OpRecord>` in an
    /// `Arc` so that the `task.clone()` calls on the foreground /
    /// background consumer retry paths are cheap refcount bumps instead
    /// of full deep clones of what can, during sync catch-up, be a
    /// multi-thousand-op chunk. Mobile (Android) RAM is constrained.
    ///
    /// This regression test pins the clone semantics directly via
    /// `Arc::strong_count` / `Arc::ptr_eq`:
    ///
    ///   1. Construction of a `BatchApplyOps(Arc::new(vec![...]))` leaves
    ///      the allocation at `strong_count == 1` (plus any strong refs
    ///      the test itself holds).
    ///   2. `task.clone()` — the operation every retry-prep site invokes
    ///      on the no-retry happy path — does NOT deep-clone the inner
    ///      Vec: the Arc refcount is bumped by one, and the cloned task
    ///      shares pointer identity with the original via `Arc::ptr_eq`.
    ///   3. Dropping either clone decrements the refcount; nothing leaks.
    #[test]
    fn batch_apply_ops_no_retry_does_not_deep_clone_m10() {
        let records = Arc::new(vec![
            make_op_record(1),
            make_op_record(2),
            make_op_record(3),
        ]);
        assert_eq!(
            Arc::strong_count(&records),
            1,
            "freshly-constructed Arc<Vec<OpRecord>> should have strong_count == 1",
        );

        let task = MaterializeTask::BatchApplyOps(Arc::clone(&records));
        assert_eq!(
            Arc::strong_count(&records),
            2,
            "holding the Arc inside MaterializeTask plus the test binding \
             should leave strong_count == 2",
        );

        // The critical property: cloning the task (as
        // `consumer.rs::process_single_foreground_task` L~154 and
        // `consumer.rs::run_background` L~232/L~250 do on every retry
        // prep — including the no-retry happy path, pre-M-10) must NOT
        // deep-clone the inner Vec. It is a refcount bump.
        let task_clone = task.clone();
        match &task_clone {
            MaterializeTask::BatchApplyOps(inner) => {
                assert_eq!(
                    Arc::strong_count(inner),
                    3,
                    "task.clone() must be a refcount bump (strong_count == 3), \
                     not a deep clone",
                );
                assert!(
                    Arc::ptr_eq(inner, &records),
                    "Arc::clone through task.clone() must preserve pointer identity \
                     — a deep clone would create a fresh allocation",
                );
            }
            other => panic!("expected BatchApplyOps variant, got {other:?}"),
        }

        drop(task_clone);
        assert_eq!(
            Arc::strong_count(&records),
            2,
            "dropping the cloned task should release exactly one strong ref",
        );
        drop(task);
        assert_eq!(
            Arc::strong_count(&records),
            1,
            "dropping the original task should return strong_count to 1",
        );
    }
}
