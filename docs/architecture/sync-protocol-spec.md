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

- `src-tauri/agaric-sync/src/sync_protocol/types.rs` — the `SyncMessage` envelope and
  `SyncState`.
- `src-tauri/agaric-sync/src/sync_protocol/loro_sync_types.rs` — the `LoroSyncMessage`
  payload and `LORO_SYNC_PROTOCOL_VERSION`.
- `src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs` — the per-session
  `SyncOrchestrator` state machine.
- `src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs` — `prepare_outgoing` /
  `apply_remote` and the version-vector reachability check.
- `src-tauri/agaric-sync/src/sync_daemon/session_supervisor.rs` — the initiator-side session
  driver (`run_sync_session`).
- `src-tauri/agaric-sync/src/sync_daemon/server.rs` — the responder-side session driver
  (`handle_incoming_sync`).
- `src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer.rs` — the snapshot catch-up
  sub-flow.
- `src-tauri/agaric-sync/src/sync_files.rs` — the attachment-transfer sub-protocol.
- `src-tauri/agaric-sync/src/sync_constants.rs` — shared protocol constants.
- `src-tauri/agaric-sync/src/transport/session.rs` — QUIC framing of `SyncMessage`
  (length prefix, `MAX_FRAME_SIZE`).
- `src-tauri/agaric-sync/src/transport/bulk.rs` — bulk byte transfer on the same stream.
- `src-tauri/agaric-sync/src/transport/driver.rs` — the shared session loop and its
  `SessionLimits`.
- `src-tauri/agaric-sync/src/transport/service.rs` — the ALPN, admission control, and
  connection-setup bounds.

## Envelope encoding

Two distinct serde-tagged enums travel on the wire:

- The session envelope `SyncMessage` is serialized as JSON and written to a
  QUIC bi-stream as a `u32` big-endian length prefix followed by the JSON body
  (`transport::session::send_sync_message` / `recv_sync_message`). Its serde
  attribute is `#[serde(tag = "type")]`, so each variant is a JSON object
  with a `"type"` discriminant plus the variant's fields, e.g.
  `{"type":"HeadExchange","heads":[…]}`. A session is many messages on one
  bi-stream; the transport owes the protocol only the message boundary.
- The streaming payload `LoroSyncMessage` is nested inside
  `SyncMessage::LoroSync` and uses
  `#[serde(tag = "kind", rename_all = "snake_case")]`, producing
  `{"kind":"snapshot",…}` / `{"kind":"update",…}`.

