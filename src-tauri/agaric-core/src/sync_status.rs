//! The two sync-side records `materializer::StatusInfo` carries (#4502).
//! Defined here so the materializer's status type does not depend on the sync
//! crate; `agaric_sync::sync_protocol::{snapshot_fallback_metrics,
//! audit_ingest_metrics}` own the counters that produce them and re-export
//! these so their paths still resolve.

/// Snapshot of the most recent sync snapshot-fallback occurrence. Surfaced
/// (cloned) through `StatusInfo::snapshot_fallback_last`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct SnapshotFallbackLast {
    /// Monotonic ordinal of this occurrence within the process — equal to
    /// `count` at the moment it was recorded. Lets an operator tell apart
    /// "the count moved" from "the same stale `reason` is being re-read".
    pub occurrence: u64,
    /// Remote device / peer id whose `from_vv` could not be reached.
    pub peer_id: String,
    /// Per-space scope of the rejected update.
    pub space_id: String,
    /// Human-readable diagnostic from `classify_from_vv_reachability`
    /// (carries the offending `peer={peer_id} counter>=…` detail).
    pub reason: String,
}

/// Snapshot of the most recent audit-ingest stall. Surfaced (cloned) through
/// `StatusInfo::audit_ingest_last_stall`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct AuditIngestStall {
    /// Monotonic ordinal of this stall within the process — equal to
    /// `stalls` at the moment it was recorded. Lets an operator tell apart
    /// "a new stall happened" from "the same stale record is being re-read".
    pub occurrence: u64,
    /// Remote device / peer that shipped the batch.
    pub remote_device_id: String,
    /// The op-log device whose chain stalled (usually *not* the peer that
    /// shipped it — frontiers propagate transitively).
    pub op_device_id: String,
    /// The `seq` that faulted. Everything above it in that device's chain was
    /// deferred.
    pub op_seq: i64,
    /// How many consecutive batches this device has now stalled without making
    /// progress. `1` is an ordinary busy writer; a value at or above
    /// `PERSISTENT_STALL_BATCHES` is the #3727 permanent-stall condition.
    pub consecutive: u32,
    /// The classified-as-transient error, rendered.
    pub error: String,
}
