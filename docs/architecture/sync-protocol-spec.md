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
- `src-tauri/src/sync_protocol/orchestrator.rs` — the per-session
  `SyncOrchestrator` state machine.
- `src-tauri/src/sync_protocol/loro_sync.rs` — `prepare_outgoing` /
  `apply_remote` and the version-vector reachability check.
- `src-tauri/src/sync_daemon/orchestrator.rs` — the initiator-side session
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

Bulk binary payloads (snapshot blobs, attachment file bytes) are **not**
JSON. They travel as WebSocket binary frames after a JSON control message,
each frame at most `BINARY_FRAME_CHUNK_SIZE` (5 MB) — see
[Binary-frame transfer](#binary-frame-transfer).

### Transport limits

Defined in `src-tauri/src/sync_constants.rs` and (per-connection) in
`src-tauri/src/sync_net/connection.rs`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `SyncConnection::MAX_MSG_SIZE` | 10,000,000 bytes | Hard cap on any single WebSocket frame (text or binary). |
| `BINARY_FRAME_CHUNK_SIZE` | 5,000,000 bytes | Chunk unit for snapshot + attachment binary frames; kept under `MAX_MSG_SIZE` for framing headroom. |
| `HANDSHAKE_TIMEOUT` | 120 s | Per-`handle_message` budget on both session loops. |
| `SyncConnection::RECV_TIMEOUT` | (see `connection.rs`) | Overall idle receive guard, kept strictly larger than `HANDSHAKE_TIMEOUT`. |

## Message types

All variants below are arms of the `SyncMessage` enum in
`src-tauri/src/sync_protocol/types.rs`, unless noted as belonging to
`LoroSyncMessage` (`src-tauri/src/sync_protocol/loro_sync_types.rs`).

### `SyncMessage::HeadExchange`

```text
HeadExchange { heads: Vec<DeviceHead> }
```

The first message of every session, sent in both directions exactly once.
`DeviceHead` (a `struct` in `types.rs`) is the per-device frontier:

```text
DeviceHead { device_id: String, seq: i64, hash: String }
```

`heads` is the latest `(device_id, seq, hash)` tuple per device known to the
sender's op log, computed by `operations::get_local_heads`.

### `SyncMessage::LoroSync`

```text
LoroSync { msg: LoroSyncMessage, is_last: bool }
```

The sole streaming-phase payload. Carries one `LoroSyncMessage` per
`SpaceId`, sent zero-or-more times in either direction. `is_last: true`
marks the final per-space message of a batch and tells the receiver to
transition to completion.

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

### `SyncMessage::SyncComplete`

```text
SyncComplete { last_hash: String }
```

Per-side terminal of the delta phase, sent once per side after that side has
streamed its final `LoroSync`. `last_hash` is the sender's new
frontier-of-record, written to `peer_refs` to bookmark the next session's
starting point.

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
(`src-tauri/src/sync_protocol/orchestrator.rs`); its phase enum is
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
  `src-tauri/src/sync_protocol/orchestrator.rs`.

The surrounding daemon (`src-tauri/src/sync_daemon`) owns everything outside
the per-session machine: discovery, scheduling, per-peer locking, connection
setup, TOFU cert pinning, dormant/active mode, and the post-`ResetRequired`
and post-`Complete` sub-flows.

## Handshake sequence

The initiator side is driven by `run_sync_session`
(`sync_daemon/orchestrator.rs`); the responder side by `handle_incoming_sync`
(`sync_daemon/server.rs`). Both share the same exchange-until-terminal loop
with a `HANDSHAKE_TIMEOUT` per `handle_message` call.

### Normal (delta) flow

```text
Initiator                                  Responder
   │                                           │
   │ start() → HeadExchange { heads }          │
   ├──────────────────────────────────────────►
   │            (responder recv_json, identifies peer from heads,
   │             validates against TLS cert CN)
   │                                           │
   │      HeadExchange { heads }               │  responder replies in kind,
   ◄──────────────────────────────────────────┤  then begins its own stream
   │      LoroSync { msg, is_last:false } ...  │
   ◄──────────────────────────────────────────┤  (one per SpaceId; full
   │      LoroSync { msg, is_last:true }       │   Snapshot under peer_vv=None)
   ◄──────────────────────────────────────────┤
   │                                           │
   │ (initiator likewise streams its spaces)   │
   │ LoroSync ... LoroSync { is_last:true }    │
   ├──────────────────────────────────────────►
   │                                           │
   │      SyncComplete { last_hash }           │
   ◄─────────────────────────────────────────►┤  (each side, after its
   │ SyncComplete { last_hash }                │   final LoroSync)
   ├──────────────────────────────────────────►
   │              [ file-transfer phase ]      │
```

Mechanics worth pinning:

- The initiator sends the first `HeadExchange`; the responder reads it
  first, derives the peer identity from the advertised heads, and rejects
  the session with `Error` if the `device_id` does not match the TLS
  certificate CN it is connected to (the B-34 check in `server.rs`).
- On receiving the remote's `HeadExchange`, each side calls
  `head_exchange_outgoing_loro`, which builds one `LoroSync` per registered
  space (full `Snapshot`, since `peer_vv` is `None` under the current
  protocol) and queues all but the first into `pending_loro_messages`. The
  driver loop drains the queue via `next_message()` after each
  `handle_message`.
- Empty-stream short-circuit: a peer with zero registered spaces replies
  `SyncComplete` directly from `ExchangingHeads` rather than emitting a
  zero-byte `LoroSync`.
- `is_last: true` on the final per-space `LoroSync` drives the receiver to
  `Complete` and prompts its own `SyncComplete`, which carries the local
  head hash and is recorded into `peer_refs` inside a single
  `BEGIN IMMEDIATE` transaction (`upsert_peer_ref_in_tx` +
  `complete_sync_in_tx`).

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

When the responder cannot satisfy the initiator's heads with a delta replay,
the session exits the delta loop in `ResetRequired` and hands off to
`snapshot_transfer.rs`. The initiator runs `try_receive_snapshot_catchup`;
the responder runs `try_offer_snapshot_catchup`.

```text
Initiator                                  Responder
   │ HeadExchange { heads }                    │
   ├──────────────────────────────────────────►
   │                                           │  check_reset_required == true
   │      ResetRequired { reason }             │  (log compacted past heads)
   ◄──────────────────────────────────────────┤
   │ (delta loop breaks; both enter sub-flow)  │
   │                                           │  get_latest_snapshot()
   │                                           │  + covering check:
   │                                           │    if snapshot frontier <
   │      Error { message }   (stale)     │    remote head → Error, abort
   ◄──────────────────────────────────────────┤
   │      SnapshotOffer { size_bytes }         │  otherwise offer
   ◄──────────────────────────────────────────┤
   │ (cap check: size_bytes > 256 MB?)         │
   │      SnapshotReject  → session ends       │
   ├──────────────────────────────────────────►
   │      SnapshotAccept                       │  (under cap)
   ├──────────────────────────────────────────►
   │      <binary frames × ⌈size/5 MB⌉>        │  send_binary_chunked
   ◄──────────────────────────────────────────┤
   │ apply_snapshot() (BEGIN IMMEDIATE +       │
   │   defer_foreign_keys; wipe + restore),    │
   │ advance peer_refs.last_hash = up_to_hash  │
```

Notes:

- If the responder has no complete snapshot in `log_snapshots`,
  `try_offer_snapshot_catchup` returns `NoSnapshot` and the session closes
  with no catch-up.
- The covering check (`snapshot_covers_remote_heads`) guards against a
  snapshot whose `up_to_seqs` is behind any advertised remote head; on
  mismatch the responder sends `Error` rather than silently rolling the
  initiator back.
- The initiator streams received bytes to a temp file (bounded by the 256 MB
  cap), then decodes + applies via `crate::snapshot::apply_snapshot`, whose
  restore is atomic. See
  [`crdt-and-recovery.md`](crdt-and-recovery.md) for snapshot atomicity.
- Post-snapshot the initiator's `op_log` is wiped, so the next scheduled
  session advertises empty heads and picks up post-snapshot deltas via a
  normal `HeadExchange` — no recursive session restart.

## Version-vector format and exchange

The version vector is Loro-internal and opaque to the wire layer. The type
alias `LoroVersionVector = Vec<u8>` (`loro_sync_types.rs`) carries the output
of Loro's `VersionVector::encode()`; only the engine decodes it.

How peers compare and request missing ops:

- **Sender** (`loro_sync::prepare_outgoing`): with `peer_vv == None` it
  exports a full `Snapshot`; with `peer_vv == Some(vv)` it exports an
  `Update` covering ops since `vv` (`export_update_since`) and stamps
  `from_vv = vv` onto the message. Under the current protocol the
  orchestrator always passes `peer_vv = None` (full snapshot per space);
  per-peer version-vector tracking that would emit `Update` messages is a
  documented follow-up — implementation detail in
  `src-tauri/src/sync_protocol/orchestrator.rs` and `loro_sync.rs`.
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
