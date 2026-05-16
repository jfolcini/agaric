<!-- markdownlint-disable MD060 -->
# Sync, Networking, Android

Local-WiFi peer-to-peer sync over TLS-pinned WebSocket carrying Loro CRDT messages. No cloud, no relay, no accounts.

Companion to [`docs/features/sync.md`](../features/sync.md) (user perspective) and [`crdt-and-recovery.md`](crdt-and-recovery.md) (the Loro engine itself + snapshot atomicity).

## Stack

| Layer | Choice |
| --- | --- |
| Discovery | mDNS via `mdns-sd` (pure Rust, no Avahi/Bonjour daemon required) |
| Pairing | EFF-wordlist 4-word passphrase OR QR code; ephemeral mTLS session |
| Transport | self-signed ECDSA P-256, TOFU certificate pinning by SHA-256, WebSocket |
| Protocol | `SyncMessage` enum carrying `LoroSyncMessage::{Snapshot, Update}` per space |
| Scheduler | per-peer exponential backoff with jitter, lifecycle-gated |

## Discovery

mDNS service type `_agaric._tcp.local.`. Each device announces its `device_id` and port; peers browse and resolve. **No Avahi dependency** — `mdns-sd` does everything in-process.

Manual fallback: `peer_refs.last_address` (`host:port`) for peers that mDNS can't see (cross-subnet, VPN, firewall). The pairing dialog has a manual-entry path.

**Android mDNS requires a WifiManager `MulticastLock`** — Android disables multicast by default to save battery. `sync_daemon/android_multicast.rs` holds the lock for the daemon's lifetime via RAII (JNI bridge). Without it, Android peers can broadcast but not receive mDNS replies; symptom is "phones don't find each other on the same network".

The required Android manifest permissions are `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE`.

## Pairing

5-minute timer (paused while either side is typing). The session establishes:

1. EFF-wordlist 4-word passphrase displayed on Device A. QR code is the same passphrase encoded.
2. Device B enters the passphrase (camera scan or manual). Both sides derive a shared symmetric key from the passphrase.
3. Devices exchange self-signed ECDSA P-256 certificates over a brief mTLS session keyed by the passphrase. Each side pins the other's certificate by SHA-256 into `peer_refs.cert_hash` (TOFU — first contact wins).
4. After pairing, the passphrase is discarded. All subsequent connections use the pinned certs.

**Rejected alternatives**: persistent shared passphrase (security: passphrase theft = forever access), SPAKE2 (no good Rust impl; complexity not worth it for the threat model).

If you re-install Agaric on a peer, its certificate hash changes — you'll need to unpair and re-pair. Pairing isn't a recovery flow for "I lost my keys"; it's first-contact establishment.

## Transport

- **TLS** with self-signed ECDSA P-256 (`CN=agaric-{device_id}`). `rcgen` generates the cert; private key in OS keychain via `keyring` crate.
- **Certificate pinning.** `PinningCertVerifier` rejects any cert whose SHA-256 doesn't match `peer_refs.cert_hash`. Also enforces `CN=agaric-{expected_device_id}` so a cert swap with a matching hash but mismatched CN fails.
- **Self-device guard.** Prevents talking to your own announced service in mDNS loopback scenarios.
- **WebSocket framing.** `MAX_MSG_SIZE = 10_000_000` bytes per WS frame; `BINARY_FRAME_CHUNK_SIZE = 5_000_000` for snapshot + attachment transfer (the actual chunk unit).
- **Timeouts.** `HANDSHAKE_TIMEOUT` (per-`handle_message` budget) is shorter than `RECV_TIMEOUT` (overall idle); a compile-time assertion enforces the ordering.

## Protocol

`SyncMessage` (`src-tauri/src/sync_protocol/types.rs`) is the envelope. The streaming-phase variant is `LoroSync { msg: LoroSyncMessage, is_last: bool }`. `LoroSyncMessage::{Snapshot, Update}` carries the actual CRDT bytes per `SpaceId`. `from_vv` (version-vector floor) lets the responder send only ops the initiator is missing.

**State machine.** `Idle → ExchangingHeads → StreamingOps → ApplyingOps → Merging → TransferringFiles → Complete`. The names predate Loro and survive even though the streaming phase no longer carries individual ops — they now wrap Loro messages.

`LORO_SYNC_PROTOCOL_VERSION` envelope guards cross-version peers; mismatched versions surface a non-retryable failure.

### Loro sync flow

