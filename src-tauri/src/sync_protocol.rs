//! Sync protocol orchestrator (ADR-09).
//!
//! Implements the core sync logic: head exchange, op streaming, remote-op
//! application, block-level merge, and peer-ref bookkeeping.  The transport
//! layer (WebSocket, BLE, …) is handled elsewhere — this module operates
//! purely on typed [`SyncMessage`] values.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::merge;
use crate::op_log::{self, OpRecord};
use crate::peer_refs;

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
    HeadExchange { heads: Vec<DeviceHead> },
    OpBatch { ops: Vec<OpTransfer>, is_last: bool },
    ResetRequired { reason: String },
    SnapshotOffer { size_bytes: u64 },
    SnapshotAccept,
    SnapshotReject,
    SyncComplete { last_hash: String },
    Error { message: String },
}

/// Current phase of the sync state machine.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncState {
    Idle,
    ExchangingHeads,
    StreamingOps,
    ApplyingOps,
    Merging,
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

/// Counts returned by [`apply_remote_ops`].
pub struct ApplyResult {
    pub inserted: usize,
    pub duplicates: usize,
    pub hash_mismatches: usize,
}

/// Counts returned by [`merge_diverged_blocks`].
pub struct MergeResults {
    pub clean_merges: usize,
    pub conflicts: usize,
    pub already_up_to_date: usize,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Get the latest `(device_id, seq, hash)` per device in the op log.
pub async fn get_local_heads(pool: &SqlitePool) -> Result<Vec<DeviceHead>, AppError> {
    let heads = sqlx::query_as::<_, DeviceHead>(
        "SELECT device_id, seq, hash FROM op_log \
         WHERE (device_id, seq) IN \
           (SELECT device_id, MAX(seq) FROM op_log GROUP BY device_id) \
         ORDER BY device_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(heads)
}

/// Compute the set of [`OpRecord`]s to send to a remote peer based on their
/// advertised heads.
///
/// For each device we have ops for:
/// - If remote knows about this device: send ops with `seq > remote_seq`.
/// - If remote doesn't know: send ALL ops for that device.
pub async fn compute_ops_to_send(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<Vec<OpRecord>, AppError> {
    let local_heads = get_local_heads(pool).await?;
    let mut ops: Vec<OpRecord> = Vec::new();

    for local_head in &local_heads {
        let after_seq = remote_heads
            .iter()
            .find(|rh| rh.device_id == local_head.device_id)
            .map(|rh| rh.seq)
            .unwrap_or(0);

        if after_seq >= local_head.seq {
            continue; // remote is up-to-date for this device
        }

        let device_ops = op_log::get_ops_since(pool, &local_head.device_id, after_seq).await?;
        ops.extend(device_ops);
    }

    Ok(ops)
}

/// Check whether a full reset is required for sync with a remote peer.
///
/// Returns `true` if the remote advertises a `(device_id, seq)` that we no
/// longer have in our op log (e.g. after compaction).
pub async fn check_reset_required(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<bool, AppError> {
    for head in remote_heads {
        match op_log::get_op_by_seq(pool, &head.device_id, head.seq).await {
            Ok(_) => {}
            Err(AppError::NotFound(_)) => return Ok(true),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

/// Insert remote ops into the local op log and enqueue materialisation.
///
/// For each op: verify it doesn't already exist (duplicate detection), then
/// call [`dag::insert_remote_op`].  Successfully inserted ops are enqueued
/// as [`MaterializeTask::ApplyOp`].
pub async fn apply_remote_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
    ops: Vec<OpTransfer>,
) -> Result<ApplyResult, AppError> {
    let mut result = ApplyResult {
        inserted: 0,
        duplicates: 0,
        hash_mismatches: 0,
    };

    for op in ops {
        let record: OpRecord = op.into();

        // Duplicate check — if the op already exists, skip it.
        match op_log::get_op_by_seq(pool, &record.device_id, record.seq).await {
            Ok(_) => {
                result.duplicates += 1;
                continue;
            }
            Err(AppError::NotFound(_)) => { /* new op — proceed */ }
            Err(e) => return Err(e),
        }

        match dag::insert_remote_op(pool, &record).await {
            Ok(()) => {
                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(record))
                    .await?;
                result.inserted += 1;
            }
            Err(AppError::InvalidOperation(ref msg)) if msg.contains("hash mismatch") => {
                result.hash_mismatches += 1;
            }
            Err(e) => return Err(e),
        }
    }

    Ok(result)
}

/// After receiving all ops, merge blocks that have diverged between two
/// devices.
///
/// 1. Finds blocks that have `edit_block` ops from both `device_id` and
///    `remote_device_id`.
/// 2. For each, calls [`dag::get_block_edit_heads`] and, if there are ≥ 2
///    heads, [`merge::merge_block`].
///
/// **TODO (sync-merge-coverage):** This currently only detects `edit_block`
/// divergence.  The following conflict types are NOT yet handled:
/// - `set_property` – concurrent property edits (needs LWW via
///   `merge::resolve_property_conflict`)
/// - `move_block` – concurrent reparenting
/// - `delete_block` vs `edit_block` – resurrection / tombstone conflict
///
/// These require new queries and additional merge logic in `dag.rs` and
/// `merge.rs`.
pub async fn merge_diverged_blocks(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    remote_device_id: &str,
) -> Result<MergeResults, AppError> {
    use sqlx::Row;

    let mut results = MergeResults {
        clean_merges: 0,
        conflicts: 0,
        already_up_to_date: 0,
    };

    let rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log WHERE device_id IN (?, ?) AND op_type = 'edit_block' \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in rows {
        let block_id: String = row.try_get("block_id")?;

        let heads = dag::get_block_edit_heads(pool, &block_id).await?;
        if heads.len() < 2 {
            continue;
        }

        // Find our head and their head
        let our_head = heads.iter().find(|(d, _)| d == device_id);
        let their_head = heads
            .iter()
            .find(|(d, _)| d == remote_device_id)
            .or_else(|| heads.iter().find(|(d, _)| d != device_id));

        if let (Some(ours), Some(theirs)) = (our_head, their_head) {
            let outcome = merge::merge_block(pool, device_id, &block_id, ours, theirs).await?;

            match outcome {
                merge::MergeOutcome::Merged(ref record) => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(record.clone()))
                        .await?;
                    results.clean_merges += 1;
                }
                merge::MergeOutcome::ConflictCopy {
                    ref conflict_block_op,
                    ..
                } => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(conflict_block_op.clone()))
                        .await?;
                    results.conflicts += 1;
                }
                merge::MergeOutcome::AlreadyUpToDate => {
                    results.already_up_to_date += 1;
                }
            }
        }
    }

    Ok(results)
}

/// Complete a sync session — update peer_refs with the final hashes.
pub async fn complete_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_received_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    peer_refs::update_on_sync(pool, peer_id, last_received_hash, last_sent_hash).await
}

