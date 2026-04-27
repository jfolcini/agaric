use serde::{Deserialize, Serialize};

use crate::op_log::OpRecord;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Per-device head: the latest `(device_id, seq, hash)` for a device in the
/// op log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
pub struct DeviceHead {
    pub device_id: String,
    pub seq: i64,
    pub hash: String,
}

/// Wire-safe representation of an [`OpRecord`] for transmission between peers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpTransfer {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    pub created_at: String,
}

// ---- Conversions ----------------------------------------------------------

impl From<OpRecord> for OpTransfer {
    fn from(r: OpRecord) -> Self {
        Self {
            device_id: r.device_id,
            seq: r.seq,
            parent_seqs: r.parent_seqs,
            hash: r.hash,
            op_type: r.op_type,
            payload: r.payload,
            created_at: r.created_at,
        }
    }
}

impl From<OpTransfer> for OpRecord {
    fn from(t: OpTransfer) -> Self {
        Self {
            device_id: t.device_id,
            seq: t.seq,
            parent_seqs: t.parent_seqs,
            hash: t.hash,
            op_type: t.op_type,
            payload: t.payload,
            created_at: t.created_at,
        }
    }
}

/// Messages exchanged between two sync peers.
///
/// # Valid wire-level message sequence
///
/// The full session is driven by two cooperating state machines: the
/// per-session [`SyncOrchestrator`](super::SyncOrchestrator) (defined in
/// [`crate::sync_protocol::orchestrator`]) drives the head-exchange →
/// op-stream → merge → complete pipeline, and the surrounding
/// [`crate::sync_daemon`] orchestrator drives the post-complete
/// snapshot and file-transfer sub-flows. The valid order on the wire
/// is:
///
/// 1. **`HeadExchange`** — exactly once per session, in both
///    directions. Sent first by the initiator, replied by the
///    responder. Carries the latest `(device_id, seq, hash)` tuple per
///    advertised device. A second `HeadExchange` mid-session is a
///    protocol violation and transitions to
///    [`SyncState::Failed`](super::SyncState::Failed).
///
/// 2. **`OpBatch`** — zero or more, in either direction, after the
///    peer-relevant `HeadExchange` has been processed. Every batch
///    carries `is_last`; the final batch sets `is_last: true` to
///    flush the receiver's accumulator and trigger the per-session
///    apply + merge.
///
/// 3. **`SyncComplete`** — exactly once per side, after that side has
///    streamed its final `OpBatch`. Carries `last_hash` (the receiver's
///    new frontier-of-record), which is written to `peer_refs` to
///    bookmark the next session's starting point.
///
/// 4. **`ResetRequired`** — terminal *side-exit* in place of
///    `SyncComplete`, sent by the responder when its op log has been
///    compacted past the initiator's advertised heads (i.e. a delta
///    replay is impossible). Triggers the snapshot sub-flow below;
///    the per-session state machine never accepts another delta
///    message after this point.
///
/// 5. **`SnapshotOffer` → `SnapshotAccept` | `SnapshotReject`**
///    (post-`ResetRequired` only) — driven by
///    [`crate::sync_daemon::snapshot_transfer`], not the per-session
///    state machine. Responder offers; initiator accepts (and then
///    receives the blob in binary frames) or rejects (and the session
///    closes). `SnapshotOffer` arriving outside this sub-flow is a
///    protocol error.
///
/// 6. **`FileRequest` → (`FileOffer` + binary frames + `FileReceived`)*
///    → `FileTransferComplete`** (post-`SyncComplete` only) — driven
///    by [`crate::sync_files`], not the per-session state machine.
///    Both peers run this exchange in turn (initiator first, then
///    responder) so each side can pull missing attachments. These
///    variants must therefore **never** reach the per-session
///    `SyncOrchestrator::handle_message` dispatch.
///
/// 7. **`Error { message }`** — any side may send at any point to
///    abort. The receiver transitions to
///    [`SyncState::Failed`](super::SyncState::Failed); the connection
///    is closed and the daemon retries on the next scheduled tick.
///
/// See [`crate::sync_protocol::orchestrator`] (per-session ASCII
/// diagram) and [`crate::sync_daemon::orchestrator`] (daemon-level
/// orchestration) for the source-of-truth narrative.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncMessage {
    /// First exchanged in a session; advertises `(device_id, seq, hash)`
    /// tuples. Both peers must send exactly one.
    HeadExchange { heads: Vec<DeviceHead> },
    /// Streamed after `HeadExchange`. The batch carrying `is_last: true`
    /// flushes the receiver's accumulator and triggers apply + merge.
    OpBatch { ops: Vec<OpTransfer>, is_last: bool },
    /// Responder side-exit: our op log was compacted past the
    /// initiator's heads, so a delta replay is impossible. Triggers
    /// the snapshot sub-flow in [`crate::sync_daemon::snapshot_transfer`].
    ResetRequired { reason: String },
    /// Snapshot sub-flow only (post-`ResetRequired`). Responder offers
    /// the latest local snapshot blob's size; initiator decides.
    SnapshotOffer { size_bytes: u64 },
    /// Initiator accepts the offered snapshot; responder follows up with
    /// `size_bytes` of binary frames.
    SnapshotAccept,
    /// Initiator declines (size cap, integrity check, etc.). Session ends.
    SnapshotReject,
    /// Per-side terminal: this side has finished sending and bookmarks
    /// `last_hash` as its new frontier-of-record in `peer_refs`.
    SyncComplete { last_hash: String },
    /// Any side may send at any time to abort the session.
    Error { message: String },
    /// File-transfer sub-flow only (post-`SyncComplete`).
    /// Request file transfer for missing attachments.
    FileRequest { attachment_ids: Vec<String> },
    /// File-transfer sub-flow only.
    /// Offer a file for transfer (metadata before binary data).
    FileOffer {
        attachment_id: String,
        size_bytes: u64,
        blake3_hash: String,
    },
    /// File-transfer sub-flow only.
    /// Receiver confirms hash + write succeeded for `attachment_id`.
    FileReceived { attachment_id: String },
    /// File-transfer sub-flow only.
    /// "No more files from this side" sentinel — concludes one half of
    /// the bidirectional file-transfer phase.
    FileTransferComplete,
}

