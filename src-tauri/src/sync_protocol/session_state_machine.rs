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
//!   setup, TOFU cert pinning — see [`crate::sync_daemon::session_supervisor`].
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
///   Bogus `peer_id = ""` row to `peer_refs`.
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
    /// #2502: the peer's per-space Loro version vectors as advertised in this
    /// session's `HeadExchange`, stashed so the streamer can persist them to
    /// `peer_refs.loro_vv_bytes` **on session completion** (not at handshake —
    /// a session that fails mid-stream must not record a frontier the peer
    /// never actually received). Read back on the next session as the
    /// incremental-export floor when the initiator advertises no vv for a
    /// space, retiring the every-tick full-snapshot churn (#610).
    peer_advertised_loro_vvs: Vec<crate::sync_protocol::types::SpaceVersionVector>,
    /// #2481 phase 1: `true` once the peer advertised
    /// `HeadExchange { op_log_replication: true }`. The responder gates the
    /// audit-only op-log push on this — it only appends `OpLogBatch`
    /// messages to a peer that advertised the capability, so an older peer
    /// (deserializes the flag as `false`) is never sent the variant it
    /// cannot decode.
    peer_op_log_replication: bool,
    /// #2481 phase 1: the peer's advertised per-device op-log frontiers
    /// (`HeadExchange.heads`), stashed so the streamer can compute which op
    /// records the peer still lacks (`seq > the peer's frontier per device`)
    /// via [`collect_ops_for_peer`] when building the streaming reply.
    peer_advertised_heads: Vec<DeviceHead>,
    /// #2481 phase 1: audit-only op-log batches queued for the peer, drained
    /// after [`pending_loro_messages`] by [`next_message`](Self::next_message)
    /// so op records ride the tail of the same streaming phase as the
    /// `LoroSync` deltas. Each entry becomes one
    /// [`SyncMessage::OpLogBatch`]; the receiver hands every record to
    /// [`crate::dag::insert_replicated_op`] (audit metadata, never applied to
    /// state). The final drained message overall (last op batch, or last
    /// `LoroSync` when there are none) carries `is_last: true`.
    pending_op_batches: VecDeque<Vec<OpTransfer>>,
    /// #2481 phase 1: audit op records the puller has *received* this session,
    /// buffered until session completion. They are NOT written inline in
    /// `handle_message`: `insert_replicated_op` takes the write lock, and
    /// mid-stream that contends with the materializer's background inbound-sync
    /// cache rebuild triggered by the just-applied `LoroSync` (SQLite is
    /// single-writer — an oversized-block FTS rebuild can hold the lock past
    /// the busy_timeout, #611). Instead they are drained in
    /// [`complete_pull_session`](Self::complete_pull_session), after a
    /// materializer flush settles that rebuild, so the audit write runs
    /// uncontended.
    pending_ingest_records: Vec<OpTransfer>,
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
            remote_device_id: None,
            expected_remote_id: None,
            streamed_to_peer: false,
            peer_advertised_loro_vvs: Vec::new(),
            peer_op_log_replication: false,
            peer_advertised_heads: Vec::new(),
            pending_op_batches: VecDeque::new(),
            pending_ingest_records: Vec::new(),
            event_sink: None,
        }
    }

    /// Attach an event sink that will be notified on every state transition.
    pub fn with_event_sink(mut self, sink: Box<dyn crate::sync_events::SyncEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    /// Resolve the Loro engine state for this session: the materializer's
    /// state (#2249 — the one instance `crate::run` constructed at boot;
    /// no process global). Each device (production or a test's device)
    /// owns its `Arc<LoroState>`, so two devices in one test process use
    /// distinct engines without any override seam. Always present.
    ///
    /// `pub(crate)` for the daemon layer: `run_sync_session` threads this
    /// state into the snapshot catch-up so the post-RESET engine
    /// reload (#607) hits the same registry the session syncs against.
    pub(crate) fn loro_state(&self) -> std::sync::Arc<crate::loro::shared::LoroState> {
        std::sync::Arc::clone(self.materializer.loro_state())
    }

    /// Incremental sync: collect this device's per-space Loro version
    /// vectors to advertise in `HeadExchange`. The responder uses them to
    /// stream an incremental [`LoroSyncMessage::Update`] (the delta since
    /// our vv) per space instead of a full snapshot. Empty when no Loro
    /// state is initialised (the responder then falls back to snapshots).
    fn collect_local_loro_vvs(&self) -> Vec<crate::sync_protocol::types::SpaceVersionVector> {
        let state = self.loro_state();
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
        // Ship deltas (Update) instead of full snapshots (#87 §10.5).
        let loro_vvs = self.collect_local_loro_vvs();
        self.state = SyncState::ExchangingHeads;
        self.session.state = SyncState::ExchangingHeads;
        self.emit(crate::sync_events::SyncEvent::Progress {
            state: crate::sync_events::sync_state_label(&self.state).to_string(),
            remote_device_id: self.session.remote_device_id.clone(),
            ops_received: self.session.ops_received,
            ops_sent: self.session.ops_sent,
        });
        Ok(SyncMessage::HeadExchange {
            heads,
            loro_vvs,
            // Advertise our engine format so a peer on an incompatible format
            // is rejected up front in the responder's HeadExchange arm (#2130).
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            // #2481 phase 1: advertise support for audit-only op-log
            // replication so a capable peer may stream us `OpLogBatch`. An
            // older peer omits/ignores this flag and never sends the variant.
            op_log_replication: true,
            // #2200: advertise that we can decompress zstd-compressed
            // chunked LoroSync payloads. The responder (which streams
            // `LoroSync` back to us) reads this flag and only then
            // compresses; an older responder ignores it and streams raw.
            wire_compression: true,
        })
    }

    /// Process a received message and optionally produce a response.
    ///
    /// Validates that the incoming message is appropriate for the current
    /// state before dispatching.  Out-of-order messages transition to
    /// [`SyncState::Failed`] and return an error.
    ///
    /// Instrumented with a `sync_msg` span tagged by current state
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
            (SyncState::Complete | SyncState::Failed(_), _) => {
                return Err(AppError::InvalidOperation(format!(
                    "sync session already in terminal state {:?}, cannot handle {:?}",
                    self.state,
                    std::mem::discriminant(&msg),
                )));
            }
            // Error and ResetRequired are always accepted (protocol signals)
            (_, SyncMessage::Error { .. } | SyncMessage::ResetRequired { .. }) => {}
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
            // OpLogBatchChunked, like LoroSyncChunked, is reassembled into a
            // plain OpLogBatch by the wire layer before dispatch (#2593) and
            // never legitimately reaches the orchestrator. This arm keeps the
            // match exhaustive; the dispatch match below rejects it loudly.
            (_, SyncMessage::OpLogBatchChunked { .. }) => {}
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
            // OpLogBatch (#2481 phase 1) rides the tail of the streaming
            // phase: the responder appends it after its LoroSync deltas (or,
            // for a device with no registered spaces, as the sole stream), so
            // it is valid in the same states as LoroSync — `StreamingOps`
            // (after ≥1 LoroSync) or `ExchangingHeads` (pure-audit stream, the
            // responder's first reply). The dispatch match below ingests each
            // record as audit metadata.
            (
                SyncState::StreamingOps | SyncState::ExchangingHeads,
                SyncMessage::OpLogBatch { .. },
            ) => {}
            (_, SyncMessage::OpLogBatch { .. }) => {
                let msg_str = "OpLogBatch received outside the streaming phase";
                self.state = SyncState::Failed(msg_str.into());
                self.session.state = self.state.clone();
                self.emit(crate::sync_events::SyncEvent::Error {
                    message: msg_str.into(),
                    remote_device_id: self.session.remote_device_id.clone(),
                });
                return Err(AppError::InvalidOperation(msg_str.into()));
            }
        }

        match msg {
            // ---- HeadExchange ------------------------------------------------
            SyncMessage::HeadExchange {
                heads,
                loro_vvs,
                engine_format_version,
                // #2481 phase 1: the peer's audit-replication capability
                // gates whether we append `OpLogBatch` messages to the
                // streaming reply below (stashed at `peer_op_log_replication`).
                op_log_replication,
                // #2200: the peer's compression capability is consumed by
                // the sync-daemon wire layer (`sync_daemon::wire`), which
                // reads it off the received `HeadExchange` and records it
                // on the `SyncConnection`. Ignored by this core.
                wire_compression: _,
            } => {
                // Gate raw-byte Loro merges by engine format before doing any
                // import work (#2130). An incompatible peer is rejected up
                // front with a clear `SyncEvent::Error` rather than failing
                // mid-session on a raw-byte merge.
                //
                // `engine_format_version == 0` means a legacy peer predating
                // this field — fall through to the existing import-time
                // v1/unknown-format guards (`reject_legacy_v1_snapshot` /
                // `reject_unknown_format_version`) for those.
                //
                // Only `engine_format_version` is gated here; sibling-order
                // divergence is still resolved by import-time migration, not a
                // hard incompatibility, so it is intentionally not gated.
                let local = crate::loro::engine::ENGINE_FORMAT_VERSION;
                if engine_format_version != 0 && engine_format_version != local {
                    let msg = format!(
                        "peer engine format v{engine_format_version} incompatible with local v{local}"
                    );
                    self.state = SyncState::Failed(msg.clone());
                    self.session.state = self.state.clone();
                    self.emit(crate::sync_events::SyncEvent::Error {
                        message: msg.clone(),
                        remote_device_id: self.session.remote_device_id.clone(),
                    });
                    return Err(AppError::InvalidOperation(msg));
                }

                // Identify the remote device.
                //
                // #2481: the peer advertises the frontier of EVERY device it
                // holds (its own plus any foreign device whose ops it
                // replicated as audit metadata), so the first non-self head is
                // NOT reliably the peer's own identity — a multi-device
                // advertisement would mis-attribute the session and, against
                // the daemon-supplied cert CN, false-fail as a "device_id
                // mismatch". When the daemon set an `expected_remote_id` from
                // the verified TLS cert CN (#778, authoritative), use it. Only
                // for a cert-less (in-memory test) session do we fall back to
                // the first-non-self head — where a peer that has never
                // originated its own ops legitimately yields an empty id, so an
                // empty `remote_id` here is not malformed.
                let remote_id = match &self.expected_remote_id {
                    Some(expected) => expected.clone(),
                    None => heads
                        .iter()
                        .find(|h| h.device_id != self.device_id)
                        .map(|h| h.device_id.clone())
                        .unwrap_or_default(),
                };

                self.remote_device_id = Some(remote_id.clone());
                self.session.remote_device_id = remote_id;

                // #2502: stash the peer's advertised per-space Loro VVs so the
                // streamer can persist them to `peer_refs.loro_vv_bytes` on
                // session completion (churn-cutting export floor next round).
                self.peer_advertised_loro_vvs = loro_vvs.clone();

                // #2481 phase 1: stash the peer's advertised op-log frontiers +
                // audit-replication capability so `head_exchange_outgoing_loro`
                // can append the op records the peer lacks after the LoroSync
                // deltas (only when the peer advertised the capability).
                self.peer_advertised_heads = heads.clone();
                self.peer_op_log_replication = op_log_replication;

                // Check whether a reset is required — own-lineage-loss in Loro
                // VV space (#2502, retiring the op-log-seq heads check, #87
                // §10.5). Reset iff the peer's advertised VVs claim ops WE
                // authored (our own current-epoch Loro PeerID) that our engine
                // can no longer produce. Remote-frontier staleness (the peer
                // being ahead for OTHER peer ids) is not a reset — the receiver
                // -side `apply_remote` reachability gate (→
                // SnapshotFallbackRequested) handles an unbridgeable delta; both
                // funnel into the same ResetRequired → snapshot-catch-up path.
                let epoch = crate::loro::peer_epoch::load_peer_epoch(&self.pool).await?;
                let own_peer_id = crate::loro::engine::peer_id_for_epoch(&self.device_id, epoch);
                let local_loro_vvs = self.collect_local_loro_vvs();
                if check_reset_required(own_peer_id, &local_loro_vvs, &loro_vvs)? {
                    self.state = SyncState::ResetRequired;
                    self.session.state = SyncState::ResetRequired;
                    self.emit(crate::sync_events::SyncEvent::Error {
                        message: "local engine missing own-authored ops claimed by remote".into(),
                        remote_device_id: self.session.remote_device_id.clone(),
                    });
                    return Ok(Some(SyncMessage::ResetRequired {
                        reason: "local engine missing own-authored ops claimed by remote".into(),
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
            // `apply_remote` may return
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

                    {
                        let loro_state = self.loro_state();
                        self.state = SyncState::ApplyingOps;
                        self.session.state = SyncState::ApplyingOps;
                        self.emit(crate::sync_events::SyncEvent::Progress {
                            state: crate::sync_events::sync_state_label(&self.state).to_string(),
                            remote_device_id: self.session.remote_device_id.clone(),
                            ops_received: self.session.ops_received,
                            ops_sent: self.session.ops_sent,
                        });
                        // #705 / #2249: a LoroSync payload we cannot import
                        // (e.g. an undecodable snapshot) must FAIL the session
                        // and surface the error — never fake convergence by
                        // proceeding to `SyncComplete` / recording `synced_at`.
                        // The registry is always present now (#2249 removed the
                        // process-global-`None` defensive branch), so an
                        // unimportable/corrupt payload is the sole failure here.
                        let outcome = match loro_sync::apply_remote(
                            &self.pool,
                            &loro_state.registry,
                            &self.device_id,
                            msg,
                        )
                        .await
                        {
                            Ok(outcome) => outcome,
                            Err(e) => {
                                self.state = SyncState::Failed(e.to_string());
                                self.session.state = self.state.clone();
                                return Err(e);
                            }
                        };
                        match outcome {
                            ApplyOutcome::Imported {
                                changed_blocks,
                                purged_blocks,
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
                                // #4: `apply_remote` wrote the
                                // per-block SQL projection (core columns,
                                // properties incl. reserved hot-path columns,
                                // direct tag edges) and refreshed
                                // `block_tag_inherited` (scoped, #2036/#2265),
                                // but NOT the read-path derived caches / FTS.
                                // Enqueue the rebuild fan-out via the
                                // materializer (background, deduped). #421:
                                // FTS is driven from `changed_blocks`
                                // (targeted per-block reindex) instead of a
                                // full O(vault) rebuild. #2264: the fan-out
                                // itself short-circuits when the import was a
                                // complete no-op (both sets empty) — see
                                // `enqueue_inbound_sync_rebuilds`.
                                // Non-fatal: a queue-closed error must not
                                // unwind the sync session — the projection
                                // already committed — so log + continue
                                // (mirrors `dispatch_background_or_warn`).
                                if let Err(e) = self
                                    .materializer
                                    .enqueue_inbound_sync_rebuilds(&changed_blocks, &purged_blocks)
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
                                // The import was NOT
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
                    // #2249: the old "shared state not initialised" failure
                    // arm is gone — engine state is a constructor-threaded
                    // `&LoroState` (always present), so an un-importable
                    // LoroSync payload is unrepresentable here.
                }

                if !is_last {
                    // #2536: a streamer with multiple registered spaces ships
                    // one `LoroSync` per space (only the last `is_last: true`).
                    // We just parked in `ApplyingOps` for the import above; if
                    // we return still in `ApplyingOps`, the NEXT space's
                    // `LoroSync` hits the state-validation match — which only
                    // accepts `LoroSync` in `StreamingOps | ExchangingHeads` —
                    // and the wildcard arm rejects it as "LoroSync received
                    // before HeadExchange", failing an otherwise valid
                    // multi-space session. Restore `StreamingOps` so the
                    // streaming phase continues to accept the remaining
                    // per-space messages.
                    self.state = SyncState::StreamingOps;
                    self.session.state = SyncState::StreamingOps;
                    return Ok(None); // wait for more LoroSync messages
                }

                // Final LoroSync of the batch and no #2481 audit records follow
                // (the responder sets `is_last` on the very last message across
                // both queues). Transition to Complete and send our
                // SyncComplete. Loro's import has already converged the engine
                // state, so no further merge step is needed.
                self.complete_pull_session().await
            }

            // ---- SyncComplete -----------------------------------------------
            SyncMessage::SyncComplete { last_hash } => {
                // `peer_refs::upsert_peer_ref` + `complete_sync` write
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

                // #2502: the streamer persists the peer's advertised per-space
                // VVs now that the session has completed (the initiator acked
                // with this SyncComplete), so the next session can ship an
                // incremental Update from that frontier. No-op for the puller
                // (its stash is empty — it sent, never received, a HeadExchange).
                self.persist_peer_loro_vvs(&peer_id).await?;

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
            // ---- Chunked OpLogBatch header (#2593) --------------------------
            // Same contract as LoroSyncChunked: the wire layer reassembles it
            // into a plain OpLogBatch before dispatch. One reaching
            // `handle_message` is a transport-dispatch regression — fail loudly.
            SyncMessage::OpLogBatchChunked { .. } => Err(AppError::InvalidOperation(
                "OpLogBatchChunked must be reassembled by the sync daemon wire \
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

            // ---- OpLogBatch (#2481 phase 1) ---------------------------------
            // Audit-only op-log replication: the streamer appends these after
            // its LoroSync deltas (see `head_exchange_outgoing_loro` +
            // `next_message`). Each record is hash-verified and stored as
            // append-only audit metadata (`is_replicated = 1`) via
            // `crate::dag::insert_replicated_op` — it is NEVER applied to state
            // (state flows exclusively through Loro CRDT sync). Only the puller
            // (initiator) reaches this arm; the streamer sends OpLogBatch and
            // never receives it (single-direction, responder → initiator, in
            // one session — the reverse propagates when roles swap, exactly
            // like state sync, #610).
            SyncMessage::OpLogBatch { records, is_last } => {
                // Single-direction guard: only the PULLER ingests op batches.
                // If we streamed this session (`streamed_to_peer`, the
                // responder role), receiving an `OpLogBatch` is a protocol
                // violation — the puller must not stream back. Reject loudly so
                // a misbehaving/Forked peer cannot push audit records into the
                // streamer's log through an unexpected direction (records are
                // hash-verified + audit-only regardless, so this is defence in
                // depth, not a state-integrity fix).
                if self.streamed_to_peer {
                    let msg = "OpLogBatch received by the streamer; audit \
                               replication is single-direction (puller ingests)";
                    self.state = SyncState::Failed(msg.into());
                    self.session.state = self.state.clone();
                    self.emit(crate::sync_events::SyncEvent::Error {
                        message: msg.into(),
                        remote_device_id: self.session.remote_device_id.clone(),
                    });
                    return Err(AppError::InvalidOperation(msg.into()));
                }

                // Buffer the records; they are ingested (once) in
                // `complete_pull_session` after a materializer flush, NOT
                // inline here — an inline `insert_replicated_op` write contends
                // with the materializer's background inbound-sync rebuild from
                // the just-applied `LoroSync` and can lose the SQLite
                // single-writer race (#611). Records arrive in
                // `(device_id, seq)` order and are appended in that order,
                // which the Audit profile's parent-gap relaxation relies on.
                self.pending_ingest_records.extend(records);

                if !is_last {
                    // More stream to come (further op batches). Stay in
                    // StreamingOps so the next OpLogBatch passes state
                    // validation, mirroring the non-final LoroSync arm.
                    self.state = SyncState::StreamingOps;
                    self.session.state = SyncState::StreamingOps;
                    return Ok(None);
                }

                // Final message of the whole stream (state deltas already
                // applied). Ingest the buffered audit records and complete the
                // pull with SyncComplete — same bookkeeping as the
                // final-LoroSync arm (this is the puller side).
                self.complete_pull_session().await
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
    /// Empty-`peer_id` row.
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
    /// The ensure-row + record pair runs in one `BEGIN IMMEDIATE`
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

    /// #2502: persist the peer's advertised per-space Loro VVs to
    /// `peer_refs.loro_vv_bytes` on session completion.
    ///
    /// Only the streamer (responder) populates `peer_advertised_loro_vvs` — it
    /// is the side that processed an inbound `HeadExchange`; the initiator sent
    /// one and never received one, so its stash is empty and this is a no-op
    /// for it (early return). The write composes an upsert + column update in a
    /// single `BEGIN IMMEDIATE` tx so the frontier commits atomically.
    async fn persist_peer_loro_vvs(&self, peer_id: &str) -> Result<(), AppError> {
        if self.peer_advertised_loro_vvs.is_empty() {
            return Ok(());
        }
        let bytes =
            crate::sync_protocol::types::encode_persisted_loro_vvs(&self.peer_advertised_loro_vvs);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, peer_id).await?;
        peer_refs::update_loro_vv_bytes_in_tx(&mut tx, peer_id, &bytes).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Build and queue outgoing [`SyncMessage::LoroSync`] messages,
    /// one per [`SpaceId`] currently held in
    /// [`crate::loro::shared::get`]'s registry.
    ///
    /// Strategy:
    /// * Build one message per registered space via
    ///   [`crate::sync_protocol::loro_sync::prepare_outgoing`]. When the
    ///   initiator advertised a version vector for the space (looked up
    ///   from `peer_vvs`), ship an incremental Update (the delta since
    ///   that vv); otherwise — a space the initiator lacks, or an older
    ///   peer that sent no vvs — ship a full Snapshot (`peer_vv = None`).
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
    #[tracing::instrument(skip_all, err)]
    async fn head_exchange_outgoing_loro(
        &mut self,
        peer_vvs: &[crate::sync_protocol::types::SpaceVersionVector],
    ) -> Result<Option<SyncMessage>, AppError> {
        use crate::sync_protocol::loro_sync;
        use crate::sync_protocol::loro_sync_types::LoroSyncMessage;

        // Snapshot the registry's currently-registered space ids
        // (#2249: engine state is always present — threaded from the
        // materializer / test override; an empty registry simply means
        // nothing to ship).
        let loro_state = self.loro_state();
        let space_ids: Vec<crate::space::SpaceId> = loro_state.registry.space_ids();

        // #2481 phase 1: audit-only op records the peer still lacks, batched
        // for the wire. Empty unless the peer advertised `op_log_replication`
        // AND we hold op records beyond its advertised per-device frontier.
        // These stream *after* the LoroSync deltas (see `next_message`), so a
        // device with no registered spaces but pending audit records still
        // replicates them.
        let op_batches = self.collect_op_batches_for_peer().await?;

        // Enumerate spaces and build one LoroSync per space. When the
        // initiator advertised a version vector for a space, ship an
        // incremental Update (the delta since their vv); otherwise — a
        // space the initiator doesn't have, or an older peer that sent no
        // Vvs — ship a full Snapshot. The receiver's reachability
        // gate (`apply_remote`) catches an unreachable `from_vv` and falls
        // back to a snapshot, so a stale advertised vv is safe. Skipped
        // entirely when the registry is empty (nothing to ship).
        let mut messages: VecDeque<LoroSyncMessage> = VecDeque::with_capacity(space_ids.len());
        if !space_ids.is_empty() {
            // #2040: read the vault-wide SQL-soft-deleted id set ONCE for this
            // whole sync round, then thread it into every per-space
            // `prepare_outgoing`. Previously each space re-ran the identical
            // full-vault `SELECT id FROM blocks WHERE deleted_at IS NOT NULL`, so S
            // spaces meant S identical reads on every sync tick / debounced change /
            // mDNS discovery. The set's content does not depend on the space, so
            // sharing it across spaces is behaviour-preserving.
            let sql_deleted = loro_sync::read_sql_soft_deleted_ids(&self.pool).await?;

            // #2502/#610: persisted per-peer VV floor. When the initiator advertised
            // no vv for a space (an older peer, or the every-tick churn case), fall
            // back to the frontier this peer advertised at its LAST completed session
            // (`peer_refs.loro_vv_bytes`) so we still ship an incremental Update
            // instead of a full Snapshot. A stale/ahead persisted floor is safe: the
            // receiver's `apply_remote` reachability gate catches an unbridgeable
            // `from_vv` and falls back to a snapshot. Empty when we have no persisted
            // frontier for this peer (never synced, or the peer id is unresolved).
            let persisted_floor: Vec<crate::sync_protocol::types::SpaceVersionVector> =
                match self.remote_device_id.clone().filter(|s| !s.is_empty()) {
                    Some(peer_id) => {
                        match crate::peer_refs::get_loro_vv_bytes(&self.pool, &peer_id).await? {
                            Some(bytes) => {
                                crate::sync_protocol::types::decode_persisted_loro_vvs(&bytes)
                            }
                            None => Vec::new(),
                        }
                    }
                    None => Vec::new(),
                };

            for sid in &space_ids {
                let peer_vv = peer_vvs
                    .iter()
                    .find(|v| &v.space_id == sid)
                    .map(|v| v.vv.as_slice())
                    // #2502/#610 fallback: the peer's last-session frontier.
                    .or_else(|| {
                        persisted_floor
                            .iter()
                            .find(|v| &v.space_id == sid)
                            .map(|v| v.vv.as_slice())
                    });
                // #1257 freshness gate: `prepare_outgoing` returns `None` when the
                // engine is stale vs SQL for this space (it would export a block SQL
                // has soft-deleted). On refusal, skip the space — emit no payload for
                // it this round; the gate already logged + signalled a
                // rebuild-from-op-log is needed. Do NOT repair inline.
                match loro_sync::prepare_outgoing(
                    &loro_state.registry,
                    sid,
                    &self.device_id,
                    peer_vv,
                    &sql_deleted,
                )
                .await?
                {
                    Some(m) => messages.push_back(m),
                    None => {
                        tracing::warn!(
                            device_id = %self.device_id,
                            space_id = %sid.as_str(),
                            "loro: #1257 freshness gate refused export for space; \
                             skipping it in this push (rebuild-from-op-log required)"
                        );
                    }
                }
            }
        }

        // Empty-stream short-circuit. Nothing to ship — no registered spaces
        // (or every space refused by the #1257 freshness gate) AND no audit
        // records to replicate. Reply `SyncComplete` directly so we do not
        // waste a round-trip on an empty `LoroSync`; the remote's state
        // validation accepts `SyncComplete` in `ExchangingHeads` for exactly
        // this case.
        if messages.is_empty() && op_batches.is_empty() {
            return self.reply_sync_complete().await;
        }

        // #705: this counts outbound LoroSync *messages* (one per registered
        // space, each a full CRDT snapshot/update), not individual CRDT
        // operations. #2481 audit op batches are metadata, not state deltas,
        // so they are deliberately not counted here. Surfaced in the UI as
        // "Ops Sent"; the i18n tooltip is worded as "sync messages" to match.
        self.session.ops_sent = messages.len();

        // #610: we are streaming to the peer — this is the responder
        // (pull-from-us) role. Mark it so the post-session bookkeeping does
        // NOT advance our `synced_at` for this peer (we pulled nothing from
        // them); only the puller records `synced_at`. Streaming audit-only op
        // records counts as streaming for this purpose — the peer still pulled
        // from us, we pulled nothing back this session.
        self.streamed_to_peer = true;

        self.state = SyncState::StreamingOps;
        self.session.state = SyncState::StreamingOps;
        self.emit(crate::sync_events::SyncEvent::Progress {
            state: crate::sync_events::sync_state_label(&self.state).to_string(),
            remote_device_id: self.session.remote_device_id.clone(),
            ops_received: self.session.ops_received,
            ops_sent: self.session.ops_sent,
        });

        // Queue the whole outgoing stream (LoroSync deltas first, then op
        // batches) and return the first message. `next_message` orders the two
        // queues and sets `is_last` only on the final message across both — so
        // the receiver completes exactly once, after state deltas AND audit
        // records have arrived. Non-empty here: the short-circuit above
        // returned when both queues were empty.
        self.pending_loro_messages = messages;
        self.pending_op_batches = VecDeque::from(op_batches);
        Ok(Some(self.next_message().expect(
            "stream is non-empty: the empty messages + empty op_batches short-circuit returned above",
        )))
    }

    /// Reply to a `HeadExchange` with `SyncComplete` when there is nothing to
    /// stream (empty registry, every space refused by the #1257 freshness
    /// gate, and no #2481 audit records to replicate). Transitions to
    /// `Complete` and emits the terminal event, mirroring the puller-side
    /// completion but from the streamer's empty-stream short-circuit.
    async fn reply_sync_complete(&mut self) -> Result<Option<SyncMessage>, AppError> {
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
            // #1071: empty-stream short-circuit applies no inbound ops, so the
            // accumulated set is empty — read it from the session uniformly
            // with the other Complete sites.
            changed_page_ids: self.session.changed_page_ids.clone(),
        });
        Ok(Some(SyncMessage::SyncComplete { last_hash }))
    }

    /// #2481 phase 1 — collect the audit-only op-log batches to stream to the
    /// peer after the LoroSync deltas.
    ///
    /// Returns an empty `Vec` unless the peer advertised
    /// `HeadExchange { op_log_replication: true }` (capability gate — an older
    /// peer never receives the [`SyncMessage::OpLogBatch`] variant it cannot
    /// decode) AND we hold op records the peer lacks
    /// ([`collect_ops_for_peer`], `seq > the peer's advertised per-device
    /// frontier`). Records are partitioned into wire-sized batches under
    /// [`crate::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES`] so each rides the
    /// inline JSON frame ([`batch_ops_for_wire`]).
    ///
    /// A single op record larger than the inline bound (a sync-applied/imported
    /// op whose `payload` carries a large block `content`) still ships — it
    /// lands in its own batch and the wire layer (`sync_daemon::wire`) sends it
    /// via the chunked [`SyncMessage::OpLogBatchChunked`] transport (#2593)
    /// rather than dropping it at the 10 MB frame cap. No per-record filtering
    /// happens here.
    async fn collect_op_batches_for_peer(&self) -> Result<Vec<Vec<OpTransfer>>, AppError> {
        if !self.peer_op_log_replication {
            return Ok(Vec::new());
        }
        let records = collect_ops_for_peer(&self.pool, &self.peer_advertised_heads).await?;
        Ok(batch_ops_for_wire(
            records,
            crate::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES,
        ))
    }

    /// Complete a pull session on the puller (initiator) side: record the
    /// `synced_at` bookkeeping and return the terminal `SyncComplete`.
    ///
    /// Called from the final-message arm of the streaming phase — the last
    /// `LoroSync` when no audit records follow, or the last
    /// [`SyncMessage::OpLogBatch`] (#2481) when they do. Only the puller
    /// reaches this path (the streamer sends the stream and never receives
    /// it), so recording `synced_at` here is unconditional and correct (#610):
    /// we pulled the peer's state into our store, so the scheduler should stop
    /// marking us due every tick. Skips the write only when the peer was never
    /// identified — never fabricates a bogus empty-`peer_id` row.
    async fn complete_pull_session(&mut self) -> Result<Option<SyncMessage>, AppError> {
        // #2481: ingest the buffered audit records now that the streaming phase
        // is done. Flush the materializer FIRST so this write does not race the
        // background inbound-sync cache rebuild triggered by this session's
        // `LoroSync` imports (SQLite single-writer; an oversized-block FTS
        // rebuild can otherwise hold the write lock past the busy_timeout and
        // fail the audit write, #611). Best-effort throughout — the op log is
        // not load-bearing for state, so a flush error or a single corrupt
        // record (hash mismatch, NUL byte) is logged and skipped, never
        // faulting an otherwise-successful pull (which would re-ship + re-fault
        // the same record every session → permanent backoff over non-state
        // data). The unresolved-parent-gap case is already handled inside
        // `insert_replicated_op` under the Audit profile (warn-and-land).
        if !self.pending_ingest_records.is_empty() {
            if let Err(e) = self.materializer.flush().await {
                tracing::warn!(
                    device_id = %self.device_id,
                    error = %e,
                    "#2481: materializer flush before op-log ingest failed; \
                     ingesting anyway (best-effort)"
                );
            }
            let records = std::mem::take(&mut self.pending_ingest_records);
            let mut ingested = 0usize;
            for record in &records {
                match crate::dag::insert_replicated_op(&self.pool, record).await {
                    Ok(true) => ingested += 1,
                    Ok(false) => {} // idempotent redelivery — already held
                    // Distinguish genuine corruption (hash mismatch / NUL /
                    // domain validation → `Validation`) from a transient
                    // DB/lock error (`Database` / `PoolTimedOut`, e.g. a rebuild
                    // task the flush did not fully settle). Both skip the record
                    // — the puller's frontier for that device does not advance,
                    // so it re-ships next session — but only the former is
                    // "corrupt"; mislabeling a transient loss hides it.
                    Err(e @ (AppError::Database(_) | AppError::PoolTimedOut)) => {
                        tracing::warn!(
                            device_id = %self.device_id,
                            remote_device_id = %self.session.remote_device_id,
                            op_device_id = %record.device_id,
                            op_seq = record.seq,
                            error = %e,
                            "#2481: transient DB error ingesting a replicated op \
                             record; skipping it (will re-ship next session)"
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            device_id = %self.device_id,
                            remote_device_id = %self.session.remote_device_id,
                            op_device_id = %record.device_id,
                            op_seq = record.seq,
                            error = %e,
                            "#2481: rejecting a corrupt replicated op record; \
                             skipping it (audit-only, not load-bearing for state)"
                        );
                    }
                }
            }
            tracing::debug!(
                device_id = %self.device_id,
                remote_device_id = %self.session.remote_device_id,
                ingested,
                total = records.len(),
                "#2481: ingested buffered op-log audit records at session completion"
            );
        }

        let last_hash = get_local_heads(&self.pool)
            .await?
            .into_iter()
            .find(|h| h.device_id == self.device_id)
            .map(|h| h.hash)
            .unwrap_or_default();

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
            // #1071: deduped page ids accumulated from this session's applied
            // ops (empty when no Imported outcome occurred).
            changed_page_ids: self.session.changed_page_ids.clone(),
        });
        Ok(Some(SyncMessage::SyncComplete { last_hash }))
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

    /// Drain the next queued streaming message, if any.
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
    ///
    /// The stream is ordered: all per-space [`SyncMessage::LoroSync`] deltas
    /// first, then any #2481 audit-only [`SyncMessage::OpLogBatch`] messages.
    /// The single final message overall — the last op batch, or the last
    /// `LoroSync` when there are no op batches — carries `is_last: true`, so
    /// the receiver transitions to `Complete` exactly once, after the whole
    /// stream (state deltas *and* audit records) has been delivered.
    pub fn next_message(&mut self) -> Option<SyncMessage> {
        // When `head_exchange_outgoing_loro`'s registry-empty branch
        // fires, both queues stay empty and the session reply is
        // `SyncComplete` (returned directly from `handle_message`) —
        // `next_message` then returns `None` immediately. Otherwise it
        // drains the LoroSync queue, then the op-batch queue, one message
        // at a time. `is_last` is only set on the very last message across
        // *both* queues.
        if let Some(msg) = self.pending_loro_messages.pop_front() {
            let is_last =
                self.pending_loro_messages.is_empty() && self.pending_op_batches.is_empty();
            return Some(SyncMessage::LoroSync { msg, is_last });
        }
        if let Some(records) = self.pending_op_batches.pop_front() {
            let is_last = self.pending_op_batches.is_empty();
            return Some(SyncMessage::OpLogBatch { records, is_last });
        }
        None
    }

    /// Borrow the session counters.
    pub fn session(&self) -> &SyncSession {
        &self.session
    }

    /// Read the daemon-provided `expected_remote_id` so callers
    /// (snapshot catch-up) can mirror the [`SyncMessage::SyncComplete`]
    /// fallback when `session.remote_device_id` is empty. Returns
    /// `None` if no expected id was set (e.g., an in-process test
    /// harness without `with_expected_remote_id`).
    pub fn expected_remote_id(&self) -> Option<&str> {
        self.expected_remote_id.as_deref()
    }
}
