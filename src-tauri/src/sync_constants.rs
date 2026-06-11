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
// in `sync_files`, large LoroSync payloads in `sync_daemon::wire`).
// Stays well under `SyncConnection::MAX_MSG_SIZE` (10 MB) to leave
// headroom for WebSocket framing overhead.
pub const BINARY_FRAME_CHUNK_SIZE: usize = 5_000_000;

// ---------------------------------------------------------------------------
// LoroSync payload transport (#611)
// ---------------------------------------------------------------------------

// Largest Loro payload (`LoroSyncMessage::{Snapshot,Update}.bytes`) that is
// shipped *inline* as part of the JSON text frame. Anything larger rides the
// chunked binary path (`SyncMessage::LoroSyncChunked` header + binary frames,
// see `sync_daemon::wire`).
//
// Sizing: `Vec<u8>` serialises as a JSON number array, which inflates each
// byte to at most 4 characters ("255," — three digits plus the separator).
// `2_400_000 * 4 = 9_600_000` characters of array body, leaving ~400 KB of
// headroom for the envelope (`type`/`kind` tags, `space_id`, `from_vv`,
// `is_last`) under `SyncConnection::MAX_MSG_SIZE` (10 MB). The decision is
// made on `bytes.len()` (not the serialised length) so the inline-vs-chunked
// choice is deterministic and never requires materialising an over-cap JSON
// string just to measure it. The `loro_inline_max_fits_recv_cap` tripwire in
// `sync_daemon::wire` locks this arithmetic against drift.
//
// Compatibility: payloads at or under this threshold keep the exact
// `protocol_version: 1` inline wire shape, so a pre-#611 peer interoperates
// untouched for every payload it could ever successfully receive (its
// receive cap broke at ~2.8 MB of Loro bytes anyway).
pub const LORO_INLINE_MAX_BYTES: usize = 2_400_000;

// Upper bound on `LoroSyncChunkedHeader::size_bytes` accepted from a peer
// before any binary frame is read — defence-in-depth against a runaway or
// malicious header causing an unbounded allocation. Matches the snapshot
// sub-flow's `MAX_SNAPSHOT_SIZE` (256 MB) cap: a per-space Loro snapshot is
// the same order of magnitude as the compressed DB snapshot blob, and both
// arrive over the identical chunked binary machinery.
pub const MAX_LORO_SYNC_PAYLOAD_SIZE: u64 = 256 * 1024 * 1024;
