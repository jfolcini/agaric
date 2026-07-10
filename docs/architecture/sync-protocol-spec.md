<!-- markdownlint-disable MD060 -->
# Sync Protocol Wire-Format Spec

Low-level companion to [`sync-and-network.md`](sync-and-network.md). Where
that document covers the high-level design (discovery, pairing, transport,
daemon, backoff), this one is the source-of-truth for the **wire format**:
every message variant and its serialized shape, the ordered message
exchanges (handshake, reconnect, snapshot fallback), the Loro version-vector
exchange, the attachment-transfer sub-protocol, and the per-session state
machine.

This is an extraction of the implementation as it stands; it does not
propose new behavior. The canonical source is the code, primarily:

- `src-tauri/src/sync_protocol/types.rs` — the `SyncMessage` envelope and
  `SyncState`.
- `src-tauri/src/sync_protocol/loro_sync_types.rs` — the `LoroSyncMessage`
  payload and `LORO_SYNC_PROTOCOL_VERSION`.
- `src-tauri/src/sync_protocol/session_state_machine.rs` — the per-session
  `SyncOrchestrator` state machine.
- `src-tauri/src/sync_protocol/loro_sync.rs` — `prepare_outgoing` /
  `apply_remote` and the version-vector reachability check.
- `src-tauri/src/sync_daemon/session_supervisor.rs` — the initiator-side session
  driver (`run_sync_session`).
- `src-tauri/src/sync_daemon/server.rs` — the responder-side session driver
  (`handle_incoming_sync`).
- `src-tauri/src/sync_daemon/snapshot_transfer.rs` — the snapshot catch-up
  sub-flow.
- `src-tauri/src/sync_files.rs` — the attachment-transfer sub-protocol.
- `src-tauri/src/sync_constants.rs` and `src-tauri/src/sync_net/connection.rs`
  — shared transport constants.

## Envelope encoding

Two distinct serde-tagged enums travel on the wire:

- The session envelope `SyncMessage` is serialized as JSON over WebSocket
  text frames (`SyncConnection::send_json` / `recv_json`). Its serde
  attribute is `#[serde(tag = "type")]`, so each variant is a JSON object
  with a `"type"` discriminant plus the variant's fields, e.g.
  `{"type":"HeadExchange","heads":[…]}`.
- The streaming payload `LoroSyncMessage` is nested inside
  `SyncMessage::LoroSync` and uses
  `#[serde(tag = "kind", rename_all = "snake_case")]`, producing
  `{"kind":"snapshot",…}` / `{"kind":"update",…}`.

