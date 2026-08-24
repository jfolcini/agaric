use serde::{Deserialize, Serialize};

use crate::sync_protocol::loro_sync_types::{LoroSyncChunkedHeader, LoroSyncMessage};
use agaric_store::op_log::OpRecord;

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

/// The initiator's Loro version vector for one space, advertised in
/// [`SyncMessage::HeadExchange`] so the responder can ship an incremental
/// [`LoroSyncMessage::Update`] (the delta since this vv) instead of a full
/// Snapshot (#87 §10.5 per-peer-vv exchange).
///
/// `vv` is the opaque encoding from
/// [`agaric_engine::loro::engine::LoroEngine::version_vector`]. A space the initiator
/// does not list here (or an older peer that sends none) falls back to a full
/// snapshot for that space — the field is purely an optimisation hint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpaceVersionVector {
    pub space_id: agaric_store::space::SpaceId,
    pub vv: Vec<u8>,
}

/// Serialize a peer's advertised per-space version vectors into the opaque
/// blob persisted in `peer_refs.loro_vv_bytes` (#2502).
///
/// The persistence layer (`agaric_store::peer_refs`) stores these bytes verbatim and
/// takes no dependency on this type; the encoding lives here so the
/// serialize/parse pair stays in one place. JSON is used (rather than a bespoke
/// binary framing) because the payload is tiny — a handful of spaces, each with
/// a few-byte Loro-encoded vv — and its debuggability outweighs the size cost
/// for a per-peer bookmark written once per session.
pub fn encode_persisted_loro_vvs(vvs: &[SpaceVersionVector]) -> Vec<u8> {
    // Serializing a `Vec<SpaceVersionVector>` cannot fail (plain data), but map
    // any theoretical error to an empty blob — the reader treats that as "no
    // persisted frontier" and falls back to a full snapshot, which is safe.
    serde_json::to_vec(vvs).unwrap_or_default()
}

/// Parse the `peer_refs.loro_vv_bytes` blob back into per-space version vectors
/// (#2502). A malformed/legacy blob yields an empty list — the caller then
/// falls back to a full snapshot per space, exactly as if nothing were
/// persisted, so a decode failure is degraded-but-safe rather than fatal.
pub fn decode_persisted_loro_vvs(bytes: &[u8]) -> Vec<SpaceVersionVector> {
    serde_json::from_slice(bytes).unwrap_or_default()
}

/// The maximum length, in Unicode scalar values, of a device name on the wire
/// (#4298).
///
/// 64, matching `MAX_RENAME_LENGTH` in
/// `src/components/dialogs/RenameDialog.tsx` — the cap the user's own rename
/// already enforces. Picking the same number means a peer-supplied name and a
/// user-typed one occupy the same space in the device list, so neither can
/// blow out a layout the other fits in.
///
/// Counted in **characters**, not bytes, so the bound is on what is rendered
/// rather than on the encoding: a 64-character name is 64 columns of text
/// whether it is ASCII or CJK, and a byte cap would truncate a multi-byte
/// name to a fraction of that (or, worse, mid-scalar).
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

