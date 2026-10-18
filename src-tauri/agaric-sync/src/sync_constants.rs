//! Sync-stack–wide constants.
//!
//! Centralised so values that must agree across the daemon, protocol,
//! transport, and bulk-transfer layers cannot drift independently. Each
//! constant carries a one-line rationale next to its definition.
//!
//! Constants scoped to a single layer (e.g. `transport::session::MAX_FRAME_SIZE`,
//! `transport::driver`'s `RECV_TIMEOUT`) intentionally stay where they live —
//! this module is only for values that were previously duplicated in two or more
//! files across the sync stack.

use std::time::Duration;

// Per-`handle_message` budget on both sides of the sync session loop.
// Generous enough to absorb a large multi-device frontier merge or a
// one-shot snapshot apply without spuriously aborting, while still
// guaranteeing forward progress against a stuck remote / dead-loop in
// the state machine. Used by both initiator (`sync_daemon::session_supervisor`)
// and responder (`sync_daemon::server`) message loops.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

// Granularity of the streamed reads: attachment files in `sync_files` (through
// `transport::bulk`), and frame bodies and raw Loro bytes in
// `transport::session`.
//
// Under the retired WebSocket transport this *was* the binary frame size, sized
// to sit well under that transport's 10 MB per-message cap. Under QUIC there is
// no such frame: `transport::bulk` copies a byte stream through a fixed buffer
// of this size (`BULK_COPY_BYTES`), and `transport::session` reads through one,
// so the number now sets peak copy-buffer heap and the cadence of `on_progress`
// ticks. It is kept at the old value so progress reporting lands where users
// have seen it land, and nothing caps it — raising it costs heap per in-flight
// transfer, not correctness.
pub const BINARY_FRAME_CHUNK_SIZE: usize = 5_000_000;

// ---------------------------------------------------------------------------
// LoroSync payload transport (#5761)
// ---------------------------------------------------------------------------

// Upper bound on an announced payload size accepted from a peer before the
// buffer is allocated, so a corrupt length cannot become an unbounded
// allocation. It bounds `LoroSyncChunkedHeader::size_bytes`, the raw Loro
// bytes after a `LoroSync` header (#5761), and is
// `transport::session::MAX_FRAME_SIZE`, the cap on a whole framed message.
pub const MAX_LORO_SYNC_PAYLOAD_SIZE: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// OpLogBatch payload transport (#2593, #2481 follow-up)
// ---------------------------------------------------------------------------

// Largest serialised `OpLogBatch.records` payload (`serde_json::to_vec` of the
// `Vec<OpTransfer>`) shipped *inline* as part of the JSON message. Anything
// larger used to ride the chunked binary path
// (`SyncMessage::OpLogBatchChunked`); since #3464 removed it, an over-threshold
// batch ships inline and this bound only gates the peer-capability check in
// `collect_op_batches_for_peer`.
//
// It is on the wire: a chunking-era peer split its batches here, under the
// retired WebSocket transport's 10 MB per-message cap. The records serialise
// as JSON objects/strings (~1× plus escaping), so a batch under this bound sat
// comfortably within that cap once wrapped in the
// `{"type":"OpLogBatch","records":[..],"is_last":..}` envelope. The decision
// is made on the serialised payload length (not the whole message) so the
// capability check never requires materialising an over-cap JSON just to
// measure it.
//
// Compatibility: batches at or under this threshold keep the exact inline
// `OpLogBatch` wire shape, so a peer that understands `OpLogBatch` (#2481
// phase 1) but not the chunked envelope (#2593) interoperates untouched for
// every batch it could ever successfully receive.
pub const OP_LOG_BATCH_INLINE_MAX_BYTES: usize = 2_400_000;

// Hard cap on a serialised `OpLogBatch` payload, mirroring
// `MAX_LORO_SYNC_PAYLOAD_SIZE`. A batch above it is dropped at the sender
// (`collect_op_batches_for_peer`) rather than faulting the session, since it
// exceeds the frame cap itself. A single op record carries at most one block's
// `content: String` (normally bounded by the 256 KiB content cap in
// `block_ops.rs`; a sync-applied/imported op is not re-checked against that
// cap, which is exactly why an oversized record is possible at all), so 256 MB
// is generous headroom for any realistic batch.
pub const MAX_OP_LOG_BATCH_PAYLOAD_SIZE: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Responder connection concurrency (#1581)
// ---------------------------------------------------------------------------

// Upper bound on the number of *concurrent in-flight responder sessions* the
// endpoint service (`transport::service::SyncService`) will run at once. A
// permit is acquired from an `Arc<Semaphore>` of this size in the accept loop
// *before* the connection is admitted; when the service is already at capacity
// the freshly accepted connection is refused immediately rather than spending
// the CPU and file-descriptor cost of setting it up. The permit is then held
// for the whole responder session, which can live up to
// `transport::driver`'s `RECV_TIMEOUT` (180 s).
//
// This is a *stability* bound, not adversarial DoS hardening — per AGENTS.md
// §"Threat Model" the sync peers are the user's own paired devices and there is
// no malicious actor. The value bounds task / file-descriptor fan-out so that a
// flurry of reconnect attempts (device wake, network flap, a peer retry-looping)
// cannot pin an unbounded number of 180 s sessions and the DB connections they
// contend for.
//
// Sizing: a single user pairs a handful of devices; 16 leaves generous headroom
// over any realistic paired-device count and over the 6-connection DB pool
// (2 writers + 4 readers) those sessions ultimately draw on, while still being a
// hard, finite ceiling.
pub const MAX_CONCURRENT_RESPONDER_SESSIONS: usize = 16;

// ---------------------------------------------------------------------------
// Connect timeout (#2027)
// ---------------------------------------------------------------------------

// Wall-clock budget for the *initiator-side* connect — `Endpoint::connect` on
// the sync ALPN, in `sync_daemon::session_supervisor`. The initiator runs this
// while holding the per-peer lock and blocking its JoinSet round, so a stale
// `last_address` that no longer answers would otherwise hang the whole sync
// round. On elapse the connect fails fast: the multi-address helper records the
// error and moves on to the next address, ultimately failing the round into the
// existing backoff.
//
// Sizing: one LAN connection setup. Ten seconds is generous headroom for a
// slow or loaded device, or a brief network hiccup, while still writing off a
// dead address fast enough that a peer with several stale addresses does not
// consume the round. Distinct from (and far below) the 120 s per-message
// `HANDSHAKE_TIMEOUT`, which covers an established session rather than
// connection setup.
//
// The responder's mirror of this bound is `transport::service`'s
// `CONNECTION_SETUP_TIMEOUT`, which states its own rationale rather than
// importing this one — the two bound different halves of the same event and
// should be tunable apart.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
