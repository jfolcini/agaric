# Session 1273 — why pairing never worked, and what the port does not fix

**Date:** 2026-08-06
**Issues:** #3488 (done), #3469 (done), #3468 (done), #3502–#3505 (filed), #3491–#3496 (filed), #3501 (filed), #3120 / #3343 / #3464 (corrected)
**PRs:** #3490, #3497, #3499, #3500

Continues session-1272. That one built the endpoint service and read the responder. This
one finished the transport primitives, started the cutover — and then found the reason
the feature has never worked, which turned out not to be a transport problem at all.

## The headline: the proof exchange is fine, nothing reliably dials

Two independent causes had already been found in the pairing flow: #3463 (the joiner
compared the typed passphrase against its *own* session, so two-device pairing could
never succeed) and #3469 (success announced the moment `pair()` returned, when pairing had
only been initiated). Two independent causes in one flow is enough reason to look for a
third rather than assume the path is now correct.

There is one, and it is #3502.

Of the three places the daemon can start an outbound session, two enumerate `peer_refs` —
Branch B (`wait_for_debounced_change`, `session_supervisor.rs:319`) and Branch C (periodic
resync, `:413`). During a first-ever pair `peer_refs` is **empty**, so neither can produce
a partner. That leaves Branch A, the mDNS resolve, and:

```rust
let already_discovered = discovered.contains_key(&peer.device_id);
discovered.insert(...);
if already_discovered {
    return None; // Already known, just updated timestamp
}
if !should_attempt_sync_with_discovered_peer(..., pairing_pending) { ... }
```

The short-circuit returns **before `pairing_pending` is consulted**. The pairing bypass
lives inside a function the pairing case cannot reach. `discovered` is owned by
`daemon_loop` with no active→dormant path, so it persists for the process; and every
resolve refreshes the timestamp *above* the short-circuit, so Branch C's staleness sweep
never evicts a peer that stays visible.

One initiation opportunity, per peer, per process lifetime. And the dialog spends it
before the user has typed: `initHost()` runs on every open (`PairingDialog.tsx:287`) and
the dialog defaults to the host role, so both devices arm *their own* passphrase, dial,
and reject each other — putting each in the other's `discovered` map. When the user
finally types the real code the markers agree for the first time, and nobody dials again.

### Why this shape, specifically

