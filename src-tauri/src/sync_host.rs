//! App-side glue between `materializer` and `agaric_sync` (#4502): the
//! sync-side half of `StatusInfo`, read by the `get_status` command. The
//! `ApplyHost` impl for the engine's `Materializer` lives in
//! `agaric_sync::apply_host`, next to the trait.

use agaric_sync::sync_protocol::{audit_ingest_metrics, snapshot_fallback_metrics};
use agaric_sync::sync_scheduler::SyncScheduler;

use crate::materializer::SyncStatus;

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
