//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, Loro-CRDT engine
//! sync, and peer-ref bookkeeping.  The transport layer (WebSocket,
//! BLE, …) is handled elsewhere — this module operates purely on typed
//! [`SyncMessage`](crate::sync_protocol::SyncMessage) values.

// Sync wire types for Loro-based sync
// (`LoroSyncMessage::{Snapshot, Update}`).
pub mod loro_sync_types;

// `prepare_outgoing` + `apply_remote` helpers that build / consume
// the wire types.
pub mod loro_sync;

// #3226 durable quarantine for permanently-stuck write-ahead inbox slots
// (the resolution path #3194 / #3213 deliberately left unbuilt).
pub mod loro_sync_quarantine;

// #1319 cross-session aggregate of snapshot-fallback occurrences,
// surfaced through `StatusInfo`.
pub mod snapshot_fallback_metrics;

// #3726 / #3727 cross-session aggregate of audit op-log ingest deferrals,
// per-device stalls and ascending-seq precondition violations, surfaced
// through `StatusInfo`.
pub mod audit_ingest_metrics;

mod operations;
mod session_state_machine;
pub mod types;

// #4498 — property tests for the crate's pure decision functions (the two
// version-vector comparisons, the wire-batch partition, the persisted-bookmark
// codec). Kept in one file rather than four `mod tests` blocks because every
// property scores against the same generated model, and the model is the part
// worth reading once.
#[cfg(test)]
mod protocol_proptest;

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public API surface
// ---------------------------------------------------------------------------

pub use operations::*;
pub use session_state_machine::SyncOrchestrator;
pub use types::*;