/// True for a character that must never survive into a stored device name
/// (#4298).
///
/// Two families, both of which make a name *render* as something other than
/// what it says:
///
/// * [`char::is_control`] — C0/C1. A newline or a carriage return in a name
///   breaks it across lines in every surface that renders it (the device list
///   row, the sync-failure toast, the unpair dialog, the `aria-label` on
///   rename and address); a `NUL` or a `BEL` renders as nothing or as a
///   replacement box.
/// * The Unicode bidi and zero-width **format** characters. `U+202E`
///   RIGHT-TO-LEFT OVERRIDE is the classic one: it reverses the display order
///   of everything after it, so a peer can name itself such that the row reads
///   as another device entirely, and the isolates (`U+2066`..`U+2069`) do the
///   same with a scope. The zero-width ones (`U+200B`..`U+200D`, `U+FEFF`)
///   have no width at all, so two peers can hold names that are visually
///   identical and textually distinct — the device list's whole job is to tell
///   devices apart.
///
/// This is not an XSS defence: React escapes what it renders and the name
/// never reaches `dangerouslySetInnerHTML`. It is a *spoofing* defence, on the
/// one string in this app that arrives from an untrusted remote and is
/// displayed verbatim.
///
/// Stripping `U+200D` costs the ZWJ in a name made of emoji sequences (a
/// `👨‍💻` degrades to two adjacent glyphs). That is the accepted price:
/// an emoji hostname is a rarity, and a joiner that lets one device impersonate
/// another is not a rarity worth preserving it for.
///
/// The ranges, spelled out once: `U+061C` ARABIC LETTER MARK;
/// `U+200B`..`U+200F` (ZWSP, ZWNJ, ZWJ, LRM, RLM); `U+202A`..`U+202E` (LRE,
/// RLE, PDF, LRO, RLO); `U+2066`..`U+2069` (LRI, RLI, FSI, PDI); and `U+FEFF`
/// ZWNBSP/BOM.
fn is_display_hostile(c: char) -> bool {
    if c.is_control() {
        return true;
    }
    matches!(
        c,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Normalise a device name for the wire (#4298): strip the characters that
/// would let it render as something other than itself (see
/// `is_display_hostile`), trim it, treat empty/whitespace-only as absent, and
/// clamp it to [`MAX_DEVICE_NAME_CHARS`].
///
/// Applied on **send** (the initiator advertising its own hostname) and again
/// on **receive** (the responder persisting what a peer claimed). The
/// receive-side application is the load-bearing one: the sender is an untrusted
/// remote and there is nothing about a well-behaved sender that a hostile one
/// cannot omit. Doing it on send too keeps this device from being the one that
/// puts an unreasonable value on the wire, and keeps the two sides' notion of a
/// valid name identical by construction — one function, called twice.
///
/// Returns `None` for anything that is not a name, so the caller never has to
/// distinguish "sent nothing" from "sent whitespace": both mean *no name*, and
/// a stored `NULL` is what makes the display fall through to the next
/// precedence level rather than rendering a blank row. A name that is *only*
/// hostile characters reduces to nothing and is therefore no name either.
///
/// The strip runs before the trim, so a name whose visible content is fenced
/// by format characters (`"\u{202E} laptop"`) still has its now-exposed
/// whitespace removed, and before the cap, so the 64 scalars that survive are
/// 64 scalars of actual name rather than of invisible padding.
pub fn clamp_device_name(name: &str) -> Option<String> {
    let stripped: String = name.chars().filter(|c| !is_display_hostile(*c)).collect();
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_DEVICE_NAME_CHARS).collect())
}

/// Wire-format mirror of `OpRecord` for sync transfer.
///
/// **I-Sync-4 — deliberate boundary, not duplication.** Today every field
/// matches `op_log::OpRecord` and `From<OpRecord> for OpTransfer` (and the
/// reverse) is pure pass-through. The split is preserved as a future-proofing
/// seam: if a v2 wire format ever needs to add a transfer-only field (e.g.
/// a transfer-time integrity signature, encryption envelope, compression
/// flag) or omit a DB-only field (e.g. a server-stamped `materialized_at`),
/// the boundary is already in place — collapsing into `pub type OpTransfer
/// = OpRecord;` now and re-introducing later would be more work than
/// maintaining the two trivial structs and their `From` impls.
///
/// **Invariant:** the two structs MUST stay structurally identical *for the
/// hash-bearing columns* until a deliberate v2-shape divergence lands. Adding
/// a new hash-bearing field to `OpRecord` requires the same field on
/// `OpTransfer` and an update to both `From` impls. A `#[cfg(test)]` parity
/// test below pins this contract for the hash-bearing columns.
///
/// **`origin` is a deliberate transfer-carried, non-hashed exception (#2481).**
/// `origin` is op-log *attribution* metadata (`user` / an agent tag; migration
/// 0033). It is NOT part of `compute_op_hash`'s preimage (see
/// `op-log-format.md` §Validity rules), so shipping it does not affect
/// verification — and it is exactly the cross-device attribution #2481's
/// audit-only replication exists to carry. It is `#[serde(default)]` (defaults
/// to `"user"`) so the wire change is strictly back-compatible: an older peer
/// that omits the field deserializes as `"user"`, and an older peer that
/// receives it ignores the unknown field. `OpRecord` (the DB-read Rust struct)
/// does not surface `origin`, so `From<OpRecord>` fills the transfer default;
/// the audit send path builds `OpTransfer` directly from an `op_log` row that
/// SELECTs the `origin` column, preserving the authored attribution verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpTransfer {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    /// Epoch-ms (mirrors `op_log.created_at`, INTEGER since migration 0079).
    pub created_at: i64,
    /// Op-log attribution (`user` / agent tag; migration 0033). Not hashed;
    /// `#[serde(default)]` → `"user"` for wire back-compat (#2481). See the
    /// struct doc-comment.
    #[serde(default = "default_op_origin")]
    pub origin: String,
}

