# Session 1270 — iroh sync port: decision, spike, and the pairing bug

**Date:** 2026-08-05 → 2026-08-06
**Issues:** #78, #3120, #3325, #3327, #3343, #3355, #3356, #3460, #3462, #3463, #3464
**PRs:** #3461, #3462

## What this session was

The maintainer asked to replace the custom sync machinery with iroh, for a fully
peer-to-peer experience with no centralized servers, and confirmed a fact that
reshaped the whole plan: **the existing sync never worked** — a pairing bug that was
never diagnosed.

## The three findings that mattered

### 1. The plan's LAN-only config leaks to n0

#78 specified `RelayMode::Disabled` — "no n0 relays, no external service". iroh ships
a preset with exactly that shape, `presets::N0DisableRelay`, implemented as
`N0.apply(builder).relay_mode(RelayMode::Disabled)`. `N0` installs
`PkarrPublisher::n0_dns()`, `PkarrResolver::n0_dns()` and `DnsAddressLookup::n0_dns()`,
and **disabling the relay leaves all three running**. Measured against the plan's
literal wording: 4 lookups of `dns.iroh.link` on startup.

No relay traffic, but the device still announces its addresses to a third party on
every start. For a no-centralized-servers product that is the entire property, lost to
a config that reads correct. I had repeated the same wording in my own decision comment
on #78 an hour earlier, and corrected it there rather than quietly fixing the code.

The config that holds: `presets::Minimal` (no address-lookup services at all),
`clear_relay_transports()`, and a subnet-scoped bind with `is_default_route(false)`.

### 2. Two of my four guards could not fail

The first offline-guard draft had four assertions and all four passed immediately.
Two were vacuous:

- `relay_urls()` is empty under the full `presets::N0` configuration too, because no
  relay resolves while the recording resolver refuses DNS. True for a reason unrelated
  to the LAN-only config.
- The public-address assertion holds on any NAT'd host — every dev machine, every CI
  runner — regardless of configuration.

Both were rewritten onto the resolver record and paired with controls asserting the
opposite, then forced red to prove they fire: 4 `dns.iroh.link` lookups for the DNS
guard, **210** relay hostname lookups in 3s for the relay guard.

The review on #3462 then caught a third: the README claimed the guard was
"build-enforced" when **nothing in CI compiled the spike crate**. Corrected, and the
guard has since been moved into `agaric-sync` where `cargo nextest run --workspace`
actually runs it.

### 3. Why sync never worked — #3463

`confirm_pairing_inner` validates the typed passphrase against **the passphrase this
same device generated for itself**. The pairing dialog unconditionally calls
`startPairing()` on every device that opens it, with no host/joiner distinction. So
device B compares device A's passphrase against B's own. Mismatch every time; odds of
accidental success ≈ 1/7776⁴.

Verified three independent ways: the `useEffect(open)` → `startPairing()` call, the
local-slot read in `confirm_pairing_inner`, and `confirm_pairing: returnUndefined` in
the tauri mock.

The regression came *from a security fix*. The `H-1` commit message states it plainly:
before H-1 the passphrase was accepted as-is and the whole verification machinery was
dead code. After H-1 it is secure and structurally impossible. The fix closed a real
hole and removed the only path that ever functioned.

**Every test layer masked it.** Rust tests feed a session's own passphrase back into
`confirm_pairing_inner` against the same `Mutex` — a device confirming its own
passphrase, always green. Loopback-TLS tests pre-seed `peer_refs`, bypassing pairing
entirely. The frontend mock returns unconditional success. No test anywhere exercises
two independent pairing sessions, which is the only case that matters.

This is **transport-independent**: it lives in the command layer and the frontend, and
would have survived the iroh swap untouched.

## Decisions recorded in plan #3464

- **The boundary is the protocol FSM, not `SyncConnection`.** Preserving
  `SyncConnection`'s surface is a trap: `peer_cert_hash()`/`peer_cert_cn()` cannot be
  preserved (no certs), keeping the API keeps `wire.rs`, and a single framed channel
  forecloses QUIC's concurrent streams.
- **No `Transport` trait.** The FSM is already I/O-free, and two real iroh endpoints
  handshake in 0.07s. A trait with one prod impl and one test impl would work around a
  problem iroh removes.
- **`DeviceId` stays; `EndpointId` is added.** `DeviceId` is op-log attribution — the
  snapshot format does not change. `DeviceId` is never read off the wire; it is looked
  up from the authenticated `EndpointId`. This is the structural replacement for the
  #1559 residual.
- **Pairing roles become explicit** so #3463 is unrepresentable, not merely fixed.
- **Keep our own mDNS initially** — `iroh-mdns-address-lookup` is 0.4.0 and our
  `android_multicast.rs` handles a `MulticastLock` iroh may not. Lowers the retirement
  estimate from 8,461 to ~7,900 LOC; stated rather than quietly kept.

## Issue hygiene

Closed as obsoleted by the port, each with a comment explaining why it is
not-applicable rather than deferred: **#3355** (pre-auth amplification — QUIC
authenticates before the first app byte), **#3356** (cert-pinning oracle — no certs),
**#3343** (`AuthenticatedPeer` — the property becomes structural), **#3327**
(file-transfer robustness — iroh-blobs replaces both files).

Re-scoped rather than closed: **#3325** (attachment-GC half survives), **#3120** —
where I withdrew the recommendation I had made hours earlier. ~13.7K of its 25.2K LOC
are tests for code the port deletes; relocating them so they can be deleted a week
later is motion, not progress.

## Still open

**Q2 — QUIC/UDP on Android and restrictive WiFi.** Untestable from a Linux dev box, and
the one gate between here and release. Nothing in this session is evidence about it.
