<!-- markdownlint-disable MD060 -->
# Sync, Networking, Android

Local-WiFi peer-to-peer sync carrying Loro CRDT messages. No cloud, no relay, no accounts. (Transport: QUIC via `iroh` since #3464; the Transport and Stack sections below still describe the retired mTLS/WebSocket stack.)

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

mDNS service type `_agaric._udp.local.` (`src-tauri/agaric-sync/src/mdns.rs`). Each device announces its `device_id` **and its iroh `endpoint_id`**, plus the port; peers browse and resolve. **No Avahi dependency** — `mdns-sd` does everything in-process.

Both TXT keys are load-bearing and neither is trusted. `endpoint_id` (the ed25519 public key, written in `Display` form: 64 lowercase hex characters) is the only part you can dial — mDNS supplies the rest of an iroh `EndpointAddr` via the A and SRV records. `device_id` is the op-log attribution key and what `peer_refs` rows are stored under, so a discovering peer can match a hit against a known row before spending a dial. A record with no parseable `endpoint_id` is ignored rather than surfaced: it names a peer without addressing it. Anyone on the LAN can forge either field; the pin is checked against the handshake-authenticated `EndpointId`, so a forged record costs a failed dial, not a session.

`_udp`, not `_tcp`, because the advertised service is a QUIC endpoint (#3488). **This is a silent wire break**: a device on either side of the change does not see one on the other — the browse key differs, so no event fires and no error is raised. The ALPN change in the same port already forbids a cross-release *session*, which is what makes the break harmless, but it happens after the dial and so cannot report this one.

Manual fallback: `peer_refs.last_address` (`host:port`) for peers that mDNS can't see (cross-subnet, VPN, firewall). The pairing dialog has a manual-entry path.

**Android mDNS requires a WifiManager `MulticastLock`** — Android disables multicast by default to save battery. `sync_daemon/android_multicast.rs` holds the lock for the daemon's lifetime via RAII (JNI bridge). Without it, Android peers can broadcast but not receive mDNS replies; symptom is "phones don't find each other on the same network".

The required Android manifest permissions are `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE`.

## Pairing

5-minute timer (paused while either side is typing). The session establishes:

1. EFF-wordlist 4-word passphrase displayed on Device A. QR code is the same passphrase encoded.
2. Device B enters the passphrase (camera scan or manual). Each side computes a domain-separated blake3 *proof* of the passphrase (`pairing::pairing_proof`, #855) — there is no derived symmetric key; the passphrase is never used to encrypt anything.
3. Devices exchange self-signed ECDSA P-256 certificates as plaintext JSON over the WebSocket, whose confidentiality and authenticity come from the rustls mTLS + TOFU cert-pin layer (not from the passphrase). The responder pins the peer's certificate by SHA-256 into `peer_refs.cert_hash` (TOFU — first contact wins) only after the passphrase proof matches its own stored value, which closes the #855 CN-spoof window.
4. After pairing, the passphrase is discarded. All subsequent connections use the pinned certs.

**Rejected alternatives**: persistent shared passphrase (security: passphrase theft = forever access), SPAKE2 (no good Rust impl; complexity not worth it for the threat model).

If you re-install Agaric on a peer, its certificate hash changes — you'll need to unpair and re-pair. Pairing isn't a recovery flow for "I lost my keys"; it's first-contact establishment.

## Transport

> **Stale as of the iroh cutover (#3464).** The sync transport is now QUIC via
> `iroh` — `src-tauri/agaric-sync/src/transport/`. The mTLS/WebSocket stack this
> section describes (`sync_net`, `sync_cert`, `sync_daemon::wire`) has been
> deleted, and `peer_refs.cert_hash` is superseded by `peer_refs.endpoint_id`.
> The timeout bullet below is current; the rest is retained as a description of
> the pre-cutover design until this document is rewritten.

- **TLS** with self-signed ECDSA P-256 (`CN=agaric-{device_id}`). `rcgen` generates the cert; the cert and its private key are persisted together as a combined PEM file in the app data dir (`sync_cert.rs`, written owner-only `0600` — #1580). There is no OS keychain / `keyring` dependency; OS full-disk encryption is the confidentiality boundary.
- **Certificate pinning.** `PinningCertVerifier` rejects any cert whose SHA-256 doesn't match `peer_refs.cert_hash`. Also enforces `CN=agaric-{expected_device_id}` so a cert swap with a matching hash but mismatched CN fails.
- **Self-device guard.** Prevents talking to your own announced service in mDNS loopback scenarios.
- **WebSocket framing.** `MAX_MSG_SIZE = 10_000_000` bytes per WS frame; `BINARY_FRAME_CHUNK_SIZE = 5_000_000` for snapshot + attachment transfer (the actual chunk unit).
- **Timeouts.** `HANDSHAKE_TIMEOUT` (per-`handle_message` budget) is shorter than `RECV_TIMEOUT` (overall idle); a `#[test]` (`default_limits_are_the_values_carried_from_the_old_transport` in `src-tauri/agaric-sync/src/transport/driver.rs`) enforces the ordering on `SessionLimits`. Not a `const_assert!` because both values come from `Duration::from_secs`, which isn't usable in const context on the supported rustc range.

## Protocol

`SyncMessage` (`src-tauri/agaric-sync/src/sync_protocol/types.rs`) is the envelope. The streaming-phase variant is `LoroSync { msg: LoroSyncMessage, is_last: bool }`. `LoroSyncMessage::{Snapshot, Update}` carries the actual CRDT bytes per `SpaceId`. `from_vv` (version-vector floor) lets the responder send only ops the initiator is missing.

**State machine.** `Idle → ExchangingHeads → StreamingOps → ApplyingOps → Merging → TransferringFiles → Complete`. The names predate Loro and survive even though the streaming phase no longer carries individual ops — they now wrap Loro messages.

`LORO_SYNC_PROTOCOL_VERSION` envelope guards cross-version peers; mismatched versions surface a non-retryable failure.

### Loro sync flow

1. **Head exchange.** The initiator sends its per-space frontier (`{device_id → seq}`) **and** its per-space Loro version vectors (`HeadExchange.loro_vvs`, collected by `collect_local_loro_vvs`). The responder uses each advertised vv to pick an incremental `Update` (delta since that vv) over a full `Snapshot`, per space — incremental sync is live, not aspirational.
2. **Engine computes delta.** Loro's `oplog_vv()` diff between local and peer-frontier yields the export envelope. No `compute_ops_to_send` — the engine owns it.
3. **Push.** Sender exports `LoroDoc::export(ExportMode::Snapshot | Updates(peer_vv))`, ships as `LoroSyncMessage`.
4. **Apply.** Receiver imports into per-space `LoroEngine`. Materializer projects engine state into SQL primary state post-import.
5. **`is_last: true`** transitions both sides to `SyncComplete`.
6. **File-transfer phase** ships attachment blobs in 5 MB binary frames after op convergence.

## Snapshot catch-up

When the responder cannot satisfy the initiator's advertised version vectors by delta replay, the session exits the delta loop into `ResetRequired` and hands off to `sync_daemon/snapshot_transfer.rs`.

Since **#2503** the production catch-up is a **Loro-snapshot merge**, not a wipe-and-replace: the responder exports a per-space `LoroDoc` snapshot, the initiator *merges* it into its own engine and reprojects SQL from the merged state. Loro import is monotonic, so it never rolls the receiver back and the initiator's unsynced local content **survives** — the exact inversion of the old CBOR contract.

The legacy CBOR path (`SnapshotOffer` / `SnapshotAccept` / `SnapshotReject` → `apply_snapshot()`, which wipes core tables and re-seeds from the blob) is retained on the **accept-old** receive branch only, for a peer that predates #2503. It is never offered by a current responder. What that destructive branch still costs the receiving device is documented in [`crdt-and-recovery.md § What a catch-up RESET costs the caught-up device`](crdt-and-recovery.md); the wire-level detail is in [`sync-protocol-spec.md § Snapshot-fallback flow`](sync-protocol-spec.md).

## Daemon

`src-tauri/agaric-sync/src/sync_daemon/` runs a long-lived task with a `tokio::select!` over:

- **mDNS browse stream** — new peer announcements.
- **`SyncTrigger` channel** — change-triggered sync (debounced ~3 s).
- **Periodic resync tick** — coarse retry for missed change-trigger events.
- **Foreground notify** — wakes the loop on app-foreground transition.

### Dormant mode

If no paired peers exist, the daemon defers mDNS browse + TLS listener entirely. Boot is cheaper on a fresh install; the daemon spawns a lightweight waiter that triggers full startup when the first pairing completes.

### Lifecycle-aware

`LifecycleHooks` gates the periodic resync tick on `is_foreground`. Backgrounded → skip ticks until `wake.notified()` fires on foreground. This matters most on Android (battery + Doze) but also helps desktop laptops on battery.

## Dual-backoff

Two independent schedules, **intentionally not coordinated**:

- **Backend** (`src-tauri/agaric-sync/src/sync_scheduler.rs`): per-peer exponential 2 s → 4 s → 8 s → 16 s → 32 s → `MAX_BACKOFF` (60 s) cap, with ±10 % jitter so two devices don't lock-step on resync ticks. A per-peer mutex prevents concurrent connections to the same peer.
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
