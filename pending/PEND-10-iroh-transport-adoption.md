# PEND-10 — iroh transport adoption (P2P over QUIC with NAT traversal)

## Decision recap

The user has approved adopting **iroh** as the sync transport layer to enable cross-WiFi sync (cellular ↔ home, work ↔ home, etc.). iroh is a P2P networking stack built on QUIC with built-in NAT traversal, hole-punching, and relay fallback. Pure Rust, MIT/Apache-2.0 dual-licensed, actively maintained by n0.

**Scope: transport only.** iroh replaces the existing mDNS+WebSocket+TLS+TOFU+pairing stack. The merge layer (diffy, conflict copies, `is_conflict` schema) stays unchanged — a future CRDT migration is a separate, independent decision (not currently scoped in `pending/`). The op-batch protocol shapes (`HeadExchange`, `OpBatch`, `SyncComplete`, etc.) stay; they just ride over iroh's QUIC streams instead of `tokio-tungstenite`.

**Rationale:** the current stack is LAN-only by design. Users cannot sync between a phone on cellular and a desktop at home without being on the same WiFi. iroh solves this with transparent NAT traversal and relay fallback (n0's relay servers as a safety net when direct connection fails). The threat model doesn't change — still single-user, no adversaries, TOFU-style device pairing.

## What iroh is + what we'd use from it

iroh is a modular P2P stack. Agaric would consume:

- **iroh-net** (core transport): `Endpoint` (the listening/connecting node), `NodeId` (derived from a `SecretKey`, replaces cert hashes), `NodeAddr` (addresses + relay info), QUIC streams (replace WebSocket frames).
- **iroh-blobs** (recommended): content-addressed blob sync with built-in integrity verification. Replaces the current chunked binary-frame file transfer in `sync_files/` + `snapshot_transfer.rs`. One mechanism for both files and snapshots.
- **iroh tickets** (PKCE-style invite codes): `NodeId` + relay addresses encoded in a shareable ticket. Replaces the current passphrase+QR flow. Tickets can be shared as QR codes or text.
- **iroh's discovery** (mDNS-like but built-in): local peer discovery. iroh has its own LAN discovery, no need for the standalone `mdns-sd` crate. Relay addresses are baked into tickets.

## Mapping: current → iroh

| Current | iroh | Notes |
| --- | --- | --- |
| mDNS service announce (`_agaric._tcp.local.`) | iroh discovery + tickets | Tickets encode `NodeId` + relay addrs; no separate service type needed |
| mTLS+TOFU+CN verification | `NodeId`-based auth (intrinsic to QUIC) | The `SecretKey` IS the identity; `NodeId` is derived. No cert generation. |
| WebSocket binary frames | QUIC streams (multiple per session) | Streaming semantics unchanged; framing layer differs |
| 4-word passphrase + QR pairing (post-MAINT-110: plaintext JSON over mTLS) | iroh tickets via QR or text | Tickets are ~100-200 chars (verify in spike); QR-scannable |
| `sync_files/` chunked binary transfer | iroh-blobs (content-addressed) | Hashes verify integrity; atomic transfers; one mechanism for files + snapshots |
| `snapshot_transfer.rs` binary frame exchange | iroh-blobs | Same as above |
| `sync_protocol/types.rs` message shapes | unchanged, ride QUIC streams | `HeadExchange`, `OpBatch`, `SyncComplete` etc. stay; just over QUIC |
| `peer_refs.cert_hash` column | `peer_refs.node_id` column | Schema migration; `NodeId` is a string (base32-encoded public key) |

## What stays unchanged

- **`sync_protocol/` (state machine + message shapes):** `SyncOrchestrator`, `SyncState`, `SyncMessage`, `OpTransfer` — all stay. Transport-agnostic.
- **`sync_scheduler.rs` (backoff logic):** unchanged.
- **`sync_events.rs` (event sink trait):** unchanged.
- **`sync_daemon/orchestrator.rs` (per-peer locking, session lifecycle):** stays; just calls iroh APIs instead of mDNS + WebSocket.
- **Op log, materializer, merge engine:** unchanged.
- **Threat model:** single-user, no adversaries, TOFU-style device pairing. Same as today.

## Phased plan

### Phase 0 — Spike (3 weeks / 15-21 person-days, hard time-box)

Prototype two iroh nodes on two machines, exchange synthetic `OpBatch` payloads end-to-end, verify tickets work, test across-LAN and across-NAT.

**Deliverables:**

1. A standalone `iroh-spike` crate (or feature-gated module) that:
   - Brings up two iroh `Endpoint`s.
   - Generates a ticket on one side, shares it (QR or text) to the other.
   - Establishes a QUIC connection via the ticket.
   - Exchanges 1 MB of synthetic `OpBatch` JSON over a QUIC stream.
   - Measures handshake latency, throughput, memory footprint.
2. Test scenarios:
   - **LAN direct:** both nodes on same WiFi, direct connection.
   - **NAT fallback:** one node behind home NAT, the other on public internet, relay-assisted connection.
   - **Ticket lifecycle:** generate, encode QR, decode, connect, verify peer `NodeId`.
3. Measurements:
   - Handshake latency (LAN direct, NAT relay).
   - Throughput (1 MB payload, LAN vs relay).
   - Memory footprint at idle (after connection closes).
   - Relay fallback behavior (force direct failure, verify relay kicks in).

**Kill criteria — measurable, no subjective bars. Any one fires → kill the migration.**

1. **(a) iroh wire-format + minor-version churn.** Verify in spike that a stable `iroh 1.x.y` is published on crates.io and the spike compiles + runs against that pin (no 0.x dependency leaks). The spike must produce (i) the concrete `iroh = "=1.x.y"` pin and the commit hash, (ii) a documented re-evaluation cadence for minor bumps, (iii) a scan of the v1.0 release notes for any post-1.0 wire-format break announcements. **Kill if any of:** iroh is still 0.x at spike completion; a documented wire-format break with no upgrade path lands between the pin and the chosen release; the spike cannot compile against a stable `1.x.y` for any reason.
2. **(b) Transport handshake works end-to-end.** Two iroh nodes on the same LAN connect and exchange a 1 MB `OpBatch` payload in **<2 seconds**. Across NAT (one node behind home NAT, the other on public internet) connect and exchange same payload via relay in **<5 seconds**.
3. **(c) Compatible license.** iroh + iroh-blobs are MIT or Apache-2.0 (compatible with Agaric's GPL-3.0-or-later). Any GPL-incompatible deps in the iroh tree → kill.
4. **(d) Ticket flow is human-acceptable.** A ticket can be shared via QR code (visual length, scannable on a phone screen) and via text paste (length, no whitespace gotchas). **If tickets are 500+ chars or break on paste, kill** (pairing UX gap forces a fallback design).
5. **(e) Memory + binary size acceptable.** iroh adds **<5 MB to the Agaric binary** AND **<20 MB peak memory at idle**.
6. **(f) Relay dependency is documented.** Verify: (i) self-host story (can users run their own relay?), (ii) LAN-only mode exists (users who never want traffic off-LAN can opt out), (iii) relay fallback is transparent (no user-visible "relay mode" UI).

If any kill criterion fires: archive the spike crate, document the failing criterion in this file, return PEND-10 to "deferred" state.

### Phase 1 — Shadow / parallel transport (2-3 weeks)

Land iroh as a **second transport** alongside the existing mDNS+WebSocket stack. Behind a feature flag. New paired devices can opt into iroh; existing pairs keep WebSocket+mDNS.

**Deliverables:**

1. New `src-tauri/src/sync_net/iroh.rs` module (or `sync_net_iroh/`) with:
   - `IrohEndpoint` wrapper (manages the iroh `Endpoint` lifecycle).
   - `IrohConnection` abstraction (QUIC stream, mirrors `SyncConnection` API: `send_json`, `recv_json`, `send_binary`, `recv_binary`).
   - Ticket generation, encoding, decoding.
   - Local discovery via iroh's built-in mDNS.
2. Schema migration: add `node_id` (nullable, iroh-only) and `transport_preference` (enum: `WebSocket`, `Iroh`, `Auto`) columns to `peer_refs`.
3. Modify `sync_daemon/orchestrator.rs` to:
   - Try iroh first if `transport_preference == Iroh` or `node_id` is set.
   - Fall back to WebSocket if iroh fails or `transport_preference == WebSocket`.
   - On successful iroh connection, record the `NodeId` in `peer_refs.node_id`.
4. Pairing flow: after successful pairing, generate an iroh ticket and offer it as an alternative to (or replacement for) the QR.
5. Tests: unit tests for ticket encode/decode, integration tests for iroh connection + op exchange.

**Reversibility:** iroh is opt-in; WebSocket stays as fallback. Disable the feature flag and revert to WebSocket-only.

### Phase 2 — Cutover (2-3 weeks)

iroh becomes the default transport. WebSocket+mDNS stays as fallback for one release.

**Deliverables:**

1. Flip the default: `transport_preference` defaults to `Iroh` for new pairs.
2. Migration of existing peers — choose ONE:
   - **Option A:** on first sync with an existing peer, derive a temporary `NodeId` from the cert hash deterministically. Store it. On natural re-pair, generate a fresh `NodeId`.
   - **Option B (recommended):** require a one-time re-pair step. UI prompt: "This device now uses a new pairing method. Scan the new QR code on your other device." Cleaner code; one-time UX cost.
3. Pairing UX: replace 4-word passphrase + QR with iroh ticket QR (or ticket text, user choice).
4. Tests: verify existing WebSocket peers still sync via fallback; verify new iroh peers sync via iroh.

**Reversibility:** WebSocket fallback stays. Critical bug → flip the default back.

### Phase 3 — Cleanup (4-6 weeks)

Delete the old transport stack.

**Deliverables:**

| File / module | LOC (verified) |
| --- | --- |
| `src-tauri/src/sync_net/` (mod.rs, connection.rs, tls.rs, websocket.rs, tests.rs) | **3,128** |
| `src-tauri/src/sync_daemon/server.rs` (WebSocket responder) | **376** |
| `src-tauri/src/sync_daemon/discovery.rs` (mDNS peer discovery) | **283** |
| `src-tauri/src/sync_daemon/snapshot_transfer.rs` (binary frame chunking) | **1,824** |
| `src-tauri/src/sync_daemon/android_multicast.rs` (JNI multicast lock) | **227** |
| `src-tauri/src/sync_cert.rs` (TLS cert generation/persistence) | **786** |
| `src-tauri/src/pairing.rs` (passphrase + QR) | **625** |
| `src-tauri/src/sync_files.rs` (root file) | **1,326** |
| `src-tauri/src/sync_daemon/tests.rs` | **3,797** |
| `src-tauri/src/sync_files/tests.rs` | **2,368** |

`Cargo.toml`: remove `mdns-sd`, `tokio-tungstenite`, `rustls`, `tokio-rustls`, `rcgen`, `x509-parser`, `sha2` (used **only** for cert-pin hashing in `sync_net/tls.rs` + `sync_net/websocket.rs` — verified; blake3 stays for op-log hash chain), `qrcode`, `if-addrs`. Add `iroh`, `iroh-blobs` (and any iroh-net split-out — verify the actual crate names + count in spike).

Schema migration: drop `peer_refs.cert_hash` (or keep one release, drop in Phase 4).

Delete the per-file test modules (`#[cfg(test)] mod tests`) inside each deleted source file in addition to the standalone test files above.

**Reversibility:** none. Commit only after Phase 2 stabilizes.

**Total LOC deleted: ~14,740** (including `sync_daemon/tests.rs` ~3,797 LOC and `sync_files/tests.rs` ~2,368 LOC; numbers refreshed 2026-05-17 via `wc -l`). **Added: ~2-3k LOC** (iroh module + integration glue). **Net delete: ~12k LOC.**

### Phase 4 (optional) — Drop the WebSocket fallback (1 release later)

One full release after Phase 2, remove WebSocket fallback entirely. Delete `transport_preference` column. Simplify pairing flow.

**Rationale:** frees binary size, removes maintenance burden. Only after a full release with iroh as default.

## What changes for the user

1. **Sync works across WiFi networks.** Cellular ↔ home, work ↔ home. No need to be on the same private network.
2. **First-pair UX:** "Scan ticket QR" instead of "type 4-word passphrase + accept QR scan." Simpler, faster.
3. **Re-pair after device reinstall:** new `NodeId`; user has to re-issue a ticket. Same UX cost as today's TOFU re-pin.
4. **Offline LAN sync still works:** if both devices are on the same LAN, iroh connects directly (no relay). Relay only kicks in when direct connection fails.

## Risks

| Risk | Mitigation |
| --- | --- |
| **iroh minor-version churn (post-1.0)** | Pin to a specific `1.x.y` and re-evaluate every minor. Wire-format stability is in effect under semver from the v1.0 line; this is now a normal maintenance cost, not a headline risk. |
| **Relay dependency on n0.computer** | Verify self-host + LAN-only options in spike (kill criterion (f)). LAN sync still works direct if relays go down. |
| **Relay metadata leak** (NodeId + traffic timing visible to relay operator) | Document explicitly in user-facing settings: "When sync uses relay (cross-WiFi), n0's relay servers can see your device's NodeId, the timing of your sync sessions, and the byte sizes of your messages — not the contents (QUIC encrypts those). Use 'LAN-only' mode in Settings to disable relays." Same threat model floor (single-user, no adversaries), but the user should be informed. |
| **n0 (relay operator) goes out of business / is compromised** | LAN-only mode (kill criterion (f)) is the durable fallback — sync continues to work over LAN regardless of relay status. Self-host story (also (f)) is the user's escape hatch for cross-WiFi if n0 disappears. |
| **Ticket sharing reveals `NodeId` publicly** | Tickets should be shared via trusted channels (QR in person; secure messenger; not a public posting). Same threat model — single-user, no adversaries — so disclosed NodeId is not a vulnerability per se. Document. |
| **Existing paired peers must re-pair** | Phase 2 Option B: explicit one-time re-pair UX. Migration is a single user-facing prompt per device pair. For users with N>2 paired devices, N-1 re-pairs needed; document this cost up front. |
| **iroh-blobs vs current chunked transfer semantics** | Spike validates resumable transfer + integrity + atomicity behavior. Phase 1 keeps both side-by-side for parity. |
| **Android long-lived QUIC + Doze/battery optimization** | iroh has Android support, but Doze + adaptive battery can kill long-lived connections without notice. Mitigation: foreground service is already required by Tauri Android for the existing sync_daemon, so the constraint is a continuation, not new. **Spike must explicitly test:** background app + screen-off + sync-attempt-resume — does iroh recover, or does the connection die unrecoverably? |
| **Tauri plugin requirement** | Verify in spike: does iroh need a `tauri-plugin-iroh` (and does one exist), or does it work as a regular crate via Tauri commands? If a plugin is required and doesn't exist, scope expands to write one. |
| **Loss of "must be on same WiFi" UX safety property** | LAN-only mode in iroh (kill criterion (f)). Settings toggle in Phase 1+2 for users who want to disable relays. **Verify the LAN-only mode actually exists and is documented before Phase 1 starts** (early kill check). |
| **Snapshot + file transfer atomicity changes** | iroh-blobs is content-addressed; integrity checks built-in. Spike validates atomicity / partial-transfer recovery, especially for snapshots (where atomicity matters most). |
| **Wire format breaking change between iroh versions** | Pin a specific minor (kill criterion (a)). The op_log payload format is independent of iroh's wire format, so iroh format changes only matter for live sync, not stored state. |
| **Existing op_log entries refer to peers via cert_hash** | Verify in Phase 1 whether the op_log has any cert_hash-keyed references that need migrating, OR confirm peer references in op_log are device_id (a separate identifier from cert_hash). If migration is needed, write migration 0042 in Phase 1 not Phase 3. |
| **Pairing UI mid-migration** (one device on Phase 2, the other on Phase 1) | Phase 1 + 2 must coexist gracefully: a device that's been upgraded to Phase 2 (iroh-default) should still recognize a Phase 1 device that's still presenting the old WebSocket+passphrase pairing. Test this explicitly. |
| **CI integration testing for iroh** | iroh integration tests need network access. The existing CI runs nextest on linux-only; verify whether iroh tests run there or whether they need to be marked `#[ignore]` and run only locally. May need a separate "iroh-network-tests" CI job. |
| **`SecretKey` storage and reinstall flow** | iroh derives `NodeId` from a `SecretKey`. Spike must verify: where does iroh keep the key by default? Can it be persisted via the existing `keyring` crate (preferred — same backend as OAuth tokens)? Is loss of key on reinstall the same UX as today's TOFU re-pin? |

## Sequencing with a future CRDT migration

A future CRDT migration (merge engine swap) is **independent in design** — iroh swaps the transport, CRDT would swap the merge engine. But a solo maintainer should not run both at once. CRDT is not currently scoped in `pending/`; this section is forward-looking guidance for whenever it gets filed.

**Recommended order: iroh first, CRDT after.**

- **Why:** iroh Phase 1+2 lets you observe sync flowing over a new transport on real networks while the merge engine is still the well-tested diffy. If iroh has a bug, debug it without simultaneously debugging the new merge engine.

**Alternative order: CRDT first, iroh after.**

- **Why pick this:** CRDT's user-visible payoff (no conflict copies) is immediate and high-value. iroh's payoff (cross-WiFi) is conditional on the user actually using cross-WiFi.

**Don't:** merge into one super-migration. Too many moving parts; debugging is impossible.

## Files affected by phase

### Phase 0 (spike)

- New: `src-tauri/src/iroh_spike/` (standalone, feature-gated, deleted after spike).

### Phase 1 (shadow)

- New: `src-tauri/src/sync_net/iroh.rs` (or `sync_net_iroh/`).
- Modify: `sync_daemon/mod.rs`, `sync_daemon/orchestrator.rs`, `peer_refs.rs`, `commands/sync_cmds.rs`.
- New migration: add `node_id` and `transport_preference` columns to `peer_refs`.

### Phase 2 (cutover)

- Modify: `sync_daemon/orchestrator.rs` (flip default), pairing flow.
- Modify: `peer_refs.rs` (populate `node_id` or require re-pair per Option A/B).

### Phase 3 (cleanup)

- Delete: `sync_net/`, `sync_daemon/server.rs`, `sync_daemon/discovery.rs`, `sync_daemon/snapshot_transfer.rs`, `sync_daemon/android_multicast.rs`, `sync_cert.rs`, `pairing.rs`, `sync_files.rs`, `sync_files/`.
- Delete corresponding test files.
- Modify: `sync_daemon/mod.rs` (remove submodule declarations).
- Modify: `Cargo.toml` (remove old deps, add iroh).
- Modify: `commands/sync_cmds.rs` (remove old pairing logic, wire iroh tickets).

### Phase 4 (optional)

- Modify: `sync_daemon/orchestrator.rs` (remove WebSocket fallback).
- Modify: `peer_refs.rs` (drop `transport_preference`, `cert_hash`).

## Total cost

> Cost is driven by (a) substantial test-file LOC in Phase 3 (~6.2k), (b) cross-NAT spike infrastructure being non-trivial for a solo maintainer, (c) `sync_daemon/orchestrator.rs` directly imports `sync_net::*` so Phase 1 has more refactoring than a clean transport-swap would suggest.

- Phase 0 (spike): **15-21 days**
- Phase 1 (shadow): **20-25 days**
- Phase 2 (cutover): **15-21 days**
- Phase 3 (cleanup, ~14.7k LOC including tests): **14-21 days**
- Phase 4 (optional): **3-5 days** (unchanged)

**Total: 64-88 person-days (~9-13 person-weeks) for Phases 0-3.**

**Calendar (solo maintainer): 13-18 weeks (~3-4.5 months) for Phases 0-3.**

This is a meaningful project. Build in a 2-3 week buffer that's invisible inside individual phase windows but visible in the overall plan.

## Total impact

- **Net LOC: ~12k deleted** (~14.7k removed including test files, ~2-3k added).
- **Net Cargo deps:** −7 to −9 crates (mdns-sd, tokio-tungstenite, rustls, tokio-rustls, rcgen, x509-parser, sha2-for-cert-pinning, qrcode, if-addrs); +2-3 (iroh stack — verify exact crate names in spike).
- **User-visible:** cross-WiFi sync; new pairing UX; one-time re-pair during cutover (N-1 prompts for users with N paired devices).
- **Maintenance dividend:** the `sync_net/` + `sync_daemon/` test corpus (~6.2k LOC) goes away too.

## Total risk

**High but bounded.** Phases 0-1 reversible. Phase 2 reversible at cost (WebSocket fallback). Phase 3 irreversible. Six explicit kill criteria gate the migration before any irreversible work.

## Decision points

1. **End of Phase 0 (spike report):** all 6 kill criteria met? Yes → approve Phase 1. No → defer PEND-10.
2. **End of Phase 1 (shadow report):** parity with WebSocket transport acceptable? Unexpected issues? Yes → approve Phase 2. No → iterate or defer.
3. **End of Phase 2 (cutover report):** existing peers re-paired? iroh default? User-facing issues? Yes → approve Phase 3. No → revert to Phase 1.

## Open questions

1. **Concrete iroh `1.x.y` pin + minor-cadence plan.** iroh v1.x is stable; the spike just needs to settle on a specific minor and a "we revisit on minor bumps" rhythm. (Sources: GitHub releases, docs.rs, CHANGELOG.)
2. **iroh relay cost model.** Are there bandwidth/latency caveats when traffic falls back to relays? Quantify in spike.
3. **iroh-blobs resumability.** Does iroh-blobs support resumable transfers? Current `sync_files/` does not. If iroh-blobs does, that's a win.
4. **Ticket expiration / revocation.** Do iroh tickets expire? Can they be revoked? Current pairing is one-shot (5-minute timeout); persistent tickets change the UX (accidental old-ticket sharing risk).
5. **Android foreground service + Doze.** iroh's long-lived QUIC + Android Doze + adaptive battery. Spike must test on a real device, not emulator: background app → screen-off → sync-attempt-resume → does iroh reconnect or die? What's the recovery cost?
6. **iroh-blobs snapshot atomicity.** When syncing a snapshot via iroh-blobs, is the transfer atomic? Current `snapshot_transfer.rs` is not (partial transfers possible). Atomicity matters more for snapshots than for files.
7. **Privacy stance on relay metadata.** What does n0's relay see (NodeId, traffic timing, byte sizes)? Document for the user explicitly. (Reviewer flagged this as missing dimensionalization.)
8. **`SecretKey` storage.** Verify in spike that iroh accepts an externally-managed `SecretKey` so we can persist via the existing `keyring` crate (same backend as OAuth tokens). Reinstall = new `SecretKey` = same UX cost as today's TOFU re-pin.
9. **Tauri plugin requirement.** Does iroh need a `tauri-plugin-iroh` to integrate? Does one exist? If yes, what's its release cadence? If neither, scope expands to write a plugin (adds 1-2 weeks).
10. **CI integration for network-dependent tests.** iroh's tests need network access. Existing nextest CI runs on Linux only. Verify whether iroh tests can run there, or whether a separate "iroh-network-tests" CI job is needed. Plan for the gap.
11. **n0 relay SLA + offboarding plan.** What's n0's published uptime SLA? What's the project's plan if n0 sunsets the public relays? (Self-host fallback + LAN-only mode + the option to point at a different relay.)
12. **Existing op_log peer references.** Verify in Phase 1 whether op_log entries reference peers via `cert_hash` or `device_id`. If `cert_hash`, plan an extra migration; if `device_id`, no extra migration needed.
13. **Phase 1 backward-compat between mixed devices.** When one paired device runs Phase 2 (iroh-default) and the other still runs Phase 1 (WebSocket-only), does sync work, fail gracefully, or hang? Test explicitly.

## Appendix: iroh ecosystem status (to be verified in spike)

- Current iroh version (<https://github.com/n0-computer/iroh/releases>).
- API stability story (post-1.0? documented stability commitment?).
- Wire-protocol-format stability between minor versions.
- License (MIT? Apache-2.0? GPL-compatible?).
- Relay self-host story.
- LAN-only mode (opt out of relays).
- Android support (confirmed working on Tauri Android).
- iroh-blobs API surface (resumable, atomic).
- Ticket format (length, QR-scannable, paste-safe).

References for the spike:

- <https://iroh.computer/>
- <https://docs.rs/iroh>
- <https://github.com/n0-computer/iroh>
- <https://docs.rs/iroh-blobs>
- <https://www.iroh.computer/docs/concepts/tickets>
