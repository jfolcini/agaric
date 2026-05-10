//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, Loro-CRDT engine
//! sync, and peer-ref bookkeeping.  The transport layer (WebSocket,
//! BLE, …) is handled elsewhere — this module operates purely on typed
//! [`SyncMessage`] values.

// PEND-09 Phase 3 day-3 — sync wire types for Loro-based sync
// (`LoroSyncMessage::{Snapshot, Update}`).  Intentionally NOT
// `#[cfg(feature = "loro-shadow")]`-gated — the types live in the
// default build so the orchestrator can construct/match them
// uniformly across builds.
pub mod loro_sync_types;

// PEND-09 Phase 3 day-4 — `prepare_outgoing` + `apply_remote`
// helpers that build / consume the day-3 wire types.  The module
// declaration is unconditional so the public API surface stays
// stable across builds; the function bodies are
// `#[cfg(feature = "loro-shadow")]`-gated because they touch
// `LoroEngineRegistry` (only present under that feature).  Day-9
// removes the gate.
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
