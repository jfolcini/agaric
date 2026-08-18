<!-- markdownlint-disable MD060 -->
# Sync, Networking, Android

Local-WiFi peer-to-peer sync over QUIC (iroh) carrying Loro CRDT messages. No cloud, no relay, no accounts.

Companion to [`docs/features/sync.md`](../features/sync.md) (user perspective) and [`crdt-and-recovery.md`](crdt-and-recovery.md) (the Loro engine itself + snapshot atomicity).

## Stack

| Layer | Choice |
| --- | --- |
| Discovery | mDNS via `mdns-sd` (pure Rust, no Avahi/Bonjour daemon required) |
| Pairing | EFF-wordlist 4-word passphrase OR QR code; the passphrase proof rides inside the first `HeadExchange` (#855) |
| Transport | iroh QUIC over **UDP**; peer identity is an ed25519 `EndpointId` authenticated by the TLS 1.3 handshake inside the QUIC handshake |
| Protocol | `SyncMessage` enum carrying `LoroSyncMessage::{Snapshot, Update}` per space |
| Scheduler | per-peer exponential backoff with jitter, lifecycle-gated |

## Discovery

mDNS service type `_agaric._udp.local.` (`src-tauri/agaric-sync/src/mdns.rs`). Each device announces its `device_id` **and its iroh `endpoint_id`**, plus the port; peers browse and resolve. **No Avahi dependency** — `mdns-sd` does everything in-process.

Both TXT keys are load-bearing and neither is trusted. `endpoint_id` (the ed25519 public key, written in `Display` form: 64 lowercase hex characters) is the only part you can dial — mDNS supplies the rest of an iroh `EndpointAddr` via the A and SRV records. `device_id` is the op-log attribution key and what `peer_refs` rows are stored under, so a discovering peer can match a hit against a known row before spending a dial. A record with no parseable `endpoint_id` is ignored rather than surfaced: it names a peer without addressing it. Anyone on the LAN can forge either field; the pin is checked against the handshake-authenticated `EndpointId`, so a forged record costs a failed dial, not a session.

`_udp`, not `_tcp`, because the advertised service is a QUIC endpoint (#3488). **This is a silent wire break**: a device on either side of the change does not see one on the other — the browse key differs, so no event fires and no error is raised. The ALPN change in the same port already forbids a cross-release *session*, which is what makes the break harmless, but it happens after the dial and so cannot report this one.

Manual fallback: `peer_refs.last_address` (`host:port`) for **already-paired** peers that mDNS has not surfaced — a fresh start against a peer that has not announced yet — set per row in `PeerListItem.tsx`. It is **not** a cross-subnet or VPN route: `lan_only` calls `clear_ip_transports()` and binds one subnet with `set_is_default_route(false)`, so iroh's longest-prefix egress match leaves an off-subnet destination with no socket at all (`transport/endpoint.rs`). The reachable set is the same subnet either way; the fallback only removes the dependency on multicast within it. Under iroh this fallback needs **both halves** — `resolve_peer_address` (`sync_daemon/discovery.rs`) only builds a dialable peer when the row has a cached address *and* a bound `endpoint_id`, because a dial names a key and addresses are only candidate paths to it. A row with an address and no key resolves a peer nothing can dial, which is worse than resolving nothing: `try_sync_with_peer` then bails before it records a failure or emits an event, so the peer silently never syncs.

This fallback does not exist for a *first-ever* pair: `endpoint_id` is bound by TOFU (`bind_endpoint_id`) only after a successful first sync, a first sync requires a dial, and a dial requires an `endpoint_id`. Both TOFU sites bind only after the session settles — `server.rs` on the responder, `session_supervisor.rs` on the initiator — so the key a dial needs cannot come from the session that dial would open. Before a session exists, the mDNS TXT record is the only carrier of a peer's `endpoint_id` (`mdns.rs`); the QUIC handshake also names one, but only once you have already reached the peer. `lan_only` calls `clear_address_lookup()`, so iroh has no discovery of its own. The pairing dialog's manual mode (`entryMode: 'manual' | 'scan'` in `PairingDialog.tsx`) is passphrase entry vs. QR scan, not an address field, and the QR code deliberately carries only the passphrase — no host, no port, no key (`pairing.rs`). So on a network where mDNS multicast does not reach both devices (AP/client isolation, guest WiFi, multicast disabled, two subnets), a first pair cannot be completed by any route the UI exposes.

**Android mDNS requires a WifiManager `MulticastLock`** — Android disables multicast by default to save battery. `sync_daemon/android_multicast.rs` holds the lock for the daemon's lifetime via RAII (JNI bridge). Without it, Android peers can broadcast but not receive mDNS replies; symptom is "phones don't find each other on the same network".

The required Android manifest permissions are `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE`.

## Pairing

5-minute timer (paused while either side is typing). The session establishes:

1. EFF-wordlist 4-word passphrase displayed on Device A. QR code is the same passphrase encoded.
2. Device B enters the passphrase (camera scan or manual). Each side computes a domain-separated blake3 *proof* of the passphrase (`pairing::pairing_proof`, #855) — there is no derived symmetric key; the passphrase is never used to encrypt anything.
3. There is no certificate exchange any more. The QUIC handshake authenticates both ends' `EndpointId` (an ed25519 public key) before a single application byte moves, so identity is established by the transport rather than claimed in an application message. The initiator carries `HeadExchange.pairing_proof`; the responder admits the unpaired peer only when that proof matches the one it stored when it armed or confirmed the pairing, and *then* binds the handshake-authenticated key into `peer_refs.endpoint_id` (TOFU — first contact wins, `bind_endpoint_id`).
4. After pairing, the passphrase is discarded. All subsequent connections are recognised by the bound key.

**Identity is not authorization.** The handshake answers *which key is this*; it does not answer *may this key sync my vault* — anyone can generate a keypair. So the #855 proof, the S-1 unpaired gate, the S-5 per-peer lock, #2537 cancel ownership and the #1519 pending-pairing bridge all survive the port unchanged in purpose. What changed is the proof's *job*: from "stop a spoofed `CN=agaric-{victim}` being pinned as the victim" to "authorize a genuine but unknown key". Narrower, still load-bearing.

**Rejected alternatives**: persistent shared passphrase (security: passphrase theft = forever access), SPAKE2 (no good Rust impl; complexity not worth it for the threat model).

If a peer's app data directory is wiped (a clean re-install), `sync-endpoint.key` is regenerated and the device comes back with a different `EndpointId`. The initiator's pinned-identity check (`try_sync_with_peer` step 4) refuses the announcement rather than re-binding, so you'll need to unpair and re-pair. Pairing isn't a recovery flow for "I lost my keys"; it's first-contact establishment.

**Migrated installs re-TOFU once (#3514).** Migration `0107_peer_refs_endpoint_id` adds the column but cannot backfill it — a cert hash does not yield an ed25519 key — so every pre-cutover pair upgrades with `endpoint_id IS NULL`. The responder recognises nobody until a binding exists; the bootstrap is the *initiator's*, which matches an mDNS-announced `device_id` against an existing row and binds the announced key. Both devices dial on the resync tick, so a pair re-binds within one tick. For the length of that window an mDNS record claiming a paired device's `device_id` could be bound instead of the real one. It is currently silent; see [`threat-model.md`](threat-model.md) § B3 for the trust-boundary entry.

## Transport

Everything below lives in `src-tauri/agaric-sync/src/transport/`. The retired mTLS/WebSocket stack — the `sync_net` modules, `sync_cert`, and `sync_daemon::wire` — was deleted outright in #3544, so the property "no production module reaches for it" is now enforced by the compiler rather than by a text-scanning guard test.

- **Endpoint** (`transport/endpoint.rs`). `lan_only` builds the iroh endpoint with relays disabled, relay transports and IP transports cleared, address lookup cleared, and a DNS resolver that answers nothing — so there is no route by which the endpoint reaches n0's infrastructure. The builder refuses a prefix broader than `MIN_IPV4_PREFIX_LEN` (`/8`) or `MIN_IPV6_PREFIX_LEN` (`/7`), and separately refuses a bind address in publicly-routable space — the prefix bounds how *broad* the confined block is, the second check bounds *where* it sits, and both are needed before "confined to a LAN" is true.
- **Identity** (`transport/identity.rs`). 32 raw ed25519 secret bytes, hex-encoded, one line, mode `0o600`, at `sync-endpoint.key` in the app data dir. Its own file rather than a field in the old cert PEM, because the identity outlives the transport. Hex rather than raw bytes so a truncated file is *detectable* instead of silently decoding to a different, valid-looking key. There is no OS keychain / `keyring` dependency; OS full-disk encryption is the confidentiality boundary.
- **Admission control** (`transport/service.rs`). ALPN `agaric/sync/0` — both ends must agree or the handshake fails before any application data moves. `MAX_CONCURRENT_RESPONDER_SESSIONS` (16) is carried unchanged from the old accept loop; its sizing is about the 6-connection DB pool those sessions draw on, not about handshake cost, which is why an over-capacity connection is **refused** (`Incoming::refuse`) rather than queued. The permit is taken *before* the handshake and released by `Drop`. Setup runs off the accept loop in a spawned `AdmittedConnection::establish`, bounded by `CONNECTION_SETUP_TIMEOUT` (10 s, the handshake) and `FIRST_FRAME_TIMEOUT` (180 s, the peer's first frame — which it cannot send until it has read its own heads out of the database).
- **Self-device guard.** Prevents talking to your own announced service in mDNS loopback scenarios: `should_attempt_sync_with_discovered_peer` drops a `device_id` equal to the local one, and the responder rejects a settled `remote_id` equal to its own.
- **Framing** (`transport/session.rs`). One `SyncMessage` is a `u32` big-endian length prefix plus a serde-JSON body on a QUIC bi-stream. `MAX_FRAME_SIZE` is `MAX_LORO_SYNC_PAYLOAD_SIZE` (256 MB) and is checked *before* a buffer is created; the buffer then grows in `BINARY_FRAME_CHUNK_SIZE` (5 MB) steps as bytes actually land, so a four-byte prefix cannot commit 256 MB. There is no chunking layer: a QUIC stream is a flow-controlled byte stream, so the only thing the transport still owes the protocol is where one message ends.
- **Bulk** (`transport/bulk.rs`). Snapshot blobs and attachment files are a plain copy loop on the same stream — one fixed `BULK_COPY_BYTES` (5 MB) buffer, `total_size` bounded against a caller-supplied cap before any read, progress ticked per buffer rather than per read. `BULK_IDLE_TIMEOUT` (180 s) is an **idle** bound reset per read, not a transfer bound.
- **Timeouts** (`transport/driver.rs`). `SessionLimits` carries three: `recv` (`RECV_TIMEOUT`, 180 s per awaited message), `dispatch` (`HANDSHAKE_TIMEOUT`, per `handle_message`), and `close_wait` (10 s). `dispatch` is deliberately shorter than `recv`, and a `#[test]` (`default_limits_are_the_values_carried_from_the_old_transport` in `transport/driver.rs`) pins the ordering; it is not a `const_assert!` because both values come from `Duration::from_secs`, which isn't usable in const context on the supported rustc range. The old stack's numbers moved with the responsibility rather than with the name — `TLS_HANDSHAKE_TIMEOUT` bounded `TlsAcceptor::accept` plus the WebSocket upgrade, machinery this port deletes, so its value is restated at each new site rather than imported.

### What the port cost

The port is not uniformly an improvement, and the regressions are load-bearing enough to name here rather than only on the issues.

- **No wire compression (#3512).** zstd lived in the retired chunking layer. `HeadExchange.wire_compression` advertised it; #3543 removed the field from the wire once it was established that nothing read the received value (the field was write-only — set `true` on send, destructured to `_` on receive). Loro payloads are a `Vec<u8>` inside a serde-JSON envelope, so they cost roughly **4 wire bytes per byte of CRDT state**, and that expansion is now paid in full. Against the 256 MB frame cap that puts the hard offer failure at roughly 64 MB of Loro state in one space — a much larger budget than the old 10 MB message ceiling, so not obviously a regression in reachable capacity, but a hard failure at a threshold nobody has measured, on a value that only grows.
- **Inbound is single-homed (#3513).** `lan_only` takes **one** bind address, so the daemon accepts on a single interface — the first RFC 1918 IPv4, with the prefix taken from its netmask. A desktop on both WiFi and Ethernet accepts on whichever the enumeration picks first. The *outbound* half genuinely improved: `EndpointAddr` carries every advertised address at once and iroh races them, so one `CONNECT_TIMEOUT` now covers all candidates where the old sequential loop paid one per address.
- **Dead peers cost 10 s (#3515).** TCP refused a connection to a closed port instantly. UDP gives no response at all, so a dial to a departed peer burns the full `CONNECT_TIMEOUT` (10 s). Branch B awaits its `JoinSet` inline (#490 M3), so an app quit can wait on a doomed dial.
- **The S-5 lock key was asymmetric during the pairing window (#3511, fixed).** `HeadExchange` carries no `device_id`, and a fresh joiner with an empty op log advertises no head of its own, so the responder had nothing but the endpoint id to lock on until a binding existed — while the initiator locked on the device id. An inbound and an outbound session with the same device could therefore overlap for exactly the window in which both ends are most likely to dial simultaneously. The old stack did not have this gap: the cert CN supplied a device id unconditionally. **Both roles now key on the peer's `EndpointId`** (`sync_daemon::peer_lock_key`), which is the only identifier both hold unconditionally — the responder from the handshake, the initiator because it cannot dial without one. No wire change; see #3529 for why `EndpointId` is the right key for anything that must work *during* pairing, and why `device_id` stays the durable identity everywhere else.

### What the port did not fix

**First-ever pairing initiation (#3502) — fixed separately, in #3535.** `process_discovery_event`, the three initiation branches and `should_attempt_sync_with_discovered_peer` are daemon *policy*, not transport; the cutover replaced how bytes move and touched none of them, so the defect survived the port unchanged and had to be closed on its own.

The failure was that during a first-ever pair `peer_refs` is empty, so only the mDNS-resolve branch could start an outbound session — and its already-discovered short-circuit returned before `pairing_pending` was consulted, giving one initiation opportunity per peer per process lifetime, which the pairing dialog spent on open before the user had typed. #3535 reorders the clauses so a pending pairing outranks the already-discovered guard, and removes the matching short-circuit in `process_discovery_event`.

Nothing in this document should be read as saying the QUIC port *by itself* makes pairing work. A first-ever pair has since been observed against two live devices — a Linux desktop and an Android phone, both 0.9.8 — so the evidence is no longer unit tests alone. The run is recorded in [`session-1345`](../session-log/session-1345-first-live-pair-and-what-it-cost-to-believe-the-tools.md). Be precise about what it covers: pairing and the first inbound session, not a verified two-way sync, and only after a VPN tunnel and a default-deny host firewall were cleared on the desktop. The initiator-side apply that aborted on `blocks.parent_id` (#4083) was fixed afterwards and has not been re-exercised on hardware, so a full two-way sync remains unobserved (#3507).

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
6. **File-transfer phase** streams attachment blobs on the same QUIC stream after op convergence, copied through one 5 MB buffer (`BULK_COPY_BYTES`).

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

If no paired peers exist, the daemon defers mDNS browse + announce and the endpoint service entirely. Boot is cheaper on a fresh install; the daemon spawns a lightweight waiter that triggers full startup when the first pairing completes. The dormant-mode log line in `sync_daemon/mod.rs` names what is actually deferred — "mDNS and QUIC endpoint" — since #3526; nothing about *what* is deferred, or when, changed with the rename.

### Lifecycle-aware

`LifecycleHooks` gates the periodic resync tick on `is_foreground`. Backgrounded → skip ticks until `wake.notified()` fires on foreground. This matters most on Android (battery + Doze) but also helps desktop laptops on battery.

## Dual-backoff

Two independent schedules, **intentionally not coordinated**:

- **Backend** (`src-tauri/agaric-sync/src/sync_scheduler.rs`): per-peer exponential 2 s → 4 s → 8 s → 16 s → 32 s → `MAX_BACKOFF` (60 s) cap, with ±10 % jitter so two devices don't lock-step on resync ticks. A per-peer mutex prevents concurrent connections to the same peer.
- **Frontend** (`useSyncTrigger.ts`): coarse 60 s → 600 s cadence for the UI's "wake the scheduler" hint. Backend is authoritative; mid-backoff `startSync()` from the FE resolves as a quick no-op.

The dual layer is deliberate: backend handles failure recovery; frontend handles "the user clicked Sync".

## `peer_refs` table

One row per paired peer (`device_id` PK):

- `endpoint_id` — the peer's iroh `EndpointId`, 64 lowercase hex characters, bound on first successful session (TOFU). This is the pinned identity the responder resolves an inbound peer by (S-1) and the initiator checks an mDNS announcement against. Nullable: migration `0107` could not backfill it, so a migrated install starts with `NULL` here (see the re-TOFU note under Pairing). A column-level CHECK rejects the uppercase, base32 and `fmt_short()` spellings, because `FromStr` is deliberately laxer than `Display`. The CHECK can only ever restate the *shape*, though — SQLite has no curve arithmetic, and roughly half of all 64-hex strings are not decompressible ed25519 points. So the write path (`bind_endpoint_id`) parses the value into an `EndpointId` before storing it (#3561): the column's declared meaning and its contents are the same statement, rather than "64 hex characters" being read everywhere as "an endpoint id". Reads stay tolerant — `get_peer_ref` and `list_peer_refs` hand the column back verbatim — so a row written around the API stays visible and unpairable instead of becoming unreadable.
- `cert_hash` — the old pinned TLS hash. **Retained but dead**: nothing in production reads it since the cutover. Migrations are append-only, so deleting the old transport (#3544) did not take the column with it; it outlives the code that gave it meaning until a migration retires it explicitly.
- `last_address` — manual `host:port` override. Still written and still read, but only as one half of the mDNS-independent fallback: a row needs a bound `endpoint_id` too before it resolves a dialable peer.
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
- **Foreground-only sync** — Android Doze + battery saver kill background network connections aggressively; a QUIC/UDP session is no more survivable than the WebSocket it replaces. The daemon defers all work via `LifecycleHooks` when backgrounded; sync resumes on foreground.
- **QUIC/UDP on restrictive WiFi is unverified.** The Android half of this claim is retired: a first pair completed between a desktop and an Android phone over QUIC on a real LAN (session 1345). What that run did *not* exercise is a hostile network — AP/client isolation, multicast disabled, or two subnets — and it needed a VPN and a host firewall cleared before it worked at all, which is evidence that restrictive environments are where the remaining risk is. This gates release, not development (#3507).
- **ABI matrix**: ARM64 device + x86_64 emulator. 32-bit ABIs (armv7, i686) are intentionally not supported.
- **DB path**: `/data/data/com.agaric.app/notes.db` (Android-managed app-private storage; no sdcard).
- **QR scanner**: `html5-qrcode`; `CAMERA` permission requested at runtime. Manual 4-word passphrase fallback always works.

## Operator notes

Local firewall must allow inbound **UDP** — QUIC is UDP, so a rule written for TCP lets nothing through and the symptom looks like a sync bug rather than a firewall one. mDNS additionally needs UDP 5353.

The port is **not stable across launches**: `lan_bind_target` binds `(interface_ip, 0)`, so the OS assigns an ephemeral port each start and the daemon announces whatever it got over mDNS. A firewall rule therefore has to be written against the application, not against a fixed port number. `lan_bind_target` also picks **one** interface (#3513). It no longer picks the first RFC 1918 address: that loop was the #3853 bug, and it is worth knowing why, because it skipped a `192.160.160.0/24` LAN — public address space that looks private — and bound a Docker bridge instead. Selection now runs `lan_interface::decide`, which classifies every enumerated address (physical before cellular before virtual, CGNAT deprioritised) and prefers the one the default route leaves from. The loopback fallback survives for the case where nothing usable is found at all, and still binds and accepts nothing from outside.

The user-facing setup snippets live in [`docs/features/sync.md § Pitfalls`](../features/sync.md) and [`docs/BUILD.md`](../BUILD.md).
