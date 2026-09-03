//! App-side glue between `materializer` and `agaric_sync` (#4502): the
//! `Materializer` as the sync daemon's [`ApplyHost`], and the sync-side half
//! of `StatusInfo`. It lives outside `materializer/` so that module has no
//! dependency on the sync crate, and descends into `agaric-sync` with the
//! materializer, where the orphan rule lets sync implement its own trait for
//! the engine's type.

use std::path::PathBuf;
use std::sync::Arc;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_sync::apply_host::ApplyHost;
use agaric_sync::sync_protocol::{audit_ingest_metrics, snapshot_fallback_metrics};
use agaric_sync::sync_scheduler::SyncScheduler;

use crate::materializer::{Materializer, SyncStatus};

#[async_trait::async_trait]
impl ApplyHost for Materializer {
    fn loro_state(&self) -> Arc<agaric_engine::loro::shared::LoroState> {
        Arc::clone(Materializer::loro_state(self))
    }

    async fn enqueue_inbound_sync_rebuilds(
        &self,
        changed_blocks: &[BlockId],
        purged_blocks: &[BlockId],
    ) -> Result<(), AppError> {
        Materializer::enqueue_inbound_sync_rebuilds(self, changed_blocks, purged_blocks).await
    }

    /// #3328: the attachment root, served from the value `lib.rs` registers
    /// via `Materializer::set_app_data_dir` — the same `OnceLock` the
    /// `CleanupOrphanedAttachments` task reads. Sync-received attachments and
    /// the GC that reconciles them now resolve their directory from one
    /// place instead of two.
    ///
    /// `None` before `set_app_data_dir` runs (and in tests that never call
    /// it); the sync call sites fall back to deriving the root from the pool
    /// in that case, which is the pre-#3328 behaviour.
    fn app_data_dir(&self) -> Option<PathBuf> {
        Materializer::app_data_dir(self)
    }

    async fn enqueue_post_snapshot_rebuilds(&self) -> Result<(), AppError> {
        Materializer::enqueue_post_snapshot_rebuilds(self).await
    }

    async fn flush(&self) -> Result<(), AppError> {
        Materializer::flush(self).await
    }
}

/// #2621 (agaric-sync inversion): lets the sync layer's constructors accept a
/// `Materializer` (tests) or an already-erased `Arc<dyn ApplyHost>`
/// (production) uniformly via `impl Into<Arc<dyn ApplyHost>>`, wrapping the
/// concrete coordinator exactly once with no double indirection.
impl From<Materializer> for Arc<dyn ApplyHost> {
    fn from(materializer: Materializer) -> Self {
        Arc::new(materializer)
    }
}

/// The sync layer's contribution to `StatusInfo`: the scheduler's per-peer
/// failure counts plus the process-global snapshot-fallback (#1319) and
/// audit-ingest (#3726, #3727) aggregates.
pub fn sync_status(scheduler: &SyncScheduler) -> SyncStatus {
    SyncStatus {
        peer_failure_counts: scheduler.failure_counts(),
        snapshot_fallback_count: snapshot_fallback_metrics::count(),
        snapshot_fallback_last: snapshot_fallback_metrics::last(),
        audit_ingest_deferred: audit_ingest_metrics::deferred_records(),
        audit_ingest_stalls: audit_ingest_metrics::stalls(),
        audit_ingest_out_of_order: audit_ingest_metrics::out_of_order_records(),
        audit_ingest_last_stall: audit_ingest_metrics::last(),
    }
}
