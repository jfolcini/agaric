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
    pub property_lww: usize,
    pub move_lww: usize,
    pub delete_edit_resurrect: usize,
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
/// All ops are inserted inside a **single explicit transaction** to amortise
/// the per-op `BEGIN IMMEDIATE` / `COMMIT` overhead.  Materialisation tasks
/// are enqueued only *after* the transaction commits, guaranteeing that every
/// op is durable before any of them are processed.
///
/// Duplicates are detected via `INSERT OR IGNORE` on the composite PK
/// `(device_id, seq)` — zero `rows_affected` means the op was already
/// present.
pub async fn apply_remote_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
    ops: Vec<OpTransfer>,
) -> Result<ApplyResult, AppError> {
    use crate::hash::verify_op_hash;

    let mut result = ApplyResult {
        inserted: 0,
        duplicates: 0,
        hash_mismatches: 0,
    };
    let mut to_materialize = Vec::new();

    // Wrap all inserts in a single transaction to reduce per-op overhead.
    let mut tx = pool.begin().await?;

    for op in ops {
        let record: OpRecord = op.into();

        // Hash verification (same logic as dag::insert_remote_op)
        if !verify_op_hash(
            &record.hash,
            &record.device_id,
            record.seq,
            record.parent_seqs.as_deref(),
            &record.op_type,
            &record.payload,
        ) {
            result.hash_mismatches += 1;
            continue;
        }

        // INSERT OR IGNORE — duplicate delivery is a no-op
        let r = sqlx::query(
            "INSERT OR IGNORE INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.device_id)
        .bind(record.seq)
        .bind(&record.parent_seqs)
        .bind(&record.hash)
        .bind(&record.op_type)
        .bind(&record.payload)
        .bind(&record.created_at)
        .execute(&mut *tx)
        .await?;

        if r.rows_affected() > 0 {
            to_materialize.push(record);
            result.inserted += 1;
        } else {
            result.duplicates += 1;
        }
    }

    tx.commit().await?;

    // Enqueue materialization AFTER commit — ensures all ops are durable
    // before any are processed.
    if !to_materialize.is_empty() {
        materializer
            .enqueue_foreground(MaterializeTask::BatchApplyOps(to_materialize))
            .await?;
    }

    Ok(result)
}

/// After receiving all ops, merge blocks that have diverged between two
/// devices.
///
/// Handles four kinds of concurrent-edit conflicts:
///
/// 1. **`edit_block` divergence** — finds blocks with concurrent edits from
///    both devices, performs three-way text merge via [`merge::merge_block`].
/// 2. **`set_property` conflicts** — concurrent property changes on the same
///    `(block_id, key)` pair are resolved via Last-Writer-Wins
///    ([`merge::resolve_property_conflict`]).
/// 3. **`move_block` conflicts** — concurrent reparenting of the same block
///    is resolved via LWW (later `created_at` wins, with `device_id`
///    tiebreaker).
/// 4. **`delete_block` vs `edit_block`** — if one device deleted a block
///    while the other edited it, the edit wins and the block is resurrected
///    via a `restore_block` op.
///
/// **Not handled as a conflict: `move_block` vs `delete_block`.**  Both ops
/// apply in sequence and the block ends up deleted regardless of order
/// (commutativity).  A move to a new parent followed by a delete still
/// soft-deletes the block; a delete followed by a move updates a
/// soft-deleted row's parent (harmless).  No resolution op is needed.
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
        property_lww: 0,
        move_lww: 0,
        delete_edit_resurrect: 0,
    };

    // ── 1. edit_block divergence ──────────────────────────────────────────
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

    // ── 2. set_property conflicts (LWW) ──────────────────────────────────
    let prop_rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id, \
                json_extract(payload, '$.key') as prop_key \
         FROM op_log \
         WHERE device_id IN (?, ?) AND op_type = 'set_property' \
         GROUP BY json_extract(payload, '$.block_id'), json_extract(payload, '$.key') \
         HAVING COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in prop_rows {
        let block_id: String = row.try_get("block_id")?;
        let prop_key: String = row.try_get("prop_key")?;

        // Fetch latest set_property op from each device for this (block_id, key)
        let op_a_row = sqlx::query(
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
             FROM op_log \
             WHERE device_id = ? AND op_type = 'set_property' \
               AND json_extract(payload, '$.block_id') = ? \
               AND json_extract(payload, '$.key') = ? \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(device_id)
        .bind(&block_id)
        .bind(&prop_key)
        .fetch_one(pool)
        .await?;

        let op_b_row = sqlx::query(
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
             FROM op_log \
             WHERE device_id = ? AND op_type = 'set_property' \
               AND json_extract(payload, '$.block_id') = ? \
               AND json_extract(payload, '$.key') = ? \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(remote_device_id)
        .bind(&block_id)
        .bind(&prop_key)
        .fetch_one(pool)
        .await?;

        let op_a = OpRecord {
            device_id: op_a_row.try_get::<String, _>("device_id")?,
            seq: op_a_row.try_get::<i64, _>("seq")?,
            parent_seqs: op_a_row.try_get::<Option<String>, _>("parent_seqs")?,
            hash: op_a_row.try_get::<String, _>("hash")?,
            op_type: op_a_row.try_get::<String, _>("op_type")?,
            payload: op_a_row.try_get::<String, _>("payload")?,
            created_at: op_a_row.try_get::<String, _>("created_at")?,
        };

        let op_b = OpRecord {
            device_id: op_b_row.try_get::<String, _>("device_id")?,
            seq: op_b_row.try_get::<i64, _>("seq")?,
            parent_seqs: op_b_row.try_get::<Option<String>, _>("parent_seqs")?,
            hash: op_b_row.try_get::<String, _>("hash")?,
            op_type: op_b_row.try_get::<String, _>("op_type")?,
            payload: op_b_row.try_get::<String, _>("payload")?,
            created_at: op_b_row.try_get::<String, _>("created_at")?,
        };

        let resolution = merge::resolve_property_conflict(&op_a, &op_b)?;

        // Idempotent guard: skip if the local device already has the winning
        // value (e.g. from a previous merge pass).  Without this check we
        // would append a redundant resolution op on every subsequent sync
        // because the historical ops still satisfy the HAVING clause.
        let current_local: crate::op::SetPropertyPayload = serde_json::from_str(&op_a.payload)?;
        if current_local == resolution.winner_value {
            continue;
        }

        // Apply the winner by appending a new set_property op
        let winning_payload = crate::op::OpPayload::SetProperty(resolution.winner_value);
        let new_record =
            op_log::append_local_op_at(pool, device_id, winning_payload, crate::now_rfc3339())
                .await?;

        materializer
            .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
            .await?;
        results.property_lww += 1;
    }

    // ── 3. move_block conflicts (LWW) ────────────────────────────────────
    let move_rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log \
         WHERE device_id IN (?, ?) AND op_type = 'move_block' \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in move_rows {
        let block_id: String = row.try_get("block_id")?;

        let move_a_row = sqlx::query(
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
             FROM op_log \
             WHERE device_id = ? AND op_type = 'move_block' \
               AND json_extract(payload, '$.block_id') = ? \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(device_id)
        .bind(&block_id)
        .fetch_one(pool)
        .await?;

        let move_b_row = sqlx::query(
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
             FROM op_log \
             WHERE device_id = ? AND op_type = 'move_block' \
               AND json_extract(payload, '$.block_id') = ? \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(remote_device_id)
        .bind(&block_id)
        .fetch_one(pool)
        .await?;

        let ts_a: String = move_a_row.try_get("created_at")?;
        let ts_b: String = move_b_row.try_get("created_at")?;
        let dev_a: String = move_a_row.try_get("device_id")?;
        let dev_b: String = move_b_row.try_get("device_id")?;

        // LWW: later created_at wins, with device_id tiebreaker
        let winner_row = match ts_a.cmp(&ts_b) {
            std::cmp::Ordering::Greater => &move_a_row,
            std::cmp::Ordering::Less => &move_b_row,
            std::cmp::Ordering::Equal => {
                if dev_a >= dev_b {
                    &move_a_row
                } else {
                    &move_b_row
                }
            }
        };

        let winner_payload_json: String = winner_row.try_get("payload")?;
        let winner_move: crate::op::MoveBlockPayload = serde_json::from_str(&winner_payload_json)?;

        // Idempotent guard: skip if the local device's latest move already
        // matches the winning move (avoids infinite re-resolution).
        let local_payload_json: String = move_a_row.try_get("payload")?;
        let local_move: crate::op::MoveBlockPayload = serde_json::from_str(&local_payload_json)?;
        if local_move == winner_move {
            continue;
        }

        let move_payload = crate::op::OpPayload::MoveBlock(winner_move);
        let new_record =
            op_log::append_local_op_at(pool, device_id, move_payload, crate::now_rfc3339()).await?;

        materializer
            .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
            .await?;
        results.move_lww += 1;
    }

    // ── 4. delete_block vs edit_block (edit wins → resurrect) ────────────
    let del_edit_rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log \
         WHERE device_id IN (?, ?) AND op_type IN ('delete_block', 'edit_block') \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT op_type) > 1 AND COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in del_edit_rows {
        let block_id: String = row.try_get("block_id")?;

        // Fetch the block's deleted_at to build the RestoreBlockPayload
        let block_row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(pool)
            .await?;

        let deleted_at_value: String = match block_row {
            Some(ref r) => r
                .try_get::<Option<String>, _>("deleted_at")?
                .unwrap_or_default(),
            None => String::new(),
        };

        // Idempotent guard: only resurrect if the block is actually deleted
        // in the materialized table.  On repeated syncs the delete_block and
        // edit_block ops still sit in op_log (satisfying the HAVING clause)
        // even after a previous restore.  Without this check we would emit
        // a redundant restore_block op on every subsequent sync.
        // This also handles the race where the delete hasn't been materialised
        // yet — we correctly skip and let the materialiser process in order.
        if deleted_at_value.is_empty() {
            continue;
        }

        // Edit wins — resurrect the block
        let restore_payload = crate::op::OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(&block_id),
            deleted_at_ref: deleted_at_value,
        });
        let new_record =
            op_log::append_local_op_at(pool, device_id, restore_payload, crate::now_rfc3339())
                .await?;

        materializer
            .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
            .await?;
        results.delete_edit_resurrect += 1;
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
    event_sink: Option<Box<dyn crate::sync_events::SyncEventSink>>,
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
            event_sink: None,
        }
    }

    /// Attach an event sink that will be notified on every state transition.
    pub fn with_event_sink(mut self, sink: Box<dyn crate::sync_events::SyncEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    /// Emit a [`SyncEvent`](crate::sync_events::SyncEvent) if a sink is
    /// attached.
    fn emit(&self, event: crate::sync_events::SyncEvent) {
        if let Some(sink) = &self.event_sink {
            sink.on_sync_event(event);
        }
    }

    /// Generate the initial `HeadExchange` message to kick off sync.
    pub async fn start(&mut self) -> Result<SyncMessage, AppError> {
        let heads = get_local_heads(&self.pool).await?;
        self.state = SyncState::ExchangingHeads;
        self.session.state = SyncState::ExchangingHeads;
        self.emit(crate::sync_events::SyncEvent::Progress {
            state: crate::sync_events::sync_state_label(&self.state).to_string(),
            remote_device_id: self.session.remote_device_id.clone(),
            ops_received: self.session.ops_received,
            ops_sent: self.session.ops_sent,
        });
        Ok(SyncMessage::HeadExchange { heads })
    }

    /// Process a received message and optionally produce a response.
    ///
    /// Validates that the incoming message is appropriate for the current
    /// state before dispatching.  Out-of-order messages transition to
    /// [`SyncState::Failed`] and return an error.
    pub async fn handle_message(
        &mut self,
        msg: SyncMessage,
    ) -> Result<Option<SyncMessage>, AppError> {
        // ── State validation ─────────────────────────────────────────────
        // Reject messages that don't match the current state.
        match (&self.state, &msg) {
            // Terminal states reject everything
            (SyncState::Complete, _) | (SyncState::Failed(_), _) => {
                return Err(AppError::InvalidOperation(format!(
                    "sync session already in terminal state {:?}, cannot handle {:?}",
                    self.state,
                    std::mem::discriminant(&msg),
                )));
            }
            // Error and ResetRequired are always accepted (protocol signals)
            (_, SyncMessage::Error { .. }) | (_, SyncMessage::ResetRequired { .. }) => {}
            // HeadExchange only valid in Idle or ExchangingHeads
            (SyncState::Idle | SyncState::ExchangingHeads, SyncMessage::HeadExchange { .. }) => {}
            (_, SyncMessage::HeadExchange { .. }) => {
                let msg_str = "HeadExchange received in wrong state";
                self.state = SyncState::Failed(msg_str.into());
                self.session.state = self.state.clone();
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: msg_str.into(),
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                return Err(AppError::InvalidOperation(msg_str.into()));
            }
            // OpBatch valid in StreamingOps or ExchangingHeads (receiver gets ops right after head exchange)
            (SyncState::StreamingOps | SyncState::ExchangingHeads, SyncMessage::OpBatch { .. }) => {
            }
            (_, SyncMessage::OpBatch { .. }) => {
                let msg_str = "OpBatch received before HeadExchange";
                self.state = SyncState::Failed(msg_str.into());
                self.session.state = self.state.clone();
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: msg_str.into(),
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                return Err(AppError::InvalidOperation(msg_str.into()));
            }
            // SyncComplete valid in StreamingOps (Complete is terminal, already caught above)
            (SyncState::StreamingOps, SyncMessage::SyncComplete { .. }) => {}
            (_, SyncMessage::SyncComplete { .. }) => {
                let msg_str = "SyncComplete received in wrong state";
                self.state = SyncState::Failed(msg_str.into());
                self.session.state = self.state.clone();
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: msg_str.into(),
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                return Err(AppError::InvalidOperation(msg_str.into()));
            }
            // Snapshot messages accepted in any non-terminal state
            (
                _,
                SyncMessage::SnapshotOffer { .. }
                | SyncMessage::SnapshotAccept
                | SyncMessage::SnapshotReject,
            ) => {}
        }

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
                    self.emit(crate::sync_events::SyncEvent::Error {
                        message: "local op log missing ops claimed by remote".into(),
                        remote_device_id: self.session.remote_device_id.clone(),
                    });
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
                self.emit(crate::sync_events::SyncEvent::Progress {
                    state: crate::sync_events::sync_state_label(&self.state).to_string(),
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });

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
                self.emit(crate::sync_events::SyncEvent::Progress {
                    state: crate::sync_events::sync_state_label(&self.state).to_string(),
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });
                let to_apply = std::mem::take(&mut self.received_ops);
                let count = to_apply.len();
                let apply_result =
                    apply_remote_ops(&self.pool, &self.materializer, to_apply).await?;
                if apply_result.hash_mismatches > 0 {
                    tracing::warn!(
                        mismatches = apply_result.hash_mismatches,
                        inserted = apply_result.inserted,
                        duplicates = apply_result.duplicates,
                        peer = ?self.remote_device_id,
                        "hash chain verification failures detected during sync"
                    );
                }
                self.session.ops_received = count;

                // Merge diverged blocks
                self.state = SyncState::Merging;
                self.session.state = SyncState::Merging;
                self.emit(crate::sync_events::SyncEvent::Progress {
                    state: crate::sync_events::sync_state_label(&self.state).to_string(),
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });
                let remote_id = self.remote_device_id.clone().unwrap_or_default();
                let merge_results = merge_diverged_blocks(
                    &self.pool,
                    &self.device_id,
                    &self.materializer,
                    &remote_id,
                )
                .await?;
                if merge_results.conflicts > 0 {
                    tracing::warn!(
                        conflicts = merge_results.conflicts,
                        clean_merges = merge_results.clean_merges,
                        already_up_to_date = merge_results.already_up_to_date,
                        peer = ?self.remote_device_id,
                        "merge conflicts detected during sync"
                    );
                }

                // Determine our latest head hash for the SyncComplete message
                let last_hash = get_local_heads(&self.pool)
                    .await?
                    .into_iter()
                    .find(|h| h.device_id == self.device_id)
                    .map(|h| h.hash)
                    .unwrap_or_default();

                self.state = SyncState::Complete;
                self.session.state = SyncState::Complete;
                self.emit(crate::sync_events::SyncEvent::Complete {
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });
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
                self.emit(crate::sync_events::SyncEvent::Complete {
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });
                Ok(None)
            }

            // ---- ResetRequired ----------------------------------------------
            SyncMessage::ResetRequired { reason } => {
                self.state = SyncState::ResetRequired;
                self.session.state = SyncState::ResetRequired;
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: reason,
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                Ok(None)
            }

            // ---- Error ------------------------------------------------------
            SyncMessage::Error { message } => {
                self.state = SyncState::Failed(message.clone());
                self.session.state = SyncState::Failed(message.clone());
                self.emit(crate::sync_events::SyncEvent::Error {
                    message,
                    remote_device_id: self.session.remote_device_id.clone(),
                });
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
    use crate::op::{
        CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
        SetPropertyPayload,
    };
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

    // ── State validation tests ──────────────────────────────────────────

    /// Sending OpBatch from Idle (before start()) should fail because
    /// Idle is not in the OpBatch-accepted set.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_rejects_op_batch_before_head_exchange() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // Don't call start() — state is Idle
        let result = orch
            .handle_message(SyncMessage::OpBatch {
                ops: vec![],
                is_last: true,
            })
            .await;

        assert!(result.is_err(), "OpBatch from Idle should be rejected");
        assert_eq!(
            orch.session().state,
            SyncState::Failed("OpBatch received before HeadExchange".into()),
        );

        materializer.shutdown();
    }

    /// After a full sync completes, sending another HeadExchange should
    /// fail because Complete is a terminal state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_rejects_messages_in_terminal_state() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // Drive to Complete
        let _start = orch.start().await.unwrap();
        orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();
        orch.handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await
        .unwrap();
        assert_eq!(orch.session().state, SyncState::Complete);

        // Now try sending another HeadExchange — should fail
        let result = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await;
        assert!(
            result.is_err(),
            "messages in terminal state should be rejected"
        );

        materializer.shutdown();
    }

    /// Error messages should be accepted in any non-terminal state,
    /// including Idle.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_accepts_error_in_any_state() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // State is Idle — Error should still be accepted
        let result = orch
            .handle_message(SyncMessage::Error {
                message: "test error".into(),
            })
            .await;
        assert!(result.is_ok(), "Error should be accepted in Idle state");
        assert_eq!(orch.session().state, SyncState::Failed("test error".into()),);

        materializer.shutdown();
    }

    // ── Merge coverage tests ────────────────────────────────────────────

    /// Device A and B both set_property on same block+key.
    /// merge_diverged_blocks should detect and resolve via LWW.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_resolves_property_conflict_lww() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z";

        // Create the block first (needed for materializer)
        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // Device A sets property "priority" = "high"
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        // Device B sets property "priority" = "low" (later timestamp)
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert!(
            results.property_lww > 0,
            "should resolve at least one property conflict"
        );

        materializer.shutdown();
    }

    /// Device A and B both move_block same block.
    /// merge_diverged_blocks should detect and resolve via LWW.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_resolves_move_conflict_lww() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00+00:00";
        let ts_b = "2025-01-15T12:01:00+00:00";

        // Create the block and parent blocks
        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("PARENT-A"),
            ts_a.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("PARENT-B"),
            ts_a.into(),
        )
        .await
        .unwrap();

        // Device A moves BLK1 to PARENT-A
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENT-A")),
                new_position: 0,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        // Device B moves BLK1 to PARENT-B (later timestamp)
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENT-B")),
                new_position: 1,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert!(
            results.move_lww > 0,
            "should resolve at least one move conflict"
        );

        materializer.shutdown();
    }

    /// Device A deletes a block, Device B edits it.
    /// merge_diverged_blocks should resurrect the block (edit wins).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_resurrects_deleted_edited_block() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00+00:00";
        let ts_b = "2025-01-15T12:01:00+00:00";

        // Create the block
        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // Insert the block into the blocks table (needed for deleted_at lookup)
        sqlx::query("INSERT INTO blocks (id, block_type, content, deleted_at) VALUES (?, ?, ?, ?)")
            .bind("BLK1")
            .bind("content")
            .bind("test")
            .bind(ts_a)
            .execute(&pool)
            .await
            .unwrap();

        // Device A deletes the block
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::test_id("BLK1"),
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        // Device B edits the block
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                to_text: "updated content".into(),
                prev_edit: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert!(
            results.delete_edit_resurrect > 0,
            "should resurrect at least one deleted+edited block"
        );

        materializer.shutdown();
    }

    // ── Idempotent guard tests ──────────────────────────────────────────

    /// Calling merge_diverged_blocks twice with no new changes should not
    /// create duplicate resolution ops.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_property_idempotent_on_repeated_sync() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z"; // B wins

        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // First merge — should create one resolution op
        let r1 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();
        assert_eq!(
            r1.property_lww, 1,
            "first merge should resolve 1 property conflict"
        );

        // Second merge — idempotent guard should skip
        let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();
        assert_eq!(
            r2.property_lww, 0,
            "second merge should not re-resolve already-resolved property conflict"
        );

        materializer.shutdown();
    }

    /// Calling merge_diverged_blocks twice for move conflicts should be
    /// idempotent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_move_idempotent_on_repeated_sync() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00+00:00";
        let ts_b = "2025-01-15T12:01:00+00:00";

        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("PARENT-A"),
            ts_a.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("PARENT-B"),
            ts_a.into(),
        )
        .await
        .unwrap();

        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENT-A")),
                new_position: 0,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENT-B")),
                new_position: 1,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        let r1 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();
        assert_eq!(r1.move_lww, 1, "first merge should resolve 1 move conflict");

        let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();
        assert_eq!(
            r2.move_lww, 0,
            "second merge should not re-resolve already-resolved move conflict"
        );

        materializer.shutdown();
    }

    /// No conflicting ops → all counters zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_no_conflicts_returns_zeros() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Only device-A has ops — no conflicts possible
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload("BLK1"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert_eq!(results.clean_merges, 0);
        assert_eq!(results.conflicts, 0);
        assert_eq!(results.already_up_to_date, 0);
        assert_eq!(results.property_lww, 0);
        assert_eq!(results.move_lww, 0);
        assert_eq!(results.delete_edit_resurrect, 0);

        materializer.shutdown();
    }

    /// delete+edit resurrection should not re-fire if block is not deleted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_delete_edit_skips_when_not_deleted() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00+00:00";
        let ts_b = "2025-01-15T12:01:00+00:00";

        append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // Block exists in blocks table but is NOT deleted (deleted_at = NULL)
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind("BLK1")
            .bind("content")
            .bind("test")
            .execute(&pool)
            .await
            .unwrap();

        // Device A has a delete_block op and device B has an edit_block op
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::test_id("BLK1"),
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                to_text: "updated content".into(),
                prev_edit: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // Block is not actually deleted in materialized table → should skip
        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert_eq!(
            results.delete_edit_resurrect, 0,
            "should NOT resurrect a block that is not deleted in materialized table"
        );

        materializer.shutdown();
    }

    /// OpBatch received in ExchangingHeads state should be accepted
    /// (receiver gets ops right after sending its head exchange).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_accepts_op_batch_in_exchanging_heads() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // start() → ExchangingHeads
        let _start = orch.start().await.unwrap();
        assert_eq!(orch.session().state, SyncState::ExchangingHeads);

        // OpBatch should be accepted in ExchangingHeads
        let result = orch
            .handle_message(SyncMessage::OpBatch {
                ops: vec![],
                is_last: true,
            })
            .await;
        assert!(
            result.is_ok(),
            "OpBatch should be accepted in ExchangingHeads state"
        );

        materializer.shutdown();
    }

    // ======================================================================
    // #454 — apply_remote_ops mixed batch (valid + invalid + duplicate)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_remote_ops_mixed_batch_counts_correctly() {
        // Create ops on a "remote" database so they get valid hashes
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

        // Set up a fresh "local" database
        let (local_pool, _local_dir) = test_pool().await;
        let materializer = Materializer::new(local_pool.clone());

        // Pre-insert op1 so it becomes a duplicate when we apply the batch
        apply_remote_ops(&local_pool, &materializer, vec![t1.clone()])
            .await
            .unwrap();

        // Build a bad-hash op: clone a valid transfer and corrupt its hash
        let mut bad_op = t2.clone();
        bad_op.hash =
            "BADHASH0000000000000000000000000000000000000000000000000000000000".to_string();
        bad_op.seq = 99; // different seq so it's not just a duplicate of t2

        // Batch: duplicate (t1 again) + valid new (t2) + bad hash
        let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2, bad_op])
            .await
            .unwrap();

        assert_eq!(
            result.duplicates, 1,
            "op1 already in DB should be duplicate"
        );
        assert_eq!(result.inserted, 1, "op2 should be newly inserted");
        assert_eq!(
            result.hash_mismatches, 1,
            "corrupted hash op should be counted as mismatch"
        );

        materializer.shutdown();
    }

    // ======================================================================
    // #453 — merge property conflict with equal timestamps (device_id tiebreaker)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn merge_property_conflict_equal_timestamps_uses_device_id_tiebreaker() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Both devices use the exact same timestamp — forces the device_id
        // tiebreaker path in resolve_property_conflict.
        let same_ts = "2025-01-15T12:00:00Z";

        // Create the block (needed for materializer)
        append_local_op_at(&pool, "AAAA", test_create_payload("BLK1"), same_ts.into())
            .await
            .unwrap();

        // Device "AAAA" sets property "priority" = "high"
        append_local_op_at(
            &pool,
            "AAAA",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            same_ts.into(),
        )
        .await
        .unwrap();

        // Device "ZZZZ" sets property "priority" = "low" at the SAME timestamp.
        // "ZZZZ" > "AAAA" lexicographically, so ZZZZ's value should win.
        append_local_op_at(
            &pool,
            "ZZZZ",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            same_ts.into(),
        )
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "AAAA", &materializer, "ZZZZ")
            .await
            .unwrap();

        assert!(
            results.property_lww > 0,
            "should resolve property conflict via device_id tiebreaker when timestamps are equal"
        );

        // A second merge should be idempotent — the resolution already applied
        let r2 = merge_diverged_blocks(&pool, "AAAA", &materializer, "ZZZZ")
            .await
            .unwrap();
        assert_eq!(
            r2.property_lww, 0,
            "second merge should not re-resolve the already-resolved conflict"
        );

        materializer.shutdown();
    }

    // ======================================================================
    // #452 — SyncOrchestrator rejects HeadExchange after already exchanged
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_rejects_head_exchange_in_streaming_state() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

        // start() → ExchangingHeads
        let _start = orch.start().await.unwrap();
        assert_eq!(orch.session().state, SyncState::ExchangingHeads);

        // Receive remote HeadExchange → StreamingOps
        orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();
        assert_eq!(orch.session().state, SyncState::StreamingOps);

        // Send a SECOND HeadExchange in StreamingOps → should fail
        let result = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await;
        assert!(
            result.is_err(),
            "HeadExchange should be rejected in StreamingOps state"
        );
        assert_eq!(
            orch.session().state,
            SyncState::Failed("HeadExchange received in wrong state".into()),
            "state should transition to Failed with descriptive message"
        );

        materializer.shutdown();
    }
}
