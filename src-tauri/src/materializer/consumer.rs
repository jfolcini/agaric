//! Consumer loops for the materializer foreground and background queues.

use sqlx::SqlitePool;
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::mpsc;
use tracing::Instrument;

use super::dedup::{dedup_tasks, group_tasks_by_block_id};
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
    #[allow(clippy::cast_possible_truncation)]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    metrics.last_materialize_ms.store(now_ms, Ordering::Relaxed);
}

async fn process_foreground_segment(
    pool: &SqlitePool,
    tasks: Vec<MaterializeTask>,
    metrics: &Arc<QueueMetrics>,
    gcal_handle: &Arc<OnceLock<GcalConnectorHandle>>,
) {
    let groups = group_tasks_by_block_id(tasks);
    if groups.len() <= 1 {
        for (_block_id, group_tasks) in groups {
            for task in group_tasks {
                process_single_foreground_task(pool, task, metrics, gcal_handle).await;
            }
        }
        return;
    }
    let mut join_set = tokio::task::JoinSet::new();
    for (_block_id, group_tasks) in groups {
        let pool = pool.clone();
        let metrics = Arc::clone(metrics);
        let gcal_handle = Arc::clone(gcal_handle);
        join_set.spawn(async move {
            for task in group_tasks {
                process_single_foreground_task(&pool, task, &metrics, &gcal_handle).await;
            }
        });
    }
    while let Some(result) = join_set.join_next().await {
        if let Err(e) = result {
            tracing::error!(error = %e, "foreground group task panicked");
        }
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
    let retry_task = task.clone();
    let pool_clone = pool.clone();
    let metrics_clone = Arc::clone(metrics);
    let gcal_clone = Arc::clone(gcal_handle);
    let result = tokio::task::spawn(async move {
        handle_foreground_task(&pool_clone, &task, &metrics_clone, &gcal_clone).await
    })
    .await;
    match &result {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            log_consumer_result("fg", &result);
            tracing::info!("retrying failed foreground task after 100ms backoff");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let pool_clone2 = pool.clone();
            let metrics_clone2 = Arc::clone(metrics);
            let gcal_clone2 = Arc::clone(gcal_handle);
            // C-2a: keep `retry_task` alive past the spawn so we can
            // pull `OpRecord` fields out of it for the warn line below
            // when the retry also fails. The spawn gets its own clone.
            let spawned_task = retry_task.clone();
            let retry_result = tokio::task::spawn(async move {
                handle_foreground_task(&pool_clone2, &spawned_task, &metrics_clone2, &gcal_clone2)
                    .await
            })
            .await;
            log_consumer_result("fg-retry", &retry_result);
            if matches!(&retry_result, Ok(Err(_)) | Err(_)) {
                metrics.fg_errors.fetch_add(1, Ordering::Relaxed);
                // REVIEW-LATER C-2a: defense-in-depth observability for
                // materializer divergence. `ApplyOp` / `BatchApplyOps`
                // tasks that exhaust the foreground retry are dropped
                // silently — `fg_errors` alone lumps every fg failure
                // together, so a non-Apply error masks a real apply
                // divergence. Bump a dedicated counter and emit a warn
                // line carrying the op coordinates (kind, seq,
                // device_id, op_type) so the drop is searchable in
                // logs and surfaceable via `StatusInfo` in the status
                // banner. Non-Apply foreground failures (Barrier and
                // legacy non-Apply variants — none of which are routed
                // through the foreground queue today, but the match
                // arm is exhaustive for safety) keep their existing
                // single-counter behavior.
                let err_msg = match &retry_result {
                    Ok(Err(e)) => format!("{e}"),
                    Err(e) => format!("panic: {e}"),
                    Ok(Ok(())) => unreachable!("matched Ok(Err)|Err just above"),
                };
                match &retry_task {
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
        }
        Err(_) => {
            log_consumer_result("fg", &result);
            metrics.fg_panics.fetch_add(1, Ordering::Relaxed);
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
                const INITIAL_BACKOFF_MS: u64 = 150;
                let mut succeeded = false;
                let mut panicked = false;
                let mut last_error_msg: Option<String> = None;
                let task_clone = task.clone();
                let pool_clone = pool.clone();
                let rp_clone = rp_ref.cloned();
                let result = tokio::task::spawn(async move {
                    handle_background_task(&pool_clone, &task_clone, rp_clone.as_ref()).await
                })
                .await;
                match &result {
                    Ok(Ok(())) => {
                        succeeded = true;
                    }
                    Ok(Err(e)) => {
                        last_error_msg = Some(format!("{e:?}"));
                        log_consumer_result("bg", &result);
                        for attempt in 1..=MAX_RETRIES {
                            let backoff_ms = INITIAL_BACKOFF_MS * (1 << (attempt - 1));
                            tracing::warn!(task = ?format!("{:?}", std::mem::discriminant(&task)), retry = attempt, backoff_ms, "retrying failed background task after {backoff_ms}ms backoff");
                            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                            let retry_task = task.clone();
                            let pool_clone2 = pool.clone();
                            let rp_clone2 = rp_ref.cloned();
                            let retry_result = tokio::task::spawn(async move {
                                handle_background_task(&pool_clone2, &retry_task, rp_clone2.as_ref())
                                    .await
                            })
                            .await;
                            match &retry_result {
                                Ok(Ok(())) => {
                                    succeeded = true;
                                    last_error_msg = None;
                                    break;
                                }
                                Ok(Err(e)) => {
                                    last_error_msg = Some(format!("{e:?}"));
                                    log_consumer_result(&format!("bg-retry-{attempt}"), &retry_result);
                                }
                                Err(e) => {
                                    last_error_msg = Some(format!("panic: {e:?}"));
                                    log_consumer_result(&format!("bg-retry-{attempt}"), &retry_result);
                                    panicked = true;
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        last_error_msg = Some(format!("panic: {e:?}"));
                        log_consumer_result("bg", &result);
                        panicked = true;
                    }
                }
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