// ---------------------------------------------------------------------------
// SyncOrchestrator — message-driven state machine
// ---------------------------------------------------------------------------

/// Drives a single sync session through the head-exchange → op-stream →
/// merge → complete lifecycle.
pub struct SyncOrchestrator {
    pool: SqlitePool,
    device_id: String,
    materializer: Materializer,
    state: SyncState,
    session: SyncSession,
    pending_ops_to_send: Vec<OpRecord>,
    received_ops: Vec<OpTransfer>,
    remote_device_id: Option<String>,
}

impl SyncOrchestrator {
    pub fn new(pool: SqlitePool, device_id: String, materializer: Materializer) -> Self {
        Self {
            session: SyncSession {
                state: SyncState::Idle,
                local_device_id: device_id.clone(),
                remote_device_id: String::new(),
                ops_received: 0,
                ops_sent: 0,
            },
            pool,
            device_id,
            materializer,
            state: SyncState::Idle,
            pending_ops_to_send: Vec::new(),
            received_ops: Vec::new(),
            remote_device_id: None,
        }
    }

    /// Generate the initial `HeadExchange` message to kick off sync.
    pub async fn start(&mut self) -> Result<SyncMessage, AppError> {
        let heads = get_local_heads(&self.pool).await?;
        self.state = SyncState::ExchangingHeads;
        self.session.state = SyncState::ExchangingHeads;
        Ok(SyncMessage::HeadExchange { heads })
    }