Bulk binary payloads (snapshot blobs, attachment file bytes, and
over-threshold `LoroSync` payloads — see
[`SyncMessage::LoroSyncChunked`](#syncmessagelorosyncchunked)) are **not**
JSON. They travel as WebSocket binary frames after a JSON control message,
each frame at most `BINARY_FRAME_CHUNK_SIZE` (5 MB) — see
[Binary-frame transfer](#binary-frame-transfer).

### Transport limits

Defined in `src-tauri/src/sync_constants.rs` and (per-connection) in
`src-tauri/src/sync_net/connection.rs`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `SyncConnection::MAX_MSG_SIZE` | 10,000,000 bytes | Hard cap on any single WebSocket frame (text or binary). |
| `BINARY_FRAME_CHUNK_SIZE` | 5,000,000 bytes | Chunk unit for snapshot + attachment + chunked-LoroSync binary frames; kept under `MAX_MSG_SIZE` for framing headroom. |
| `LORO_INLINE_MAX_BYTES` | 2,400,000 bytes | Threshold above which a `LoroSync` payload's `bytes` leave the inline JSON envelope and ride chunked binary frames instead (`LoroSyncChunked`, #611). Sized so the worst-case JSON inflation of an inline payload (a `Vec<u8>` serialises as a number array, up to 4 chars/byte) stays under `MAX_MSG_SIZE`. |
| `HANDSHAKE_TIMEOUT` | 120 s | Per-`handle_message` budget on both session loops. |
| `SyncConnection::RECV_TIMEOUT` | (see `connection.rs`) | Overall idle receive guard, kept strictly larger than `HANDSHAKE_TIMEOUT`. |

## Message types

All variants below are arms of the `SyncMessage` enum in
`src-tauri/src/sync_protocol/types.rs`, unless noted as belonging to
`LoroSyncMessage` (`src-tauri/src/sync_protocol/loro_sync_types.rs`).

### `SyncMessage::HeadExchange`

```text
HeadExchange { heads: Vec<DeviceHead>,
               loro_vvs: Vec<SpaceVersionVector>,   // #[serde(default)]
               engine_format_version: u32 }          // #[serde(default)]
```

The first message of every session, sent by the **initiator only**, exactly
once. The responder does **not** reply with its own `HeadExchange` — it
replies with the streaming phase directly (see
[Handshake sequence](#handshake-sequence)). `DeviceHead` (a `struct` in
`types.rs`) is the per-device frontier:

```text
DeviceHead { device_id: String, seq: i64, hash: String }
```

`heads` is the latest `(device_id, seq, hash)` tuple per device known to the
sender's op log, computed by `operations::get_local_heads`.

`loro_vvs` carries the initiator's per-space Loro version vectors so the
responder can stream an incremental `LoroSyncMessage::Update` (the delta
since the initiator's vv) instead of a full snapshot (#1230). It is
`#[serde(default)]` for wire back-compat: an older initiator omits it and
the responder falls back to a full `Snapshot` per space.

`engine_format_version` advertises the sender's
`loro::engine::ENGINE_FORMAT_VERSION` so the responder can reject an
incompatible peer up front, before any raw-byte Loro merge (#2130). Also
`#[serde(default)]`: a legacy peer deserializes as `0`, which falls through
to the import-time format guards.

**Frontier semantics — Loro VVs are the sole state-causality signal
(#2502).** The op-log `heads` and the Loro `loro_vvs` answer different
questions. Since #490-M1 the op log is strictly device-local, and per
issue #2481 it also carries *foreign* device frontiers as append-only
audit metadata — so `heads` is an **audit/replication cursor** ("which of your op
records do I already hold"), never a state-causality signal. All
state-reset decisions are made from Loro VVs:

- The receiver-side `from_vv`-reachability gate in `apply_remote` catches an
  unbridgeable incremental-`Update` gap (the peer's declared floor is ahead
  of the receiver's `oplog_vv()`) — see
  [`SnapshotFallbackRequested`](#snapshotfallbackrequested).
- The streamer-side, handshake-time `operations::check_reset_required`
  detects **own-lineage loss**: it compares the peer's advertised `loro_vvs`
  against the local engine's per-space VVs for **our own current-epoch Loro
  `PeerID`** only. A peer claiming more of *our own* authored ops than our
  engine can produce means we lost our own tail (compaction/history loss,
  older-backup restore) → `ResetRequired`. The peer being ahead for *other*
  peer ids is a normal pull, never a reset. Restricting to our own peer id
  also prevents a post-reset device (fresh-epoch `PeerID` at counter 0) from
  looping.

Both funnel into the single `ResetRequired` → snapshot-catch-up recovery
path. #2502 retired the previous op-log-`(device_id, seq)` reset lookup
entirely (it conflated the audit cursor with state causality and produced
the #602 forever-backoff bug); `heads` retains its two surviving,
non-decision jobs — remote-device identification and the defensive
`snapshot_covers_remote_heads` covering check in the snapshot sub-flow.

**Persisted per-peer version vectors (`peer_refs.loro_vv_bytes`, #2502).**
On session completion the streamer persists the peer's advertised
per-space `loro_vvs` (a serialized `Vec<SpaceVersionVector>`) to
`peer_refs.loro_vv_bytes` (migration 0100, a nullable BLOB — never on the
wire). On the next session, when the initiator advertises *no* vv for a
space (an older peer, or the every-tick churn case), the streamer falls
back to this persisted frontier as the incremental-`Update` export floor
instead of shipping a full `Snapshot` — removing the last excuse for the
full-snapshot churn (#610). A stale/ahead persisted floor is safe: the
receiver's reachability gate catches an unbridgeable delta and falls back
to a snapshot.

**Cross-version compatibility (old peer ↔ new peer).** Nothing on the wire
changed — `loro_vvs` was already `#[serde(default)]` and the persisted VV
is local-only. An older peer that advertises no `loro_vvs` yields an empty
peer-vv list, so the own-lineage reset check trivially returns "no reset"
and the streamer proceeds normally (using its persisted floor if it has
one); genuine state-divergence with that peer is still caught by the
receiver-side reachability gate. New peer ↔ new peer additionally gets the
handshake-time own-lineage check and the churn-cutting export floor.

**Divergence within one device: op_log ahead of engine (#2475).** The
dangerous divergence isn't heads-vs-VVs in flight between two devices —
both frontiers on a healthy device already agree, because both are
derived from the same locally-applied ops. It's **op_log vs. engine on
one device**: the `sql_only` fallback path
(`SqlOnlyFallbackReason::SpaceUnresolved`,
`src-tauri/src/materializer/handlers/sql_only_fallback.rs:75`) writes an
op's SQL projection without routing it through the per-space `LoroEngine`
when the op's space hasn't resolved yet. A device that has taken this
path has an op_log `seq` (and thus an advertised `heads` entry) ahead of
what its own Loro engine — and therefore its own `loro_vvs` — can
produce. That device cannot satisfy a peer's incremental-update request
for the ops it claims to have: the peer's `from_vv`-reachability check
sees a floor the device's own export can't back. The single-recovery-path
design in this spec absorbs this into the same `ResetRequired` /
`SnapshotFallbackRequested` machinery used for ordinary staleness (see
[Snapshot-fallback flow](#snapshot-fallback-flow) and
["Fate of the initiator's local state"](#fate-of-the-initiators-local-state-2474)
above) — op_log-ahead-of-engine resolves via reset, the same as any other
unbridgeable gap, not as a silently-diverging third state.

### `SyncMessage::LoroSync`

```text
LoroSync { msg: LoroSyncMessage, is_last: bool }
```

The sole streaming-phase payload. Carries one `LoroSyncMessage` per
`SpaceId`, sent zero-or-more times by the **responder only** (the streamer;
see the pull-model note under [Handshake sequence](#handshake-sequence)).
`is_last: true` marks the final per-space message of a batch and tells the
receiver to transition to completion.

`LoroSyncMessage` (in `loro_sync_types.rs`) has two variants:

```text
Snapshot { protocol_version: u8, space_id: SpaceId, bytes: Vec<u8> }
Update   { protocol_version: u8, space_id: SpaceId,
           from_vv: LoroVersionVector, bytes: Vec<u8> }
```

- `protocol_version` is locked to `LORO_SYNC_PROTOCOL_VERSION` (currently
  `1`) at send time. `apply_remote` rejects any other value with a
  validation error — a version mismatch is a non-retryable failure.
- `Snapshot.bytes` is the output of `LoroDoc::export(ExportMode::Snapshot)`;
  the receiver imports it unconditionally (used for initial sync / no prior
  state for `space_id`).
- `Update.bytes` is the output of
  `LoroDoc::export(ExportMode::updates(&peer_vv))`; the receiver imports it
  against existing engine state.
- `from_vv` is the encoded peer version vector used as the `from` floor of
  the update (see [Version vectors](#version-vector-format-and-exchange)).
- `LoroVersionVector` is a type alias for `Vec<u8>` — opaque Loro-encoded
  version-vector bytes, not parsed by the wire layer.

### `SyncMessage::LoroSyncChunked`

```text
LoroSyncChunked { header: LoroSyncChunkedHeader, is_last: bool }

LoroSyncChunkedHeader (serde tag "kind", snake_case):
  Snapshot { protocol_version: u8, space_id: SpaceId, size_bytes: u64 }
  Update   { protocol_version: u8, space_id: SpaceId,
             from_vv: LoroVersionVector, size_bytes: u64 }
```

The chunked-binary transport encoding of `LoroSync` (#611). An inline
`LoroSyncMessage.bytes` serialises as a JSON number array (~3.6× inflation,
worst case 4 chars/byte), and a single text frame is capped at
`MAX_MSG_SIZE` (10 MB) — so a growing space payload would eventually exceed
the cap and permanently break sync. Payloads larger than
`LORO_INLINE_MAX_BYTES` (2,400,000 bytes) therefore travel out-of-band: the
sender emits this JSON envelope carrying a header-only mirror of the
`LoroSyncMessage` (`bytes` replaced by `size_bytes`; `from_vv` stays inline
— version vectors are tiny), followed by exactly `size_bytes` of raw Loro
bytes in chunked binary frames — the same machinery as the snapshot-blob
and attachment-file sub-flows.

**Never reaches the protocol orchestrator.** The wire layer
(`sync_daemon::wire::send_sync_message` / `recv_sync_message`) splits an
over-threshold `LoroSync` into header + binary frames on send and
reassembles them back into a plain `SyncMessage::LoroSync` on receive; the
state machine only ever sees `LoroSync`. A `LoroSyncChunked` arriving at
`handle_message` indicates a transport-dispatch regression and fails the
session loudly (same contract as `SnapshotOffer`). `protocol_version` is
validated by `apply_remote` after reassembly — there is no separate
header-level check, so version-mismatch handling stays in one place.

**Compatibility.** A pre-#611 peer does not know this envelope and fails
the session with a deserialize error on receiving one. That is strictly no
worse than the status quo: the chunked path is only taken for payloads
whose inline JSON would have blown the old peer's 10 MB receive cap anyway;
every payload an old peer could successfully receive still rides the
unchanged inline shape.

### `SyncMessage::SyncComplete`

```text
SyncComplete { last_hash: String }
```

Terminal of the delta phase, sent once by the **puller** (the initiator)
after it has applied the responder's final `LoroSync { is_last: true }` —
or directly by a responder with zero registered spaces (the empty-stream
short-circuit). `last_hash` is the sender's new frontier-of-record; the
puller records `synced_at` + the bookmark in `peer_refs` (#610 — the
streamer deliberately does *not*, so the reverse-direction session stays
due).

### `SyncMessage::ResetRequired`

```text
ResetRequired { reason: String }
```

Terminal side-exit in place of `SyncComplete`. Issued when a delta replay is
impossible — either the responder's op log was compacted past the
initiator's advertised heads (`operations::check_reset_required`), or
`apply_remote` returns `SnapshotFallbackRequested` (see
[`SnapshotFallbackRequested`](#snapshotfallbackrequested)). Triggers the
snapshot sub-flow; the per-session state machine accepts no further delta
messages after this point.

### Snapshot sub-flow variants

Driven by `src-tauri/src/sync_daemon/snapshot_transfer.rs`, **not** the
per-session orchestrator (which explicitly errors if they reach
`handle_message`):

```text
SnapshotOffer { size_bytes: u64 }   // responder → initiator
SnapshotAccept                       // initiator → responder
SnapshotReject                       // initiator → responder
```

`size_bytes` is the length of the compressed snapshot blob; the initiator
caps it at `MAX_SNAPSHOT_SIZE` (256 MB).

### Attachment sub-flow variants

Driven by `src-tauri/src/sync_files.rs`, also outside the per-session
orchestrator:

```text
FileRequest { attachment_ids: Vec<String> }
FileOffer   { attachment_id: String, size_bytes: u64, blake3_hash: String }
FileReceived { attachment_id: String }
FileTransferComplete
```

See [Attachment-transfer sub-protocol](#attachment-transfer-sub-protocol).

### `SyncMessage::Error`

```text
Error { message: String }
```

Any side may send at any point to abort. The receiver transitions to
`SyncState::Failed`; the connection closes and the daemon retries on the
next scheduled tick. It is also used by the responder's snapshot covering
check to fail loudly on a stale snapshot (see the path in
`snapshot_transfer.rs`).

## State machine

The per-session state machine is `SyncOrchestrator`
(`src-tauri/src/sync_protocol/session_state_machine.rs`); its phase enum is
`SyncState` (`src-tauri/src/sync_protocol/types.rs`).

`SyncState` variants: `Idle`, `ExchangingHeads`, `StreamingOps`,
`ApplyingOps`, `Merging`, `TransferringFiles`, `Complete`, `ResetRequired`,
`Failed(String)`. (Some names — `Merging`, `TransferringFiles` — predate the
Loro-CRDT streaming model and survive for observers; the active delta path
moves `ExchangingHeads → StreamingOps → ApplyingOps → Complete`.)

```text
Idle
  │ start() emits HeadExchange
  ▼
ExchangingHeads
  │ on remote HeadExchange:
  │   ├─ check_reset_required == true ─────────────► ResetRequired
  │   ├─ no registered spaces (empty stream) ──────► Complete (SyncComplete)
  │   └─ else emit first LoroSync (+ queue rest)
  ▼
StreamingOps
  │ each inbound LoroSync → apply_remote:
  │   ├─ ApplyOutcome::Imported ─────► ApplyingOps (transient), back to StreamingOps
  │   └─ ApplyOutcome::SnapshotFallbackRequested ──► ResetRequired
  │ inbound LoroSync { is_last: true } ─────────────► Complete (emit SyncComplete)
  ▼
ApplyingOps  (per-message engine-import phase; SQL projection + cache rebuild enqueue)
  ▼
Complete   (terminal: peer_refs bookkeeping committed)

Side-exits from any non-terminal state:
  • inbound Error{message} ──────────► Failed(message)
  • out-of-order message  ──────────► Failed(reason)
  • ResetRequired (own or peer) ─────► ResetRequired (hand off to snapshot sub-flow)
```

Terminal classification (orchestrator predicates):

- `is_succeeded()` — `true` only for `Complete`.
- `is_terminal()` — `true` for `Complete`, `Failed(_)`, or `ResetRequired`.

State validation lives in the `match (&self.state, &msg)` block at the top
of `SyncOrchestrator::handle_message`. Notable rules:

- `Complete` / `Failed(_)` reject every message.
- `Error` and `ResetRequired` are accepted in any state (protocol signals).
- `HeadExchange` is valid only in `Idle` / `ExchangingHeads`; a second one
  mid-session transitions to `Failed`.
- `LoroSync` and `SyncComplete` are valid in `StreamingOps` and also in
  `ExchangingHeads` (the latter absorbs the empty-stream short-circuit where
  a peer with no registered spaces replies `SyncComplete` directly).
- The `SnapshotOffer` / `SnapshotAccept` / `SnapshotReject` and the four
  file-transfer variants pass state validation but are rejected by the
  dispatch body — they are handled by the daemon-layer sub-flows, never the
  orchestrator. Implementation detail in
  `src-tauri/src/sync_protocol/session_state_machine.rs`.

The surrounding daemon (`src-tauri/src/sync_daemon`) owns everything outside
the per-session machine: discovery, scheduling, per-peer locking, connection
setup, TOFU cert pinning, dormant/active mode, and the post-`ResetRequired`
and post-`Complete` sub-flows.

## Handshake sequence

The initiator side is driven by `run_sync_session`
(`sync_daemon/session_supervisor.rs`); the responder side by `handle_incoming_sync`
(`sync_daemon/server.rs`). Both share the same exchange-until-terminal loop
with a `HANDSHAKE_TIMEOUT` per `handle_message` call.

### Normal (delta) flow

A session is a **pull**: data flows responder → initiator only (#610). The
initiator advertises its frontier; the responder streams the delta; the
initiator applies and confirms. Bidirectional convergence comes from the
*reverse* session — each daemon initiates its own pull on its own schedule —
not from bidirectional streaming within one session.

```text
Initiator (puller)                         Responder (streamer)
   │                                           │
   │ start() → HeadExchange                    │
   │   { heads, loro_vvs, engine_format_v }    │
   ├──────────────────────────────────────────►
   │            (responder identifies peer from heads, validates
   │             against TLS cert CN, gates engine_format_version,
   │             runs check_reset_required on OWN-device heads)
   │                                           │
   │      LoroSync { msg, is_last:false } ...  │  one per SpaceId:
   ◄──────────────────────────────────────────┤  incremental Update against
   │      LoroSync { msg, is_last:true }       │  the initiator's advertised
   ◄──────────────────────────────────────────┤  vv; full Snapshot for a
   │ (applies each via apply_remote)           │  space it didn't advertise
   │                                           │
   │ SyncComplete { last_hash }                │  puller records synced_at +
   ├──────────────────────────────────────────►  peer_refs bookmark; the
   │              [ file-transfer phase ]      │  streamer does not (#610)
```

Mechanics worth pinning:

- The initiator sends the session's only `HeadExchange`; the responder
  derives the peer identity from the advertised heads and rejects the
  session with `Error` if the `device_id` does not match the TLS
  certificate CN it is connected to (the B-34 check in `server.rs`).
- On receiving the `HeadExchange`, the responder calls
  `head_exchange_outgoing_loro`, which builds one `LoroSync` per registered
  space — an incremental `Update` against the initiator's advertised
  version vector for that space, or a full `Snapshot` for a space the
  initiator didn't advertise (#1230) — and queues all but the first into
  `pending_loro_messages`. The driver loop drains the queue via
  `next_message()` after each `handle_message`. Over-threshold payloads are
  re-encoded as `LoroSyncChunked` by the wire layer transparently.
- Empty-stream short-circuit: a responder with zero registered spaces
  replies `SyncComplete` directly from `ExchangingHeads` rather than
  emitting a zero-byte `LoroSync`; the initiator (which never streamed)
  records the pull.
- `is_last: true` on the final per-space `LoroSync` drives the initiator to
  `Complete` and prompts its `SyncComplete`, which carries the local head
  hash and is recorded into `peer_refs` inside a single `BEGIN IMMEDIATE`
  transaction (`upsert_peer_ref_in_tx` + `complete_sync_in_tx`).
- `synced_at` bookkeeping is puller-only (#610): a responder that streamed
  must not advance `synced_at` for the initiator, or it would starve the
  reverse-direction session's scheduling.

### Reconnect flow

There is no separate reconnect message. A reconnect is simply a new session
that reuses the previously pinned certificate and the `peer_refs` bookmark:

- The daemon (`daemon_loop`) reconnects on a discovery event, a debounced
  change trigger, or a periodic resync tick. Connection setup uses the
  pinned `peer_refs.cert_hash` (TOFU) and, if mDNS cannot resolve the peer,
  the manual `peer_refs.last_address`.
- The session itself is identical to the normal flow above: a fresh
  `HeadExchange` advertises the current frontier, and the delta is whatever
  has accumulated since the last `SyncComplete` bookmark. The protocol is
  stateless between sessions — the `last_hash` / per-space engine state in
  the DB is the only carried-over context.

### Snapshot-fallback flow

As of **#2503** this catch-up is a **Loro-snapshot merge**, not a CBOR
wipe-and-replace. When the responder cannot satisfy the initiator's heads with
a delta replay, the session exits the delta loop in `ResetRequired` and hands
off to `snapshot_transfer.rs`. The responder ships its per-space `LoroDoc`
snapshots (the engine's truth) and the initiator *merges* them into its own
engine, then reprojects SQL from the merged state. The initiator's unsynced
local content **survives** — the exact inversion of the pre-#2503 CBOR-wipe
data-loss contract (#2474).

The initiator runs `try_receive_snapshot_catchup` (which dispatches on the
first message); the responder runs `try_offer_loro_snapshot_catchup`.

```text
Initiator                                  Responder
   │ HeadExchange { heads, loro_vvs }          │
   ├──────────────────────────────────────────►
   │                                           │  check_reset_required == true
   │      ResetRequired { reason }             │  (own-lineage VV loss, #2502)
   ◄──────────────────────────────────────────┤
   │ (delta loop breaks; both enter sub-flow)  │
   │                                           │  for each registered space:
   │                                           │    prepare_outgoing(None) →
   │                                           │    LoroSyncMessage::Snapshot
   │   LoroSync { Snapshot, is_last } × spaces │  send_sync_message (chunked
   ◄──────────────────────────────────────────┤   binary path #611 for large)
   │ apply_remote() per space:                 │
   │   engine.import(snapshot)  ← MERGE        │
   │   reproject changed blocks → SQL          │
   │ (unsynced local content preserved)        │
   │ advance peer_refs.last_hash (a PULL;      │
   │   NO reset_count bump, NO engine wipe)    │
```

Notes:

- The responder always sends **full snapshots** (`prepare_outgoing` with
  `peer_vv = None`): `ResetRequired` means the initiator's VV is unreachable,
  so an incremental `Update` could not be applied — a full snapshot merges
  cleanly against any receiver state.
- No covering check / `256 MB` cap / `SnapshotReject` is needed: a Loro merge
  is monotonic (it never rolls the receiver back), so the CBOR-era guards are
  gone from the production path.
- If the responder has no exportable space state, it sends a terminal
  `SyncComplete` and the session closes with no catch-up (a non-progress
  event; the next scheduled sync retries).
- Large space snapshots ride the chunked-binary transport
  (`sync_daemon::wire::send_sync_message`, #611), so there is no per-message
  size cap on the Loro path.
- No `op_log` wipe, no engine registry reload, no peer-epoch bump: the merge
  is applied against the live engines in place.

#### Wire compatibility (send-new / accept-old)

`SnapshotOffer` / `SnapshotAccept` / `SnapshotReject` are **retained** as wire
variants for one-sided back-compat, but production **never sends** a
`SnapshotOffer`:

- **New responder → any initiator**: always streams `LoroSync { Snapshot }`.
  A pre-#2503 initiator expecting a `SnapshotOffer` fails the catch-up and
  retries (**forward-incompatible**, documented deprecation — resolves once
  both devices upgrade).
- **Old responder → new initiator**: an old peer still offers a CBOR
  `SnapshotOffer`; `try_receive_snapshot_catchup` peeks the first message and
  routes a `SnapshotOffer` into the legacy `apply_snapshot` wipe-and-replace
  path (**accept-old**), preserving convergence during a rolling upgrade.

The legacy CBOR `apply_snapshot` RESET (and its #2474 data-loss contract) thus
survives only on the accept-old receive branch and as the compaction artifact;
it is no longer reachable from the production *offer* path. The offer-side CBOR
helpers (`try_offer_snapshot_catchup`, the `snapshot_covers_remote_heads`
covering check) are retained `#[cfg(test)]` only, to simulate a legacy peer.

#### Fate of the initiator's local state (#2474)

The loss below applies **only to the legacy CBOR accept-old branch** (#2503).
On the Loro-merge path the initiator's unsynced local content is preserved by
Loro's merge semantics and its history is re-pulled per #2481 phase 3.

Under the legacy CBOR `apply_snapshot` RESET, it wipes the initiator's
`op_log` (and Loro sidecar state) wholesale, so on the caught-up device
**content converges to the snapshot but the local paper trail — page history,
activity feed, undo/redo, per-op origin/`is_undo` attribution — is destroyed**
(see [crdt-and-recovery.md](crdt-and-recovery.md) § "What a catch-up RESET
costs the caught-up device" for the full contract and the pinning tests).
The at-risk *content* is any op the initiator authored locally that it
had not yet pushed to some peer before this reset. A session is a
**pull** (data flows responder -> initiator only, #610 above — see the
explicit "only the puller receives LoroSync, the streamer never reaches
this arm" comment on the `SyncMessage::LoroSync` handler in
`session_state_machine.rs`), so **the initiator never pushes anything to
the responder within the failing session itself, on either trigger**:

- **Heads-triggered** (`check_reset_required == true` in the state
  machine): the responder's own-device check fails, so it replies
  `ResetRequired` **instead of** reaching its outgoing head-exchange —
  no `LoroSync` is ever queued or sent. (Post-#490-M1 device-local
  op_logs make this trigger near-vestigial — a peer rarely advertises
  heads about *your* device; see #2475.)
- **VV-triggered** (`ApplyOutcome::SnapshotFallbackRequested`): fires
  only on the **initiator**, while it is importing a responder `Update`
  (the responder itself never reaches the `LoroSync`-handling arm — it
  only ever sends). The responder may well have streamed several other
  spaces successfully before the failing one aborts the loop, but that
  traffic moves responder -> initiator, same as the normal flow — it
  does not push anything from the initiator toward the responder. Those
  interim imports are moot for the initiator's own unsynced ops, and
  are themselves wiped moments later by the RESET's unconditional
  `loro_doc_state` DELETE (pinned by
  `apply_snapshot_wipes_loro_doc_state_and_engines_reload_empty_2474`)
  — the snapshot the initiator goes on to apply re-supplies the same
  responder content anyway.

Neither trigger is more "lossy" than the other for the initiator's own
unsynced local ops: they have no peer copy in either case, and are gone
the moment `apply_snapshot` wipes `op_log`. Surviving a reset requires
an unrelated, separately-timed **reverse-direction session** (the
initiator acting as responder for this peer, on its own schedule, per
"Bidirectional convergence comes from the *reverse* session" above) to
have already pushed those ops out beforehand — an orthogonal,
unguaranteed timing dependency, not a property of which trigger fired.

The device-local reset (history/undo/attribution loss + engine re-key)
is **unconditional** — identical regardless of trigger — because it is a
property of `apply_snapshot` itself, pinned by
`apply_snapshot_resets_undo_and_history_surface_2474` and siblings in
`src-tauri/src/snapshot/tests.rs`.

## Version-vector format and exchange

The version vector is Loro-internal and opaque to the wire layer. The type
alias `LoroVersionVector = Vec<u8>` (`loro_sync_types.rs`) carries the output
of Loro's `VersionVector::encode()`; only the engine decodes it.

How peers compare and request missing ops:

- **Sender** (`loro_sync::prepare_outgoing`): with `peer_vv == None` it
  exports a full `Snapshot`; with `peer_vv == Some(vv)` it exports an
  `Update` covering ops since `vv` (`export_update_since`) and stamps
  `from_vv = vv` onto the message. Incremental sync is wired (PR #1230):
  the orchestrator drives `peer_vv` per space from the initiator's
  advertised version vectors. The initiator collects its per-space VVs
  (`collect_local_loro_vvs`) and ships them in `HeadExchange.loro_vvs`; the
  responder looks up each space's advertised vv and passes
  `peer_vv = Some(vv)` to emit an incremental `Update`. For a space the
  initiator did not advertise, the responder falls back to the peer's
  **persisted** frontier from `peer_refs.loro_vv_bytes` (the vv it advertised
  at the last completed session, #2502/#610) as the export floor, and only
  when neither is available does it ship a full `Snapshot` (`peer_vv = None`)
  (`src-tauri/src/sync_protocol/session_state_machine.rs`, `loro_sync.rs`).
- **Receiver** (`loro_sync::apply_remote`): for an `Update`, before any
  engine import it reads the local engine's current version vector
  (`version_vector()`) and runs `classify_from_vv_reachability` against the
  message's `from_vv`. "Reachable" means: for every `(peer_id, counter)`
  entry in `from_vv` (counter `0` entries skipped), the local vv has an entry
  for the same `peer_id` with a counter `>=` the peer's. A `Snapshot` skips
  this check and imports unconditionally.
- If any entry is missing or the local counter lags, the update cannot be
  applied without losing ops; the receiver short-circuits with
  `ApplyOutcome::SnapshotFallbackRequested` (next section) rather than let
  the engine surface an opaque decode error.

`LORO_SYNC_PROTOCOL_VERSION` (`u8`, currently `1`) versions the envelope
carrying these bytes, distinct from Loro's own binary format version on the
payload. Bumping it is a deliberate wire-format break; a `#[cfg(test)]` test
in `loro_sync_types.rs` pins the constant and the serde round-trip shape.

## `SnapshotFallbackRequested`

`SnapshotFallbackRequested` is a variant of `ApplyOutcome`
(`src-tauri/src/sync_protocol/loro_sync.rs`), the return type of
`apply_remote`:

```text
ApplyOutcome::Imported { space_id: SpaceId, changed_blocks: Vec<BlockId> }
ApplyOutcome::SnapshotFallbackRequested { space_id: SpaceId, reason: String }
```

**Trigger.** It is returned only for a `LoroSyncMessage::Update` whose
`from_vv` fails the reachability check above — i.e. the peer's declared
floor is ahead of (or concurrent with) the receiver's `oplog_vv()`. The
engine import is **not** attempted; no SQL transaction is opened, so the miss
is side-effect-free.

**Handling.** The orchestrator's `LoroSync` dispatch matches this outcome and
translates it into a `SyncMessage::ResetRequired { reason }` reply (with the
space id folded into `reason`), transitioning the session to
`SyncState::ResetRequired`. From there it is identical to the
log-compacted-side-exit path: the daemon layer drives the snapshot catch-up
sub-flow described in [Snapshot-fallback flow](#snapshot-fallback-flow). This
keeps the unreachable-delta case and the compacted-log case on a single
recovery path.

## Attachment-transfer sub-protocol

After the delta phase reaches `Complete`, the session runs a bidirectional
attachment transfer (`src-tauri/src/sync_files.rs`). It is driven directly
off the wire by `run_file_transfer_initiator` / `run_file_transfer_responder`
and never enters the per-session orchestrator. File-transfer failure is
non-fatal — it is logged and does not abort the (already-successful) sync.

The exchange runs in two halves so each side can pull missing attachments. In
each half the puller sends `FileRequest`, the pusher answers with a
`FileOffer` + binary frames + a `FileReceived` ACK per file, and ends with
`FileTransferComplete`:

```text
Side A (puller)                            Side B (pusher)
   │ FileRequest { attachment_ids }           │  (ids A is missing)
   ├──────────────────────────────────────────►
   │      FileOffer { attachment_id,           │  per requested file
   │                  size_bytes, blake3_hash }│
   ◄──────────────────────────────────────────┤
   │      <binary frames × ⌈size/5 MB⌉>        │  send_binary_chunked, streamed
   ◄──────────────────────────────────────────┤  off disk; hash verified on recv
   │ FileReceived { attachment_id }            │  ACK only after write + hash OK
   ├──────────────────────────────────────────►
   │                 ...                       │
   │      FileTransferComplete                 │  sentinel: no more files
   ◄──────────────────────────────────────────┤
   │ (roles swap: B pulls, A pushes)           │
```

Mechanics:

- `FileOffer` carries `size_bytes` and the `blake3_hash` ahead of the bytes.
  The receiver cross-checks `size_bytes` against its own attachments DB row
  and rejects (without ACK) on disagreement, and verifies the running
  `blake3` hash as it streams chunks to a `<final>.tmp-<random>` file before
  the atomic rename.
- Binary data uses the same `BINARY_FRAME_CHUNK_SIZE` (5 MB) frame unit as
  the snapshot transfer; a zero-length file is sent as a single empty frame
  so the receiver's frame accounting terminates.
- `FileReceived` is sent only after the file has been written and its hash
  verified.
- `FileTransferComplete` concludes one half; a side with nothing to offer
  still sends it (and an empty `FileRequest` means "I need nothing").
- The `cancel` flag is checked between files so a large transfer can be
  aborted mid-stream.

### Binary-frame transfer

Both the snapshot blob and attachment files use the shared chunked-binary
path on `SyncConnection` (`src-tauri/src/sync_net/connection.rs`):
`send_binary_chunked` splits the payload into frames of at most
`BINARY_FRAME_CHUNK_SIZE` and the receiver reassembles by frame accounting
against the advertised `size_bytes`. Frames are raw WebSocket binary frames
(no JSON), each bounded by `MAX_MSG_SIZE`. A zero-byte payload is always
delivered as one empty frame so the receiver loop terminates cleanly.

## See also

- [`sync-and-network.md`](sync-and-network.md) — high-level sync design,
  discovery, pairing, transport, daemon, backoff, `peer_refs`.
- [`crdt-and-recovery.md`](crdt-and-recovery.md) — the Loro engine and
  snapshot atomicity.
- [`docs/features/sync.md`](../features/sync.md) — user-facing perspective.
