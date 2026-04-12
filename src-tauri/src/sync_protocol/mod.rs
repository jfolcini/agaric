//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, op streaming, remote-op
//! application, block-level merge, and peer-ref bookkeeping.  The transport
//! layer (WebSocket, BLE, …) is handled elsewhere — this module operates
//! purely on typed [`SyncMessage`] values.

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
