# Session 1388 — a first pair that actually synced, and the peer row nobody had measured

Live two-device session (2026-08-24, Linux desktop + Pixel 8, both on 0.9.8, same
LAN). The goal was the one the user named as the last blocker to daily-driving
Agaric: **make pairing and sync work, for real, on real hardware** — then fix the
mobile Device Management UI and the bugs filed from the phone.

This log covers the diagnosis and the first shipped batch.

## The blocker was not Agaric

`docs/features/sync.md` has warned about this since #3507, and the warning was
exactly right, which is worth recording because the symptom is so misleading.

The desktop's log showed a healthy daemon and a dead network:

```
INFO  discovered new peer via mDNS  peer_id=e3d48f0a-…
WARN  peer did not answer the dial within the connect budget  candidates=1 timeout_s=10
```

Discovery worked. Every dial died. The cause was a **Zscaler VPN on the phone**,
whose tunnel route table contained `192.160.0.0/13` — which covers the user's LAN
`192.160.160.0/24`, because that LAN is numbered out of *public* address space.
Link-local multicast (`224.0.0.251`) escapes a tunnel; unicast does not. So mDNS
worked and nothing else did.

Measured on the device, for Agaric's own uid:

```
$ ip route get 192.160.160.80 uid 10408
192.160.160.80 dev tun0 table 1178 src 100.64.0.1     <-- into the VPN

$ ping -c3 192.160.160.80          -> 100% packet loss
$ ping -c3 -I wlan0 192.160.160.80 -> 0% loss, 11ms
```

Two dead ends worth writing down so nobody re-walks them:

- **Source-address binding is not enough.** `ping -I 192.160.160.102` (bind the
  source address) still lost 100%; only `-I wlan0` (bind the *device*) escaped.
  Agaric already binds the right source address — that is precisely why it fails
  silently rather than erroring.
