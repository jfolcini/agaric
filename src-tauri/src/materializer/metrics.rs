use serde::Serialize;
use std::sync::atomic::AtomicU64;

#[derive(Debug)]
pub struct QueueMetrics {
    pub fg_processed: AtomicU64,
    pub bg_processed: AtomicU64,
    pub bg_deduped: AtomicU64,
    pub fts_edits_since_optimize: AtomicU64,
    pub fts_last_optimize_ms: AtomicU64,
    pub cached_block_count: AtomicU64,
    /// #385: rate-limited cache of `SELECT COUNT(*) FROM op_log`, surfaced
    /// as `StatusInfo::total_ops_in_log`.
    ///
    /// `status_with_scheduler` is polled every ~5s while the Status view is
    /// open; the underlying COUNT is an O(rows) index scan that grows with
    /// the (append-only, compaction-trimmed) op log. Rather than thread a
    /// live counter through every op_log INSERT/DELETE site across the
    /// command / sync / recovery / snapshot layers (none of which hold a
    /// `Materializer` reference), we mirror `cached_block_count`'s
    /// stale-tolerant cache shape: recompute the COUNT at most once per
    /// [`super::coordinator::OP_LOG_COUNT_CACHE_TTL_MS`] and serve the
    /// cached value on every poll in between. `total_ops_in_log` is pure
    /// observability, so bounded staleness is acceptable. The companion
    /// timestamp lives in [`Self::cached_op_log_count_at_ms`].
    ///
    /// Sentinel: `u64::MAX` means "never computed" (no valid COUNT yet);
    /// status treats it as a forced recompute. A real COUNT can never be
    /// `u64::MAX` in practice (op_log row counts fit comfortably in i64).
    pub cached_op_log_count: AtomicU64,
    /// #385: epoch-ms timestamp of the last successful refresh of
    /// [`Self::cached_op_log_count`]. `0` means "never refreshed".
    pub cached_op_log_count_at_ms: AtomicU64,
    /// High-water mark of the foreground queue depth observed since the
    /// last metrics-snapshot dump. Reset to 0 every 5 minutes (or every
    /// dump tick) by `metrics_snapshot_task`, so this is a *windowed*
    /// peak — not an all-time peak. Surface it via `StatusInfo`
    /// understanding that consumers see the peak within the current
    /// snapshot window only.
    pub fg_high_water: AtomicU64,
    /// High-water mark of the background queue depth observed since the
    /// last metrics-snapshot dump. Same windowed-reset semantics as
    /// `fg_high_water`.
    pub bg_high_water: AtomicU64,
    pub fg_errors: AtomicU64,
    pub bg_errors: AtomicU64,
    pub fg_panics: AtomicU64,
    pub bg_panics: AtomicU64,
    /// Foreground `ApplyOp` / `BatchApplyOps` tasks dropped after the
    /// 100ms in-memory retry exhausted (C-2a).
    ///
    /// The foreground queue intentionally retries failing apply tasks
    /// only once before dropping them — the assumption is that a
    /// transient WAL contention will clear within 100ms and any
    /// persistent error indicates materializer divergence that the
    /// background reconciler / restart-time replay will eventually fix.
    /// Without an explicit counter the drop is invisible (only
    /// `fg_errors` gets bumped, and that lumps in non-Apply failures
    /// too), so a divergence between the op log and the materialized
    /// `blocks` table cannot be detected from the status endpoint.
    /// A non-zero value is the single observability signal that an
    /// apply-op task was silently discarded — pair with the
    /// `kind=ApplyOp` / `kind=BatchApplyOps` warn lines in the log
    /// (which include `seq` / `device_id` / `op_type`) for triage.
    /// Each `BatchApplyOps` drop is counted once regardless of batch
    /// size; the rest of the batch is implicitly dropped together.
    pub fg_apply_dropped: AtomicU64,
    /// PEND-24 H1: subset of [`Self::fg_apply_dropped`] whose retry
    /// row was successfully written to `materializer_retry_queue` so
    /// the boot-time / periodic sweeper can re-enqueue the op.
    /// `BatchApplyOps` drops fan out into one persisted row per
    /// record, so this counter increments per-record rather than
    /// per-batch (in contrast to `fg_apply_dropped`, which is a
    /// per-drop-event counter). A divergence between
    /// `fg_apply_dropped` and `fg_apply_dropped_persisted` (after
    /// accounting for batch fan-out) indicates that the persistence
    /// path itself is failing — pair with
    /// [`Self::retry_queue_persist_errors`] for triage.
    pub fg_apply_dropped_persisted: AtomicU64,
    /// Background tasks that exhausted all in-memory retries (per-block
    /// tasks persisted to `materializer_retry_queue`, **and as of PEND-03
    /// global cache rebuilds also persisted to that queue under the
    /// `'__GLOBAL__'` sentinel** — see BUG-22 / PEND-03), **and** tasks
    /// that `try_enqueue_background` had to shed under backpressure
    /// because the bounded channel was full (M-7 / M-8). Both
    /// drop-classes are aggregated here so a non-zero value is the
    /// single observability signal that the materializer is silently
    /// degrading cache freshness.
    pub bg_dropped: AtomicU64,
    /// PEND-03: subset of [`Self::bg_dropped`] attributable to global
    /// cache rebuild tasks (`RebuildTagsCache`, `RebuildPagesCache`,
    /// `RebuildAgendaCache`, `RebuildProjectedAgendaCache`,
    /// `RebuildTagInheritanceCache`, `RebuildPageIds`,
    /// `RebuildBlockTagRefsCache`). Lets operators distinguish a
    /// per-block reindex backlog (large `bg_dropped`, small
    /// `bg_dropped_global`) from a global-cache freshness gap (the two
    /// counters move together). Bumped both when a global task is shed
    /// at queue-full time and when one fails handler-side and is
    /// persisted via [`super::retry_queue::record_failure`].
    pub bg_dropped_global: AtomicU64,
    /// Number of times `enqueue_foreground` had to await on a full
    /// channel. A non-zero value indicates foreground backpressure.
    /// See MAINT-24.
    pub fg_full_waits: AtomicU64,
    /// PEND-24 M1: count of failed
    /// [`super::retry_queue::record_failure`] calls — i.e. the number
    /// of times the retry-queue persistence write itself returned an
    /// error.
    ///
    /// Each call into [`super::consumer::record_failure_with_retry`]
    /// makes up to two `record_failure` attempts (separated by a
    /// 100 ms backoff); both first-attempt and retry-attempt failures
    /// bump this counter. So a single dropped task whose persistence
    /// fails twice contributes `+2`. A non-zero value indicates that
    /// the retry queue write path itself is degraded — operators see
    /// `bg_dropped` / `fg_apply_dropped` continue to climb but the
    /// task may not be in `materializer_retry_queue`, so the boot-time
    /// sweeper cannot recover it.
    pub retry_queue_persist_errors: AtomicU64,
    /// Issue #157 sub-item D — count of retry-queue rows that the
    /// sweeper gave up on because they hit one of the give-up triggers:
    /// `attempts >= MAX_ATTEMPTS` (a permanently failing task) or
    /// `created_at < now - GIVE_UP_AGE_DAYS` (a stale row that's been
    /// sitting in the queue beyond the keep-trying window). Each give-up
    /// is logged with the trigger reason at warn level and the row is
    /// deleted (no further retries). A non-zero value here is the
    /// observability signal that the materializer permanently dropped
    /// at least one persisted task on this run — pair with the
    /// `give_up_reason=…` warn lines in the log for triage.
    pub retry_queue_giveup_total: AtomicU64,
    /// Milliseconds since Unix epoch of the most recent successfully
    /// processed materializer batch (foreground or background). Used to
    /// detect stalled consumers. 0 means the materializer has not yet
    /// processed any batch.
    pub last_materialize_ms: AtomicU64,
}

