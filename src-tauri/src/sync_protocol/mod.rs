//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, op streaming, remote-op
//! application, block-level merge, and peer-ref bookkeeping.  The transport
//! layer (WebSocket, BLE, …) is handled elsewhere — this module operates
//! purely on typed [`SyncMessage`] values.

// PEND-09 Phase 3 day-3 — new sync wire types for Loro-based sync
// (`LoroSyncMessage::{Snapshot, Update}`).  Day-4 wires these into
// the sender; day-5 swings the receiver and deletes `OpBatch`.
// Intentionally NOT `#[cfg(feature = "loro-shadow")]`-gated — the
// types live in the default build so day-5 can swing the wire
// without first un-gating.  See module docstring for the why.
pub mod loro_sync_types;

// PEND-09 Phase 3 day-4 — `prepare_outgoing` + `apply_remote`
// helpers that build / consume the day-3 wire types.  The module
// declaration is unconditional so the public API surface stays
// stable across builds; the function bodies are
// `#[cfg(feature = "loro-shadow")]`-gated because they touch
// `LoroEngineRegistry` (only present under that feature).  Day-5
// wires these into `super::orchestrator`'s session loop and deletes
// the diffy-typed `OpBatch` path.
pub mod loro_sync;

mod operations;
mod orchestrator;
pub mod types;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of [`OpTransfer`]s sent in a single [`SyncMessage::OpBatch`].
///
/// Large op logs are streamed in chunks of this size so that no single message
/// becomes excessively large.  Intermediate batches carry `is_last: false`;
/// the final (or only) batch carries `is_last: true`.
const OP_BATCH_SIZE: usize = 1000;

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public API surface
// ---------------------------------------------------------------------------

pub use operations::*;
pub use orchestrator::SyncOrchestrator;
pub use types::*;