1. **Head exchange.** Each side sends its frontier (`{device_id → seq}` per space).
2. **Engine computes delta.** Loro's `oplog_vv()` diff between local and peer-frontier yields the export envelope. No `compute_ops_to_send` — the engine owns it.
3. **Push.** Sender exports `LoroDoc::export(ExportMode::Snapshot | Updates(peer_vv))`, ships as `LoroSyncMessage`.
4. **Apply.** Receiver imports into per-space `LoroEngine`. Materializer projects engine state into SQL primary state post-import.
5. **`is_last: true`** transitions both sides to `SyncComplete`.
6. **File-transfer phase** (PEND-06 Tier 2) ships attachment blobs in 5 MB binary frames after op convergence.

## Snapshot catch-up (FEAT-6)

When the initiator's frontier is older than the responder's compaction point (the responder has GC'd the relevant op-log entries), the responder sends a full **snapshot** instead of replaying ops:

1. Responder emits `SnapshotOffer { size_bytes, up_to_hash }`.
2. Initiator enforces a 256 MB cap; accepts → `SnapshotAccept`; rejects → falls back to "manual re-sync" UX.
3. Responder streams the snapshot in 5 MB binary frames.
4. Initiator calls `apply_snapshot()`: wipes core tables + materialised caches in one `BEGIN IMMEDIATE` + `defer_foreign_keys` transaction, restores the snapshot, then advances `peer_refs.last_hash` to `up_to_hash`.

The snapshot atomicity is the cross-link to [`crdt-and-recovery.md § Snapshots`](crdt-and-recovery.md).

## Daemon

`sync_daemon/` runs a long-lived task with a `tokio::select!` over:

- **mDNS browse stream** — new peer announcements.
- **`SyncTrigger` channel** — change-triggered sync (debounced ~3 s).
- **Periodic resync tick** — coarse retry for missed change-trigger events.
- **Foreground notify** — wakes the loop on app-foreground transition.

### Dormant mode

If no paired peers exist, the daemon defers mDNS browse + TLS listener entirely. Boot is cheaper on a fresh install; the daemon spawns a lightweight waiter that triggers full startup when the first pairing completes.

### Lifecycle-aware (PERF-24)

`LifecycleHooks` gates the periodic resync tick on `is_foreground`. Backgrounded → skip ticks until `wake.notified()` fires on foreground. This matters most on Android (battery + Doze) but also helps desktop laptops on battery.

## Dual-backoff

Two independent schedules, **intentionally not coordinated** (MAINT-168):

- **Backend** (`sync_scheduler.rs`): per-peer exponential 2 s → 4 s → 8 s → 16 s → 32 s → 60 s cap. ±10 % jitter so two devices don't lock-step on resync ticks. Per-peer mutex prevents concurrent connections to the same peer.
- **Frontend** (`useSyncTrigger.ts`): coarse 60 s → 600 s cadence for the UI's "wake the scheduler" hint. Backend is authoritative; mid-backoff `startSync()` from the FE resolves as a quick no-op.

The dual layer is deliberate: backend handles failure recovery; frontend handles "the user clicked Sync".

## `peer_refs` table

One row per paired peer (`device_id` PK):

- `cert_hash` — pinned TLS hash (TOFU on first pair).
- `last_address` — manual `host:port` override.
- `last_hash` — content hash from last successful sync; used as snapshot-catch-up watermark.
- `device_name` — display name.
- `reset_count` + `last_reset_at` — count + timestamp of how many times the peer issued a `ResetRequired` (forces full re-sync; useful for diagnostics).

## Tauri commands

Pairing + sync lifecycle:

- `start_pairing` / `confirm_pairing` / `cancel_pairing` — passphrase exchange.
- `start_sync` / `cancel_sync` — manual trigger / abort.
- `update_peer_name` / `set_peer_address` — peer rename + manual address.
- `get_peer_ref` — read a peer's state.

These plus the standard `inner_*` testable bodies live in `sync_cmds.rs`. The exact list drifts; canonical source is `agaric_commands!` in `lib.rs`.

## Android specifics

Same Rust backend + WebView shell as desktop (Tauri 2 mobile). Architectural deltas:

- **mDNS multicast lock** as above.
- **Foreground-only sync** — Android Doze + battery saver kill background WebSocket connections aggressively. The daemon defers all work via `LifecycleHooks` when backgrounded; sync resumes on foreground.
- **ABI matrix**: ARM64 device + x86_64 emulator. 32-bit ABIs (armv7, i686) are intentionally not supported.
- **DB path**: `/data/data/com.agaric.app/notes.db` (Android-managed app-private storage; no sdcard).
- **QR scanner**: `html5-qrcode`; `CAMERA` permission requested at runtime. Manual 4-word passphrase fallback always works.

## Operator notes

Local firewall must allow inbound TCP on Agaric's port (random on first launch, persisted in `peer_refs`). The user-facing setup snippets live in [`docs/features/sync.md § Pitfalls`](../features/sync.md) and [`docs/BUILD.md`](../BUILD.md).