/// Default `OpTransfer::origin` for wire back-compat: an older peer that omits
/// the field (and the `From<OpRecord>` bridge, which has no origin to carry)
/// yields the same `"user"` default the `op_log.origin` column uses
/// (migration 0033).
fn default_op_origin() -> String {
    "user".to_string()
}

// ---- Conversions ----------------------------------------------------------

impl From<OpRecord> for OpTransfer {
    fn from(r: OpRecord) -> Self {
        // `OpRecord::block_id` is a Rust-only sidecar and
        // intentionally not included on the wire — it can always be
        // recovered from `payload` and is not part of the cross-device
        // identity of the op.
        Self {
            device_id: r.device_id,
            seq: r.seq,
            parent_seqs: r.parent_seqs,
            hash: r.hash,
            op_type: r.op_type,
            payload: r.payload,
            created_at: r.created_at,
            // `OpRecord` does not surface the `op_log.origin` column, so this
            // bridge fills the `"user"` default. The #2481 audit send path
            // does NOT go through here — it builds `OpTransfer` directly from
            // an `op_log` row that SELECTs `origin`, carrying the authored
            // attribution verbatim.
            origin: default_op_origin(),
        }
    }
}

impl From<OpTransfer> for OpRecord {
    fn from(t: OpTransfer) -> Self {
        // The wire transfer carries no `block_id` sidecar.
        // Intentionally leave `block_id` as `None` here — parsing
        // `payload` for it would add a second `serde_json::from_str`
        // per sync'd op on top of the validation parse that
        // `apply_remote_ops` already performs, regressing exactly the
        // Hot path is meant to optimise. The sync receive path
        // (`apply_remote_ops`) populates the sidecar from its
        // existing validation parse so the cost stays at one parse
        // per op on the sync side. Tests / fixtures that build an
        // `OpRecord` directly without going through that flow should
        // populate `block_id` themselves (see e.g.
        // `merge::detect::tests::make_remote_record` and
        // `dag::tests::make_remote_record`).
        Self {
            device_id: t.device_id,
            seq: t.seq,
            parent_seqs: t.parent_seqs,
            hash: t.hash,
            op_type: t.op_type,
            payload: t.payload,
            created_at: t.created_at,
            block_id: None,
        }
    }
}

