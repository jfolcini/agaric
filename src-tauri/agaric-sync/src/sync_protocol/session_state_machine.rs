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
//!   space (built from [`agaric_engine::loro::shared`]'s
//!   [`agaric_engine::loro::registry::LoroEngineRegistry`]).  When the
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
use std::sync::Arc;

use super::operations::*;
use super::types::*;
use crate::apply_host::ApplyHost;
use agaric_core::error::AppError;
use agaric_store::peer_refs;

// ---------------------------------------------------------------------------
// SyncOrchestrator — message-driven state machine
// ---------------------------------------------------------------------------

/// Drives a single sync session through the head-exchange → op-stream →
/// merge → complete lifecycle.
///
/// # Field invariants
///
/// * **`remote_device_id`** is seeded at construction from
///   `expected_remote_id` whenever the daemon supplied one (#4085 —
///   see [`SyncOrchestrator::with_expected_remote_id`]), which is
///   every production session. Only a cert-less in-memory test session
///   starts it as `None`; there it is filled by the first
///   [`SyncMessage::HeadExchange`] processed, holding the first
///   non-self `device_id` advertised in the remote's heads list — or
///   `Some(String::new())` if the remote only carried our own
///   device's heads (a peer that has never originated its own ops).
///   On `SyncComplete`, a still-empty `remote_device_id` is back-filled
///   from `expected_remote_id`; if neither is available the session
///   transitions to [`SyncState::Failed`] rather than write a bogus
///   `peer_id = ""` row to `peer_refs`.
///
///   `session.remote_device_id` (the `String` every emitted
///   [`SyncEvent`](crate::sync_events::SyncEvent) clones) tracks it, so
///   a production session's events carry a real peer id from the very
///   first `Progress` rather than from completion.
///
/// * **`expected_remote_id`** is set once at construction by the
///   daemon (via [`SyncOrchestrator::with_expected_remote_id`]) and is
///   immutable for the rest of the session. It serves two purposes:
///   (1) reject a `HeadExchange` whose remote `device_id` does not
///   match the peer the daemon connected to, and (2) the
///   `SyncComplete` fallback described above.
///
/// * **`pending_loro_messages`** holds the
///   [`LoroSyncMessage`](crate::sync_protocol::loro_sync_types::LoroSyncMessage)s
///   we owe the remote.  Populated when entering
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
    /// enqueues `ApplyHost::enqueue_inbound_sync_rebuilds` so the global
    /// derived caches (tags / pages / agenda / page-ids / block-tag-refs /
    /// page-links / FTS) converge to the imported state.
    ///
    /// #2621 (agaric-sync inversion): held as `Arc<dyn ApplyHost>` (the app-side
    /// `Materializer` impls the trait) so the sync layer depends DOWN on the
    /// abstraction instead of UP on the concrete coordinator.
    host: Arc<dyn ApplyHost>,
    pub state: SyncState,
    session: SyncSession,
    /// Pending [`LoroSyncMessage`]s queued for streaming. Populated
    /// when entering [`SyncState::StreamingOps`] from
    /// [`agaric_engine::loro::shared`] (one message per registered space — a
    /// [`LoroSyncMessage::Update`] delta when the initiator advertised a
    /// version vector for that space in its `HeadExchange`, otherwise a
    /// full [`LoroSyncMessage::Snapshot`]); drained one per call to
    /// [`next_message`](Self::next_message).
    pending_loro_messages: VecDeque<crate::sync_protocol::loro_sync_types::LoroSyncMessage>,
    remote_device_id: Option<String>,
    /// When set, the orchestrator validates that the remote device_id
    /// received in HeadExchange matches this expected peer identity.
    expected_remote_id: Option<String>,
    /// #4230: the handshake-authenticated endpoint id of a peer whose device
    /// id this session could only take from its **advertised heads** — i.e. a
    /// responder session admitted on the #855 pairing proof, where the daemon
    /// deliberately leaves [`Self::expected_remote_id`] unset because no
    /// `peer_refs` row binds the caller yet.
    ///
    /// `None` on every other session, and the guard it arms is then inert.
    /// See [`Self::with_unverified_claim_guard`] for the property it buys.
    unverified_claim_endpoint_id: Option<String>,
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
    /// #2593: `true` once the peer advertised
    /// `HeadExchange { op_log_batch_chunked: true }` — it can decode the
    /// chunked `OpLogBatchChunked` transport. The streamer only ships an
    /// oversized (over-inline-bound) op batch to such a peer; a peer that
    /// advertised `op_log_replication` but NOT this capability (a shipped #2481
    /// build) has the oversized record skipped instead, so it never receives an
    /// `OpLogBatchChunked` frame it cannot deserialize (which would fault the
    /// session, and — since the record persists — every subsequent session).
    ///
    /// This once mirrored the #2200 `wire_compression` gate; that flag was
    /// deleted in #3543 because nothing read it. This one is **not** dead: it
    /// still gates [`Self::collect_op_batches_for_peer`]'s
    /// oversized-batch `retain`, so the promise it carries ("I can survive a
    /// payload above the inline bound") is still consulted on every send.
    peer_op_log_batch_chunked: bool,
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
    /// [`crate::sync_protocol::insert_replicated_op`] (audit metadata, never applied to
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
    /// #2621: accepts anything convertible into `Arc<dyn ApplyHost>` — a
    /// concrete `Materializer` (tests, via `From<Materializer>`) or an
    /// already-erased `Arc<dyn ApplyHost>` (production) — so no call site has
    /// to wrap the coordinator by hand.
    pub fn new(pool: SqlitePool, device_id: String, host: impl Into<Arc<dyn ApplyHost>>) -> Self {
        Self {
            session: SyncSession {
                state: SyncState::Idle,
                local_device_id: device_id.clone(),
                remote_device_id: String::new(),
                ops_received: 0,
                ops_sent: 0,
                changed_page_ids: Vec::new(),
                changed_blocks: 0,
            },
            pool,
            device_id,
            host: host.into(),
            state: SyncState::Idle,
            pending_loro_messages: VecDeque::new(),
            remote_device_id: None,
            expected_remote_id: None,
            unverified_claim_endpoint_id: None,
            streamed_to_peer: false,
            peer_advertised_loro_vvs: Vec::new(),
            peer_op_log_replication: false,
            peer_op_log_batch_chunked: false,
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
    pub(crate) fn loro_state(&self) -> std::sync::Arc<agaric_engine::loro::shared::LoroState> {
        self.host.loro_state()
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

    /// Set the authoritative remote device_id for this session.
    ///
    /// When set, this value **wins**: the `HeadExchange` arm takes it verbatim
    /// instead of deriving an id from the peer's advertised heads. It does NOT
    /// reject anything — there is no comparison against the advertised heads
    /// and no error path, because #2481 made the heads an unreliable identity
    /// (a peer advertises the frontier of *every* device it holds, so the
    /// first non-self head belongs to a third device as often as to the peer),
    /// and rejecting on a disagreement would false-fail a legitimate
    /// multi-device peer. The heads are consulted only when this is `None` —
    /// the cert-less in-memory test path.
    ///
    /// # Why this seeds the session's `remote_device_id` too (#4085)
    ///
    /// `remote_device_id` used to be assigned in exactly one place before
    /// completion — the `HeadExchange` arm — and `HeadExchange` is
    /// initiator-**sent** / responder-**received**. On the initiator it was
    /// therefore `None` for the entire session *by construction*, so
    /// `session.remote_device_id` stayed `String::new()` until the completion
    /// backfill in [`Self::resolve_remote_peer_id`]. Every
    /// [`SyncEvent`](crate::sync_events::SyncEvent) emitted before that — every
    /// `Progress`, and every `Error` on a session that failed early — carried
    /// `remote_device_id: ""`, so any UI keyed on that field mis-attributed or
    /// dropped initiator-side progress and failure for the whole session.
    ///
    /// The daemon already knows who it dialled (`session_supervisor` passes the
    /// peer id it selected), and the `HeadExchange` arm already *prefers*
    /// `expected_remote_id` over the advertised heads when both are present —
    /// so seeding here changes no resolution outcome, it just makes the value
    /// available from frame 0 instead of from completion.
    ///
    /// Deliberately NOT fixed by adding a `device_id` field to `HeadExchange`:
    /// that wire change was considered and rejected in #3511's review (the
    /// field would arrive *after* the connection is accepted, and it costs a
    /// wire field forever).
    pub fn with_expected_remote_id(mut self, peer_id: String) -> Self {
        self.session.remote_device_id = peer_id.clone();
        self.remote_device_id = Some(peer_id.clone());
        self.expected_remote_id = Some(peer_id);
        self
    }

    /// #4230: mark this session's peer identity as an **unverified claim**, and
    /// arm the post-session bookkeeping guard that follows from that.
    ///
    /// Set by [`crate::sync_daemon::server`] on exactly one branch: a responder
    /// session admitted during a pairing window on the #855 passphrase proof.
    /// There, `get_peer_ref_by_endpoint_id` found no row for the
    /// handshake-authenticated key, so the daemon has nothing authoritative to
    /// pass to [`Self::with_expected_remote_id`] and deliberately leaves it
    /// unset — and [`Self::resolve_remote_peer_id`] therefore keys the session
    /// on the first non-self **advertised head**, which the peer chose.
    ///
    /// # What the guard is for
    ///
    /// The bookkeeping this session writes — `peer_refs.streamed_at` and,
    /// materially, `peer_refs.loro_vv_bytes`, the export floor consulted by the
    /// *next* session — would otherwise land on whatever row that claimed id
    /// names. A device holding the passphrase could therefore name an already
    /// paired peer and poison that peer's row: a bogus frontier makes the next
    /// sync ship an incremental update computed from a baseline the peer never
    /// held.
    ///
    /// The post-session *bind* has always refused exactly this — see
    /// `server::peer_is_bound_to_another_key`, which will not re-point a peer
    /// whose row already names a different key — but the writes happen *during*
    /// the session, before that check runs. Arming this makes the same
    /// predicate cover the writes, so the guarantee and the guard now have the
    /// same edges rather than the guard trailing the guarantee by one session.
    ///
    /// "Same edges" is exact only while the claimed row's binding holds still
    /// between the two askings, which is all a second read of a mutable table
    /// can promise. A concurrent session that binds the claimed id *after* this
    /// check and *before* the bind leaves the writes on a row that was genuinely
    /// free when they landed; the deferred-until-bind alternative races the same
    /// window from the other side, writing onto a row that was bound for the
    /// whole session and freed at the end. That is a property of asking a
    /// question about a shared table twice, not a weakness of asking it early —
    /// and both readings are strictly better than the one this replaces, which
    /// asked at neither moment.
    ///
    /// # What it deliberately does not do
    ///
    /// It does not fail the session and it does not reject the claim. #2481:
    /// a peer advertises the frontier of *every* device it holds, so a
    /// legitimate joiner that replicated a paired peer's ops advertises that
    /// peer's head first and reaches this branch with no ill intent. Its
    /// session completes exactly as before; only the write onto the other
    /// device's row is skipped — which is the same answer the bind already
    /// gives that joiner.
    ///
    /// `pub(crate)`, not `pub`: it is safe to arm only on a **responder**
    /// session admitted during a pairing window, per the branch documented
    /// above. Armed from outside the crate on an **initiator** session (or
    /// any bound peer), it would deny bookkeeping for peers whose row is
    /// legitimately bound to their own key, silently dropping their
    /// `synced_at` / `last_hash` progress. The one in-crate caller,
    /// [`crate::sync_daemon::server`], already respects that branch; the
    /// visibility just stops a future caller from getting it wrong.
    pub(crate) fn with_unverified_claim_guard(mut self, endpoint_id: String) -> Self {
        self.unverified_claim_endpoint_id = Some(endpoint_id);
        self
    }

    /// #4230: may this session key `peer_refs` bookkeeping on `peer_id`?
    ///
    /// `true` for every session whose identity the daemon vouched for
    /// (`unverified_claim_endpoint_id` unset — the guard is inert there, and
    /// costs not even a query). On a pairing-window session it is the
    /// [`crate::sync_daemon::server::peer_is_bound_to_another_key`] decision,
    /// asked with this session's authenticated key: a claimed id whose row is
    /// already bound to some *other* key is refused, everything else proceeds.
    ///
    /// A failed `list_peer_refs` denies, for the reason that function
    /// documents: the evidence that the row is free is exactly what a failed
    /// read does not have, and the cost of being wrong is one skipped
    /// bookkeeping write that the next session redoes.
    ///
    /// # Residual: a refusal is keyed on the session, not the write
    ///
    /// [`Self::resolve_remote_peer_id`] resolves one `peer_id` for the whole
    /// session, and every bookkeeping call site — [`Self::record_pull_in_tx`],
    /// [`Self::record_stream_in_tx`], and `persist_peer_loro_vvs` — asks this
    /// guard with that same id. So a #2481 joiner whose lowest-sorting
    /// advertised head happens to belong to a peer already bound to another
    /// key gets refused on *every* call site, not just one: its session
    /// writes no bookkeeping at all for itself — neither `synced_at` /
    /// `last_hash` nor the `loro_vv_bytes` export floor.
    ///
    /// #4252 added the one caller that is not a write:
    /// `head_exchange_outgoing_loro` asks before READING that same export
    /// floor back, because a floor read off a row this session may not key on
    /// is a floor belonging to some other device. A refusal there is not a
    /// skipped write but an ABSENT floor, which means a full stream — see
    /// there for why that is the cheap outcome rather than the expensive one.
    ///
    /// None of this is a regression (the post-session bind already refused the
    /// same joiner the same way); it is the practical shape of the residual
    /// behind #4251, stated here so it does not live only in that issue.
    async fn may_key_bookkeeping_on(&self, peer_id: &str) -> bool {
        let Some(endpoint_id) = self.unverified_claim_endpoint_id.as_deref() else {
            return true;
        };
        let refused = crate::sync_daemon::server::peer_is_bound_to_another_key(
            peer_refs::list_peer_refs(&self.pool).await,
            peer_id,
            endpoint_id,
        );
        if refused {
            tracing::warn!(
                device_id = %self.device_id,
                peer_id,
                endpoint_id,
                "refusing to key peer_refs bookkeeping on a device id claimed during a \
                 pairing window whose row is already bound to another key; the id came \
                 from the peer's advertised heads, which is a claim (#4230)"
            );
        }
        !refused
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
        // #855: if we are mid-pairing (our pending-pairing marker holds the
        // expected proof), echo that proof so the responder can verify we know
        // the passphrase before it TOFU-pins us. Both devices stored the same
        // domain-separated blake3 of the passphrase, so echoing our own stored
        // value proves knowledge. `None` on any normal (non-pairing) sync — the
        // responder only consults it on the unpaired-pending-pairing path.
        let pairing_proof = agaric_store::peer_refs::get_pending_pairing_proof(&self.pool).await?;
        // #4298: advertise what this device calls itself so the peer stops
        // rendering us as a truncated UUID. The app writes the OS hostname into
        // `app_settings` at boot (`peer_refs::set_local_device_name`), which is
        // how the value reaches this layer without `agaric-sync` taking a
        // `tauri` dependency for one string. Clamped here as well as on the
        // receiving side — see `clamp_device_name`.
        //
        // A read failure is not worth failing a sync over: the name is a
        // display nicety and the peer keeps whatever it already had, so this
        // degrades to "advertise no name" rather than aborting the session
        // before a single op moves.
        let device_name = match agaric_store::peer_refs::get_local_device_name(&self.pool).await {
            Ok(name) => name.as_deref().and_then(clamp_device_name),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not read this device's own name; advertising none (#4298)"
                );
                None
            }
        };
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
            engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
            // #2481 phase 1: advertise support for audit-only op-log
            // replication so a capable peer may stream us `OpLogBatch`. An
            // older peer omits/ignores this flag and never sends the variant.
            op_log_replication: true,
            // #2593: advertise that we can decode the chunked `OpLogBatchChunked`
            // transport, so a streamer may ship us an oversized op batch. A
            // shipped #2481 peer omits this (→ `false`) and the streamer skips
            // the oversized record instead of sending a frame it cannot decode.
            op_log_batch_chunked: true,
            // #855: passphrase proof, present only while mid-pairing.
            pairing_proof,
            // #4298: this device's own name, so the peer can render it.
            device_name,
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
            // LoroSyncChunked must never reach the orchestrator — since
            // #3464 nothing produces it (see the dispatch match below).
            // This arm only keeps the state match exhaustive; the dispatch
            // match rejects it loudly.
            (_, SyncMessage::LoroSyncChunked { .. }) => {}
            // OpLogBatchChunked, like LoroSyncChunked, has no producer since
            // #3464 and never legitimately reaches the orchestrator. This arm
            // keeps the match exhaustive; the dispatch match rejects it loudly.
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
                // #2593: the peer's chunked-OpLogBatch capability gates whether
                // we ship it an oversized (over-inline-bound) op batch — stashed
                // at `peer_op_log_batch_chunked` and honoured by
                // `collect_op_batches_for_peer`.
                op_log_batch_chunked,
                // #855: the initiator's pairing proof is consumed by the
                // responder daemon (`sync_daemon::server`) before it TOFU-pins
                // an unpaired device, not by this state-machine core.
                pairing_proof: _,
                // #4298: the initiator's own name is likewise consumed by the
                // responder daemon, which persists it as
                // `peer_refs.remote_device_name` at the TOFU bind point — the
                // first place the authoritative peer id is known. This core has
                // no peer row to write it to and nothing to do with it.
                device_name: _,
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
                let local = agaric_engine::loro::engine::ENGINE_FORMAT_VERSION;
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
                // #2593: stash the peer's chunked-OpLogBatch capability so
                // `collect_op_batches_for_peer` only ships an oversized batch to
                // a peer that can decode the chunked transport.
                self.peer_op_log_batch_chunked = op_log_batch_chunked;

                // Check whether a reset is required — own-lineage-loss in Loro
                // VV space (#2502, retiring the op-log-seq heads check, #87
                // §10.5). Reset iff the peer's advertised VVs claim ops WE
                // authored (our own current-epoch Loro PeerID) that our engine
                // can no longer produce. Remote-frontier staleness (the peer
                // being ahead for OTHER peer ids) is not a reset — the receiver
                // -side `apply_remote` reachability gate (→
                // SnapshotFallbackRequested) handles an unbridgeable delta; both
                // funnel into the same ResetRequired → snapshot-catch-up path.
                let epoch = agaric_engine::loro::peer_epoch::load_peer_epoch(&self.pool).await?;
                let own_peer_id =
                    agaric_engine::loro::engine::peer_id_for_epoch(&self.device_id, epoch);
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
                // from [`agaric_engine::loro::shared`]). If the registry exists
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
                                // #4305: and this is the honest count beside
                                // it — the blocks the import actually moved.
                                // `ops_received` is incremented once per
                                // inbound message even when that message's
                                // delta was empty, which is the steady state
                                // of a converged pair, so it can never answer
                                // "did anything change". Both id sets are
                                // already computed above for the projection
                                // and the fan-out; they are disjoint (#2264 —
                                // `changed_blocks` enumerates live blocks
                                // only), so summing them double-counts
                                // nothing.
                                self.session.changed_blocks = self
                                    .session
                                    .changed_blocks
                                    .saturating_add(changed_blocks.len())
                                    .saturating_add(purged_blocks.len());
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
                                    .host
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
                //
                // #4084: the streamer is not exempt from bookkeeping, only from
                // `synced_at`. It stamps `streamed_at` instead — the same event,
                // recorded in the column the scheduler does NOT read — so a
                // device that only ever succeeds as responder stops looking
                // like a device that has never synced.
                if self.streamed_to_peer {
                    self.record_stream_in_tx(&peer_id).await?;
                } else {
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
                    // #4305: the honest change count. `Some(0)` here is a
                    // converged no-op session and is what keeps the frontend
                    // silent; `ops_received` beside it is the per-space
                    // message count and is a non-zero constant on exactly
                    // that session.
                    changed_blocks: Some(self.session.changed_blocks),
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
            // The chunked encoding went with the WebSocket transport (#3464):
            // QUIC frames are capped at 256 MB, so an oversized `LoroSync`
            // ships inline and nothing produces this variant. It can only
            // arrive from a chunking-era peer, which this build cannot decode
            // — fail loudly, same contract as `SnapshotOffer`.
            SyncMessage::LoroSyncChunked { .. } => Err(AppError::InvalidOperation(
                "LoroSyncChunked is not supported: the chunked encoding was \
                 removed with the WebSocket transport, and an oversized LoroSync \
                 now travels inline"
                    .into(),
            )),
            // ---- Chunked OpLogBatch header (#2593) --------------------------
            // Same story as LoroSyncChunked: no sender produces it, and a
            // chunking-era peer's frame cannot be decoded — fail loudly.
            SyncMessage::OpLogBatchChunked { .. } => Err(AppError::InvalidOperation(
                "OpLogBatchChunked is not supported: the chunked encoding was \
                 removed with the WebSocket transport, and an oversized \
                 OpLogBatch now travels inline"
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
            // `crate::sync_protocol::insert_replicated_op` — it is NEVER applied to state
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
    ///
    /// # Log level (#4085)
    ///
    /// The fallback used to WARN. It fired on 100% of initiator sessions —
    /// `remote_device_id` was structurally `None` in that role — which is the
    /// shape of alert that trains readers to ignore the level. Since
    /// [`Self::with_expected_remote_id`] seeds both fields, taking this branch
    /// at all now means the id was cleared or was never learned, and the
    /// daemon-supplied identity is doing exactly the job it exists for: that is
    /// a DEBUG. The genuinely surprising case — completing a session with no
    /// identity from *either* source, which the caller turns into a failed
    /// session rather than a bogus `peer_id = ""` row — keeps the WARN.
    fn resolve_remote_peer_id(&mut self) -> Option<String> {
        if let Some(id) = self.remote_device_id.as_deref()
            && !id.is_empty()
        {
            return Some(id.to_owned());
        }
        match self.expected_remote_id.as_deref() {
            Some(id) if !id.is_empty() => {
                tracing::debug!(
                    device_id = %self.device_id,
                    expected_remote_id = id,
                    "remote_device_id was empty at session completion; \
                     falling back to expected_remote_id from the authenticated \
                     peer identity"
                );
                // Backfill so the event sink sees a real peer id.
                self.remote_device_id = Some(id.to_owned());
                self.session.remote_device_id = id.to_owned();
                Some(id.to_owned())
            }
            _ => {
                tracing::warn!(
                    device_id = %self.device_id,
                    "session completed with no remote device_id from either the \
                     HeadExchange or the daemon-supplied peer identity; refusing \
                     to key peer_refs bookkeeping on an empty peer_id"
                );
                None
            }
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
        // #4230: inert unless this session's identity is an unverified claim.
        //
        // Today only a *responder* session can carry such a claim and only the
        // *puller* reaches here, so this particular pairing is currently
        // unreachable — it is guarded anyway because the property worth having
        // is "no `peer_refs` writer in this file keys a row on a refused claim",
        // which must not depend on today's role/message mapping staying put. The
        // check is one call, and it is free (`None` → `true`) on every session
        // whose identity the daemon vouched for.
        if !self.may_key_bookkeeping_on(peer_id).await {
            return Ok(());
        }
        // #490 M1: no per-peer sent-hash delta is tracked under the loro-vv
        // send path, and the empty string is the sentinel
        // `peer_refs::update_on_sync` documents for exactly that ("we sent
        // nothing trackable this session"). `snapshot_transfer` passes the same
        // literal for the same reason.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, peer_id).await?;
        complete_sync_in_tx(&mut tx, peer_id, last_hash, "").await?;
        tx.commit().await?;
        Ok(())
    }

    /// #4084: record the post-session bookkeeping for a session in which WE
    /// streamed our state to the peer — ensure the peer row exists and stamp
    /// `peer_refs.streamed_at`. **Only the streamer calls this**, and it is
    /// the exact complement of [`Self::record_pull_in_tx`].
    ///
    /// It deliberately does **not** touch `synced_at` / `last_hash`. #610: the
    /// scheduler measures staleness from `synced_at`, so a streamer that
    /// refreshed it would make itself permanently not-overdue toward a peer it
    /// pulled nothing from, starving the reverse direction. Recording the
    /// stream in its own column keeps the scheduler's input untouched while
    /// making the row honest: a responder-only device previously wrote no
    /// progress at all and was indistinguishable from one that had never
    /// synced.
    ///
    /// Ensure-row + stamp share one `BEGIN IMMEDIATE` transaction for the same
    /// crash-atomicity reason as the pull path — but that atomicity is scoped
    /// to this function's own two writes, not to the caller. Both callers
    /// immediately follow this with [`Self::persist_peer_loro_vvs`] in a
    /// *second*, independent `BEGIN IMMEDIATE`, so a crash between the two
    /// calls can leave `streamed_at` stamped with no `loro_vv_bytes` written.
    /// That is not a regression — the `SyncComplete` arm has run the same two
    /// separate transactions back-to-back since #4084/#2502 — but the pair is
    /// not atomic with each other, only internally consistent on their own.
    ///
    /// Two callers, both the streamer: the `SyncComplete` arm when a stream
    /// actually went out, and [`Self::reply_sync_complete`] when the
    /// empty-stream short-circuit fired (#4096) — the second is not gated on
    /// `streamed_to_peer`, which that path never sets.
    async fn record_stream_in_tx(&self, peer_id: &str) -> Result<(), AppError> {
        // #4230: inert unless this session's identity is an unverified claim.
        if !self.may_key_bookkeeping_on(peer_id).await {
            return Ok(());
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, peer_id).await?;
        peer_refs::update_on_stream_in_tx(&mut tx, peer_id).await?;
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
        // #4230: inert unless this session's identity is an unverified claim.
        // This is the write the guard exists for — `loro_vv_bytes` is the next
        // session's export floor, so a poisoned one is a data-correctness
        // problem, not a stale timestamp.
        if !self.may_key_bookkeeping_on(peer_id).await {
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
    /// one per [`SpaceId`] currently held in the caller-supplied
    /// `LoroState`'s registry (#2249: engine state is threaded in
    /// explicitly; there is no process-global accessor anymore).
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
        let space_ids: Vec<agaric_store::space::SpaceId> = loro_state.registry.space_ids();

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
            //
            // #4252: the READ asks the same question [`Self::may_key_bookkeeping_on`]
            // asks on every WRITE (#4230). On a pairing-window session
            // `remote_device_id` is a *claim* — the first non-self advertised head —
            // and #2481 makes advertising a foreign device's frontier NORMAL, so a
            // legitimate joiner routinely keys this session on an id that is not its
            // own. Reading that row's floor computes this peer's delta from ANOTHER
            // device's frontier: never more than it should get (a further-ahead
            // baseline omits ops, it does not add any), but a truncated stream that
            // `apply_remote`'s reachability gate then refuses, costing a
            // `ResetRequired` → full-snapshot round trip on the first pairing — the
            // slowest possible path, for a peer doing nothing wrong. Treating the
            // floor as ABSENT ships the full stream directly, which is the outcome
            // that round trip was going to reach anyway.
            let persisted_floor: Vec<crate::sync_protocol::types::SpaceVersionVector> = {
                let mut floor = Vec::new();
                if let Some(peer_id) = self.remote_device_id.clone().filter(|s| !s.is_empty())
                    && self.may_key_bookkeeping_on(&peer_id).await
                    && let Some(bytes) =
                        agaric_store::peer_refs::get_loro_vv_bytes(&self.pool, &peer_id).await?
                {
                    floor = crate::sync_protocol::types::decode_persisted_loro_vvs(&bytes);
                }
                floor
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
        //
        // #4096: `streamed_to_peer` is deliberately NOT set on this path — we
        // queued no stream, and the flag's job (below) is to keep the SyncComplete
        // arm from advancing `synced_at`, an arm this return never reaches. The
        // bookkeeping this session still owes lives inside `reply_sync_complete`
        // itself, unconditionally, for exactly that reason: a bookkeeping call
        // gated on `if self.streamed_to_peer` would silently skip this path.
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
    ///
    /// # Bookkeeping (#4096)
    ///
    /// This path used to record **nothing**: no `streamed_at`, no `synced_at`,
    /// no `loro_vv_bytes`. It returns before `streamed_to_peer` is set and
    /// before the `SyncComplete`-receive arm that carries every other
    /// completion's bookkeeping, so a device whose sessions all take this
    /// branch completed session after session while its `peer_refs` row stayed
    /// exactly as blank as a peer it had never met — the hole #4084's
    /// `streamed_at` column exists to close, still open on one branch.
    ///
    /// It stamps **`streamed_at`**, not `synced_at`, and the distinction is the
    /// whole point of the two columns. This is the responder half of the
    /// session — we processed the peer's `HeadExchange` and the peer pulled
    /// from us — so "this peer pulled from us" (`streamed_at`) is what actually
    /// happened, while "we pulled from this peer" (`synced_at`) did not: we
    /// received no state at all. Stamping `synced_at` here would also be a
    /// scheduling change, not just a display one — `peers_due_for_resync` reads
    /// `synced_at` and only `synced_at`, so a responder refreshing it on every
    /// inbound session would never find the initiator overdue, which is #610's
    /// starvation exactly. An empty stream is still a stream of zero bytes the
    /// peer asked for and got.
    ///
    /// # What the stamp does and does not claim
    ///
    /// `streamed_at` never meant "bytes moved", on this branch or any other.
    /// `loro_sync::prepare_outgoing`'s incremental arm returns a `LoroSyncMessage`
    /// for a space with no new ops just as it does for one with a thousand, so a
    /// steady-state responder already stamped `streamed_at` on sessions that
    /// shipped nothing of substance. The column means "a peer completed a pull
    /// session against us this recently", and that is exactly as true here.
    ///
    /// That matters because `streamed_at` has one consumer beyond the device
    /// list's `MAX(synced_at, streamed_at)`: `peer_pulled_from_us_recently`
    /// (#4120), which suppresses *repeat* reports of an *already-reported*
    /// outbound pull failure while the peer is still pulling from us. Stamping
    /// here feeds that window, and deliberately so — a peer completing sessions
    /// against us every cycle is the condition the window is asking about. The
    /// first report of any failure still lands unconditionally, so nothing goes
    /// unreported; only the second identical toast about a peer we are visibly
    /// still serving is withheld.
    ///
    /// The one arguable case is the *degraded* reason this branch fires: the
    /// #1257 freshness gate refusing **every** registered space, i.e. we held
    /// state and declined to export it. Stamping is still the consistent
    /// answer — a *partial* refusal already streams and already stamps, so
    /// exempting the total refusal would buy no guarantee while adding a third
    /// meaning to the column — and the refusal is not silent: `prepare_outgoing`
    /// `warn!`s per space per round and signals that a rebuild-from-op-log is
    /// required.
    ///
    /// The peer's advertised frontier is persisted for the same reason the
    /// normal streaming path persists it (#2502): the session completed, so the
    /// frontier the peer advertised is a valid export floor for next time.
    /// `persist_peer_loro_vvs` is a no-op when the stash is empty.
    ///
    /// Note what the floor *is*, which is why the degraded case does not make it
    /// unsafe to persist: it is the frontier the **peer** advertised holding, not
    /// a record of what we sent. Failing to satisfy it does not make it false.
    /// It is consulted only when the peer advertises no vv for a space next time
    /// (`head_exchange_outgoing_loro`'s `or_else`), and a stale or ahead floor is
    /// already handled by the receiver's `apply_remote` reachability gate, which
    /// falls back to a snapshot on an unbridgeable `from_vv`.
    ///
    /// # A new failure mode (#4096)
    ///
    /// Writing bookkeeping here puts `record_stream_in_tx` and
    /// `persist_peer_loro_vvs` on the error path: a transient `SQLITE_BUSY`
    /// acquiring either `BEGIN IMMEDIATE` now fails this reply via `?`, where
    /// the empty-registry responder previously always completed and sent
    /// `SyncComplete`. This matches the `SyncComplete` arm, which has
    /// propagated the same errors for the non-empty-stream case since #4084;
    /// it fails safe (the caller's normal backoff/retry picks the session back
    /// up, and nothing recorded so far needs undoing), but it is a failure
    /// mode this branch did not have before, and no test exercises it.
    async fn reply_sync_complete(&mut self) -> Result<Option<SyncMessage>, AppError> {
        let last_hash = get_local_heads(&self.pool)
            .await?
            .into_iter()
            .find(|h| h.device_id == self.device_id)
            .map(|h| h.hash)
            .unwrap_or_default();

        // #4096: record the session before announcing it. `resolve_remote_peer_id`
        // also back-fills `session.remote_device_id`, so the `Complete` event
        // below is attributable even on a cert-less session that learned the id
        // only from the advertised heads. `None` means no identity from either
        // source (it logs the warning itself); there is no peer to key a row on,
        // so the session still completes — it shipped nothing and applied
        // nothing — but writes no bookkeeping rather than a bogus `peer_id = ""`
        // row. `complete_pull_session` handles the same `None` case the same
        // way (skip the write, still complete), though its own `else { warn! }`
        // means that site logs the miss twice where this one — relying solely
        // on `resolve_remote_peer_id`'s own warning — logs it once.
        if let Some(peer_id) = self.resolve_remote_peer_id() {
            self.record_stream_in_tx(&peer_id).await?;
            self.persist_peer_loro_vvs(&peer_id).await?;
        }

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
            // #4305: likewise zero — this arm applied nothing by construction.
            // Read from the session rather than hardcoded so the field cannot
            // drift from the accumulator the other sites report.
            changed_blocks: Some(self.session.changed_blocks),
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
    /// op whose `payload` carries a large block `content`) lands in its own
    /// batch. Whether that oversized batch actually ships depends on the peer's
    /// capabilities (#2593):
    ///
    /// * **Peer advertised `op_log_batch_chunked`** → the batch ships. Since the
    ///   iroh port (#3464) it ships *inline*, as one oversized `OpLogBatch`:
    ///   QUIC's 256 MB frame cap accommodates it and the chunked encoding was
    ///   removed with the transport that needed it. The capability still gates
    ///   the send because it is what the peer used to promise it could survive a
    ///   payload above the inline bound, however that payload arrives.
    /// * **Peer did NOT** (a shipped #2481 build that knows `OpLogBatch` but not
    ///   the chunked envelope) → the oversized batch is **skipped with a
    ///   warning**, exactly as before #2593. This is the critical back-compat
    ///   guard: shipping such a peer a payload above the cap it was built
    ///   against would fault the session, and because the oversized record
    ///   persists, every subsequent session too — breaking *all* state sync, not
    ///   just audit. Its state still syncs via the chunked `LoroSync` path.
    ///
    /// A batch exceeding [`MAX_OP_LOG_BATCH_PAYLOAD_SIZE`] (256 MB) is skipped
    /// unconditionally — it exceeds the frame cap itself, so it would fault the
    /// send regardless of capability.
    ///
    /// [`MAX_OP_LOG_BATCH_PAYLOAD_SIZE`]: crate::sync_constants::MAX_OP_LOG_BATCH_PAYLOAD_SIZE
    async fn collect_op_batches_for_peer(&self) -> Result<Vec<Vec<OpTransfer>>, AppError> {
        if !self.peer_op_log_replication {
            return Ok(Vec::new());
        }
        use crate::sync_constants::{MAX_OP_LOG_BATCH_PAYLOAD_SIZE, OP_LOG_BATCH_INLINE_MAX_BYTES};
        let records = collect_ops_for_peer(&self.pool, &self.peer_advertised_heads).await?;
        let mut batches = batch_ops_for_wire(records, OP_LOG_BATCH_INLINE_MAX_BYTES);
        // #2593 back-compat + hard-cap guard. `batch_ops_for_wire` isolates any
        // over-inline-bound record in its own batch, so filtering at the batch
        // level drops exactly the offending record(s).
        batches.retain(|batch| {
            let size = serde_json::to_string(batch).map_or(usize::MAX, |s| s.len());
            if size as u64 > MAX_OP_LOG_BATCH_PAYLOAD_SIZE {
                tracing::warn!(
                    device_id = %self.device_id,
                    size,
                    cap = MAX_OP_LOG_BATCH_PAYLOAD_SIZE,
                    "#2593: skipping an op batch that exceeds the transport payload cap \
                     (unshippable at any size); its state still syncs via LoroSync"
                );
                return false;
            }
            if size > OP_LOG_BATCH_INLINE_MAX_BYTES && !self.peer_op_log_batch_chunked {
                tracing::warn!(
                    device_id = %self.device_id,
                    size,
                    cap = OP_LOG_BATCH_INLINE_MAX_BYTES,
                    "#2593: skipping an oversized op batch for a peer that lacks the \
                     chunked-OpLogBatch capability (older #2481 build); its state still \
                     syncs via LoroSync"
                );
                return false;
            }
            true
        });
        Ok(batches)
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
        //
        // #3325: the per-record failure policy is NOT uniform, and the ordering
        // it enforces is what keeps the frontier honest — see
        // [`ingest_replicated_batch`], which owns it. In short: a *transient*
        // failure defers the rest of that device's chain (our advertised
        // `MAX(seq)` for it must not step over a record we do not hold, or the
        // peer never offers it again), while a *corrupt* record is skipped
        // permanently and the frontier is allowed past it.
        if !self.pending_ingest_records.is_empty() {
            if let Err(e) = self.host.flush().await {
                tracing::warn!(
                    device_id = %self.device_id,
                    error = %e,
                    "#2481: materializer flush before op-log ingest failed; \
                     ingesting anyway (best-effort)"
                );
            }
            let records = std::mem::take(&mut self.pending_ingest_records);
            let outcome = crate::sync_protocol::ingest_replicated_batch(
                &self.pool,
                &records,
                &self.device_id,
                &self.session.remote_device_id,
            )
            .await;
            tracing::debug!(
                device_id = %self.device_id,
                remote_device_id = %self.session.remote_device_id,
                ingested = outcome.ingested,
                already_held = outcome.already_held,
                rejected = outcome.rejected,
                deferred = outcome.deferred,
                out_of_order = outcome.out_of_order,
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
            // #4305: blocks this pull actually moved. A pull that imported
            // only empty per-space deltas reports `Some(0)` and is silent.
            changed_blocks: Some(self.session.changed_blocks),
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

#[cfg(test)]
mod tests {
    //! #4230 finding B: `peer_is_bound_to_another_key`'s own unit tests
    //! (`sync_daemon::server`) cover its `Err` arm, but only by handing it an
    //! injected `Result::Err` directly — that pins the predicate, not the wiring
    //! at THIS call site. [`SyncOrchestrator::may_key_bookkeeping_on`] hands the
    //! predicate the outcome of a real `list_peer_refs(&self.pool).await`, with
    //! no `?` / `ok()` / `unwrap_or_default()` in between; nothing asserted that
    //! a real failed read actually reaches the same deny. A future refactor that
    //! inserted `.unwrap_or_default()` here would fail OPEN — permit the write —
    //! with every existing test (including the predicate's own) still green.

    use std::sync::Arc;

    use super::*;
    use crate::apply_host::test_support::RecordingApplyHost;

    /// Build an armed orchestrator: an unverified claim on `endpoint_id`, over
    /// `pool`. The `ApplyHost` is a recording double — this test never runs a
    /// session, it only calls the private guard directly.
    fn orchestrator_with_claim(pool: &SqlitePool, endpoint_id: &str) -> SyncOrchestrator {
        let host: Arc<dyn ApplyHost> = Arc::new(RecordingApplyHost::new());
        SyncOrchestrator::new(pool.clone(), "device-under-test".to_owned(), host)
            .with_unverified_claim_guard(endpoint_id.to_owned())
    }

    /// #4230 / finding B: a `list_peer_refs` read that fails for real — not an
    /// injected `Result::Err` — must still deny.
    ///
    /// The peer_refs table starts empty, so a SUCCESSFUL read finds nothing
    /// bound to another key and permits (asserted first, as a control — without
    /// it a guard that always denied would pass the second assertion for the
    /// wrong reason). Then the pool is closed, the same way
    /// `loro_sync::tests::a_probe_that_cannot_run_is_counted_rather_than_read_as_a_present_parent`
    /// forces a real read failure elsewhere in this crate, and the same call
    /// must flip to deny.
    #[tokio::test]
    async fn a_real_failed_peer_ref_read_denies_bookkeeping() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        let orch = orchestrator_with_claim(&pool, "claimed-endpoint-key");

        assert!(
            orch.may_key_bookkeeping_on("PEER-A").await,
            "control: an empty peer_refs table has nothing to conflict with, so a \
             successful read must permit"
        );

        pool.close().await;

        assert!(
            !orch.may_key_bookkeeping_on("PEER-A").await,
            "a list_peer_refs read that fails for real must deny bookkeeping, the \
             same as peer_is_bound_to_another_key's own tests pin for an injected \
             Err — a closed pool is this crate's established way to force a real \
             read failure"
        );
    }

    // -----------------------------------------------------------------------
    // #4305 — the honest change count
    // -----------------------------------------------------------------------

    /// Two space ids, because two is the number the reporting user had and the
    /// number their toast said, once a minute, forever.
    const TWO_SPACES: [&str; 2] = ["01ARZ3NDEKTSV4RRFFQ69G5FA1", "01ARZ3NDEKTSV4RRFFQ69G5FA2"];

    /// Register (and thereby instantiate) every space in `TWO_SPACES` on a
    /// registry. Instantiating them is load-bearing: an orchestrator with an
    /// *empty* registry takes the empty-stream short-circuit and never streams
    /// at all, which is not the case under test.
    fn seed_spaces(state: &agaric_engine::loro::shared::LoroState, device_id: &str) {
        for sid in TWO_SPACES {
            let space = agaric_store::space::SpaceId::from_trusted(sid);
            drop(
                state
                    .registry
                    .for_space(&space, device_id)
                    .expect("engine for space"),
            );
        }
    }

    /// Drive one pull session against a peer engine and return the terminal
    /// `Complete` event's `(ops_received, changed_blocks)`.
    ///
    /// This is a real session over the real state machine: we `start()` as the
    /// puller, the peer answers with one `LoroSync` per registered space built
    /// against the version vectors we just advertised, and the last of them
    /// completes the session. Exactly the wire traffic of one resync tick.
    async fn pull_from(
        pool: &SqlitePool,
        local_state: &Arc<agaric_engine::loro::shared::LoroState>,
        peer_state: &agaric_engine::loro::shared::LoroState,
    ) -> (usize, Option<usize>) {
        use crate::sync_events::{RecordingEventSink, SyncEvent};
        use crate::sync_protocol::loro_sync;

        let sink = Arc::new(RecordingEventSink::new());
        let host: Arc<dyn ApplyHost> = Arc::new(
            crate::apply_host::test_support::RecordingApplyHost::with_loro_state(Arc::clone(
                local_state,
            )),
        );
        let mut orch = SyncOrchestrator::new(pool.clone(), "DEV_LOCAL".to_owned(), host)
            .with_expected_remote_id("DEV_PEER".to_owned())
            .with_event_sink(Box::new(Arc::clone(&sink)));

        let SyncMessage::HeadExchange { loro_vvs, .. } =
            orch.start().await.expect("start the pull session")
        else {
            panic!("the puller opens with a HeadExchange");
        };

        let sql_deleted = std::collections::HashSet::new();
        let mut payloads = Vec::new();
        for sid in TWO_SPACES {
            let space = agaric_store::space::SpaceId::from_trusted(sid);
            let peer_vv = loro_vvs
                .iter()
                .find(|v| v.space_id == space)
                .map(|v| v.vv.as_slice());
            payloads.push(
                loro_sync::prepare_outgoing(
                    &peer_state.registry,
                    &space,
                    "DEV_PEER",
                    peer_vv,
                    &sql_deleted,
                )
                .await
                .expect("prepare_outgoing")
                .expect("a registered space always yields a payload"),
            );
        }

        let last = payloads.len() - 1;
        for (i, msg) in payloads.into_iter().enumerate() {
            orch.handle_message(SyncMessage::LoroSync {
                msg,
                is_last: i == last,
            })
            .await
            .expect("import the peer's per-space payload");
        }

        sink.events()
            .into_iter()
            .find_map(|e| match e {
                SyncEvent::Complete {
                    ops_received,
                    changed_blocks,
                    ..
                } => Some((ops_received, changed_blocks)),
                _ => None,
            })
            .expect("the session must reach Complete")
    }

    /// #4305: a converged, idle pair still exchanges one `LoroSync` per space
    /// every resync tick, so `ops_received` is a non-zero constant on a session
    /// in which nothing whatsoever happened. The event must carry a second,
    /// honest number that says so — otherwise the only count available to a
    /// toast is the space count, which is what put "Synced 2 changes from
    /// device" on the user's screen every sixty seconds on a pair with no
    /// edits on either side.
    ///
    /// The second half of the test is not decoration: without it, hardcoding
    /// `changed_blocks: Some(0)` at the emission site would pass.
    #[tokio::test]
    async fn a_converged_no_op_pull_reports_zero_changes_while_ops_received_counts_spaces_4305() {
        use agaric_engine::loro::shared::LoroState;

        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        let local_state = Arc::new(LoroState::new());
        let peer_state = LoroState::new();
        seed_spaces(&local_state, "DEV_LOCAL");
        seed_spaces(&peer_state, "DEV_PEER");

        // ---- Converged: both sides hold the same (empty) state.
        let (ops_received, changed_blocks) = pull_from(&pool, &local_state, &peer_state).await;
        assert_eq!(
            ops_received, 2,
            "the protocol counter is the number of SPACES — one LoroSync each, \
             delta or no delta. This is the number the toast was built from, and \
             it is 2 on a session that did nothing at all"
        );
        assert_eq!(
            changed_blocks,
            Some(0),
            "#4305: …and the honest counter must say the truth about that same \
             session — nothing changed. `Some(0)` is what keeps the frontend silent"
        );

        // ---- Not converged: the peer wrote a block since we last pulled.
        let block = "01HZ00000000000000000CHG01";
        {
            let space = agaric_store::space::SpaceId::from_trusted(TWO_SPACES[0]);
            let mut guard = peer_state
                .registry
                .for_space(&space, "DEV_PEER")
                .expect("peer engine");
            guard
                .engine_mut()
                .apply_create_block(block, "content", "a real edit", None, 0)
                .expect("the peer writes a block");
        }

        let (ops_received, changed_blocks) = pull_from(&pool, &local_state, &peer_state).await;
        assert_eq!(
            ops_received, 2,
            "the protocol counter is unmoved by the edit — it never was a change \
             count, which is the whole point"
        );
        assert_eq!(
            changed_blocks,
            Some(1),
            "…while the honest counter tracks the one block that actually arrived"
        );
    }
}