- **An app cannot fix this.** The escape hatch would be marking the socket to the
  WiFi network, but Android's rule `13000: from all fwmark 0x0/0x20000 … lookup
  1178` sends every socket lacking `protectedFromVpn` into the tunnel, and only
  the VPN app or a system-permissioned caller can set that bit. A spike using
  `android_setsocknetwork` escaped only because `adb shell` (uid 2000) is
  network-privileged — not representative of the app.

With the VPN off, first pair completed in ~45 s.

### The iroh Router hypothesis was wrong

The session started from a suspicion that the fix was to "just use the iroh
Router" and unpick the tests pinning it off. **There is no `iroh::protocol::Router`
anywhere in this repo, and never has been** — production hand-rolls
`Endpoint::accept()` on a single ALPN (`agaric/sync/0`, `transport/service.rs:117`),
which is all a Router would have multiplexed. The tests that *look* like they pin
this actually pin the LAN-only posture (`RelayMode::Disabled` +
`clear_relay_transports()` + `clear_address_lookup()` + `clear_ip_transports()`,
`transport/endpoint.rs:270-283`). Nothing there was implicated, and the posture
was left alone.

## What was verified end to end

| Check | Result |
|---|---|
| First-ever pair (desktop host → phone joiner) | pass, ~45 s |
| Two-way transfer | 296 ops + 71 blocks, confirmed by pre/post DB diff |
| Unpair | clean; 1355 blocks intact |
| Re-pair, roles reversed (phone host → desktop joiner) | pass |
| Steady-state resync | completing on the 60 s tick |

The DB diff is the evidence that matters, because "it says Complete" is not the
same claim: `blocks` 1284 → 1355, `op_log` 1839 → 2135 (+296, exactly the phone's
op count), and blocks that were absent before the pair present after it.

One non-bug ruled out along the way: `ops_tx: 2` on every round is not a
re-send loop. It counts outbound `LoroSync` *messages*, one per registered space,
and the vault has two (`session_state_machine.rs:1448`, #705).

## Defects found and filed

- **#4297** — unpairing is one-sided. The abandoned device keeps a peer row
  reading *"Last: 1m ago"* while logging `"peer not paired with this device"` at
  ERROR every 60 s, forever. `delete_peer_ref` (`sync_cmds.rs:57-59`) is a local
  row delete with no notification, and `Rejection::Unpaired` deliberately returns
  `None` from `user_facing_message`. Correct for a stranger; wrong for a peer we
  still hold a row for.
- **#4298** — a device name is never exchanged. `device_name` appears nowhere in
  the sync protocol; every construction site sets it to `None`. So both devices
  show each other as raw UUIDs until renamed by hand, on each device separately.
- **#4299** — a captured LAN is indistinguishable from a sleeping peer. Same
  discovery result, same dial timeout, same log line, no UI signal. The
  multicast-in/unicast-out asymmetry is a distinctive signature and nothing reads it.

Also observed: the two pairing windows expire independently (#3504) — the phone's
session lapsed while the desktop's was still counting, and the Pair button then
did nothing at all, silently.

## Shipped in this batch

**The mobile paired-device row.** The reported symptom was "way too cramped and
illegible", and on-device screenshots confirmed it: the device name squeezed to
nothing, `Last: …` wrapped to three lines, the buttons dominating.

`PeerListItem` was the only card-shaped row in the app that never learned the
`flex-col sm:flex-row` idiom its siblings use (`TrashRowItem.tsx:118`,
`KeyboardTab.tsx:153`, and `PairingEntryForm.tsx:80` in this very feature). Its
action cluster was `shrink-0 flex-wrap` holding three `whitespace-nowrap` buttons,
so the `min-w-0` text column absorbed the entire deficit.

Two things only a real browser could have told us, and both changed the fix:

1. **The card is ~230px wide at a 360px viewport**, not ~345px — the 48px mobile
   rail plus panel and card padding take the rest. The action area is 196px.
2. **`touch-target` was making it worse.** Its `min-width: 44px` *replaces* a flex
   item's implicit `min-width: auto`, so `flex-1` could shrink a button below its
   own nowrap label and the text spilled out of the border. It is only meaningful
   for icon-only buttons; removed from the two labelled ones, which already get
   their 44px height from `size="sm"`.

With three buttons needing 264px in a 196px row, the fix is to stack: the action
group is `flex-col` on mobile and a row from `sm:` up, `Sync Now` / `Unpair` are
`w-full sm:w-auto`, and the rename pencil moved onto the name line where it
belongs semantically. That also makes the row rhyme with the full-width
`Pair New Device` and `Sync All` buttons directly above it in the same panel.

Second, smaller fix: `PairingPeersList` rendered the full 36-char `peer_id`, which
pushed its Unpair button off the screen edge on the phone. Now `truncateId` with
the full value on `title`.

### The suite that should have caught this

`e2e/mobile-overflow.spec.ts` was `test.skip`-ped in CI, and its own header said
to flip that "once that pre-existing bug is fixed (tracked separately)". The bug
(pairing tests querying `activeDialog` where phones render a Sheet) *was* fixed for
#3468, and all 28 tests pass locally — the skip had outlived its stated condition.
It is re-enabled here.

Re-enabling alone would not have caught this regression, though: every sync
assertion in that file ran against an **empty** device list, so `PeerListItem` was
never measured. The new `paired device row fits its card and does not overflow`
test is the only one there that materializes a peer, and it asserts
`scrollWidth <= clientWidth` on the action cluster rather than only page-level
overflow — a row can overflow its own card without the document scrolling.

Confirmed non-vacuous: it fails at both profiles against `origin/main`'s
`PeerListItem` and passes against the fix.

## Verification

- `npx vitest run` → 781 files, 17921 passed, 1 expected fail, 37 skipped
- `npx tsc -b --noEmit` → clean
- `npx playwright test e2e/mobile-overflow.spec.ts` → 30 passed at both phone profiles
- `oxlint` + `oxfmt --check` on changed files → clean

## Still open from this session

The remaining 12 bug reports filed from the phone are triaged with `path:line`
locations and sizes. Four need a design decision that has now been taken (subtler
collapse cue; drag from the block itself rather than a grip; hamburger before the
header work; "always-on controls" means the journal header). Two — the code-block
language picker and the status-bar inset — cannot be validated in jsdom or
Playwright and need a device or emulator; the second is Kotlin
(`MainActivity.kt:8` `enableEdgeToEdge()`, whose inset Android's WebView never
reports as `env(safe-area-inset-*)` without a notch).

Worth noting for whoever picks up the rest: the user's install is 0.9.8 and main
is **87 commits ahead**, so several rough edges observed on-device are already
fixed here — the responder-only "Never synced" row (`streamed_at`, migration 0111)
and the `remote_device_id was empty` WARN (now `debug!`) among them.