    /// Process a received message and optionally produce a response.
    ///
    /// **TODO (sync-state-validation):** This currently accepts any message
    /// in any state.  Add guards to reject out-of-order messages (e.g.
    /// `OpBatch` before `HeadExchange`) and transition to `Failed` with a
    /// descriptive error.
    pub async fn handle_message(
        &mut self,
        msg: SyncMessage,
    ) -> Result<Option<SyncMessage>, AppError> {
        match msg {
            // ---- HeadExchange ------------------------------------------------
            SyncMessage::HeadExchange { heads } => {
                // Identify the remote device from received heads
                let remote_id = heads
                    .iter()
                    .find(|h| h.device_id != self.device_id)
                    .map(|h| h.device_id.clone())
                    .unwrap_or_default();
                self.remote_device_id = Some(remote_id.clone());
                self.session.remote_device_id = remote_id;

                // Check whether a reset is required
                if check_reset_required(&self.pool, &heads).await? {
                    self.state = SyncState::ResetRequired;
                    self.session.state = SyncState::ResetRequired;
                    return Ok(Some(SyncMessage::ResetRequired {
                        reason: "local op log missing ops claimed by remote".into(),
                    }));
                }

                // Compute and send ops the remote is missing
                let ops = compute_ops_to_send(&self.pool, &heads).await?;
                let transfers: Vec<OpTransfer> =
                    ops.iter().cloned().map(OpTransfer::from).collect();
                self.session.ops_sent = transfers.len();
                self.pending_ops_to_send = ops;
                self.state = SyncState::StreamingOps;
                self.session.state = SyncState::StreamingOps;

                Ok(Some(SyncMessage::OpBatch {
                    ops: transfers,
                    is_last: true,
                }))
            }

            // ---- OpBatch ----------------------------------------------------
            SyncMessage::OpBatch { ops, is_last } => {
                self.received_ops.extend(ops);

                if !is_last {
                    return Ok(None); // wait for more batches
                }

                // Apply all buffered ops
                self.state = SyncState::ApplyingOps;
                self.session.state = SyncState::ApplyingOps;
                let to_apply = std::mem::take(&mut self.received_ops);
                let count = to_apply.len();
                let _apply_result =
                    apply_remote_ops(&self.pool, &self.materializer, to_apply).await?;
                self.session.ops_received = count;

                // Merge diverged blocks
                self.state = SyncState::Merging;
                self.session.state = SyncState::Merging;
                let remote_id = self.remote_device_id.clone().unwrap_or_default();
                let _merge_results = merge_diverged_blocks(
                    &self.pool,
                    &self.device_id,
                    &self.materializer,
                    &remote_id,
                )
                .await?;

                // Determine our latest head hash for the SyncComplete message
                let last_hash = get_local_heads(&self.pool)
                    .await?
                    .into_iter()
                    .find(|h| h.device_id == self.device_id)
                    .map(|h| h.hash)
                    .unwrap_or_default();

                self.state = SyncState::Complete;
                self.session.state = SyncState::Complete;
                Ok(Some(SyncMessage::SyncComplete { last_hash }))
            }

            // ---- SyncComplete -----------------------------------------------
            SyncMessage::SyncComplete { last_hash } => {
                let peer_id = self.remote_device_id.clone().unwrap_or_default();
                let last_sent_hash = self
                    .pending_ops_to_send
                    .last()
                    .map(|r| r.hash.clone())
                    .unwrap_or_default();

                // Ensure the peer row exists, then record the sync
                peer_refs::upsert_peer_ref(&self.pool, &peer_id).await?;
                complete_sync(&self.pool, &peer_id, &last_hash, &last_sent_hash).await?;

                self.state = SyncState::Complete;
                self.session.state = SyncState::Complete;
                Ok(None)
            }

            // ---- ResetRequired ----------------------------------------------
            SyncMessage::ResetRequired { .. } => {
                self.state = SyncState::ResetRequired;
                self.session.state = SyncState::ResetRequired;
                Ok(None)
            }

            // ---- Error ------------------------------------------------------
            SyncMessage::Error { message } => {
                self.state = SyncState::Failed(message.clone());
                self.session.state = SyncState::Failed(message);
                Ok(None)
            }

            // ---- Snapshot (not yet implemented) -----------------------------
            SyncMessage::SnapshotOffer { .. } => Ok(Some(SyncMessage::SnapshotReject)),
            SyncMessage::SnapshotAccept | SyncMessage::SnapshotReject => Ok(None),
        }
    }

