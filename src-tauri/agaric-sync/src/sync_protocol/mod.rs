//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, Loro-CRDT engine
//! sync, and peer-ref bookkeeping.  The transport layer (WebSocket,
//! BLE, …) is handled elsewhere — this module operates purely on typed
//! [`SyncMessage`] values.

// Sync wire types for Loro-based sync
// (`LoroSyncMessage::{Snapshot, Update}`).
pub mod loro_sync_types;

// `prepare_outgoing` + `apply_remote` helpers that build / consume
// the wire types.
pub mod loro_sync;

// #1319 cross-session aggregate of snapshot-fallback occurrences,
// surfaced through `StatusInfo`.
pub mod snapshot_fallback_metrics;

mod operations;
mod session_state_machine;
pub mod types;

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public API surface
// ---------------------------------------------------------------------------

pub use operations::*;
pub use session_state_machine::SyncOrchestrator;
pub use types::*;