/// Current phase of the sync state machine.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncState {
    Idle,
    ExchangingHeads,
    StreamingOps,
    ApplyingOps,
    Merging,
    TransferringFiles,
    Complete,
    ResetRequired,
    Failed(String),
}

/// Observable session counters.
pub struct SyncSession {
    pub state: SyncState,
    pub local_device_id: String,
    pub remote_device_id: String,
    pub ops_received: usize,
    pub ops_sent: usize,
}

/// Counts returned by [`apply_remote_ops`](super::apply_remote_ops).
#[derive(Debug)]
pub struct ApplyResult {
    pub inserted: usize,
    pub duplicates: usize,
    pub hash_mismatches: usize,
    /// Number of ops where `(device_id, seq)` already existed locally with a
    /// **different** hash — i.e., a fork: a peer produced a divergent op for
    /// the same `(device_id, seq)` slot. The local copy is kept; the
    /// incoming op is dropped (the existing `INSERT OR IGNORE` is a no-op
    /// for these rows). This is distinct from `duplicates` (same hash), and
    /// is surfaced for observability so callers can log/alert.
    pub forks: usize,
}

/// Counts returned by [`merge_diverged_blocks`](super::merge_diverged_blocks).
pub struct MergeResults {
    pub clean_merges: usize,
    pub conflicts: usize,
    pub already_up_to_date: usize,
    pub property_lww: usize,
    pub move_lww: usize,
    pub delete_edit_resurrect: usize,
}
