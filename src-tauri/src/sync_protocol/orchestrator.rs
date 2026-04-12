use sqlx::SqlitePool;
use std::collections::VecDeque;

use super::operations::*;
use super::types::*;
use super::OP_BATCH_SIZE;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op_log::OpRecord;
use crate::peer_refs;

// ---------------------------------------------------------------------------
// SyncOrchestrator — message-driven state machine
// ---------------------------------------------------------------------------

/// Drives a single sync session through the head-exchange → op-stream →
/// merge → complete lifecycle.
pub struct SyncOrchestrator {
    pool: SqlitePool,
    device_id: String,
    materializer: Materializer,
    pub(crate) state: SyncState,
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
            // File transfer messages accepted in TransferringFiles or StreamingOps state
            (
                SyncState::TransferringFiles | SyncState::StreamingOps,
                SyncMessage::FileRequest { .. }
                | SyncMessage::FileOffer { .. }
                | SyncMessage::FileReceived { .. }
                | SyncMessage::FileTransferComplete,
            ) => {}
            // File transfer messages in other states are ignored gracefully
            (
                _,
                SyncMessage::FileRequest { .. }
                | SyncMessage::FileOffer { .. }
                | SyncMessage::FileReceived { .. }
                | SyncMessage::FileTransferComplete,
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

            // ---- File transfer (F-14) ----------------------------------------
            // These messages are handled by the sync daemon's file transfer
            // phase (sync_files module).  The orchestrator accepts them for
            // state-machine correctness but delegates actual I/O to the daemon.
            SyncMessage::FileRequest { .. } => {
                self.state = SyncState::TransferringFiles;
                self.session.state = SyncState::TransferringFiles;
                Ok(None)
            }
            SyncMessage::FileOffer { .. } => Ok(None),
            SyncMessage::FileReceived { .. } => Ok(None),
            SyncMessage::FileTransferComplete => Ok(None),
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