/// Messages exchanged between two sync peers.
///
/// # Valid wire-level message sequence
///
/// The full session is driven by two cooperating state machines: the
/// per-session [`SyncOrchestrator`](super::SyncOrchestrator) (defined in
/// [`crate::sync_protocol::session_state_machine`]) drives the head-exchange →
/// op-stream → merge → complete pipeline, and the surrounding
/// [`crate::sync_daemon`] orchestrator drives the post-complete
/// snapshot and file-transfer sub-flows. The valid order on the wire
/// is:
///
/// 1. **`HeadExchange`** — exactly once per session, sent by the
///    initiator only. Carries the latest `(device_id, seq, hash)` tuple
///    per advertised device. The responder processes it and replies
///    with the streaming phase below (it does not send its own
///    `HeadExchange`). A second `HeadExchange` mid-session is a
///    protocol violation and transitions to
///    [`SyncState::Failed`](super::SyncState::Failed).
///
/// 2. **`LoroSync`** — zero or more, sent by the responder only, after
///    it has processed the initiator's `HeadExchange`. Each message
///    carries one [`LoroSyncMessage`] (Snapshot or Update) for one
///    [`agaric_store::space::SpaceId`]; `is_last: true` on the final
///    per-space message tells the receiver to transition to
///    `SyncComplete`. Loro's CRDT import converges concurrent edits.
///
/// 3. **`SyncComplete`** — sent once by the **puller** after it has
///    imported the streamer's final `LoroSync` (in the normal flow that
///    is the initiator; in the empty-registry short-circuit the responder
///    sends it directly because it had nothing to stream). Carries
///    `last_hash` (the sender's local frontier). #610: only the puller
///    records `peer_refs.synced_at` for the peer — the streamer, which
///    pulled nothing this session, must not, or it starves the reverse
///    direction.
///
/// 4. **`ResetRequired`** — terminal *side-exit* in place of
///    `SyncComplete`, sent by the responder when its op log has been
///    compacted past the initiator's advertised heads (i.e. a delta
///    replay is impossible). Triggers the snapshot sub-flow below;
///    the per-session state machine never accepts another delta
///    message after this point.
///
/// 5. **`SnapshotOffer` → `SnapshotAccept` | `SnapshotReject`**
///    (post-`ResetRequired` only) — driven by
///    [`crate::sync_daemon::snapshot_transfer`], not the per-session
///    state machine. Responder offers; initiator accepts (and then
///    receives the blob in binary frames) or rejects (and the session
///    closes). `SnapshotOffer` arriving outside this sub-flow is a
///    protocol error.
///
/// 6. **`FileRequest` → (`FileOffer` + binary frames + `FileReceived`)*
///    → `FileTransferComplete`** (post-`SyncComplete` only) — driven
///    by [`crate::sync_files`], not the per-session state machine.
///    Both peers run this exchange in turn (initiator first, then
///    responder) so each side can pull missing attachments. These
///    variants must therefore **never** reach the per-session
///    `SyncOrchestrator::handle_message` dispatch.
///
/// 7. **`Error { message }`** — any side may send at any point to
///    abort. The receiver transitions to
///    [`SyncState::Failed`](super::SyncState::Failed); the connection
///    is closed and the daemon retries on the next scheduled tick.
///
/// See [`crate::sync_protocol::session_state_machine`] (per-session ASCII
/// diagram) and [`crate::sync_daemon::session_supervisor`] (daemon-level
/// orchestration) for the source-of-truth narrative.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncMessage {
    /// First exchanged in a session; advertises `(device_id, seq, hash)`
    /// tuples. Sent by the initiator only (exactly once); the responder
    /// replies with the streaming phase rather than its own `HeadExchange`.
    ///
    /// `loro_vvs` carries the initiator's per-space Loro version vectors so
    /// the responder can stream an incremental [`LoroSyncMessage::Update`]
    /// (the delta since the initiator's vv) instead of a full snapshot. It is
    /// `#[serde(default)]` for wire back-compat: an older initiator omits it,
    /// and the responder falls back to a full snapshot per space.
    ///
    /// `engine_format_version` advertises the sender's
    /// [`agaric_engine::loro::engine::ENGINE_FORMAT_VERSION`] so the responder can
    /// reject an incompatible peer up front (before any raw-byte Loro merge)
    /// rather than failing mid-session on an import. It is `#[serde(default)]`
    /// for wire back-compat: a peer predating this field omits it and
    /// deserializes as `0`, which the responder treats as "legacy peer" and
    /// lets fall through to the import-time format guards (#2130).
    /// `heads` carries every device frontier held in the sender's local
    /// op_log — its own device plus any foreign frontiers it has previously
    /// replicated as audit metadata (#2481 phase 1). The `Vec` shape is
    /// unchanged, so this is a pure *semantic* extension: an older peer simply
    /// advertises fewer entries (its own device only), and
    /// [`check_reset_required`](super::operations::check_reset_required)
    /// already ignores every non-own-device head, so a longer list is a no-op
    /// for the reset handshake.
    ///
    /// `op_log_replication` is the #2481 phase-1 capability handshake. It is
    /// `#[serde(default)]` (→ `false`) for wire back-compat: an older peer
    /// omits it and deserializes as `false`, and an older peer that receives
    /// it ignores the unknown field. A peer MUST NOT send the new
    /// [`SyncMessage::OpLogBatch`] variant to a peer that did not advertise
    /// `op_log_replication: true` — that is how phase 1 avoids delivering an
    /// unknown-variant message an older peer cannot deserialize. Both sides
    /// gate their op-log audit exchange on having observed this flag from the
    /// other side.
    ///
    /// **Removed field: `wire_compression` (#2200, deleted in #3543).** It
    /// advertised that the sender could zstd-inflate a compressed
    /// `LoroSyncChunked` payload. The compressor and the chunked framing both
    /// went with the WebSocket transport at the iroh cutover (#3464), leaving
    /// the flag write-only: every build set it to `true` on send and discarded
    /// it on receive. Dropping it is wire-safe in both directions because this
    /// enum does **not** carry `deny_unknown_fields`: a build that still sends
    /// the key has it ignored here, and this build's omission deserializes on
    /// such a peer as its `#[serde(default)]` `false`, which no surviving code
    /// path reads. It cannot reach a *pre*-cutover peer at all — that build
    /// speaks WebSocket-over-mTLS and cannot complete an iroh QUIC handshake on
    /// `transport::service::SYNC_ALPN`, so no session exists in which the old
    /// `false`-means-send-raw-bytes semantics could be observed.
    HeadExchange {
        heads: Vec<DeviceHead>,
        #[serde(default)]
        loro_vvs: Vec<SpaceVersionVector>,
        #[serde(default)]
        engine_format_version: u32,
        #[serde(default)]
        op_log_replication: bool,
        /// #2593 — additive capability handshake for the chunked
        /// [`SyncMessage::OpLogBatchChunked`] transport. `#[serde(default)]`
        /// (→ `false`) for wire back-compat: a peer predating this field (a
        /// shipped #2481 build that advertises `op_log_replication: true` but
        /// knows nothing of the chunked envelope) omits it and deserializes as
        /// `false`. The streamer ships an oversized (over-inline-bound) op batch
        /// as `OpLogBatchChunked` ONLY to a peer that advertised
        /// `op_log_batch_chunked: true`; a peer lacking the capability has the
        /// oversized record **skipped with a warning** (its state still syncs
        /// via `LoroSync`) instead of receiving a frame it cannot deserialize —
        /// which would fault the session and, because the record persists, every
        /// subsequent one. The initiator advertises `true` (it can always decode
        /// the chunked form on receive).
        ///
        /// **Still live after the iroh cutover (#3464), unlike the sibling
        /// `wire_compression` flag this once mirrored.** The chunked *encoding*
        /// went with the WebSocket transport, so an over-inline-bound batch now
        /// travels as one oversized inline `OpLogBatch` under QUIC's frame cap.
        /// The flag survives because what it actually promises is "I can survive
        /// a payload above [`OP_LOG_BATCH_INLINE_MAX_BYTES`], however it
        /// arrives", and that promise still gates a real send decision in
        /// `SyncOrchestrator::collect_op_batches_for_peer`. Do not delete it as
        /// vestigial alongside `wire_compression` — see #3543.
        ///
        /// [`OP_LOG_BATCH_INLINE_MAX_BYTES`]: crate::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES
        #[serde(default)]
        op_log_batch_chunked: bool,
        /// #855 — proof that the initiator knows the pairing passphrase,
        /// present only while the initiator is mid-pairing (its
        /// pending-pairing marker holds the expected proof). The responder
        /// admits and TOFU-pins an *unpaired* device during the pairing window
        /// only when this matches the proof it stored when it armed/confirmed
        /// the pairing (see [`crate::pairing::pairing_proof`] and
        /// [`crate::sync_daemon::server`]). This closes the CN-spoof window: an
        /// attacker minting `CN=agaric-{victim}` but ignorant of the passphrase
        /// cannot produce a matching proof and is never pinned.
        ///
        /// `#[serde(default)]` (→ `None`) for wire back-compat: a peer predating
        /// this field omits it (an older peer can no longer complete a *first*
        /// pairing against a #855 responder, which is the intended security
        /// tightening — pairing is a deliberate mutual act on current builds),
        /// and an already-paired peer omits it on every normal sync (the
        /// responder only consults it on the unpaired-pending-pairing path).
        #[serde(default)]
        pairing_proof: Option<String>,
        /// #4298 — what the initiator calls itself: its OS hostname, so the
        /// responder can render a paired device as "javier-thinkpad" instead of
        /// `e3d48f0a-45a…`. Persisted by the responder as
        /// `peer_refs.remote_device_name` (migration 0114) — **never** as
        /// `peer_refs.device_name`, which is the local user's override and
        /// outranks this.
        ///
        /// Re-sent on every session rather than once at pairing: a device can
        /// be renamed at any time, there is no other frame that would carry the
        /// update, and the write is conditional on a change
        /// (`peer_refs::update_remote_device_name`) so a steady-state session
        /// costs one read and no write.
        ///
        /// Untrusted display text. It is clamped to
        /// [`MAX_DEVICE_NAME_CHARS`] and normalised (empty/whitespace-only →
        /// `None`) by [`clamp_device_name`] on send AND again on receive — a
        /// peer can put anything here, so every bound is re-applied by the side
        /// that has to render it rather than assumed of the sender.
        ///
        /// `#[serde(default)]` (→ `None`) for wire back-compat, exactly as
        /// `pairing_proof` above: a peer predating this field omits it and the
        /// responder simply learns no name (keeping whatever it already had),
        /// and a peer predating it that *receives* it ignores the unknown field
        /// — this enum carries no `deny_unknown_fields`.
        ///
        /// Initiator-only, because `HeadExchange` is. The responder has no
        /// equivalent one-shot frame, so it does not answer with its own name
        /// in this session; it learns nothing here and the initiator learns
        /// nothing about it. That direction closes on its own, because the roles
        /// are not fixed — every device runs the resync scheduler and dials its
        /// peers, so each side is the initiator of some session and the pair
        /// converges on both names within a resync interval. Adding a
        /// responder→initiator name frame would buy only the gap between the
        /// first pair and the peer's first outbound dial.
        #[serde(default)]
        device_name: Option<String>,
    },
    /// Loro-CRDT-based sync wire envelope.
    ///
    /// Carries one [`LoroSyncMessage`] (Snapshot or Update) per
    /// [`agaric_store::space::SpaceId`]. Sent zero-or-more times by the responder
    /// only (the streamer), after it processes the initiator's
    /// `HeadExchange`. The `is_last` flag tells the receiver this is the
    /// final per-space message of the batch so it can transition to
    /// `SyncComplete` once it processes the last one. The sole
    /// streaming-phase payload.
    LoroSync { msg: LoroSyncMessage, is_last: bool },
    /// Transport-level escape hatch for large `LoroSync` payloads
    /// (#611). Announces that the Loro bytes follow out-of-band as
    /// exactly `header.size_bytes()` of chunked binary frames, because
    /// the inline JSON number-array encoding (worst case 4 chars/byte)
    /// would blow the per-message receive cap — 10 MB on the WebSocket
    /// transport this split was sized against (see
    /// [`LoroSyncChunkedHeader`](super::loro_sync_types::LoroSyncChunkedHeader)).
    ///
    /// **Nothing in this build produces it.** The iroh port (#3464) removed
    /// the chunking layer along with the transport that needed it: a QUIC
    /// frame is bounded by `transport::session::MAX_FRAME_SIZE` (256 MB), so
    /// an over-threshold payload now ships as one ordinary
    /// [`SyncMessage::LoroSync`]. The variant stays on the wire so a peer
    /// still running the chunking build is decoded and rejected explicitly
    /// rather than as an unknown `type` tag — reaching `handle_message` fails
    /// the session loudly (same contract as `SnapshotOffer`).
    ///
    /// Position in the message sequence: identical to `LoroSync`
    /// (step 2 above) — it *is* a `LoroSync`, merely re-encoded for
    /// transport.
    LoroSyncChunked {
        header: LoroSyncChunkedHeader,
        is_last: bool,
        /// #2200 — the binary payload that follows is a single zstd frame
        /// wrapping the raw Loro bytes, so the receiver must decompress it
        /// (bounded by [`crate::sync_constants::MAX_LORO_SYNC_PAYLOAD_SIZE`])
        /// before reassembly. `header.size_bytes()` counts the *compressed*
        /// bytes on the wire (what `receive_binary_chunked` consumes);
        /// after decompression the receiver holds the raw payload.
        ///
        /// `#[serde(default)]` (→ `false`) for wire back-compat. Nothing sets
        /// it any more: the compressor retired with the WebSocket transport
        /// (#3464) and the `HeadExchange.wire_compression` capability that used
        /// to gate it was deleted in #3543, so every sender that can still
        /// reach this variant emits raw bytes (`compressed: false`), which is
        /// exactly what a #611-only peer always received.
        #[serde(default)]
        compressed: bool,
    },
    /// #2481 phase 1 — audit-only op-log replication batch. Streams op
    /// records the peer lacks (`seq > the peer's advertised per-device
    /// frontier`) as append-only, hash-verified **audit metadata**. The
    /// receiver hands each record to
    /// [`crate::sync_protocol::insert_replicated_op`], which blake3-verifies it and
    /// lands it with `is_replicated = 1` — it is **never** applied to state
    /// (state flows exclusively through Loro CRDT sync). `is_last: true`
    /// marks the final batch of the exchange.
    ///
    /// **Capability-gated (back-compat).** A peer only sends this after the
    /// other side advertised `HeadExchange { op_log_replication: true, .. }`;
    /// an older peer never advertises the capability and therefore never
    /// receives this variant, so it is never asked to deserialize an unknown
    /// `type` tag. Records ride the same size discipline as `LoroSync`:
    /// [`batch_ops_for_wire`](super::operations::batch_ops_for_wire) keeps each
    /// batch under [`crate::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES`] so
    /// it travels inline. A single op record can nonetheless exceed the inline
    /// bound (a sync-applied/imported op whose `payload` carries a large block
    /// `content`); since the iroh port (#3464) removed the chunked path such a
    /// lone-record batch simply ships as an oversized inline `OpLogBatch`,
    /// which QUIC's 256 MB frame cap accommodates. Only the hard cap
    /// [`crate::sync_constants::MAX_OP_LOG_BATCH_PAYLOAD_SIZE`] still drops one.
    ///
    /// **Rides the streaming phase (#2481 phase 1 wiring).** The streamer
    /// (responder) appends these to the tail of its `HeadExchange` reply,
    /// after the per-space `LoroSync` deltas — so they flow through the same
    /// [`SyncOrchestrator::next_message`](super::SyncOrchestrator::next_message)
    /// drain and the initiator ingests them in its normal
    /// [`handle_message`](super::SyncOrchestrator::handle_message) dispatch
    /// loop. This is what keeps the feature fully back-compat with no
    /// deadlock: an older responder simply never queues them, and the puller
    /// never blocks waiting for them (it processes whatever the streamer
    /// sends). The single-direction (responder → initiator per session)
    /// mirrors state sync; the reverse propagates when roles swap (#610). The
    /// final message across the whole stream — last `OpLogBatch`, or last
    /// `LoroSync` when there are none — carries `is_last: true`.
    OpLogBatch {
        records: Vec<OpTransfer>,
        is_last: bool,
    },
    /// Transport-level escape hatch for an [`OpLogBatch`] whose serialised
    /// `records` exceed [`crate::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES`]
    /// (#2593). Announces that the batch's `serde_json`-encoded records follow
    /// out-of-band as exactly `size_bytes` of chunked binary frames — the same
    /// machinery [`LoroSyncChunked`] uses — so a lone oversized op record (a
    /// sync-applied/imported op carrying a large block `content`) replicates its
    /// audit metadata instead of being dropped at the inline frame cap.
    ///
    /// **Nothing in this build produces it**, for the same reason as
    /// [`LoroSyncChunked`]: the iroh port (#3464) removed the chunking layer,
    /// and an oversized batch now ships inline under QUIC's 256 MB frame cap.
    /// The variant stays on the wire so a chunking-era peer is decoded and
    /// rejected explicitly; reaching `handle_message` fails the session loudly
    /// (same contract as `LoroSyncChunked`).
    ///
    /// **Capability-gated identically to [`OpLogBatch`].** It is only produced
    /// when a batch that the peer already opted into (via
    /// `op_log_replication: true`) is too large to ship inline, so no peer that
    /// lacks the `OpLogBatch` capability is ever sent this variant.
    OpLogBatchChunked {
        /// Exact byte count of the (optionally zstd-compressed) binary payload
        /// that follows this header on the wire — what
        /// `receive_binary_chunked` consumes. Bounded by
        /// [`crate::sync_constants::MAX_OP_LOG_BATCH_PAYLOAD_SIZE`] on receive
        /// before any frame is read.
        size_bytes: u64,
        is_last: bool,
        /// #2200-style wire compression. `#[serde(default)]` (→ `false`) for
        /// wire back-compat. Nothing sets it any more: the compressor retired
        /// with the WebSocket transport (#3464) and the
        /// `HeadExchange.wire_compression` capability that gated it was deleted
        /// in #3543. A `true` would mean the receiver must zstd-inflate the
        /// payload (re-bounded by `MAX_OP_LOG_BATCH_PAYLOAD_SIZE`) before
        /// deserialising the records.
        #[serde(default)]
        compressed: bool,
    },
    /// Responder side-exit: our op log was compacted past the
    /// initiator's heads, so a delta replay is impossible. Triggers
    /// the snapshot sub-flow in [`crate::sync_daemon::snapshot_transfer`].
    ResetRequired { reason: String },
    /// Snapshot sub-flow only (post-`ResetRequired`). Responder offers
    /// the latest local snapshot blob's size + integrity hash; initiator
    /// decides.
    ///
    /// `blob_blake3` (#706 item 2) is the hex blake3 of the *compressed*
    /// snapshot blob, mirroring [`FileOffer::blake3_hash`]. The transfer
    /// already rides authenticated mTLS and an atomic decode-or-rollback
    /// apply, so this guards the one remaining gap: responder-side disk
    /// corruption of the blob between read and send. The initiator
    /// re-hashes the received bytes and rejects on mismatch before the
    /// expensive decode/apply, so a corrupted blob fails fast and loud
    /// instead of surfacing as an opaque CBOR/zstd decode error.
    SnapshotOffer {
        size_bytes: u64,
        blob_blake3: String,
    },
    /// Initiator accepts the offered snapshot; responder follows up with
    /// `size_bytes` of binary frames.
    SnapshotAccept,
    /// Initiator declines (size cap, integrity check, etc.). Session ends.
    SnapshotReject,
    /// Per-side terminal: this side has finished sending and bookmarks
    /// `last_hash` as its new frontier-of-record in `peer_refs`.
    SyncComplete { last_hash: String },
    /// Any side may send at any time to abort the session.
    Error { message: String },
    /// File-transfer sub-flow only (post-`SyncComplete`).
    /// Request file transfer for missing attachments.
    FileRequest { attachment_ids: Vec<String> },
    /// File-transfer sub-flow only.
    /// Offer a file for transfer (metadata before binary data).
    ///
    /// `blake3_hash` is the blake3 hex digest of the offered file's bytes
    /// (always present; verified by the receiver on commit). It already IS the
    /// content hash, so the #1993 content-addressed dedup keys off it.
    ///
    /// `content_hash` (#1993 Phase 2) is an OPTIONAL, additive field carrying
    /// the same content-addressed hash explicitly. It is `#[serde(default)]`
    /// so the wire change is strictly back-compatible:
    /// * an OLD daemon serializes no field → a NEW receiver deserializes
    ///   `None` and falls back to `blake3_hash` / full binary transfer;
    /// * an OLD daemon receiving a NEW message ignores the unknown field.
    ///
    /// A NEW sender populates it (= `blake3_hash`) so future receivers can
    /// reason about content-addressing without depending on the transfer
    /// hash's role. The actual skip-transfer decision (#1993) is taken
    /// receiver-side in `find_missing_attachments` (a file whose hash already
    /// has a local blob is NOT requested, so it is never offered/streamed).
    FileOffer {
        attachment_id: String,
        size_bytes: u64,
        blake3_hash: String,
        #[serde(default)]
        content_hash: Option<String>,
    },
    /// File-transfer sub-flow only.
    /// Receiver confirms hash + write succeeded for `attachment_id`.
    FileReceived { attachment_id: String },
    /// File-transfer sub-flow only.
    /// "No more files from this side" sentinel — concludes one half of
    /// the bidirectional file-transfer phase.
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
    /// #1071: deduped set of owning *page* ids (page-root block ids) touched
    /// by ops applied during this session, accumulated across the session's
    /// inbound `LoroSync` messages. Threaded out via
    /// [`crate::sync_events::SyncEvent::Complete`] so the frontend reloads
    /// ONLY the affected page stores instead of every mounted BlockTree.
    /// Empty when nothing changed (or nothing resolved) — the frontend then
    /// falls back to its full-reload behaviour.
    pub changed_page_ids: Vec<String>,
    /// #4305: how many blocks this session's inbound imports actually changed
    /// or hard-purged, accumulated across the session's `LoroSync` messages.
    ///
    /// This is the session's only **honest** measure of "did anything happen".
    /// [`ops_received`](Self::ops_received) and [`ops_sent`](Self::ops_sent)
    /// are protocol-message counts — one per registered space, whether or not
    /// that space's delta was empty — so on a converged idle pair they are a
    /// constant equal to the number of spaces, forever. A user-facing surface
    /// that says "N changes" must read *this* field; `ops_*` may only be
    /// labelled as the sync messages they are.
    ///
    /// `0` therefore means the strongest thing the sync layer can say: the
    /// session ran to completion and moved no content. Callers use it to stay
    /// silent.
    pub changed_blocks: usize,
}

// The Loro-side push/apply path (`sync_protocol::loro_sync`) does not
// return per-op counts; the engine import is opaque from the
// orchestrator's view.
