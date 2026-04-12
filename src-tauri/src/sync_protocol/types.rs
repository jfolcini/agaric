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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncMessage {
    HeadExchange {
        heads: Vec<DeviceHead>,
    },
    OpBatch {
        ops: Vec<OpTransfer>,
        is_last: bool,
    },
    ResetRequired {
        reason: String,
    },
    SnapshotOffer {
        size_bytes: u64,
    },
    SnapshotAccept,
    SnapshotReject,
    SyncComplete {
        last_hash: String,
    },
    Error {
        message: String,
    },
    /// Request file transfer for missing attachments.
    FileRequest {
        attachment_ids: Vec<String>,
    },
    /// Offer a file for transfer (metadata before binary data).
    FileOffer {
        attachment_id: String,
        size_bytes: u64,
        blake3_hash: String,
    },
    /// File transfer complete — receiver confirms integrity.
    FileReceived {
        attachment_id: String,
    },
    /// No more files to transfer.
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
