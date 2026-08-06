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
- **Adopt `iroh-mdns-address-lookup`.** My first call was to keep our own mDNS,
  justified by "whether the iroh crate handles Android's `MulticastLock` is unknown" —
  deciding on an unknown, which the maintainer rightly rejected. Checked: neither that
  crate nor `swarm-discovery` beneath it handles it, and **no Rust crate can**, because
  it needs JNI into the Android Activity. Our 249-LOC shim stays for that reason alone;
  the mDNS protocol work goes external. Retirement estimate ~8,200 LOC.

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

---

# Outcomes

## Both PRs merged

| PR | content | closes |
| --- | --- | --- |
| **#3466** | pairing fix, backend + frontend + e2e | **#3463** |
| **#3467** | LAN-only endpoint with guard in CI, snapshot schema pin, spike deletion | **#3460** |

**Pairing works for the first time.** That is the headline: the app's sync feature has
never functioned end-to-end, and the reason was a comparison against the wrong device's
session.

## The pairing UX changed twice, deliberately

First to an explicit role chooser — two buttons, no backend call until one is picked.
Then, on maintainer feedback, to **implicit roles**: the dialog opens on the host path
showing this device's code, with "Have a code from the other device?" switching to the
joiner path. Choosing to enter a code is what declares the role.

The safety property survived the change because it is structural, not procedural:
`PairingRole` is a `'host' | 'joiner'` union so both-at-once does not typecheck, and
switching to joiner **cancels the host session first**. Without that cancel, a device
would be offering its own code while entering another's — #3463 wearing a different hat.

Worth recording that the chooser was never a correctness requirement. With the backend
fixed, a symmetric UI works provided the user enters the code on exactly one device.
The old UI actively invited doing it on both.

## What the reviewers caught that the tests did not

Three findings, all the same shape — **documentation outliving the thing it described**:

1. **`iroh = "1.0.3"` was not a pin.** The manifest comment argued carefully that iroh
   must not move on its own, then wrote a caret range. Worse than no comment: it tells
   the next reader a protection exists.
2. **`confirm_pairing`'s rustdoc listed an error tag** that its own guard-removal had
   deleted.
3. **The success toast asserted "Device paired successfully"** when `confirm_pairing`
   had validated nothing. My fix made the failure mode *quieter* — before, a typo gave
   an immediate (wrongly-derived) error; after, a confident success and a closed dialog.
   Softened to honest copy; the real fix is #3469.

And one hole in the same class as one I had documented at length: **`lan_only` did not
validate `prefix_len`**, so `lan_only(addr, 0, ..)` binds a `0.0.0.0/0` socket and
collapses layer 3 exactly as dropping `clear_ip_transports()` would — invisible to all
four guards. I guarded the call and left the parameter unguarded.

## Where falsification corrected the author rather than the code

The snapshot type-shape test was written to catch a TEXT→INTEGER retype hiding behind
the insta redactions. Trying to make it fail revealed that retyping the Rust field
**does not compile** — `sqlx::query_as!` verifies the field against the live column at
build time. So the uncoordinated half of the risk was already caught, earlier, by the
compiler. The test still earns its place for the *coordinated* change, and its doc now
says exactly that instead of claiming broader cover.

## Plan revisions recorded on #3464

- **D1 validated**: `handle_message(SyncMessage) -> Result<Option<SyncMessage>>` carries
  no transport types. But the FSM does **not** drive bulk transfer —
  `sync_daemon/server.rs` does, via side-channels that bypass the protocol. So the
  retirement figure counts code that disappears; the session driver is *rewritten*.
- **D5 revised**: QUIC streams give us the bulk channel without `iroh-blobs`. A plain
  stream is already strictly better than chunked WebSocket frames, so the port depends
  on **no 0.x crate** and the full retirement lands in one slice.
- **D6 reversed** (see above).
- **Sequencing corrected**: fix pairing *before* the transport swap, so a later failure
  can be attributed. Porting a system that never worked leaves no baseline to regress
  against.

## Issues filed

**#3463** pairing root cause · **#3465** snapshot-redaction allowlist covers 3 of 5
crates · **#3468** pairing dialog may be unreachable on mobile (pre-existing on `main`)
· **#3469** joiner reports success before anything is verified · **#3470** iroh is an
unconditional ~380-crate dependency for a module with no callers

**#78 closed** as superseded by **#3464**; its body predated the Loro migration and
described a cross-WiFi plan the LAN-only decision had inverted.

## Still open

**Q2 — QUIC/UDP on Android and restrictive WiFi**, now widened to include discovery
since `swarm-discovery` replaces `mdns-sd`. Needs hardware. It gates release, not
development.

**#3468** is the one to look at first: if pairing is also unreachable on mobile, that is
a second independent blocker on the same flow, and phone↔desktop is the primary use case.