    /// Returns `true` when the session has reached a terminal state.
    pub fn is_complete(&self) -> bool {
        self.state == SyncState::Complete
    }

    /// Borrow the session counters.
    pub fn session(&self) -> &SyncSession {
        &self.session
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Fixture constants ───────────────────────────────────────────────

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";

    // ── Helpers ─────────────────────────────────────────────────────────

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn test_create_payload(block_id: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "test".into(),
        })
    }

    // ── get_local_heads ─────────────────────────────────────────────────

    #[tokio::test]
    async fn get_local_heads_empty_db() {
        let (pool, _dir) = test_pool().await;
        let heads = get_local_heads(&pool).await.unwrap();
        assert!(heads.is_empty(), "empty DB should have no heads");
    }

    #[tokio::test]
    async fn get_local_heads_single_device() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=3 {
            append_local_op_at(
                &pool,
                "device-A",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        let heads = get_local_heads(&pool).await.unwrap();
        assert_eq!(heads.len(), 1, "should have exactly one device head");
        assert_eq!(heads[0].device_id, "device-A");
        assert_eq!(heads[0].seq, 3, "head seq should be 3");
        assert!(!heads[0].hash.is_empty(), "hash must not be empty");
    }

    #[tokio::test]
    async fn get_local_heads_multiple_devices() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("BLK-A1"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            "device-B",
            test_create_payload("BLK-B1"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("BLK-A2"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let heads = get_local_heads(&pool).await.unwrap();
        assert_eq!(heads.len(), 2, "should have two device heads");

        let head_a = heads.iter().find(|h| h.device_id == "device-A").unwrap();
        let head_b = heads.iter().find(|h| h.device_id == "device-B").unwrap();
        assert_eq!(head_a.seq, 2, "device-A should be at seq 2");
        assert_eq!(head_b.seq, 1, "device-B should be at seq 1");
    }

    // ── compute_ops_to_send ─────────────────────────────────────────────

    #[tokio::test]
    async fn compute_ops_to_send_new_peer() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=3 {
            append_local_op_at(
                &pool,
                "device-A",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        // Remote has no heads at all
        let ops = compute_ops_to_send(&pool, &[]).await.unwrap();
        assert_eq!(ops.len(), 3, "should send all 3 ops to a new peer");
    }

    #[tokio::test]
    async fn compute_ops_to_send_partial() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=3 {
            append_local_op_at(
                &pool,
                "device-A",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        // Remote has seq 2 for device-A
        let head2 = DeviceHead {
            device_id: "device-A".into(),
            seq: 2,
            hash: "ignored-for-this-test".into(),
        };
        let ops = compute_ops_to_send(&pool, &[head2]).await.unwrap();
        assert_eq!(ops.len(), 1, "should send only seq 3");
        assert_eq!(ops[0].seq, 3);
    }

    #[tokio::test]
    async fn compute_ops_to_send_up_to_date() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=2 {
            append_local_op_at(
                &pool,
                "device-A",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        let local_heads = get_local_heads(&pool).await.unwrap();
        let ops = compute_ops_to_send(&pool, &local_heads).await.unwrap();
        assert!(ops.is_empty(), "no ops to send when remote matches local");
    }

    // ── apply_remote_ops ────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_remote_ops_inserts_and_counts() {
        // Create ops on a "remote" database
        let (remote_pool, _remote_dir) = test_pool().await;
        let op1 = append_local_op_at(
            &remote_pool,
            "remote-dev",
            test_create_payload("BLK1"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        let op2 = append_local_op_at(
            &remote_pool,
            "remote-dev",
            test_create_payload("BLK2"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let t1: OpTransfer = op1.into();
        let t2: OpTransfer = op2.into();

        // Apply on a fresh "local" database
        let (local_pool, _local_dir) = test_pool().await;
        let materializer = Materializer::new(local_pool.clone());

        let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
            .await
            .unwrap();

        assert_eq!(result.inserted, 2, "should insert 2 new ops");
        assert_eq!(result.duplicates, 0, "no duplicates on first apply");
        assert_eq!(result.hash_mismatches, 0, "no hash mismatches");

        materializer.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_remote_ops_idempotent() {
        // Create ops on a "remote" database
        let (remote_pool, _remote_dir) = test_pool().await;
        let op1 = append_local_op_at(
            &remote_pool,
            "remote-dev",
            test_create_payload("BLK1"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        let op2 = append_local_op_at(
            &remote_pool,
            "remote-dev",
            test_create_payload("BLK2"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let t1: OpTransfer = op1.into();
        let t2: OpTransfer = op2.into();
        let t1_again = t1.clone();
        let t2_again = t2.clone();

        let (local_pool, _local_dir) = test_pool().await;
        let materializer = Materializer::new(local_pool.clone());

        // First apply
        let r1 = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
            .await
            .unwrap();
        assert_eq!(r1.inserted, 2, "first apply should insert 2");

        // Second apply — same ops
        let r2 = apply_remote_ops(&local_pool, &materializer, vec![t1_again, t2_again])
            .await
            .unwrap();
        assert_eq!(r2.duplicates, 2, "second apply should detect 2 duplicates");
        assert_eq!(r2.inserted, 0, "no new inserts on re-apply");

        materializer.shutdown();
    }

    // ── complete_sync ───────────────────────────────────────────────────

    #[tokio::test]
    async fn complete_sync_updates_peer_refs() {
        let (pool, _dir) = test_pool().await;

        // Create peer first (update_on_sync requires existing peer)
        crate::peer_refs::upsert_peer_ref(&pool, "peer-A")
            .await
            .unwrap();

        let before = crate::peer_refs::get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .unwrap();
        assert!(
            before.synced_at.is_none(),
            "synced_at should be None initially"
        );

        complete_sync(&pool, "peer-A", "hash-received", "hash-sent")
            .await
            .unwrap();

        let after = crate::peer_refs::get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .unwrap();
        assert!(
            after.synced_at.is_some(),
            "synced_at should be set after complete_sync"
        );
        assert_eq!(after.last_hash.as_deref(), Some("hash-received"));
        assert_eq!(after.last_sent_hash.as_deref(), Some("hash-sent"));
    }

    // ── OpTransfer roundtrip ────────────────────────────────────────────

    #[tokio::test]
    async fn op_transfer_from_op_record_roundtrip() {
        let (pool, _dir) = test_pool().await;

        let record = append_local_op_at(
            &pool,
            "test-device",
            test_create_payload("BLK-RT"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // OpRecord → OpTransfer
        let transfer: OpTransfer = record.clone().into();
        assert_eq!(transfer.device_id, record.device_id);
        assert_eq!(transfer.seq, record.seq);
        assert_eq!(transfer.hash, record.hash);

        // OpTransfer → OpRecord
        let roundtripped: OpRecord = transfer.into();
        assert_eq!(roundtripped.device_id, record.device_id);
        assert_eq!(roundtripped.seq, record.seq);
        assert_eq!(roundtripped.parent_seqs, record.parent_seqs);
        assert_eq!(roundtripped.hash, record.hash);
        assert_eq!(roundtripped.op_type, record.op_type);
        assert_eq!(roundtripped.payload, record.payload);
        assert_eq!(roundtripped.created_at, record.created_at);
    }

    // ── SyncOrchestrator ────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_start_returns_head_exchange() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut orchestrator =
            SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());
        let msg = orchestrator.start().await.unwrap();

        match msg {
            SyncMessage::HeadExchange { heads } => {
                assert!(heads.is_empty(), "empty DB should produce empty heads");
            }
            other => panic!("expected HeadExchange, got {:?}", other),
        }

        materializer.shutdown();
    }

    // ── SyncMessage serde roundtrip ─────────────────────────────────────

    #[test]
    fn sync_message_serde_roundtrip() {
        let messages = vec![
            SyncMessage::HeadExchange {
                heads: vec![DeviceHead {
                    device_id: "dev-A".into(),
                    seq: 5,
                    hash: "abc123".into(),
                }],
            },
            SyncMessage::OpBatch {
                ops: vec![OpTransfer {
                    device_id: "dev-A".into(),
                    seq: 1,
                    parent_seqs: None,
                    hash: "h1".into(),
                    op_type: "create_block".into(),
                    payload: "{}".into(),
                    created_at: "2025-01-01T00:00:00Z".into(),
                }],
                is_last: true,
            },
            SyncMessage::ResetRequired {
                reason: "compacted".into(),
            },
            SyncMessage::SnapshotOffer { size_bytes: 1024 },
            SyncMessage::SnapshotAccept,
            SyncMessage::SnapshotReject,
            SyncMessage::SyncComplete {
                last_hash: "xyz789".into(),
            },
            SyncMessage::Error {
                message: "something went wrong".into(),
            },
        ];

        for msg in &messages {
            let json =
                serde_json::to_string(msg).unwrap_or_else(|e| panic!("serialize failed: {e}"));
            let deser: SyncMessage = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("deserialize failed for {json}: {e}"));
            let json2 = serde_json::to_string(&deser).unwrap();
            assert_eq!(json, json2, "serde roundtrip mismatch for: {json}");
        }
    }

    // ── Additional coverage: edge cases & state machine ─────────────────

    /// Both sides have empty op logs: no ops to send, no heads.
    #[tokio::test]
    async fn compute_ops_to_send_both_empty() {
        let (pool, _dir) = test_pool().await;
        let ops = compute_ops_to_send(&pool, &[]).await.unwrap();
        assert!(ops.is_empty(), "both sides empty → nothing to send");
    }

    /// SyncOrchestrator full flow with two empty databases.
    ///
    /// Simulates: start() → remote HeadExchange → local OpBatch →
    /// remote SyncComplete.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_full_flow_empty_databases() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // 1. Start → produces HeadExchange
        let msg1 = orch.start().await.unwrap();
        assert!(
            matches!(msg1, SyncMessage::HeadExchange { ref heads } if heads.is_empty()),
            "empty DB should produce HeadExchange with no heads"
        );
        assert_eq!(orch.session().state, SyncState::ExchangingHeads);

        // 2. Receive remote HeadExchange (also empty) → produces OpBatch
        let msg2 = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();
        match msg2 {
            Some(SyncMessage::OpBatch { ops, is_last }) => {
                assert!(ops.is_empty(), "no ops to send when both sides are empty");
                assert!(is_last, "single batch should be last");
            }
            other => panic!("expected OpBatch, got {other:?}"),
        }
        assert_eq!(orch.session().state, SyncState::StreamingOps);

        // 3. Receive remote OpBatch (empty) → applies + merges → SyncComplete
        let msg3 = orch
            .handle_message(SyncMessage::OpBatch {
                ops: vec![],
                is_last: true,
            })
            .await
            .unwrap();
        match msg3 {
            Some(SyncMessage::SyncComplete { .. }) => {}
            other => panic!("expected SyncComplete, got {other:?}"),
        }
        assert_eq!(orch.session().state, SyncState::Complete);
        assert!(orch.is_complete());

        materializer.shutdown();
    }

    /// Receiving an Error message transitions to Failed state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_handles_error_message() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        let _start = orch.start().await.unwrap();
        let response = orch
            .handle_message(SyncMessage::Error {
                message: "something broke".into(),
            })
            .await
            .unwrap();
        assert!(response.is_none(), "Error should not produce a response");
        assert_eq!(
            orch.session().state,
            SyncState::Failed("something broke".into()),
        );
        assert!(!orch.is_complete());

        materializer.shutdown();
    }

    /// Receiving a ResetRequired message transitions to ResetRequired state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_handles_reset_required() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        let _start = orch.start().await.unwrap();
        let response = orch
            .handle_message(SyncMessage::ResetRequired {
                reason: "compacted".into(),
            })
            .await
            .unwrap();
        assert!(
            response.is_none(),
            "ResetRequired should not produce a response"
        );
        assert_eq!(orch.session().state, SyncState::ResetRequired);

        materializer.shutdown();
    }
}
