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
    /// [`crate::loro::shared`] (one message per registered space — a
    /// [`LoroSyncMessage::Update`] delta when the initiator advertised a
    /// version vector for that space in its `HeadExchange`, otherwise a
    /// full [`LoroSyncMessage::Snapshot`]); drained one per call to
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
    /// #610: `true` once we have streamed our own state to the peer this
    /// session (set in [`Self::head_exchange_outgoing_loro`], the
    /// responder-only path). Gates the post-session `synced_at`
    /// bookkeeping: only the side that actually **pulled** the peer's
    /// state advances `peer_refs.synced_at` (see [`Self::record_pull_in_tx`]).
    /// The streamer must NOT advance it — doing so refreshes the
    /// responder's `synced_at[initiator]` on every inbound session and
    /// starves the reverse direction (`peers_due_for_resync` never finds
    /// the initiator overdue under sustained activity).
    streamed_to_peer: bool,
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
                changed_page_ids: Vec::new(),
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
            streamed_to_peer: false,
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
    ///
    /// `pub(crate)` for the daemon layer: `run_sync_session` threads this
    /// state into the FEAT-6 snapshot catch-up so the post-RESET engine
    /// reload (#607) hits the same registry the session syncs against
    /// (override-aware in tests, process-global in production).
    pub(crate) fn loro_state(&self) -> Option<&'static crate::loro::shared::LoroState> {
        #[cfg(test)]
        if let Some(state) = self.loro_state_override {
            return Some(state);
        }
        crate::loro::shared::get()
    }

    /// Incremental sync: collect this device's per-space Loro version
    /// vectors to advertise in `HeadExchange`. The responder uses them to
    /// stream an incremental [`LoroSyncMessage::Update`] (the delta since
    /// our vv) per space instead of a full snapshot. Empty when no Loro
    /// state is initialised (the responder then falls back to snapshots).
    fn collect_local_loro_vvs(&self) -> Vec<crate::sync_protocol::types::SpaceVersionVector> {
        let Some(state) = self.loro_state() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for sid in state.registry.space_ids() {
            // Read-only accessor: must NOT bump the registry dirty_count, or
            // every initiated session would arm a spurious full-disk snapshot
            // of all spaces — the opposite of this change's goal. `None` only
            // races a concurrent unregister; the responder then sends a full
            // snapshot for that space, which is safe.
            if let Some(vv) = state.registry.loro_vv(&sid) {
                out.push(crate::sync_protocol::types::SpaceVersionVector { space_id: sid, vv });
            }
        }
        out
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
        // Advertise our per-space Loro version vectors so the responder can
        // ship deltas (Update) instead of full snapshots (MAINT-228 / #87 §10.5).
        let loro_vvs = self.collect_local_loro_vvs();
        self.state = SyncState::ExchangingHeads;
        self.session.state = SyncState::ExchangingHeads;
        self.emit(crate::sync_events::SyncEvent::Progress {
            state: crate::sync_events::sync_state_label(&self.state).to_string(),
            remote_device_id: self.session.remote_device_id.clone(),
            ops_received: self.session.ops_received,
            ops_sent: self.session.ops_sent,
        });
        Ok(SyncMessage::HeadExchange { heads, loro_vvs })
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
            // LoroSyncChunked must never reach the orchestrator — the
            // transport layer (`sync_daemon::wire::recv_sync_message`)
            // reassembles header + binary frames into a plain `LoroSync`
            // before dispatch (#611). This arm only keeps the match
            // exhaustive; the dispatch match below rejects it loudly.
            (_, SyncMessage::LoroSyncChunked { .. }) => {}
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
            SyncMessage::HeadExchange { heads, loro_vvs } => {
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
                // zero-byte sentinel `LoroSync`. The initiator's advertised
                // per-space version vectors select an incremental Update
                // (delta since their vv) over a full snapshot where present.
                return self.head_exchange_outgoing_loro(&loro_vvs).await;
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
                                ApplyOutcome::Imported {
                                    changed_blocks,
                                    changed_page_ids,
                                    ..
                                } => {
                                    // #1071: accumulate the resolved page ids
                                    // (deduped) across this session's inbound
                                    // LoroSync messages so the terminal
                                    // `SyncEvent::Complete` carries the full
                                    // targeted-invalidation set. A space with
                                    // many touched pages, or a multi-space
                                    // session, contributes them all here.
                                    for pid in changed_page_ids {
                                        if !self.session.changed_page_ids.contains(&pid) {
                                            self.session.changed_page_ids.push(pid);
                                        }
                                    }
                                    // #705: this counts inbound LoroSync
                                    // *messages* (one per space, each a full
                                    // CRDT snapshot/update), not individual
                                    // CRDT operations. The UI surfaces it as
                                    // "Ops Received"; see the i18n tooltip,
                                    // which is worded as "sync messages" to
                                    // match this semantics.
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
                            // #705: the registry must be initialised before
                            // any session runs (init is synchronous and
                            // pre-recovery in `lib.rs`), so this branch is
                            // unreachable in production. If it is ever hit,
                            // the payload cannot be imported — silently
                            // dropping it and proceeding to `SyncComplete`
                            // would fake convergence and let the responder
                            // record a bogus `synced_at`. Fail the session
                            // loudly instead.
                            let msg_str = "loro: shared state not initialised; \
                                           cannot import incoming LoroSync";
                            self.state = SyncState::Failed(msg_str.into());
                            self.session.state = self.state.clone();
                            self.emit(crate::sync_events::SyncEvent::Error {
                                message: msg_str.into(),
                                remote_device_id: self.session.remote_device_id.clone(),
                            });
                            return Err(AppError::InvalidOperation(msg_str.into()));
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

                // #610: we just PULLED the peer's full state (only the
                // puller receives LoroSync — the streamer never reaches
                // this arm). Record `synced_at` so the scheduler stops
                // marking us due every tick and re-pulling a full snapshot.
                // Skip the write only when the peer was never identified —
                // never fabricate a bogus empty-`peer_id` row (BUG-27).
                if let Some(peer_id) = self.resolve_remote_peer_id() {
                    self.record_pull_in_tx(&peer_id, &last_hash).await?;
                } else {
                    tracing::warn!(
                        device_id = %self.device_id,
                        "completed a pull session but the remote device_id was \
                         never identified; skipping synced_at bookkeeping (#610)"
                    );
                }

                self.state = SyncState::Complete;
                self.session.state = SyncState::Complete;
                self.emit(crate::sync_events::SyncEvent::Complete {
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                    // #1071: deduped page ids accumulated from this session's
                    // applied ops (empty when no Imported outcome occurred).
                    changed_page_ids: self.session.changed_page_ids.clone(),
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
                let Some(peer_id) = self.resolve_remote_peer_id() else {
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
                };

                // #610: record `synced_at` ONLY when WE pulled this session.
                // A normal responder reaches this arm having STREAMED its
                // state and received nothing back (`streamed_to_peer`), so it
                // must NOT advance `synced_at[initiator]` — doing so refreshes
                // the responder's clock for the initiator on every inbound
                // session and starves the reverse direction. The empty-registry
                // initiator also reaches this arm (the responder short-circuits
                // straight to SyncComplete); it never streamed, so it records
                // (it has synced with the peer's — empty — state).
                if !self.streamed_to_peer {
                    self.record_pull_in_tx(&peer_id, &last_hash).await?;
                }

                self.state = SyncState::Complete;
                self.session.state = SyncState::Complete;
                self.emit(crate::sync_events::SyncEvent::Complete {
                    remote_device_id: self.session.remote_device_id.clone(),
                    ops_received: self.session.ops_received,
                    ops_sent: self.session.ops_sent,
                    // #1071: deduped page ids accumulated from this session's
                    // applied ops (empty when no Imported outcome occurred).
                    changed_page_ids: self.session.changed_page_ids.clone(),
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

            // ---- Chunked LoroSync header (#611) ------------------------------
            // The wire layer reassembles `LoroSyncChunked` + its binary
            // frames into a plain `LoroSync` before dispatch
            // (`sync_daemon::wire::recv_sync_message`). One reaching
            // `handle_message` means a transport-dispatch regression —
            // fail loudly, same contract as `SnapshotOffer`.
            SyncMessage::LoroSyncChunked { .. } => Err(AppError::InvalidOperation(
                "LoroSyncChunked must be reassembled by the sync daemon wire \
                 layer (sync_daemon::wire::recv_sync_message), not dispatched \
                 to the orchestrator state machine"
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

    /// #610: resolve the remote peer id for post-session bookkeeping.
    ///
    /// Prefers the `remote_device_id` learned during HeadExchange; falls
    /// back to the daemon-supplied `expected_remote_id` (the mTLS/mDNS peer
    /// identity) and backfills `remote_device_id`/`session.remote_device_id`
    /// so the event sink sees a real id. Returns `None` when neither is
    /// available — the caller must then refuse to write a bogus
    /// empty-`peer_id` row (BUG-27).
    fn resolve_remote_peer_id(&mut self) -> Option<String> {
        if let Some(id) = self.remote_device_id.as_deref()
            && !id.is_empty()
        {
            return Some(id.to_owned());
        }
        match self.expected_remote_id.as_deref() {
            Some(id) if !id.is_empty() => {
                tracing::warn!(
                    device_id = %self.device_id,
                    expected_remote_id = id,
                    "remote_device_id was empty at session completion; \
                     falling back to expected_remote_id from mTLS/mDNS"
                );
                // Backfill so the event sink sees a real peer id.
                self.remote_device_id = Some(id.to_owned());
                self.session.remote_device_id = id.to_owned();
                Some(id.to_owned())
            }
            _ => None,
        }
    }

    /// #610: record the post-session bookkeeping for a session in which WE
    /// pulled the peer's state — ensure the peer row exists and advance
    /// `peer_refs.synced_at` (+ `last_hash`). **Only the puller calls this.**
    /// The streamer (responder) must not, or it refreshes `synced_at` for a
    /// peer it never pulled from and starves the reverse direction.
    ///
    /// PEND-24 M2: the ensure-row + record pair runs in one `BEGIN IMMEDIATE`
    /// transaction so a crash between the two writes cannot leave a peer row
    /// whose `last_hash` is stale relative to the ops actually applied. The
    /// orchestrator runs serially per peer, so lock contention is bounded;
    /// the tx exists for crash atomicity, not concurrency.
    async fn record_pull_in_tx(&self, peer_id: &str, last_hash: &str) -> Result<(), AppError> {
        // #490 M1: `last_sent_hash` is always None under the loro-vv send
        // path; the empty-string sentinel is what `peer_refs::update_on_sync`
        // expects when no op-hash delta was tracked this session.
        let last_sent_hash = self.last_sent_hash.clone().unwrap_or_default();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, peer_id).await?;
        complete_sync_in_tx(&mut tx, peer_id, last_hash, &last_sent_hash).await?;
        tx.commit().await?;
        Ok(())
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
    async fn head_exchange_outgoing_loro(
        &mut self,
        peer_vvs: &[crate::sync_protocol::types::SpaceVersionVector],
    ) -> Result<Option<SyncMessage>, AppError> {
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
                // #1071: empty-stream short-circuit applies no inbound ops, so
                // the accumulated set is empty here — but read it from the
                // session uniformly with the other Complete sites.
                changed_page_ids: self.session.changed_page_ids.clone(),
            });
            return Ok(Some(SyncMessage::SyncComplete { last_hash }));
        }

        // `space_ids` is non-empty here, so `loro_state_opt` was `Some`
        // when we read it (the `None` branch produced an empty Vec).
        let loro_state = loro_state_opt
            .expect("space_ids non-empty implies loro_state_opt was Some on the read above");

        // Enumerate spaces and build one LoroSync per space. When the
        // initiator advertised a version vector for a space, ship an
        // incremental Update (the delta since their vv); otherwise — a
        // space the initiator doesn't have, or an older peer that sent no
        // vvs — ship a full Snapshot. The receiver's MAINT-228 reachability
        // gate (`apply_remote`) catches an unreachable `from_vv` and falls
        // back to a snapshot, so a stale advertised vv is safe.
        let mut messages: VecDeque<LoroSyncMessage> = VecDeque::with_capacity(space_ids.len());
        for sid in &space_ids {
            let peer_vv = peer_vvs
                .iter()
                .find(|v| &v.space_id == sid)
                .map(|v| v.vv.as_slice());
            let m =
                loro_sync::prepare_outgoing(&loro_state.registry, sid, &self.device_id, peer_vv)
                    .await?;
            messages.push_back(m);
        }
        // #705: this counts outbound LoroSync *messages* (one per
        // registered space, each a full CRDT snapshot/update), not
        // individual CRDT operations. Surfaced in the UI as "Ops Sent";
        // the i18n tooltip is worded as "sync messages" to match.
        self.session.ops_sent = messages.len();

        // #610: we are streaming our own state to the peer — this is the
        // responder (pull-from-us) role. Mark it so the post-session
        // bookkeeping does NOT advance our `synced_at` for this peer (we
        // pulled nothing from them); only the puller records `synced_at`.
        self.streamed_to_peer = true;

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
