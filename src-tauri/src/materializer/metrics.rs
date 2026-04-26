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
    /// Background tasks that exhausted all in-memory retries and were
    /// either persisted to `materializer_retry_queue` (retryable per-block
    /// tasks) or silently dropped (global rebuild tasks that are
    /// re-dispatched elsewhere). See BUG-22.
    pub bg_dropped: AtomicU64,
    /// Number of times `enqueue_foreground` had to await on a full
    /// channel. A non-zero value indicates foreground backpressure.
    /// See MAINT-24.
    pub fg_full_waits: AtomicU64,
    /// Milliseconds since Unix epoch of the most recent successfully
    /// processed materializer batch (foreground or background). Used to
    /// detect stalled consumers. 0 means the materializer has not yet
    /// processed any batch.
    pub last_materialize_ms: AtomicU64,
}

impl Default for QueueMetrics {
    fn default() -> Self {
        // Millis since epoch won't exceed u64 for millions of years
        #[allow(clippy::cast_possible_truncation)]
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            fg_processed: AtomicU64::new(0),
            bg_processed: AtomicU64::new(0),
            bg_deduped: AtomicU64::new(0),
            fts_edits_since_optimize: AtomicU64::new(0),
            fts_last_optimize_ms: AtomicU64::new(now_ms),
            cached_block_count: AtomicU64::new(0),
            fg_high_water: AtomicU64::new(0),
            bg_high_water: AtomicU64::new(0),
            fg_errors: AtomicU64::new(0),
            bg_errors: AtomicU64::new(0),
            fg_panics: AtomicU64::new(0),
            bg_panics: AtomicU64::new(0),
            bg_dropped: AtomicU64::new(0),
            fg_full_waits: AtomicU64::new(0),
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
    // --- MAINT-24 additions ---
    /// Number of background tasks that were either persisted to the retry
    /// queue or silently dropped after exhausting retries.
    pub bg_dropped: u64,
    /// Running count of background tasks deduped in the batch drain (was
    /// already tracked atomically; now surfaced).
    pub bg_deduped: u64,
    /// Number of times the foreground `enqueue_foreground` path awaited on
    /// a full channel. Non-zero indicates backpressure.
    pub fg_full_waits: u64,
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
}
