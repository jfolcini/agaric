use serde::Serialize;
use std::sync::atomic::AtomicU64;

#[derive(Debug)]
pub struct QueueMetrics {
    pub fg_processed: AtomicU64,
    pub bg_processed: AtomicU64,
    pub bg_deduped: AtomicU64,
    pub fts_edits_since_optimize: AtomicU64,
    pub fts_last_optimize_ms: AtomicU64,
    pub fg_high_water: AtomicU64,
    pub bg_high_water: AtomicU64,
    pub fg_errors: AtomicU64,
    pub bg_errors: AtomicU64,
    pub fg_panics: AtomicU64,
    pub bg_panics: AtomicU64,
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
            fg_high_water: AtomicU64::new(0),
            bg_high_water: AtomicU64::new(0),
            fg_errors: AtomicU64::new(0),
            bg_errors: AtomicU64::new(0),
            fg_panics: AtomicU64::new(0),
            bg_panics: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StatusInfo {
    pub foreground_queue_depth: usize,
    pub background_queue_depth: usize,
    pub total_ops_dispatched: u64,
    pub total_background_dispatched: u64,
    pub fg_high_water: u64,
    pub bg_high_water: u64,
    pub fg_errors: u64,
    pub bg_errors: u64,
    pub fg_panics: u64,
    pub bg_panics: u64,
}