A proof bug fails loudly and repeatably. This one goes quiet, is **made worse by
retrying** — the doomed dial calls `record_failure` and doubles the per-peer backoff
(#3505) — and intermittently appears to work after an app restart. That is the shape of a
bug someone never manages to make work, as opposed to one they diagnose.

### Two tests stood in the way

`src/sync_daemon/tests.rs:607-614` asserts the guard holds *even while pairing is
pending*, so any fix reads as a regression. It is not simply wrong — the guard has a real
job in the paired steady state — but it pins the defect.

Worse, `process_discovery_unpaired_returns_some_only_while_pairing_pending` (`:3865-3886`)
**cannot fail for the reason it appears to test.** Its pending half swaps in a fresh map,
commented *"Use a fresh map so the already-discovered guard doesn't short-circuit."* It
names itself after the pairing-initiation property and then constructs the one
configuration in which that property holds — avoiding the configuration production is
always in.

And `full_pair_then_sync_workflow` reads as the end-to-end pairing test and is not one: it
models the joiner's dialog-open with `start_pairing_inner`, which touches only the
in-memory slot, where the command the frontend actually calls is
`start_pairing_armed_inner`, which writes the joiner's own proof to the marker. The
mid-state that breaks pairing is exactly what the test declines to model.

### The part that matters for the port

`process_discovery_event`, the three branches, and
`should_attempt_sync_with_discovered_peer` are **daemon policy, not transport**. The
cutover replaces how bytes move and touches none of them. A port that lands exactly as
planned yields a QUIC transport on which first-ever pairing still cannot complete.

Worth stating because the port had been implicitly carrying the hope of fixing sync.

## Tests that cannot fail, four times in one session

This session's most reliable source of value was not writing tests but trying to break
them. Four times a test looked like coverage and was not, and each mechanism was
different:

1. **Symmetric fixture** (session 1272, carried here). A constant shared by both ends of a
   test's own fixture cannot be tested by that fixture — both ends agree at any value.
2. **Unreachable branch.** `an_uppercase_key_would_be_invisible_to_lookup_if_it_were_stored`
   put its only assertion behind `if wrote.is_ok()`, and migration 0107's CHECK makes that
   branch never taken.
3. **Shadowing.** Adding the missing `RecordingWriter::writes` assertion to the existing
   progress test passed — and could not fail, because every break producing an over-sized
   write also perturbs the tick sequence, so the earlier assertion fires first. Split into
   its own test it falsifies cleanly (`got [10001234]` — one write where there should have
   been three).
4. **A gate that is never open.** `expectNoHorizontalOverflow`'s scoped mode gates on
   `root.scrollWidth > root.clientWidth`, but Radix content nodes carry `overflow-hidden`,
   which pins those equal forever. All three scoped call sites in the repo have always
   asserted nothing — and behind them sat a real defect: ~32px of the Keyboard Shortcuts
   Action column clipped and unreachable at 360px (#3501).

The general rule: **an assertion that only executes when it is already going to pass is
the defect it was written to catch, wearing a costume.** Only running the break finds
these; reading the test does not.

## The port: primitives done, cutover reshaped twice

`bulk` landed (#3490), completing the five transport primitives. The migration
(`0107_peer_refs_endpoint_id`) and the mDNS relocation (#3488) landed on the cutover
branch.

`endpoint_id` is TEXT, not BLOB, because iroh 1.0.3's `Display` for `PublicKey` is
`HEXLOWER` — verified in the vendored source rather than assumed — so the canonical string
is byte-exact under BINARY collation, and it crosses IPC into the UI as a readable string.
A CHECK rejects non-canonical spellings, because `FromStr` is deliberately laxer than
`Display` (it also accepts a 52-char base32 form) and `fmt_short()` returns 10 hex chars
and is the convenient thing to reach for when logging.

### The unit of work, corrected twice

First correction: the plan's "one PR, not three" argument is sound but settles a narrower
question than it appears to. It rules out splitting *ops from bulk*; it does not rule out
splitting the **rewrite from the deletion**. Those two halves want different reviews —
"does the new path match the old" versus "is this genuinely dead" — and merged, the
deletion gets skimmed at the end of a 4,000-line diff. The deletion is precisely where the
plan says the work is easiest to get wrong (per-test pruning of interleaved legacy/Loro
coverage). Cost, stated honestly: PR A forfeits the free completeness check that "it
compiles with the old code gone" provides, so it must carry an explicit guard instead.

Second correction, from attempting it: responder and initiator **cannot cross separately**.

```
run_file_transfer_initiator   :1833 request_and_receive_files
                              :1841 receive_request_and_send_files
run_file_transfer_responder   :1905 receive_request_and_send_files
                              :1912 request_and_receive_files
```

The same two helpers, opposite order, both taking `&mut SyncConnection`. Porting either
role alone breaks the other. Three ways out — duplicate ~575 lines, add the transitional
seam D2 rejected, or cross both roles together — and only the third does not add code
whose sole purpose is to be deleted.

## A design claim of mine, corrected

Session 1272 recorded that #3324's bug class becomes *unrepresentable* under iroh, because
`EndpointId` lets authorization run before the first recv.

That is true for a **paired** peer and false for an **unpaired** one. The #855 pairing
proof rides *inside* `HeadExchange`: for a peer in the pairing window there is nothing to
authorize against until the frame arrives, because the proof is in the frame. The order is
recv → authorize → dispatch, and only the first two can be reordered.

Since `driver::run_session` currently recvs **and dispatches** the opening message, a naive
port lets it reach `orch.handle_message` — which queues full-vault Loro exports — before
the proof is checked. #3324's class, reintroduced by the change meant to retire it. The
fix is to make the opening frame the caller's responsibility so the driver structurally
cannot dispatch an unauthorized one.

#3343 was closed on the stronger claim, so its rationale is corrected on the issue: the
property is still deliverable, but not by the mechanism recorded there.

## Also this session

- **#3469** shipped (PR #3499), and its review found a *reachable* false success hiding
  inside the fix meant to delete false successes: the baseline came from React state,
  which is empty when its load failed, so a transient `list_peer_refs` failure made every
  already-paired device read as brand new. The baseline is now an authoritative read that
  can say "unknown" and fails closed.
- **#3468** answered: pairing **is** reachable on mobile. `PairingDialog` renders a Radix
  Sheet below 768px by design (#2665), so the test's `dialog-content` locator was
  unsatisfiable at every viewport in the file. Ruling this out mattered — it would have
  been a second independent blocker on the phone↔desktop path.
- **`AGENTS.md`** corrected (#3497): its threat-model bullet predicted the passphrase
  question would "disappear" with the port. The *binding* question does; the proof does
  not. Fixed ahead of the responder work specifically because that is the file an agent
  reads while doing it.
- **#3120** narrowed with measurement: the cutover deletes 1,570 of `src/sync_net/`'s
  2,013 lines outright, and `transport/` — 59 tests, no app-side shim — is the worked
  example that issue is looking for. Not by design: it simply depends on nothing above it
  in the layering, which is the actual criterion.

## State

Merged: pairing fix, LAN-only endpoint, snapshot schema pin, `SyncMessage` over QUIC, LAN
bind locality, error-source hygiene, frame-reservation hardening, the session driver, the
endpoint service, bulk transfer, the `AGENTS.md` correction.

In flight: #3499 (pairing outcome), #3500 (mobile locator), and cutover PR A on
`claude/sync-cutover`.

**Q2 still gates release, not development.** QUIC/UDP on Android and restrictive WiFi
needs hardware, and nothing here is evidence about it. But #3502 now gates it too, and
that one does not need hardware — it needs two instances on one LAN.
