//! Sync protocol orchestrator.
//!
//! Implements the core sync logic: head exchange, op streaming, remote-op
//! application, block-level merge, and peer-ref bookkeeping.  The transport
//! layer (WebSocket, BLE, …) is handled elsewhere — this module operates
//! purely on typed [`SyncMessage`] values.
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::VecDeque;

use crate::dag;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::merge;
use crate::op_log::{self, OpRecord};
use crate::peer_refs;

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
#[derive(Debug)]
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
    use crate::hash::verify_op_record;

    let mut result = ApplyResult {
        inserted: 0,
        duplicates: 0,
        hash_mismatches: 0,
    };
    let mut to_materialize = Vec::new();

    // Convert all transfers to records and verify hashes upfront.
    // Reject the entire batch on the first mismatch.
    let records: Vec<OpRecord> = ops.into_iter().map(OpRecord::from).collect();
    for record in &records {
        verify_op_record(record).map_err(|msg| {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                "integrity check failed during sync: {msg}"
            );
            AppError::InvalidOperation(format!("integrity check failed: {msg}"))
        })?;
    }

    // Wrap all inserts in a single transaction to reduce per-op overhead.
    let mut tx = pool.begin().await?;

    for record in records {
        // Validate payload is well-formed JSON before insertion
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&record.payload) {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                "skipping op with invalid payload: {e}"
            );
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
    // Batch query: find all conflicting (block_id, key) pairs AND fetch the
    // latest op per device per pair in a single pass using ROW_NUMBER().
    // This replaces the former N+1 pattern (1 query to find pairs + 2
    // queries per pair).
    let prop_op_rows = sqlx::query(
        "WITH conflict_keys AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id, \
                    json_extract(payload, '$.key') as prop_key \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'set_property' \
             GROUP BY json_extract(payload, '$.block_id'), \
                      json_extract(payload, '$.key') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    json_extract(o.payload, '$.key') as prop_key, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id'), \
                            json_extract(o.payload, '$.key') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_keys ck \
               ON json_extract(o.payload, '$.block_id') = ck.block_id \
              AND json_extract(o.payload, '$.key') = ck.prop_key \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'set_property' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id, prop_key \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, prop_key, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by (block_id, prop_key), then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<(String, String), (Option<OpRecord>, Option<OpRecord>)> =
            HashMap::new();
        for row in &prop_op_rows {
            let bid: String = row.try_get("block_id")?;
            let pk: String = row.try_get("prop_key")?;
            let dev: String = row.try_get("device_id")?;
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
            };
            let entry = groups.entry((bid, pk)).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for ((_bid, _pk), (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                let resolution = merge::resolve_property_conflict(&op_a, &op_b)?;

                // Idempotent guard: skip if the local device already has the
                // winning value (e.g. from a previous merge pass).  Without
                // this check we would append a redundant resolution op on
                // every subsequent sync because the historical ops still
                // satisfy the HAVING clause.
                let current_local: crate::op::SetPropertyPayload =
                    serde_json::from_str(&op_a.payload)?;
                if current_local == resolution.winner_value {
                    continue;
                }

                // Apply the winner by appending a new set_property op
                let winning_payload =
                    crate::op::OpPayload::SetProperty(resolution.winner_value);
                let new_record = op_log::append_local_op_at(
                    pool,
                    device_id,
                    winning_payload,
                    crate::now_rfc3339(),
                )
                .await?;

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
                    .await?;
                results.property_lww += 1;
            }
        }
    }

    // ── 3. move_block conflicts (LWW) ────────────────────────────────────
    // Batch query: find all conflicting block_ids AND fetch the latest
    // move_block op per device per block in a single pass using
    // ROW_NUMBER().  Replaces the former N+1 pattern.
    let move_op_rows = sqlx::query(
        "WITH conflict_blocks AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'move_block' \
             GROUP BY json_extract(payload, '$.block_id') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_blocks cb \
               ON json_extract(o.payload, '$.block_id') = cb.block_id \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'move_block' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by block_id, then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<String, (Option<OpRecord>, Option<OpRecord>)> = HashMap::new();
        for row in &move_op_rows {
            let bid: String = row.try_get("block_id")?;
            let dev: String = row.try_get("device_id")?;
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
            };
            let entry = groups.entry(bid).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for (_bid, (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                // LWW: later created_at wins, with device_id tiebreaker
                let winner = match op_a.created_at.cmp(&op_b.created_at) {
                    std::cmp::Ordering::Greater => &op_a,
                    std::cmp::Ordering::Less => &op_b,
                    std::cmp::Ordering::Equal => {
                        if op_a.device_id >= op_b.device_id {
                            &op_a
                        } else {
                            &op_b
                        }
                    }
                };

                let winner_move: crate::op::MoveBlockPayload =
                    serde_json::from_str(&winner.payload)?;

                // Idempotent guard: skip if the local device's latest move
                // already matches the winning move (avoids infinite
                // re-resolution).
                let local_move: crate::op::MoveBlockPayload =
                    serde_json::from_str(&op_a.payload)?;
                if local_move == winner_move {
                    continue;
                }

                let move_payload = crate::op::OpPayload::MoveBlock(winner_move);
                let new_record = op_log::append_local_op_at(
                    pool,
                    device_id,
                    move_payload,
                    crate::now_rfc3339(),
                )
                .await?;

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
                    .await?;
                results.move_lww += 1;
            }
        }
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
    /// Pending [`OpTransfer`]s queued for chunked streaming.
    ///
    /// Populated when entering [`SyncState::StreamingOps`]; drained in
    /// batches of [`OP_BATCH_SIZE`] via [`next_message`](Self::next_message).
    pending_op_transfers: VecDeque<OpTransfer>,
    received_ops: Vec<OpTransfer>,
    remote_device_id: Option<String>,
    /// When set, the orchestrator validates that the remote device_id
    /// received in HeadExchange matches this expected peer identity.
    expected_remote_id: Option<String>,
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
            pending_op_transfers: VecDeque::new(),
            received_ops: Vec::new(),
            remote_device_id: None,
            expected_remote_id: None,
            event_sink: None,
        }
    }

    /// Attach an event sink that will be notified on every state transition.
    pub fn with_event_sink(mut self, sink: Box<dyn crate::sync_events::SyncEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    /// Set the expected remote device_id for peer identity validation.
    ///
    /// When set, the orchestrator will reject HeadExchange messages where
    /// the remote device_id does not match this value.
    pub fn with_expected_remote_id(mut self, peer_id: String) -> Self {
        self.expected_remote_id = Some(peer_id);
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

                // Validate the remote device claims a known peer identity
                if !remote_id.is_empty() {
                    if let Some(expected) = &self.expected_remote_id {
                        if &remote_id != expected {
                            let msg = format!(
                                "peer device_id mismatch: expected {expected}, got {remote_id}"
                            );
                            self.state = SyncState::Failed(msg.clone());
                            self.session.state = self.state.clone();
                            self.emit(crate::sync_events::SyncEvent::Error {
                                message: msg.clone(),
                                remote_device_id: remote_id,
                            });
                            return Err(AppError::InvalidOperation(msg));
                        }
                    }
                }

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
                let all_transfers: VecDeque<OpTransfer> =
                    ops.iter().cloned().map(OpTransfer::from).collect();
                self.session.ops_sent = all_transfers.len();
                self.pending_ops_to_send = ops;

                // Chunk into batches of OP_BATCH_SIZE.  The first batch is
                // returned directly; remaining ops are stored in
                // pending_op_transfers for retrieval via next_message().
                let mut remaining = all_transfers;
                let chunk_end = remaining.len().min(OP_BATCH_SIZE);
                let first_batch: Vec<OpTransfer> = remaining.drain(..chunk_end).collect();
                let is_last = remaining.is_empty();
                self.pending_op_transfers = remaining;

                self.state = SyncState::StreamingOps;
                self.session.state = SyncState::StreamingOps;
                self.emit(crate::sync_events::SyncEvent::Progress {
                    state: crate::sync_events::sync_state_label(&self.state).to_string(),
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                });

                Ok(Some(SyncMessage::OpBatch {
                    ops: first_batch,
                    is_last,
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

    /// Returns `true` when the sync session has reached a terminal state
    /// (Complete, Failed, or ResetRequired).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            SyncState::Complete | SyncState::Failed(_) | SyncState::ResetRequired
        )
    }

    /// Return the next queued [`SyncMessage::OpBatch`], if any.
    ///
    /// After [`handle_message`](Self::handle_message) returns the first
    /// batch (possibly with `is_last: false`), the transport layer should
    /// call this method in a loop to drain remaining chunks:
    ///
    /// ```ignore
    /// while let Some(batch) = orchestrator.next_message() {
    ///     send(batch).await;
    /// }
    /// ```
    pub fn next_message(&mut self) -> Option<SyncMessage> {
        if self.pending_op_transfers.is_empty() {
            return None;
        }
        let chunk_end = self.pending_op_transfers.len().min(OP_BATCH_SIZE);
        let batch: Vec<OpTransfer> = self.pending_op_transfers.drain(..chunk_end).collect();
        let is_last = self.pending_op_transfers.is_empty();
        Some(SyncMessage::OpBatch {
            ops: batch,
            is_last,
        })
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

    // ── Batch conflict resolution test ──────────────────────────────────

    /// Multiple property conflicts AND a move conflict resolved in one pass
    /// via the batch ROW_NUMBER() queries.  Verifies that the batched query
    /// approach produces the same results as the former per-conflict N+1
    /// queries.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_conflict_resolution_multiple_properties_and_move() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z"; // B wins on LWW

        // Create blocks
        for blk in &["BLK1", "BLK2", "BLK3", "PARENT-A", "PARENT-B"] {
            append_local_op_at(
                &pool,
                "device-A",
                test_create_payload(blk),
                ts_a.into(),
            )
            .await
            .unwrap();
        }

        // ── 3 property conflicts on 2 different blocks ──────────────────
        // BLK1.priority: A="high" vs B="low"
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

        // BLK1.status: A="todo" vs B="done"
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "status".into(),
                value_text: Some("todo".into()),
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
                key: "status".into(),
                value_text: Some("done".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // BLK2.tag: A="work" vs B="personal"
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK2"),
                key: "tag".into(),
                value_text: Some("work".into()),
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
                block_id: BlockId::test_id("BLK2"),
                key: "tag".into(),
                value_text: Some("personal".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // ── 1 move conflict ─────────────────────────────────────────────
        // BLK3: A moves to PARENT-A, B moves to PARENT-B
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK3"),
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
                block_id: BlockId::test_id("BLK3"),
                new_parent_id: Some(BlockId::test_id("PARENT-B")),
                new_position: 1,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // ── Resolve all conflicts in one merge pass ─────────────────────
        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert_eq!(
            results.property_lww, 3,
            "should resolve 3 property conflicts in one batch pass"
        );
        assert_eq!(
            results.move_lww, 1,
            "should resolve 1 move conflict in one batch pass"
        );

        // Second merge should be fully idempotent
        let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();
        assert_eq!(
            r2.property_lww, 0,
            "second merge should skip already-resolved property conflicts"
        );
        assert_eq!(
            r2.move_lww, 0,
            "second merge should skip already-resolved move conflict"
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

        // Batch containing a bad hash should be rejected entirely
        let err = apply_remote_ops(&local_pool, &materializer, vec![t1.clone(), t2.clone(), bad_op])
            .await
            .expect_err("batch with bad hash must be rejected");
        assert!(
            err.to_string().contains("integrity check failed"),
            "error must mention integrity check, got: {err}"
        );

        // A clean batch (no bad hashes) should still work: duplicate + new
        let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
            .await
            .unwrap();
        assert_eq!(
            result.duplicates, 1,
            "op1 already in DB should be duplicate"
        );
        assert_eq!(result.inserted, 1, "op2 should be newly inserted");

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

    // ======================================================================
    // #618 — is_terminal includes all terminal states
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn is_terminal_includes_all_terminal_states() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Complete → terminal
        let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
        orch.state = SyncState::Complete;
        assert!(orch.is_terminal(), "Complete should be terminal");
        assert!(orch.is_complete(), "Complete should also pass is_complete");

        // Failed → terminal
        let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
        orch.state = SyncState::Failed("err".into());
        assert!(orch.is_terminal(), "Failed should be terminal");
        assert!(!orch.is_complete(), "Failed should not pass is_complete");

        // ResetRequired → terminal
        let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
        orch.state = SyncState::ResetRequired;
        assert!(orch.is_terminal(), "ResetRequired should be terminal");
        assert!(
            !orch.is_complete(),
            "ResetRequired should not pass is_complete"
        );

        // Non-terminal states
        for state in [
            SyncState::Idle,
            SyncState::ExchangingHeads,
            SyncState::StreamingOps,
            SyncState::ApplyingOps,
            SyncState::Merging,
        ] {
            let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
            orch.state = state.clone();
            assert!(!orch.is_terminal(), "{state:?} should NOT be terminal");
        }

        materializer.shutdown();
    }

    // ======================================================================
    // #616 — apply_remote_ops skips ops with invalid JSON payload
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn apply_remote_ops_skips_invalid_payload() {
        let (local_pool, _local_dir) = test_pool().await;
        let materializer = Materializer::new(local_pool.clone());

        // Build an op with a valid hash but invalid JSON payload.
        // We need the hash to match the payload for it to pass hash verification,
        // so we create it via append_local_op_at first, then corrupt the payload
        // while recomputing the hash to match.
        let bad_payload_op = OpTransfer {
            device_id: "remote-dev".into(),
            seq: 1,
            parent_seqs: None,
            hash: crate::hash::compute_op_hash(
                "remote-dev",
                1,
                None,
                "create_block",
                "NOT VALID JSON {{{",
            ),
            op_type: "create_block".into(),
            payload: "NOT VALID JSON {{{".into(),
            created_at: FIXED_TS.into(),
        };

        let result = apply_remote_ops(&local_pool, &materializer, vec![bad_payload_op])
            .await
            .unwrap();

        // The op should have passed hash verification but been skipped
        // due to invalid payload.
        assert_eq!(
            result.inserted, 0,
            "invalid payload op should not be inserted"
        );
        assert_eq!(result.hash_mismatches, 0, "hash should have matched");

        materializer.shutdown();
    }

    // ======================================================================
    // #614 — orchestrator rejects HeadExchange with unexpected peer device_id
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_rejects_unexpected_peer_device_id() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone())
            .with_expected_remote_id("expected-peer".into());

        let _start = orch.start().await.unwrap();

        // Send HeadExchange with a different device_id than expected
        let result = orch
            .handle_message(SyncMessage::HeadExchange {
                heads: vec![DeviceHead {
                    device_id: "wrong-peer".into(),
                    seq: 1,
                    hash: "abc".into(),
                }],
            })
            .await;

        assert!(
            result.is_err(),
            "mismatched peer device_id should be rejected"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("peer device_id mismatch"),
            "error should mention mismatch, got: {err_msg}"
        );
        assert_eq!(
            orch.session().state,
            SyncState::Failed(
                "peer device_id mismatch: expected expected-peer, got wrong-peer".into()
            ),
        );

        materializer.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_accepts_matching_peer_device_id() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone())
            .with_expected_remote_id("expected-peer".into());

        let _start = orch.start().await.unwrap();

        // Send HeadExchange with the correct device_id
        let result = orch
            .handle_message(SyncMessage::HeadExchange {
                heads: vec![DeviceHead {
                    device_id: "expected-peer".into(),
                    seq: 1,
                    hash: "abc".into(),
                }],
            })
            .await;

        assert!(result.is_ok(), "matching peer device_id should be accepted");

        materializer.shutdown();
    }

    // ======================================================================
    // #615 — Responder-mode: orchestrator handles HeadExchange in Idle state
    // ======================================================================

    /// Responder mode: receiving HeadExchange in Idle state (without calling
    /// `start()`) should work — the orchestrator computes ops to send and
    /// returns an OpBatch.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_responder_handles_head_exchange_in_idle() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Add some local ops so the responder has data to offer
        for i in 1..=2 {
            append_local_op_at(
                &pool,
                "responder-dev",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        let mut orch = SyncOrchestrator::new(pool, "responder-dev".into(), materializer.clone());

        // Do NOT call start() — this is responder mode.
        // Initiator has no ops → sends empty heads.
        let response = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();

        // Should respond with OpBatch containing our local ops
        assert!(response.is_some(), "responder should send OpBatch");
        match response.unwrap() {
            SyncMessage::OpBatch { ops, is_last } => {
                assert!(is_last, "single batch should be marked last");
                assert_eq!(ops.len(), 2, "should send 2 local ops to initiator");
            }
            other => panic!("expected OpBatch, got {other:?}"),
        }

        // State should be StreamingOps (waiting for initiator's SyncComplete)
        assert_eq!(orch.session().state, SyncState::StreamingOps);
        assert!(!orch.is_terminal());

        materializer.shutdown();
    }

    /// Responder mode full flow: receive HeadExchange → send OpBatch →
    /// receive SyncComplete → done, without ever calling `start()`.
    ///
    /// The protocol is one-directional per session: the responder sends
    /// its ops to the initiator (via OpBatch), and the initiator replies
    /// with SyncComplete.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn orchestrator_responder_full_flow() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut orch = SyncOrchestrator::new(pool, "responder-dev".into(), materializer.clone());

        // 1. Receive HeadExchange from initiator (empty) → respond with OpBatch
        let resp1 = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();
        assert!(
            matches!(resp1, Some(SyncMessage::OpBatch { .. })),
            "first response should be OpBatch"
        );
        assert_eq!(orch.session().state, SyncState::StreamingOps);

        // 2. Receive SyncComplete from initiator → record sync → done
        let resp2 = orch
            .handle_message(SyncMessage::SyncComplete {
                last_hash: String::new(),
            })
            .await
            .unwrap();
        assert!(
            resp2.is_none(),
            "SyncComplete should not produce a response"
        );

        assert!(orch.is_complete());
        assert!(orch.is_terminal());

        materializer.shutdown();
    }

    // ======================================================================
    // #620 — OpBatch streaming for large op logs
    // ======================================================================

    /// 2500 ops → 3 batches (1000, 1000, 500) with correct is_last flags.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opbatch_streaming_sends_in_chunks() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Insert 2500 ops on "sender-dev"
        for i in 1..=2500 {
            append_local_op_at(
                &pool,
                "sender-dev",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        let mut orch = SyncOrchestrator::new(pool, "sender-dev".into(), materializer.clone());

        // Remote peer has no heads → should send all 2500 ops
        let first_msg = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();

        // First batch: 1000 ops, is_last = false
        let (batch1_ops, batch1_last) = match first_msg {
            Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
            other => panic!("expected OpBatch, got {other:?}"),
        };
        assert_eq!(batch1_ops.len(), 1000, "first batch should have 1000 ops");
        assert!(!batch1_last, "first batch should NOT be last");

        // Second batch: 1000 ops, is_last = false
        let second_msg = orch.next_message();
        let (batch2_ops, batch2_last) = match second_msg {
            Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
            other => panic!("expected OpBatch, got {other:?}"),
        };
        assert_eq!(batch2_ops.len(), 1000, "second batch should have 1000 ops");
        assert!(!batch2_last, "second batch should NOT be last");

        // Third batch: 500 ops, is_last = true
        let third_msg = orch.next_message();
        let (batch3_ops, batch3_last) = match third_msg {
            Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
            other => panic!("expected OpBatch, got {other:?}"),
        };
        assert_eq!(batch3_ops.len(), 500, "third batch should have 500 ops");
        assert!(batch3_last, "third batch SHOULD be last");

        // No more batches
        assert!(
            orch.next_message().is_none(),
            "no more batches after final chunk"
        );

        // Total ops sent should be 2500
        assert_eq!(orch.session().ops_sent, 2500);

        materializer.shutdown();
    }

    /// 500 ops → 1 batch with is_last = true (no chunking needed).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opbatch_streaming_single_batch_for_small_logs() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        // Insert 500 ops
        for i in 1..=500 {
            append_local_op_at(
                &pool,
                "sender-dev",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }

        let mut orch = SyncOrchestrator::new(pool, "sender-dev".into(), materializer.clone());

        let first_msg = orch
            .handle_message(SyncMessage::HeadExchange { heads: vec![] })
            .await
            .unwrap();

        match first_msg {
            Some(SyncMessage::OpBatch { ops, is_last }) => {
                assert_eq!(ops.len(), 500, "single batch should have all 500 ops");
                assert!(is_last, "single batch should be marked last");
            }
            other => panic!("expected OpBatch, got {other:?}"),
        }

        // No pending batches
        assert!(
            orch.next_message().is_none(),
            "no more batches for small log"
        );

        assert_eq!(orch.session().ops_sent, 500);

        materializer.shutdown();
    }

    /// Receiver accumulates ops from multiple batches then applies all at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn receiver_accumulates_multi_batch_ops() {
        // Create ops on a "remote" database so they have valid hashes
        let (remote_pool, _remote_dir) = test_pool().await;
        let mut all_transfers = Vec::new();
        for i in 1..=5 {
            let record = append_local_op_at(
                &remote_pool,
                "remote-dev",
                test_create_payload(&format!("BLK{i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
            all_transfers.push(OpTransfer::from(record));
        }

        // Set up a receiver orchestrator
        let (local_pool, _local_dir) = test_pool().await;
        let materializer = Materializer::new(local_pool.clone());
        let mut orch =
            SyncOrchestrator::new(local_pool.clone(), "local-dev".into(), materializer.clone());

        // Drive to ExchangingHeads state
        let _start = orch.start().await.unwrap();

        // Send first batch (3 ops) with is_last = false
        let batch1: Vec<OpTransfer> = all_transfers[..3].to_vec();
        let resp1 = orch
            .handle_message(SyncMessage::OpBatch {
                ops: batch1,
                is_last: false,
            })
            .await
            .unwrap();
        assert!(
            resp1.is_none(),
            "intermediate batch should not produce a response"
        );

        // Send second batch (2 ops) with is_last = true
        let batch2: Vec<OpTransfer> = all_transfers[3..].to_vec();
        let resp2 = orch
            .handle_message(SyncMessage::OpBatch {
                ops: batch2,
                is_last: true,
            })
            .await
            .unwrap();

        // Should produce SyncComplete after applying all 5 ops
        assert!(
            matches!(resp2, Some(SyncMessage::SyncComplete { .. })),
            "final batch should trigger apply + merge + SyncComplete"
        );
        assert_eq!(
            orch.session().ops_received,
            5,
            "all 5 ops should be counted as received"
        );
        assert!(orch.is_complete());

        // Verify ops were actually inserted into the local database
        let local_ops = op_log::get_ops_since(&local_pool, "remote-dev", 0)
            .await
            .unwrap();
        assert_eq!(
            local_ops.len(),
            5,
            "all 5 remote ops should be in local op log"
        );

        materializer.shutdown();
    }
}