impl Default for QueueMetrics {
    fn default() -> Self {
        // Millis since epoch fits in u64 for millions of years; saturate on overflow.
        let now_ms = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(u64::MAX);
        Self {
            fg_processed: AtomicU64::new(0),
            bg_processed: AtomicU64::new(0),
            bg_deduped: AtomicU64::new(0),
            fts_edits_since_optimize: AtomicU64::new(0),
            fts_last_optimize_ms: AtomicU64::new(now_ms),
            cached_block_count: AtomicU64::new(0),
            // #385: u64::MAX sentinel = "never computed"; 0 timestamp =
            // "never refreshed". The first status poll forces a recompute.
            cached_op_log_count: AtomicU64::new(u64::MAX),
            cached_op_log_count_at_ms: AtomicU64::new(0),
            fg_high_water: AtomicU64::new(0),
            bg_high_water: AtomicU64::new(0),
            fg_errors: AtomicU64::new(0),
            bg_errors: AtomicU64::new(0),
            fg_panics: AtomicU64::new(0),
            bg_panics: AtomicU64::new(0),
            fg_apply_dropped: AtomicU64::new(0),
            fg_apply_dropped_persisted: AtomicU64::new(0),
            bg_dropped: AtomicU64::new(0),
            bg_dropped_global: AtomicU64::new(0),
            fg_full_waits: AtomicU64::new(0),
            retry_queue_persist_errors: AtomicU64::new(0),
            retry_queue_giveup_total: AtomicU64::new(0),
            last_materialize_ms: AtomicU64::new(0),
        }
    }
}

