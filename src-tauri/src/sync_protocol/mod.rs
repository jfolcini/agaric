//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, Loro-CRDT engine
//! sync, and peer-ref bookkeeping.  The transport layer (WebSocket,
//! BLE, …) is handled elsewhere — this module operates purely on typed
//! [`SyncMessage`] values.

// PEND-09 Phase 3 day-3 — sync wire types for Loro-based sync
// (`LoroSyncMessage::{Snapshot, Update}`).
pub mod loro_sync_types;

// PEND-09 Phase 3 day-4 — `prepare_outgoing` + `apply_remote`
// helpers that build / consume the day-3 wire types.  Phase 3 day-9
// retired the `loro-shadow` feature gate; the module compiles
// unconditionally now.
pub mod loro_sync;

mod operations;
mod orchestrator;
pub mod types;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public API surface
// ---------------------------------------------------------------------------

pub use operations::*;
pub use orchestrator::SyncOrchestrator;
pub use types::*;
