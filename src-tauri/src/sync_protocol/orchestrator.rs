//! # `sync_protocol` orchestrator
//!
//! Pure, per-session state machine that drives a single sync exchange
//! through the lifecycle:
//!
//! ```text
//! Idle
//!   → ExchangingHeads          (HeadExchange sent / received)
//!   → StreamingOps             (LoroSync messages, possibly multi-message)
//!   → ApplyingOps              (Loro engine import on each LoroSync)
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
//! * Computing what to send the remote in response to its
//!   `HeadExchange` — one [`SyncMessage::LoroSync`] per registered
//!   space (built from [`crate::loro::shared`]'s
//!   [`crate::loro::registry::LoroEngineRegistry`]).  When the
//!   registry exists but is empty (no spaces touched yet) we
//!   short-circuit straight to `SyncComplete` — no streaming-phase
//!   payload — and the remote's state validation accepts
//!   `SyncComplete` in `ExchangingHeads` to absorb the empty-stream
//!   case.
//! * Importing received [`crate::sync_protocol::loro_sync_types::LoroSyncMessage`]s
//!   via [`crate::sync_protocol::loro_sync::apply_remote`].
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
use crate::error::AppError;
use crate::materializer::Materializer;
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
/// * **`pending_loro_messages`** holds the
///   [`LoroSyncMessage`]s we owe the remote.  Populated when entering
///   [`SyncState::StreamingOps`] (after processing the remote's
///   `HeadExchange`) and drained one-per-call via
///   [`SyncOrchestrator::next_message`].  The transport layer is
///   expected to call `next_message` in a loop after each call to
///   `handle_message` to drain remaining messages.
///
/// * **`state`** is the source of truth for the state machine.
///   `session.state` is a mirror kept in sync at every transition for
///   external observers (the daemon reads it via `session()` after
///   each step). [`SyncOrchestrator::is_succeeded`] returns `true`
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
    /// Drives the read-path derived-cache + FTS rebuild fan-out after an
    /// inbound sync import. The loro-sync receiver path applies engine
    /// state directly via
    /// [`crate::sync_protocol::loro_sync::apply_remote`] (which writes the
    /// per-block SQL projection inside its own tx); `handle_message` then
    /// enqueues [`Materializer::enqueue_inbound_sync_rebuilds`] so the
    /// global derived caches (tags / pages / agenda / page-ids /
    /// block-tag-refs / page-links / FTS) converge to the imported state.
    materializer: Materializer,
    pub(crate) state: SyncState,
    session: SyncSession,
    /// Always `None` under the current loro-vv protocol (#490 M1).
    ///
    /// The field was intended to capture the hash of the last op shipped to
    /// the remote, but the loro-vv send path (`head_exchange_outgoing_loro`)
    /// never assigns it — `complete_sync_in_tx` therefore always writes
    /// `peer_refs.last_sent_hash = ""`. The field is kept as a placeholder
    /// for a future per-peer hash-tracking implementation; the empty-string
    /// value is the correct sentinel that `peer_refs::update_on_sync`
    /// expects when no op-hash-delta was tracked this session.
    last_sent_hash: Option<String>,
    /// Pending [`LoroSyncMessage`]s queued for streaming. Populated
    /// when entering [`SyncState::StreamingOps`] from
    /// [`crate::loro::shared`] (one [`LoroSyncMessage::Snapshot`] per
    /// registered space — initial sync only; per-peer-vv-tracked
    /// Updates are a follow-up); drained one per call to
    /// [`next_message`](Self::next_message).
    pending_loro_messages: VecDeque<crate::sync_protocol::loro_sync_types::LoroSyncMessage>,
    /// #602 test seam: per-orchestrator Loro state override.
    ///
    /// Production always uses the process-global
    /// [`crate::loro::shared::get`] registry (one device per process).
    /// Multi-device convergence tests need TWO devices in ONE process,
    /// each with its own engine registry — impossible through the
    /// `OnceLock` global. Tests inject a leaked per-device
    /// [`crate::loro::shared::LoroState`] here; all engine access goes
    /// through [`Self::loro_state`] so the production path is unchanged.
    #[cfg(test)]
    loro_state_override: Option<&'static crate::loro::shared::LoroState>,
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
            last_sent_hash: None,
            pending_loro_messages: VecDeque::new(),
            #[cfg(test)]
            loro_state_override: None,
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

    /// #602 test seam: route all Loro engine access through this
    /// per-orchestrator state instead of the process-global
    /// [`crate::loro::shared::get`]. See `loro_state_override`.
    #[cfg(test)]
    pub(crate) fn with_loro_state(
        mut self,
        state: &'static crate::loro::shared::LoroState,
    ) -> Self {
        self.loro_state_override = Some(state);
        self
    }

    /// Resolve the Loro engine state for this session: the test-injected
    /// override when present (#602 multi-device tests), otherwise the
    /// process-global registry installed at bootstrap.
    fn loro_state(&self) -> Option<&'static crate::loro::shared::LoroState> {
        #[cfg(test)]
        if let Some(state) = self.loro_state_override {
            return Some(state);
        }
        crate::loro::shared::get()
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
            // LoroSync valid after HeadExchange (i.e. in
            // `StreamingOps`) or as the responder's first
            // post-HeadExchange message (in `ExchangingHeads`).
            (
                SyncState::StreamingOps | SyncState::ExchangingHeads,
                SyncMessage::LoroSync { .. },
            ) => {}
            (_, SyncMessage::LoroSync { .. }) => {
                let msg_str = "LoroSync received before HeadExchange";
                self.state = SyncState::Failed(msg_str.into());
                self.session.state = self.state.clone();
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: msg_str.into(),
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                return Err(AppError::InvalidOperation(msg_str.into()));
            }
            // SyncComplete valid in StreamingOps (Complete is terminal,
            // already caught above) and in ExchangingHeads (the
            // empty-stream short-circuit: when the remote has zero
            // registered spaces, `head_exchange_outgoing_loro` skips
            // the streaming phase entirely and replies with
            // `SyncComplete` directly).
            (
                SyncState::StreamingOps | SyncState::ExchangingHeads,
                SyncMessage::SyncComplete { .. },
            ) => {}
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
                if !remote_id.is_empty()
                    && let Some(expected) = &self.expected_remote_id
                    && &remote_id != expected
                {
                    let msg =
                        format!("peer device_id mismatch: expected {expected}, got {remote_id}");
                    self.state = SyncState::Failed(msg.clone());
                    self.session.state = self.state.clone();
                    self.emit(crate::sync_events::SyncEvent::Error {
                        message: msg.clone(),
                        remote_device_id: remote_id,
                    });
                    return Err(AppError::InvalidOperation(msg));
                }

                self.remote_device_id = Some(remote_id.clone());
                self.session.remote_device_id = remote_id;

                // Check whether a reset is required. #602: only heads
                // for OUR OWN device are resolved against the local
                // op_log (own-history compaction/loss detection) — a
                // remote device's ops never land in our op_log
                // post-#490-M1, so checking them here made every
                // two-edited-device session degenerate to
                // ResetRequired. Remote-frontier staleness is handled
                // by the loro-vv reachability gate in `apply_remote`
                // (MAINT-228 → SnapshotFallbackRequested).
                if check_reset_required(&self.pool, &self.device_id, &heads).await? {
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

                // Outgoing streaming-phase payload is one
                // [`SyncMessage::LoroSync`] per registered space (built
                // from [`crate::loro::shared`]). If the registry exists
                // but is empty the head-exchange short-circuits to
                // `SyncMessage::SyncComplete` rather than emitting a
                // zero-byte sentinel `LoroSync`.
                return self.head_exchange_outgoing_loro().await;
            }

            // ---- LoroSync ----------------------------
            // Dispatch each `LoroSync` payload to `apply_remote`. The
            // sender never emits a zero-byte `Snapshot` for the no-
            // spaces case, so the receiver always has real bytes to
            // import.
            //
            // MAINT-228: `apply_remote` may return
            // `ApplyOutcome::SnapshotFallbackRequested` when the
            // peer's `from_vv` is unreachable from our local
            // `oplog_vv()`.  In that case the engine import was NOT
            // attempted; we translate the signal into a
            // `SyncMessage::ResetRequired` reply and hand off to the
            // daemon-level snapshot catch-up sub-flow — identical to
            // the log-compacted-side-exit path.
            SyncMessage::LoroSync { msg, is_last } => {
                {
                    use crate::sync_protocol::loro_sync::{self, ApplyOutcome};

                    match self.loro_state() {
                        Some(loro_state) => {
                            self.state = SyncState::ApplyingOps;
                            self.session.state = SyncState::ApplyingOps;
                            self.emit(crate::sync_events::SyncEvent::Progress {
                                state: crate::sync_events::sync_state_label(&self.state)
                                    .to_string(),
                                remote_device_id: self.session.remote_device_id.clone(),
                                ops_received: self.session.ops_received,
                                ops_sent: self.session.ops_sent,
                            });
                            let outcome = loro_sync::apply_remote(
                                &self.pool,
                                &loro_state.registry,
                                &self.device_id,
                                msg,
                            )
                            .await?;
                            match outcome {
                                ApplyOutcome::Imported { changed_blocks, .. } => {
                                    self.session.ops_received =
                                        self.session.ops_received.saturating_add(1);
                                    // PEND-81 §2A #4: `apply_remote` wrote the
                                    // per-block SQL projection (core columns,
                                    // properties incl. reserved hot-path columns,
                                    // direct tag edges) and rebuilt
                                    // `block_tag_inherited`, but NOT the read-path
                                    // derived caches / FTS. Enqueue the global
                                    // rebuild fan-out via the materializer
                                    // (background, deduped). #421: FTS is driven
                                    // from `changed_blocks` (targeted per-block
                                    // reindex) instead of a full O(vault) rebuild.
                                    // Non-fatal: a queue-closed error must not
                                    // unwind the sync session — the projection
                                    // already committed — so log + continue
                                    // (mirrors `dispatch_background_or_warn`).
                                    if let Err(e) = self
                                        .materializer
                                        .enqueue_inbound_sync_rebuilds(&changed_blocks)
                                        .await
                                    {
                                        tracing::warn!(
                                            device_id = %self.device_id,
                                            error = %e,
                                            "failed to enqueue inbound-sync cache rebuilds"
                                        );
                                    }
                                }
                                ApplyOutcome::SnapshotFallbackRequested { space_id, reason } => {
                                    // MAINT-228: the import was NOT
                                    // attempted because the peer's
                                    // `from_vv` is not reachable from
                                    // our `oplog_vv()`.  Transition
                                    // to ResetRequired and let the
                                    // daemon layer drive snapshot
                                    // catch-up via
                                    // `sync_daemon::snapshot_transfer`.
                                    let full_reason = format!(
                                        "loro-sync update from_vv unreachable for space {space_id}: \
                                         {reason}",
                                        space_id = space_id.as_str(),
                                    );
                                    self.state = SyncState::ResetRequired;
                                    self.session.state = SyncState::ResetRequired;
                                    self.emit(crate::sync_events::SyncEvent::Error {
                                        message: full_reason.clone(),
                                        remote_device_id: self.session.remote_device_id.clone(),
                                    });
                                    return Ok(Some(SyncMessage::ResetRequired {
                                        reason: full_reason,
                                    }));
                                }
                            }
                        }
                        None => {
                            tracing::warn!(
                                device_id = %self.device_id,
                                "loro: shared state not initialised; \
                                 dropping incoming LoroSync"
                            );
                        }
                    }
                }

                if !is_last {
                    return Ok(None); // wait for more LoroSync messages
                }

                // Final LoroSync of the batch — transition to Complete
                // and send our SyncComplete with the latest local head
                // hash. Loro's import has already converged the engine
                // state, so no further merge step is needed.
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
                // #490 M1: `last_sent_hash` is always None (never
                // assigned by the loro-vv send path). `unwrap_or_default()`
                // produces the empty-string sentinel that
                // `peer_refs::update_on_sync` expects when no op-hash
                // tracking was performed this session.
                let last_sent_hash = self.last_sent_hash.clone().unwrap_or_default();

                // PEND-24 M2: wrap the post-session bookkeeping pair
                // (ensure peer row + record final hashes) in a single
                // `BEGIN IMMEDIATE` transaction so a crash or error
                // between the two writes cannot leave a peer row whose
                // `last_hash` is stale relative to the ops actually
                // applied. The orchestrator runs serially per peer so
                // contention on this lock is bounded; the tx exists for
                // crash atomicity, not concurrency.
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
                peer_refs::upsert_peer_ref_in_tx(&mut tx, &peer_id).await?;
                complete_sync_in_tx(&mut tx, &peer_id, &last_hash, &last_sent_hash).await?;
                tx.commit().await?;

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
            SyncMessage::SnapshotAccept | SyncMessage::SnapshotReject => {
                Err(AppError::InvalidOperation(
                    "SnapshotAccept/SnapshotReject must be handled by snapshot_transfer, \
                     not the orchestrator"
                        .into(),
                ))
            }

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

    /// Build and queue outgoing [`SyncMessage::LoroSync`] messages,
    /// one per [`SpaceId`] currently held in
    /// [`crate::loro::shared::get`]'s registry.
    ///
    /// Strategy:
    /// * Snapshot every registered space via
    ///   [`crate::sync_protocol::loro_sync::prepare_outgoing`] with
    ///   `peer_vv = None` (initial-sync only — per-peer-vv-tracked
    ///   incremental Updates are a follow-up; see plan §10.5).
    /// * Mark the **last** message with `is_last: true`; everything
    ///   else with `is_last: false`. The receiver transitions to
    ///   `Merging`/`Complete` when it processes the `is_last: true`
    ///   message.
    /// * If the registry has no spaces (Loro state not yet initialised,
    ///   no spaces touched yet, etc.), short-circuit straight to
    ///   [`SyncMessage::SyncComplete`] — no streaming-phase payload at
    ///   all. The receiver's state validation accepts `SyncComplete` in
    ///   `ExchangingHeads` so the peer advances cleanly without ever
    ///   entering `StreamingOps`.
    ///
    /// State transition: `ExchangingHeads` → `StreamingOps` (when at
    /// least one space is registered) or `ExchangingHeads` →
    /// `Complete` (empty-stream short-circuit).
    async fn head_exchange_outgoing_loro(&mut self) -> Result<Option<SyncMessage>, AppError> {
        use crate::sync_protocol::loro_sync;
        use crate::sync_protocol::loro_sync_types::LoroSyncMessage;

        // Look up the process-global registry and snapshot its
        // currently-registered space ids. If Loro state was never
        // initialised (e.g., a test that skipped the bootstrap path),
        // treat it as an empty registry — we still need to advance
        // the remote's state machine, just with zero ops sent.
        let loro_state_opt = self.loro_state();
        let space_ids: Vec<crate::space::SpaceId> = match &loro_state_opt {
            Some(s) => s.registry.space_ids(),
            None => {
                tracing::warn!(
                    device_id = %self.device_id,
                    "loro: shared state not initialised; \
                     skipping LoroSync push (short-circuiting to SyncComplete)"
                );
                Vec::new()
            }
        };

        // Empty-stream short-circuit. No registered spaces means there
        // is nothing to ship; reply with `SyncComplete` directly so we
        // do not waste a round-trip on an empty `LoroSync`. The
        // remote's state validation accepts `SyncComplete` in
        // `ExchangingHeads` for exactly this case.
        if space_ids.is_empty() {
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
            return Ok(Some(SyncMessage::SyncComplete { last_hash }));
        }

        // `space_ids` is non-empty here, so `loro_state_opt` was `Some`
        // when we read it (the `None` branch produced an empty Vec).
        let loro_state = loro_state_opt
            .expect("space_ids non-empty implies loro_state_opt was Some on the read above");

        // Enumerate spaces and build one LoroSync per space. The
        // `peer_vv = None` choice ships a full snapshot; per-peer-vv
        // tracking (and hence Update messages) is a follow-up.
        let mut messages: VecDeque<LoroSyncMessage> = VecDeque::with_capacity(space_ids.len());
        for sid in &space_ids {
            let m = loro_sync::prepare_outgoing(&loro_state.registry, sid, &self.device_id, None)
                .await?;
            messages.push_back(m);
        }
        self.session.ops_sent = messages.len();

        self.state = SyncState::StreamingOps;
        self.session.state = SyncState::StreamingOps;
        self.emit(crate::sync_events::SyncEvent::Progress {
            state: crate::sync_events::sync_state_label(&self.state).to_string(),
            remote_device_id: self.session.remote_device_id.clone(),
            ops_received: self.session.ops_received,
            ops_sent: self.session.ops_sent,
        });

        // Pop the first; the rest go into the pending queue and are
        // drained by `next_message`.  `messages` is non-empty here:
        // the `space_ids.is_empty()` short-circuit above returned
        // before we built it.
        let first = messages
            .pop_front()
            .expect("messages was just built from a non-empty space_ids list");
        let is_last = messages.is_empty();
        self.pending_loro_messages = messages;
        Ok(Some(SyncMessage::LoroSync {
            msg: first,
            is_last,
        }))
    }

    /// Returns true iff the session ended in `SyncState::Complete` — i.e. the
    /// op-batch exchange finished cleanly, no peer-reported failure, no
    /// snapshot-reset required.
    ///
    /// **Contrast with [`is_terminal`](Self::is_terminal):** `is_terminal`
    /// returns true for `Complete | Failed(_) | ResetRequired` — any state
    /// from which the session cannot make further progress. `is_succeeded`
    /// is the strict subset of `is_terminal` where the work was successful.
    ///
    /// I-Sync-3: previously named `is_complete`, but the name was easily
    /// mistaken for `is_terminal` (which it is NOT). The file-transfer gate
    /// in `run_sync_session` correctly uses this predicate so that
    /// `Failed(_)` and `ResetRequired` skip file transfer in favour of
    /// retry / snapshot-transfer respectively.
    pub fn is_succeeded(&self) -> bool {
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

    /// Drain the next queued [`SyncMessage::LoroSync`], if any.
    ///
    /// After [`handle_message`](Self::handle_message) returns the first
    /// message, the transport layer should call this method in a loop to
    /// drain remaining queued messages:
    ///
    /// ```ignore
    /// while let Some(msg) = orchestrator.next_message() {
    ///     send(msg).await;
    /// }
    /// ```
    pub fn next_message(&mut self) -> Option<SyncMessage> {
        // When `head_exchange_outgoing_loro`'s registry-empty branch
        // fires, the queue stays empty and the session reply is
        // `SyncComplete` (returned directly from `handle_message`) —
        // `next_message` then returns `None` immediately. Otherwise it
        // drains the per-space pending queue one message at a time.
        if let Some(msg) = self.pending_loro_messages.pop_front() {
            let is_last = self.pending_loro_messages.is_empty();
            return Some(SyncMessage::LoroSync { msg, is_last });
        }
        None
    }

    /// Borrow the session counters.
    pub fn session(&self) -> &SyncSession {
        &self.session
    }

    /// L-66: read the daemon-provided `expected_remote_id` so callers
    /// (snapshot catch-up) can mirror the [`SyncMessage::SyncComplete`]
    /// fallback when `session.remote_device_id` is empty. Returns
    /// `None` if no expected id was set (e.g., an in-process test
    /// harness without `with_expected_remote_id`).
    pub fn expected_remote_id(&self) -> Option<&str> {
        self.expected_remote_id.as_deref()
    }
}