/// Snapshot of materializer + sync observability fields exposed to the
/// frontend via `get_status`. Fields are added additively so existing
/// specta-derived TS bindings keep compiling.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StatusInfo {
    pub foreground_queue_depth: usize,
    pub background_queue_depth: usize,
    pub total_ops_dispatched: u64,
    pub total_background_dispatched: u64,
    /// Peak foreground queue depth observed in the current 5-minute
    /// metrics-snapshot window. Resets every dump tick (see
    /// `metrics_snapshot_task` in `coordinator.rs`); not an all-time peak.
    pub fg_high_water: u64,
    /// Peak background queue depth observed in the current 5-minute
    /// metrics-snapshot window. Same windowed-reset semantics as
    /// `fg_high_water`.
    pub bg_high_water: u64,
    pub fg_errors: u64,
    pub bg_errors: u64,
    pub fg_panics: u64,
    pub bg_panics: u64,
    /// Foreground `ApplyOp` / `BatchApplyOps` tasks dropped after the
    /// 100ms in-memory retry exhausted (C-2a). Surfaces
    /// silent materializer divergence: a non-zero value means an
    /// apply-op landed in the op log but never reached the
    /// materialized `blocks` table on this run. Pair with the
    /// `kind=ApplyOp` / `kind=BatchApplyOps` warn lines in the log
    /// (which carry `seq` / `device_id` / `op_type`) for triage.
    /// Each `BatchApplyOps` drop counts once regardless of batch size.
    pub fg_apply_dropped: u64,
    /// PEND-24 H1: subset of `fg_apply_dropped` whose retry row was
    /// successfully persisted to `materializer_retry_queue`. The
    /// boot-time / periodic sweeper re-enqueues these onto the
    /// foreground queue so the apply-op is eventually retried. A
    /// large gap between `fg_apply_dropped` and
    /// `fg_apply_dropped_persisted` (after `BatchApplyOps` fan-out)
    /// indicates the persistence write path is failing — pair with
    /// `retry_queue_persist_errors` for triage.
    pub fg_apply_dropped_persisted: u64,
    // --- MAINT-24 additions ---
    /// Number of background tasks that were either persisted to the retry
    /// queue or silently dropped after exhausting retries.
    pub bg_dropped: u64,
    /// PEND-03: subset of `bg_dropped` attributable to global cache
    /// rebuilds (`RebuildTagsCache`, `RebuildPagesCache`,
    /// `RebuildAgendaCache`, `RebuildProjectedAgendaCache`,
    /// `RebuildTagInheritanceCache`, `RebuildPageIds`,
    /// `RebuildBlockTagRefsCache`). A non-zero value means at least
    /// one global cache rebuild was shed or persisted on this run.
    /// Worst-case staleness is bounded by the persistent-retry-queue
    /// backoff cap (1h) because every dropped global task is also
    /// recorded under the `'__GLOBAL__'` sentinel for sweeper-driven
    /// re-enqueue.
    pub bg_dropped_global: u64,
    /// Running count of background tasks deduped in the batch drain (was
    /// already tracked atomically; now surfaced).
    pub bg_deduped: u64,
    /// Number of times the foreground `enqueue_foreground` path awaited on
    /// a full channel. Non-zero indicates backpressure.
    pub fg_full_waits: u64,
    /// PEND-24 M1: count of failed `record_failure` calls (i.e. retry
    /// queue persistence writes that returned an error). Each
    /// dropped task that fails persistence twice contributes `+2`
    /// (first attempt + retry attempt). A non-zero value means the
    /// retry-queue write path itself is degraded; pair with
    /// `bg_dropped` and `fg_apply_dropped_persisted` to confirm
    /// whether tasks are being lost to persist failures.
    pub retry_queue_persist_errors: u64,
    /// Issue #157 sub-item D — number of retry-queue rows the sweeper
    /// has permanently given up on (hit `attempts >= MAX_ATTEMPTS` or
    /// `created_at < now - GIVE_UP_AGE_DAYS`). A non-zero value means
    /// at least one persisted task was permanently dropped on this
    /// run; pair with the `give_up_reason=…` warn lines for triage.
    pub retry_queue_giveup_total: u64,
    /// RFC 3339 timestamp of the most recent successful batch, if any.
    pub last_materialize_at: Option<String>,
    /// Seconds elapsed since `last_materialize_at`. None when no batch has
    /// completed yet.
    pub time_since_last_materialize_secs: Option<u64>,
    /// Row count of `op_log` at status-request time. `None` if the query
    /// failed for any reason (the status call never fails because of it).
    pub total_ops_in_log: Option<i64>,
    /// `(peer_id, consecutive_failure_count)` pairs for every peer the
    /// `SyncScheduler` has seen fail at least once. Empty when the
    /// scheduler is not injected (tests, legacy callers).
    pub sync_peer_failure_counts: Vec<(String, u32)>,
    /// Number of rows currently queued in `materializer_retry_queue` —
    /// per-block tasks waiting for their next retry window.
    pub retry_queue_pending: Option<i64>,
    /// #1326 / #1057: process-global count of SQL-only fallbacks taken by
    /// the `apply_*_via_loro` handlers (Loro engine uninitialised or block
    /// space unresolved). Monotonic, never reset. **In production both
    /// fallback arms are unreachable**, so a non-zero value signals an
    /// unexpected engine-uninit or space-resolution miss that warrants
    /// investigation — pair with the
    /// `target=materializer::sql_only_fallback` debug lines (which carry
    /// `op` + `reason`) for triage. Sourced from
    /// [`super::handlers::sql_only_fallback::count`].
    pub sql_only_fallback_count: u64,
}