Bulk binary payloads (snapshot blobs, attachment file bytes) are **not**
JSON. They are written as raw bytes on the same bi-stream after a JSON control
message and copied through one fixed `BULK_COPY_BYTES` (5 MB) buffer — see
[Binary-frame transfer](#binary-frame-transfer).

**The chunking layer is gone (#3464).** `LoroSyncChunked` and `OpLogBatchChunked`
existed only to work around the WebSocket message cap: a `LoroSyncMessage.bytes`
is a `Vec<u8>` inside a serde-JSON envelope, so it serialises as a number array
at up to 4 characters per byte, and any vault past ~2.5 MB of Loro state produced
an over-cap frame. A QUIC stream has no message boundary and no length ceiling,
so the workaround has no counterpart. Both variants remain in the `SyncMessage`
enum and remain rejected by the orchestrator, but **nothing produces them any
more** and nothing reassembles them. Two consequences the reader should not have
to derive:

- **zstd wire compression is gone with them (#3512).** It lived in the retired
  `sync_daemon::wire` module, deleted with the rest of the old transport in
  #3544. The `HeadExchange.wire_compression` capability that gated it was then
  **removed from the wire in #3543**, once it was established that no surviving
  code path read the received value — see
  [`SyncMessage::HeadExchange`](#syncmessageheadexchange) for the compatibility
  argument. The `compressed: bool` on the two retired chunked variants remains,
  permanently `false`.
- **The 4× JSON expansion is now paid in full**, against a 256 MB frame cap
  instead of a 10 MB message cap. That is a much larger budget than before, but
  it makes a single space past roughly 64 MB of Loro state a hard offer failure
  at a threshold nobody has measured.

### Transport limits

Defined in `src-tauri/agaric-sync/src/sync_constants.rs` and, for the ones the
transport owns, in `src-tauri/agaric-sync/src/transport/`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `SYNC_ALPN` | `agaric/sync/0` | The ALPN both ends negotiate (`transport/service.rs`). A mismatch fails the QUIC handshake before any application data moves; bumping it strands a device that has not upgraded. |
| `transport::session::MAX_FRAME_SIZE` | 256 MB (= `MAX_LORO_SYNC_PAYLOAD_SIZE`) | Hard cap on one framed `SyncMessage`, checked on send and, on receive, **before** a buffer is allocated. |
| `BINARY_FRAME_CHUNK_SIZE` | 5,000,000 bytes | Two jobs now. It is the receive buffer's growth step in `transport::session` — a frame is reserved as bytes actually land, so a 4-byte prefix cannot commit 256 MB — and it is `BULK_COPY_BYTES`, the single fixed buffer bulk transfer copies through. |
| `LORO_INLINE_MAX_BYTES` | 2,400,000 bytes | Threshold above which a `LoroSync` payload's `bytes` used to leave the inline JSON envelope for `LoroSyncChunked` (#611). **Now inert**: nothing produces the chunked variant, so every `LoroSync` rides the inline shape whatever its size. |
| `OP_LOG_BATCH_INLINE_MAX_BYTES` | 2,400,000 bytes (= `LORO_INLINE_MAX_BYTES`) | Same story for `OpLogBatchChunked` (#2593). The threshold still gates whether an oversized batch is *skipped* when the peer lacks the capability, but the chunked frame it would have gated is no longer emitted. |
| `MAX_OP_LOG_BATCH_PAYLOAD_SIZE` | 256 MB | Batches serialising larger than this are dropped from the reply entirely (state still converges via `LoroSync`). |
| `MAX_LORO_SYNC_PAYLOAD_SIZE` | 256 MB | The crate's answer to "the largest protocol payload we will allocate for before we have seen the bytes"; `MAX_FRAME_SIZE` is deliberately this value rather than a new number. |
| `MAX_SNAPSHOT_SIZE` | 256 MB | Cap the initiator applies to `SnapshotOffer.size_bytes` (defined in `sync_daemon/snapshot_transfer.rs`). |
| `HANDSHAKE_TIMEOUT` | 120 s | Per-`handle_message` budget, applied by `SessionLimits::dispatch` in `transport/driver.rs`. |
| `transport::session::RECV_TIMEOUT` | 180 s | Per-awaited-message receive guard, applied by `recv_sync_message_within`. Carried across from `SyncConnection::RECV_TIMEOUT` by value, restated rather than imported because `sync_net` is retired. |
| `transport::driver::RECV_TIMEOUT` (private) | 180 s | **A second, same-named constant** — this is the one that feeds `SessionLimits::recv`, i.e. the session driver's default. Same value and same provenance as `session::RECV_TIMEOUT`, but a different item: retuning one does not move the other. Disambiguated here because the name alone does not. |
| `CONNECTION_SETUP_TIMEOUT` | 10 s | Budget for the QUIC handshake alone (`transport/service.rs`), spent in a spawned `AdmittedConnection::establish` so one stalled peer costs one slot rather than the whole accept queue. |
| `FIRST_FRAME_TIMEOUT` | 180 s | Budget for the peer's *first* frame, which it cannot send until `orch.start()` has read local heads and version vectors out of the database. Deliberately not the handshake budget. |
| `CLOSE_WAIT` | 10 s | How long the side that wrote the final frame waits for the peer's close (`transport/driver.rs`). |
| `BULK_IDLE_TIMEOUT` | 180 s | **Idle** bound on bulk transfer, reset per read (`transport/bulk.rs`) — not a bound on the whole transfer. |
| `CONNECT_TIMEOUT` | 10 s | Whole-dial budget on the initiator. iroh races every candidate path, so one budget covers all of them — but UDP gives no `ECONNREFUSED`, so a dial to a departed peer now burns the full 10 s (#3515). |
| `MAX_CONCURRENT_RESPONDER_SESSIONS` | 16 | Admission cap; over-capacity connections are refused, not queued. Sized against the 6-connection DB pool the sessions draw on, not against handshake cost. |
| `LORO_SYNC_PROTOCOL_VERSION` | 1 | Envelope version on `LoroSyncMessage` (`loro_sync_types.rs`); distinct from Loro's own payload format version. |

## Message types

All variants below are arms of the `SyncMessage` enum in
`src-tauri/agaric-sync/src/sync_protocol/types.rs`, unless noted as belonging to
`LoroSyncMessage` (`src-tauri/agaric-sync/src/sync_protocol/loro_sync_types.rs`).

### `SyncMessage::HeadExchange`

```text
HeadExchange { heads: Vec<DeviceHead>,
               loro_vvs: Vec<SpaceVersionVector>,   // #[serde(default)]
               engine_format_version: u32,           // #[serde(default)]
               op_log_replication: bool,             // #[serde(default)] capability
               op_log_batch_chunked: bool,           // #[serde(default)] capability
               pairing_proof: Option<String>,        // #[serde(default)]
               device_name: Option<String> }         // #[serde(default)]
```

Every field after `heads` is `#[serde(default)]`, so a peer predating any of
them deserializes the zero value and degrades to the older behaviour. The two
`bool`s are **additive capability advertisements** — see the variants they gate
below.

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

**Removed field: `wire_compression` (#2200, deleted in #3543).** It advertised
that the sender could decompress zstd-compressed chunked `LoroSync` payloads.
Compression lived in the chunking layer of the retired `sync_daemon::wire` module
(deleted in #3544), which the QUIC transport has no counterpart for, so the flag
became write-only: `start()` set it to `true` and the receiving orchestrator
destructured it to `_`. #3543 removed it rather than leaving a protocol field
that does nothing.

Removing it is safe in both directions:

- **This build meets a peer shipped between #2200 and #3543.** That peer still
  sends `wire_compression: true`. `SyncMessage` carries no
  `#[serde(deny_unknown_fields)]`, so serde ignores the extra key and the
  `HeadExchange` parses normally.
- **That peer meets this build.** This build omits the key; the peer's
  `#[serde(default)]` yields `false`. On any build that could reach the QUIC
  handshake, `false` changes nothing — the received value is discarded there too.
- **A pre-cutover peer cannot be reached at all.** It speaks
  WebSocket-over-mTLS and cannot complete an iroh QUIC handshake on
  `transport::service::SYNC_ALPN`, so the old "`false` means stream me raw
  bytes" semantics has no session in which to be observed.

`op_log_batch_chunked` (#2593) was **not** removed with it, despite the two being
introduced as mirror images. The chunked *encoding* it named is gone — nothing
emits `OpLogBatchChunked` any more — but the flag still gates a live send
decision, so unlike `wire_compression` its received value is read: a batch over
`OP_LOG_BATCH_INLINE_MAX_BYTES` is skipped when the peer did not advertise the
capability, and one over `MAX_OP_LOG_BATCH_PAYLOAD_SIZE` is skipped
unconditionally. What the flag now promises is "I can survive a payload above the
inline bound, however it arrives" rather than "I can decode chunked frames".
State still converges via `LoroSync`; only the audit tail is dropped.

`pairing_proof: Option<String>` (#855) is present only while the initiator is
mid-pairing (its pending-pairing marker holds the proof). It is the
domain-separated blake3 of the pairing passphrase (`pairing::pairing_proof`).
The responder admits an **unpaired** device during the pairing window (the #1519
first-connect bridge) **only** when this matches, under `constant_time_eq`, the
proof it stored when it armed/confirmed the pairing; the peer's
handshake-authenticated `EndpointId` is bound to the row only after the session
settles a device id.

**The iroh cutover did not retire this field, and reading it as part of the old
certificate defence is the mistake this area most invites.** The proof's job
changed, not its necessity. Under the old stack it stopped an attacker who minted
`CN=agaric-{victim}` from being pinned as the victim; under QUIC there is no CN to
mint, but the handshake proves only *which key* dialled — anyone can generate a
keypair — so without the proof the pairing window would admit, and bind, whichever
endpoint happened to connect during it. Narrower job, same load.

It is `#[serde(default)]` (→ `None`): an already-paired peer
omits it on every normal sync (the responder consults it only on the
unpaired-pending-pairing path), and a peer predating the field can no longer
complete a *first* pairing against a #855 responder — the intended security
tightening, since pairing is a deliberate mutual act on current builds. The
proof travels only over the QUIC channel's TLS 1.3 encryption; a full
man-in-the-middle relay is out of the paired-device threat model
(AGENTS.md §"Threat Model").

`device_name: Option<String>` (#4298) is what the initiator calls itself — its
OS hostname — so the responder can render the paired device as
`javier-thinkpad` rather than `e3d48f0a-45a…`. The responder persists it as
`peer_refs.remote_device_name`, **never** as `peer_refs.device_name`, which is
the local user's override and outranks it (see
[sync-and-network.md](sync-and-network.md#peer_refs-table)). It is re-sent on
every session rather than once at pairing, because a device can be renamed at
any time and no other frame would carry the update; the write is conditional on
a change, so a steady-state session costs a read and no write.

It is untrusted display text. `clamp_device_name` strips display-hostile
characters, trims, caps it at `MAX_DEVICE_NAME_CHARS`, and maps
empty/whitespace-only to `None` — applied on send *and* again on receive, since
nothing a well-behaved sender does can be assumed of a hostile one.

It is `#[serde(default)]` (→ `None`) for the same wire back-compat reason as
`pairing_proof`: a peer predating the field omits it and the responder simply
keeps whatever name it already had, while a peer predating it that *receives*
one ignores the unknown key (no `deny_unknown_fields`). `None` is also what a
*current* peer sends when its OS reports no hostname that names it in
particular — stock Android reports `localhost` for every device, so that value
is filtered at the boot refresh (`identifying_hostname` in `lib.rs`) rather
than advertised, and every consumer falls through to the truncated id.

Initiator-only, because `HeadExchange` is: the responder has no equivalent
one-shot frame and does not answer with its own name. The gap closes on its
own — roles are not fixed, every device dials its peers on the resync
scheduler, so each side initiates some session and the pair converges on both
names within a resync interval.

**Privacy note.** `HeadExchange` is the opening frame, and during the pairing
window a joiner dials *every* mDNS-discovered device on the LAN — so a hostname
(which often embeds the user's real name) reaches devices that go on to reject
the session. A real but marginal exposure, and not a new one: `pairing_proof`
already travels the same frame to the same over-broad audience.

**`HeadExchange` carries no `device_id`, and S-5 is keyed accordingly (#3511).**
The responder cannot learn the peer's Agaric device id before the session runs:
the certificate CN used to supply it unconditionally, and `get_local_heads` reads
only `op_log`, so a fresh joiner with an empty log advertises no head of its own
either. S-5's per-peer lock key was therefore **asymmetric during the pairing
window** — the responder fell back to the endpoint id while the initiator used
the device id — so an inbound and an outbound session with the same device could
overlap until a binding existed.

Resolved by keying **both roles on the peer's `EndpointId`**
(`sync_daemon::peer_lock_key`), not by adding a `device_id` to the frame. A wire
field would arrive *after* the connection is accepted, so the responder would
still have to choose a key before it had one, and it would cost a field forever.
The `EndpointId` is the only identifier both roles hold unconditionally: the
responder has it from the QUIC/TLS 1.3 handshake before any application byte, and
the initiator must have it to dial at all. The trade-off is that an `EndpointId`
is 1:1 with an *install*, so the lock now admits one concurrent session per
install rather than per device id — confined to the lock; `device_id` remains the
durable identity everything else is keyed on (#3529).

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
(`SqlOnlyFallbackReason`,
`src-tauri/agaric-engine/src/apply/sql_only_fallback.rs`) writes an
op's SQL projection without routing it through the per-space `LoroEngine`
when the op's space hasn't resolved or the block is absent from that
space's engine tree. A device that has taken this
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
LoroSyncChunked { header: LoroSyncChunkedHeader, is_last: bool,
                  compressed: bool }   // #[serde(default)], permanently false
                                       // since #3543 retired the capability

LoroSyncChunkedHeader (serde tag "kind", snake_case):
  Snapshot { protocol_version: u8, space_id: SpaceId, size_bytes: u64 }
  Update   { protocol_version: u8, space_id: SpaceId,
             from_vv: LoroVersionVector, size_bytes: u64 }
```

**Retired by the QUIC cutover; the variant remains in the enum and nothing
emits it.** It was the chunked-binary transport encoding of `LoroSync` (#611):
an inline `LoroSyncMessage.bytes` serialises as a JSON number array (~3.6×
inflation, worst case 4 chars/byte), and a single WebSocket text frame was
capped at 10 MB, so a growing space payload would eventually exceed the cap and
permanently break sync. Payloads larger than `LORO_INLINE_MAX_BYTES` therefore
travelled out-of-band as a header-only envelope followed by `size_bytes` of raw
Loro bytes in binary frames.

A QUIC stream has no message boundary and no length ceiling, so the workaround
has no counterpart: `transport::session` writes the whole `LoroSync` as one
length-prefixed frame under the 256 MB `MAX_FRAME_SIZE`. The producer and the
reassembler both lived in `sync_daemon::wire`, which is deleted (#3544), so
`LORO_INLINE_MAX_BYTES` no longer routes anything and `compressed` no longer has
a compressor behind it (#3512).

**Still rejected at the orchestrator.** `handle_message` fails the session
loudly on this variant, and that contract is unchanged — it now means "a peer on
an incompatible build sent this" rather than "the wire layer failed to
reassemble". `protocol_version` is validated by `apply_remote`, so
version-mismatch handling stays in one place either way.

**Compatibility.** A pre-cutover peer cannot reach this code path at all. It
browses and announces `_agaric._tcp.local.`, so it never sees a current build's
record and a current build never sees its; and it dials TCP where nothing is
listening. The frames are unreachable rather than merely unused. Note that the
service-type change is a **silent** break — no event fires, so "incompatible
release" is indistinguishable from "device is off" — whereas an ALPN mismatch
would be loud. The ALPN is negotiated inside the QUIC handshake, after the dial,
so it cannot be the mechanism that reports this one (#3488).

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

### `SyncMessage::OpLogBatch`

```text
OpLogBatch { records: Vec<OpTransfer>, is_last: bool }   // streamer → puller
```

Audit-only op-log replication (#2481 phase 1). The **streamer** appends these
to the tail of its streaming reply — *after* the per-space `LoroSync` deltas —
carrying the op records the puller lacks (`seq >` the puller's advertised
per-device frontier from `HeadExchange.heads`, computed by
`operations::collect_ops_for_peer` and partitioned under
`OP_LOG_BATCH_INLINE_MAX_BYTES` by `batch_ops_for_wire`). Each record is hash-verified and stored by the puller
via `dag::insert_replicated_op` with `is_replicated = 1` — append-only **audit
metadata that is never applied to state** (state flows exclusively through Loro
CRDT sync). A corrupt record (hash mismatch) is logged and skipped best-effort,
never faulting the pull.

The puller **buffers** received records during the stream and ingests them once,
at session completion (`complete_pull_session`), after a materializer flush. The
inline write would otherwise contend with the background inbound-sync cache
rebuild that the just-applied `LoroSync` enqueued — SQLite is single-writer, and
an oversized-block FTS rebuild can hold the write lock past the 5 s
`busy_timeout` (#611). Flushing first drains that rebuild so the audit write runs
uncontended.

The batches ride the **same streaming phase and drain** (`next_message`) as the
`LoroSync` deltas, so the receiver ingests them in its normal `handle_message`
loop; the single final message across the whole stream — the last `OpLogBatch`,
or the last `LoroSync` when there are none — carries `is_last: true` and drives
the puller to `Complete`. This is single-direction per session (streamer →
puller, mirroring state sync); the reverse propagates when roles swap (#610). A
streamer that receives an `OpLogBatch` (it should only send them) fails the
session — the direction is enforced, not just conventional.

`OpLogBatch` used to share `LoroSync`'s inline/chunked transport (#2593): a batch
whose serialized records exceeded `OP_LOG_BATCH_INLINE_MAX_BYTES`
(= `LORO_INLINE_MAX_BYTES`, 2,400,000 bytes) rode a
[`SyncMessage::OpLogBatchChunked`](#syncmessageoplogbatchchunked) header + binary
frames instead of an inline JSON frame, so a single op record larger than the
inline bound — a sync-applied/imported op whose `payload` carries a large block
`content`, bypassing the 256 KiB command-layer content cap — replicated its
audit metadata rather than being dropped at the 10 MB frame cap. The routing
lived in the retired `sync_daemon::wire`; since the cutover every `OpLogBatch`
rides the plain inline shape on a QUIC frame, bounded only by the 256 MB
`MAX_FRAME_SIZE`, and the orchestrator produces/consumes nothing else.

**The oversized batch is capability-gated (#2593).** Whether the streamer ships
that oversized batch at all depends on the puller advertising
`HeadExchange { op_log_batch_chunked: true }` — the additive capability that says
"I can decode `OpLogBatchChunked`". A puller that advertised `op_log_replication`
but NOT `op_log_batch_chunked` (a shipped #2481 build that knows `OpLogBatch` but
not the chunked envelope) has the oversized batch **skipped with a warning** in
`collect_op_batches_for_peer`, exactly as before #2593 — its state still syncs
via `LoroSync`. This is essential: sending such a peer an `OpLogBatchChunked`
frame it cannot deserialize would fault the session, and because the oversized
record persists, every subsequent session too, breaking *all* state sync. A batch
exceeding `MAX_OP_LOG_BATCH_PAYLOAD_SIZE` (256 MB) is skipped regardless of
capability (unshippable even chunked). This once mirrored the #2200
`wire_compression` capability gate; that flag was deleted in #3543 because
nothing read it, whereas this one is still consulted on every send.

**Capability-gated (back-compat).** The streamer appends `OpLogBatch` only when
the puller advertised `HeadExchange { op_log_replication: true }` — an older
peer that omits the flag (`#[serde(default)]` → `false`) is never sent the
variant it cannot deserialize, and a newer puller talking to an older streamer
simply never receives one (it blocks on nothing — the batches are additive to a
stream it already drains). No new handshake round-trip; nothing on the wire
becomes mandatory.

### `SyncMessage::OpLogBatchChunked`

```text
OpLogBatchChunked { size_bytes: u64, is_last: bool, compressed: bool }   // streamer → puller
```

**Retired by the QUIC cutover on the same terms as
[`LoroSyncChunked`](#syncmessagelorosyncchunked); nothing emits it.** It was the
chunked-binary transport encoding of `OpLogBatch` (#2593): a batch whose
`serde_json`-encoded `records` exceeded `OP_LOG_BATCH_INLINE_MAX_BYTES` travelled
as this envelope (announcing `size_bytes` of follow-up binary frames,
`compressed` set when the peer advertised the since-retired `wire_compression`
capability and zstd shrank the payload) followed by the records' bytes. The
producer and reassembler lived in
`sync_daemon::wire`, deleted in #3544; the orchestrator still rejects the variant
loudly if one arrives.

**What survives is the *skip*, not the chunking.** `collect_op_batches_for_peer`
still drops a batch over `MAX_OP_LOG_BATCH_PAYLOAD_SIZE` (256 MB) unconditionally,
and still drops one over `OP_LOG_BATCH_INLINE_MAX_BYTES` when the peer did not
advertise `op_log_batch_chunked`. In both cases the batch is skipped with a
warning and **state still converges via `LoroSync`** — only the audit tail is
lost. Under the current transport an oversized batch for a capable peer simply
rides as a plain `OpLogBatch`, bounded by the 256 MB `MAX_FRAME_SIZE` rather than
by a chunked header.

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

Driven by `src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer.rs`, **not** the
per-session orchestrator (which explicitly errors if they reach
`handle_message`):

```text
SnapshotOffer { size_bytes: u64, blob_blake3: String }  // responder → initiator
SnapshotAccept                                          // initiator → responder
SnapshotReject                                          // initiator → responder
```

`size_bytes` is the length of the compressed snapshot blob and `blob_blake3`
its digest, checked after the transfer; the initiator caps `size_bytes` at
`MAX_SNAPSHOT_SIZE` (256 MB) before reading any frame.

### Attachment sub-flow variants

Driven by `src-tauri/agaric-sync/src/sync_files.rs`, also outside the per-session
orchestrator:

```text
FileRequest  { attachment_ids: Vec<String> }
FileOffer    { attachment_id: String, size_bytes: u64, blake3_hash: String,
               content_hash: Option<String> }   // #[serde(default)]
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
(`src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs`); its phase enum is
`SyncState` (`src-tauri/agaric-sync/src/sync_protocol/types.rs`).

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
  │ each inbound OpLogBatch (#2481) → buffer records (audit-only),
  │   stay in StreamingOps while is_last:false
  │ inbound message with is_last:true (last LoroSync, or last OpLogBatch) ─► flush +
  │   insert_replicated_op the buffered records ─► Complete (emit SyncComplete)
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
- `OpLogBatch` (#2481) is valid in `StreamingOps` / `ExchangingHeads` — the
  same states as `LoroSync`, since it rides the tail of the same stream — and
  is ingested by the dispatch body (`dag::insert_replicated_op`), unlike the
  snapshot / file-transfer variants below.
- The `SnapshotOffer` / `SnapshotAccept` / `SnapshotReject` and the four
  file-transfer variants pass state validation but are rejected by the
  dispatch body — they are handled by the daemon-layer sub-flows, never the
  orchestrator. Implementation detail in
  `src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs`.

The surrounding daemon (`src-tauri/src/sync_daemon`) owns everything outside
the per-session machine: discovery, scheduling, per-peer locking, connection
setup, TOFU binding of the peer's `EndpointId`, dormant/active mode, and the post-`ResetRequired`
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
   │            (responder has already authorized the key and locked the
   │             peer before this frame is dispatched; the FSM then gates
   │             engine_format_version, checks heads against
   │             expected_remote_id when one is set, and runs
   │             check_reset_required on OWN-device heads)
   │                                           │
   │      LoroSync { msg, is_last:false } ...  │  one per SpaceId:
   ◄──────────────────────────────────────────┤  incremental Update against
   │      LoroSync { msg, is_last:false }      │  the initiator's advertised
   ◄──────────────────────────────────────────┤  vv; full Snapshot for a
   │ (applies each via apply_remote)           │  space it didn't advertise
   │                                           │
   │      OpLogBatch { records, is_last:true } │  #2481 audit tail: op records
   ◄──────────────────────────────────────────┤  the puller lacks, only when it
   │ (ingests each via insert_replicated_op)   │  advertised op_log_replication
   │                                           │
   │ SyncComplete { last_hash }                │  puller records synced_at +
   ├──────────────────────────────────────────►  peer_refs bookmark; the
   │              [ file-transfer phase ]      │  streamer does not (#610)
```

(When the puller is an older peer that did not advertise `op_log_replication`,
no `OpLogBatch` is appended and the last `LoroSync` carries `is_last:true`, the
pre-#2481 shape.)

Mechanics worth pinning:

- The initiator sends the session's only `HeadExchange`. The old B-34 check
  — reject if the advertised `device_id` disagrees with the TLS certificate
  CN — has no CN to check any more; its successor is `expected_remote_id`.
  `handle_incoming_sync_inner` sets it **only** from a peer row already bound
  to the handshake-authenticated `EndpointId`, where it is authoritative, and
  the FSM then rejects a `HeadExchange` that disagrees with it. It is
  deliberately *not* set from the heads-derived id: #2481 frontier
  advertisement means the first non-self head is not reliably the peer's own
  identity, so a mismatch would false-fail a legitimate multi-device peer.
  With it unset — during the pairing window, or before a migrated install has
  re-bound — the FSM falls back to the heads-derived id, which is what the old
  cert-less path did.
- Authorization happens **before** the frame is dispatched, not before it is
  received. The responder's caller does `recv → authorize → dispatch`: it reads
  the opening frame itself, checks S-1 / the #855 proof / S-5, and only then
  hands the frame to `run_session` as `Role::Responder { opening }`. The driver
  never reads an opening frame of its own, so there is no path by which one
  reaches `handle_message` unauthorized — which is what makes #3324's bug class
  structurally unrepresentable rather than merely guarded. The order cannot be
  tightened further: the #855 proof rides *inside* `HeadExchange`, so for an
  unpaired peer there is nothing to authorize against until the frame arrives.
- A first message that is not a `HeadExchange` is rejected outright before any
  of the above.
- On receiving the `HeadExchange`, the responder calls
  `head_exchange_outgoing_loro`, which builds one `LoroSync` per registered
  space — an incremental `Update` against the initiator's advertised
  version vector for that space, or a full `Snapshot` for a space the
  initiator didn't advertise (#1230) — and queues all but the first into
  `pending_loro_messages`. The driver loop drains the queue via
  `next_message()` after each `handle_message`. Over-threshold payloads are
  re-encoded as `LoroSyncChunked` by the wire layer transparently.
- #2481 audit tail: when the puller advertised `op_log_replication: true`,
  `head_exchange_outgoing_loro` also queues the op records the puller lacks
  (`collect_ops_for_peer` → `batch_ops_for_wire`) into `pending_op_batches`,
  drained after the `LoroSync` messages by the same `next_message()` loop. The
  `is_last` flag moves to the final message across *both* queues, so the puller
  completes only after state deltas AND audit records have arrived.
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
that reuses the previously bound key and the `peer_refs` bookmark:

- The daemon (`daemon_loop`) reconnects on a discovery event, a debounced
  change trigger, or a periodic resync tick. A dial names the peer's bound
  `peer_refs.endpoint_id`; every address mDNS advertised goes into the
  `EndpointAddr` at once and iroh races them under a single `CONNECT_TIMEOUT`.
  If mDNS cannot resolve the peer, the fallback needs the manual
  `peer_refs.last_address` **and** a bound `endpoint_id` — an address without a
  key resolves a peer nothing can dial. An announcement whose key disagrees with
  the bound one is refused rather than re-bound.
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
- Large space snapshots used to ride the chunked-binary transport (#611) so that
  no per-message cap applied on the Loro path; since the cutover they ride one
  length-prefixed QUIC frame (`transport::session`) under `MAX_FRAME_SIZE`
  (256 MB), which is the only bound left.
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
  (`src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs`, `loro_sync.rs`).
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
(`src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs`), the return type of
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
attachment transfer (`src-tauri/agaric-sync/src/sync_files.rs`). It is driven directly
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
   │      <size_bytes of raw stream bytes>     │  send_bulk, streamed off disk
   ◄──────────────────────────────────────────┤  hash verified as it arrives
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
  the atomic rename. The optional `content_hash` (#1993) mirrors
  `blake3_hash` so a future receiver can reason about content-addressing
  independently of the transfer hash; the actual skip-transfer decision is
  taken receiver-side in `find_missing_attachments` — a file whose hash
  already has a local blob is never requested, so it is never offered.
- Binary data rides the same QUIC stream as the JSON control messages, copied
  through one `BULK_COPY_BYTES` (5 MB) buffer — the same path the snapshot
  transfer uses. A zero-length file sends **no bytes at all**: the old transport
  sent one empty frame as a sentinel and QUIC has no counterpart, so both ends of
  the bulk phase have to cross in the same commit. The zero-byte case is guarded
  by reading the trailing marker off the same stream.
- `FileReceived` is sent only after the file has been written and its hash
  verified.
- `FileTransferComplete` concludes one half; a side with nothing to offer
  still sends it (and an empty `FileRequest` means "I need nothing").
- The `cancel` flag is checked between files so a large transfer can be
  aborted mid-stream.

### Binary-frame transfer

Both the snapshot blob and attachment files use the shared bulk path in
`src-tauri/agaric-sync/src/transport/bulk.rs`. There is no chunking layer: a QUIC
stream is a reliable, ordered, flow-controlled byte stream, so `send_bulk` copies
the payload straight onto the same bi-stream the JSON control messages use, and
`recv_bulk` reads exactly `size_bytes` back off it.

What the layer still owes the protocol, and did not lose with the chunking:

- **It bounds before it trusts.** `total_size` comes from the peer and is checked
  against a caller-supplied cap *before* any read. This is deliberately worded
  like `transport::session`'s prefix refusal so one grep finds both; the two caps
  look redundant and are not, because the session cap bounds a frame and this one
  bounds a declared transfer.
- **Allocation is constant, not proportional.** Every read is sized from the fixed
  `BULK_COPY_BYTES` buffer's own length rather than from a constant, so an
  over-sized allocation surfaces as an over-sized *request* — the property is
  pinned at the trait seam rather than by an allocator probe, which would not have
  caught it (an 8 GB `alloc_zeroed` is lazily mapped on an overcommitting kernel).
- **Progress is cumulative and ticked per 5 MB buffer**, not per read: a QUIC
  stream returning 64 KB at a time would otherwise turn one buffer into ~80 Tauri
  events (82 measured when this was broken). A zero-size transfer still ticks once.
- **`BULK_IDLE_TIMEOUT` (180 s) is an idle bound reset per read**, not a bound on
  the whole transfer — a cap-sized attachment does not have to fit in 180 s.

One property was *lost* and is worth knowing: overrun is now structurally
impossible to observe rather than detected. The loop never requests more than it
is still owed, so a peer with surplus bytes is never given a buffer to put them
in; the old receiver caught that after the fact and named the peer, whereas
surplus now stays in the stream and corrupts the next frame's length prefix
instead. Safer, diagnosed later — filed as #3489, which argues the check belongs
in the session layer.

## See also

- [`sync-and-network.md`](sync-and-network.md) — high-level sync design,
  discovery, pairing, transport, daemon, backoff, `peer_refs`.
- [`crdt-and-recovery.md`](crdt-and-recovery.md) — the Loro engine and
  snapshot atomicity.
- [`docs/features/sync.md`](../features/sync.md) — user-facing perspective.
