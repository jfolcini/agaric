//! # `sync_protocol` orchestrator
//!
//! Pure, per-session state machine that drives a single sync exchange
//! through the lifecycle:
//!
//! ```text
//! Idle
//!   → ExchangingHeads          (HeadExchange sent / received)
//!   → StreamingOps             (OpBatch chunks, possibly multi-batch)
//!   → ApplyingOps              (apply remote ops to local op log)
//!   → Merging                  (block-level conflict / LWW resolution)
//!   → Complete                 (terminal: SyncComplete bookkeeping done)
//!
//! plus terminal side-exits:
//!   → ResetRequired            (responder's log compacted past our heads)
//!   → Failed(reason)           (protocol violation or fatal error)
//! ```
//!
//! ## What this module owns
//!
//! * Validating that an incoming [`SyncMessage`] is appropriate for the
//!   current [`SyncState`] (out-of-order messages transition to
//!   [`SyncState::Failed`]).
//! * Computing what ops to send the remote in response to its
//!   `HeadExchange`, chunking them into [`OP_BATCH_SIZE`] batches, and
//!   draining the queue via [`SyncOrchestrator::next_message`].
//! * Buffering received [`OpTransfer`]s across multi-batch streams and
//!   applying them in one atomic pass when `is_last: true` arrives.
//! * Performing the post-apply block-level merge.
//! * Emitting fine-grained progress events through an attached
//!   [`crate::sync_events::SyncEventSink`].
//!
//! ## What this module does **not** own
//!
//! * Peer discovery, scheduling, backoff, per-peer locking, connection
//!   setup, TOFU cert pinning — see [`crate::sync_daemon::orchestrator`].
//! * Snapshot catch-up — once the machine reaches
//!   [`SyncState::ResetRequired`], the daemon layer drives the
//!   snapshot sub-flow via [`crate::sync_daemon::snapshot_transfer`].
//!   `handle_message` will *reject* a `SnapshotOffer` if it ever
//!   arrives at the protocol layer (see the dispatch arm below).
//! * File transfer — once the machine reaches [`SyncState::Complete`],
//!   the daemon layer hands the connection to
//!   [`crate::sync_files::run_file_transfer_initiator`] /
//!   [`crate::sync_files::run_file_transfer_responder`], which read
//!   the `FileRequest` / `FileOffer` / `FileReceived` /
//!   `FileTransferComplete` messages directly off the wire. These
//!   variants must therefore **never** reach `handle_message`; the
//!   dispatch defends against regressions with a `debug_assert!`.

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
///
/// # Field invariants
///
/// * **`remote_device_id`** is `None` until the first
///   [`SyncMessage::HeadExchange`] is processed. After that it holds
///   the first non-self `device_id` advertised in the remote's heads
///   list — or `Some(String::new())` if the remote only carried our
///   own device's heads (a peer that has never originated its own
///   ops). On `SyncComplete`, an empty `remote_device_id` is
///   back-filled from `expected_remote_id` (set by the daemon from
///   the mTLS / mDNS peer identity); if neither is available the
///   session transitions to [`SyncState::Failed`] rather than write a
///   bogus `peer_id = ""` row to `peer_refs` (BUG-27).
///
/// * **`expected_remote_id`** is set once at construction by the
///   daemon (via [`SyncOrchestrator::with_expected_remote_id`]) and is
///   immutable for the rest of the session. It serves two purposes:
///   (1) reject a `HeadExchange` whose remote `device_id` does not
///   match the peer the daemon connected to, and (2) the
///   `SyncComplete` fallback described above.
///
/// * **`received_ops`** accumulates [`OpTransfer`]s across consecutive
///   `OpBatch` messages with `is_last: false`. When the batch carrying
///   `is_last: true` arrives, the buffer is drained in one
///   `std::mem::take` and applied atomically; the field is then
///   `Vec::new()` for the rest of the session. A protocol violation
///   that delivers `OpBatch` after `SyncComplete` is rejected by the
///   state-validation match before reaching the apply path.
///
/// * **`pending_op_transfers`** is the dual: ops *we* owe the remote.
///   It is populated when entering [`SyncState::StreamingOps`] (after
///   processing the remote's `HeadExchange`) and drained in batches
///   of [`OP_BATCH_SIZE`] via [`SyncOrchestrator::next_message`]. The
///   transport layer is expected to call `next_message` in a loop
///   after each call to `handle_message` to drain remaining chunks.
///
/// * **`state`** is the source of truth for the state machine.
///   `session.state` is a mirror kept in sync at every transition for
///   external observers (the daemon reads it via `session()` after
///   each step). [`SyncOrchestrator::is_complete`] returns `true`
///   only for [`SyncState::Complete`]; [`SyncOrchestrator::is_terminal`]
///   returns `true` for any of `Complete`, `Failed(_)`, or
///   `ResetRequired` — the three states from which no further
///   messages will be processed (the state-validation match rejects
///   anything that arrives in `Complete` / `Failed`, and the daemon
///   exits the message loop on `ResetRequired` to hand off to
///   snapshot catch-up).
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
    ///
    /// MAINT-21: instrumented with a `sync_msg` span tagged by current state
    /// and incoming message discriminant so protocol-level log lines can be
    /// correlated within an outer `sync{peer=ULID}` session span.
    #[tracing::instrument(
        skip_all,
        name = "sync_msg",
        fields(state = ?self.state, msg = ?std::mem::discriminant(&msg)),
    )]
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
            // File-transfer messages must never reach the protocol
            // orchestrator — they are read directly off the wire by
            // `sync_files::run_file_transfer_{initiator,responder}` after
            // the daemon-layer loop exits on `SyncState::Complete`. This
            // arm exists only to keep the match exhaustive; the dispatch
            // match below `debug_assert!`s on the same variants so a
            // future regression fails loudly in tests.
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
                // Identify the remote device from received heads. A peer that
                // has never originated its own ops will only advertise per-
                // device heads for *other* devices (including ours), so an
                // empty `remote_id` at this point is not automatically
                // malformed — it simply means "we can't yet attribute this
                // session to a specific peer from the heads list alone".
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
                let remote_id = self.remote_device_id.clone().unwrap_or_else(|| {
                    tracing::warn!(
                        device_id = %self.device_id,
                        expected_remote_id = ?self.expected_remote_id,
                        "remote_device_id not set at merge phase — using empty fallback"
                    );
                    String::new()
                });
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
                // BUG-27: `peer_refs::upsert_peer_ref` + `complete_sync` write
                // rows keyed by `peer_id`. An empty string here silently
                // creates / updates a bogus peer row, permanently corrupting
                // the per-peer sync bookkeeping. If the remote device was
                // never identified during the session (either because the
                // HeadExchange only carried our own device_id or because we
                // reached SyncComplete without a prior HeadExchange — a
                // protocol violation), fall back to the `expected_remote_id`
                // set by the sync daemon from the mTLS/mDNS peer identity.
                // If neither is available, transition to Failed instead of
                // silently proceeding with `peer_id = ""`.
                let peer_id = match self.remote_device_id.as_deref() {
                    Some(id) if !id.is_empty() => id.to_owned(),
                    _ => match self.expected_remote_id.as_deref() {
                        Some(id) if !id.is_empty() => {
                            tracing::warn!(
                                device_id = %self.device_id,
                                expected_remote_id = id,
                                "remote_device_id was empty at SyncComplete; \
                                 falling back to expected_remote_id from mTLS/mDNS"
                            );
                            // Backfill so the event sink sees a real peer id.
                            self.remote_device_id = Some(id.to_owned());
                            self.session.remote_device_id = id.to_owned();
                            id.to_owned()
                        }
                        _ => {
                            let msg = "SyncComplete received before remote device_id \
                                       was identified; refusing to record sync with \
                                       empty peer_id"
                                .to_owned();
                            self.state = SyncState::Failed(msg.clone());
                            self.session.state = self.state.clone();
                            self.emit(crate::sync_events::SyncEvent::Error {
                                message: msg.clone(),
                                remote_device_id: self.session.remote_device_id.clone(),
                            });
                            return Err(AppError::InvalidOperation(msg));
                        }
                    },
                };
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

            // ---- Snapshot ---------------------------------------------------
            // The snapshot catch-up sub-flow runs entirely at the sync daemon
            // layer (`sync_daemon::snapshot_transfer`) AFTER the main loop
            // exits with `ResetRequired`. `handle_message` must never receive
            // a `SnapshotOffer` on any reachable path — if one arrives here,
            // it indicates a protocol state-machine bug (e.g. a regression in
            // the daemon-layer interception). Fail loudly so the caller can
            // surface the violation instead of silently reject-and-continue.
            SyncMessage::SnapshotOffer { .. } => Err(AppError::InvalidOperation(
                "SnapshotOffer must be handled by the sync daemon \
                 snapshot_transfer sub-flow, not by the orchestrator state \
                 machine"
                    .into(),
            )),
            SyncMessage::SnapshotAccept | SyncMessage::SnapshotReject => Ok(None),

            // ---- File transfer (F-14) ---------------------------------------
            // File-transfer messages are read directly off the wire by
            // `sync_files::run_file_transfer_{initiator,responder}` after the
            // daemon-layer loop exits on `SyncState::Complete`. They must
            // never enter `handle_message` — if one does, it indicates a
            // regression in the daemon dispatch path (e.g., a future change
            // that forgets to hand the connection off after the orchestrator
            // signals completion). debug_assert in tests, degrade gracefully
            // in release so a stray message cannot brick a sync session.
            SyncMessage::FileRequest { .. }
            | SyncMessage::FileOffer { .. }
            | SyncMessage::FileReceived { .. }
            | SyncMessage::FileTransferComplete => {
                debug_assert!(
                    false,
                    "file-transfer message reached the protocol orchestrator; \
                     these are handled by sync_files.rs after SyncComplete"
                );
                Ok(None)
            }
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
