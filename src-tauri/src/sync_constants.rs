//! Sync-stack–wide constants.
//!
//! Centralised so values that must agree across the daemon, protocol,
//! transport, and bulk-transfer layers cannot drift independently. Each
//! constant carries a one-line rationale next to its definition.
//!
//! Constants that are scoped to a single layer (e.g. `SyncConnection::MAX_MSG_SIZE`,
//! `SyncConnection::RECV_TIMEOUT`) intentionally stay where they live —
//! this module is only for values that were previously duplicated in
//! two or more files in the sync stack.

use std::time::Duration;

// Per-`handle_message` budget on both sides of the sync session loop.
// Generous enough to absorb a large multi-device frontier merge or a
// one-shot snapshot apply without spuriously aborting, while still
// guaranteeing forward progress against a stuck remote / dead-loop in
// the state machine. Used by both initiator (`sync_daemon::orchestrator`)
// and responder (`sync_daemon::server`) message loops.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

// Maximum size of a single binary WebSocket frame for chunked transfers
// (snapshot blobs in `sync_daemon::snapshot_transfer`, attachment files
// in `sync_files`). Stays well under `SyncConnection::MAX_MSG_SIZE`
// (10 MB) to leave headroom for WebSocket framing overhead.
pub const BINARY_FRAME_CHUNK_SIZE: usize = 5_000_000;
