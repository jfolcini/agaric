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

## Everything else that shipped

Nine PRs in total. The rest, after the peer row:

- **#4302** — three independent phone reports. A native `contextmenu` handler
  that called `openContextMenu` unconditionally while the timer path beside it
  correctly guarded on `isDraggingRef`, so Android's ~500ms native event opened
  the menu mid-drag; and a threshold gap where a 6-9px drift killed the drag
  (sensor tolerance 5) but survived the long-press check (10), so the menu
  popped on a gesture performed as a drag. Plus the Advanced Query icon
  (`SlidersHorizontal` → `Funnel`, in both the sidebar and the palette or they
  disagree) and copy block / subtree / selection wired into the context menu's
  copy group, which could copy references but not content.
- **#4303** — the Android status bar (#4301). `env(safe-area-inset-*)` is
  reported by Android's WebView for display CUTOUTS only, never for system
  bars, so every value is `0px` on a handset without a notch and the app paints
  its header under the clock. Deleting `enableEdgeToEdge()` fixes nothing —
  `targetSdk = 36` enforces edge-to-edge anyway. The insets are now pushed in
  from `MainActivity` as an inline style on `documentElement`, over CSS
  variables that fall back to `env()` everywhere else.
- **#4304** — one-sided unpair (#4297).
- **#4305** — the collapse caret's box replaced by a solid-vs-outline glyph
  (shape+fill, so the #216 non-rotation contract survives without the plate),
  and `Tab.enteredFrom` so deleting a page returns you where you came from
  instead of always `pages`. The two fallbacks — `tabs.ts` said `pages`, the
  Android back chain said `journal` — now agree by construction.
- **#4306** — the mobile rail replaced by a hamburger. +48px, measured.
- **#4308** — the empty-block placeholder (#4307).
- **#4309** — the journal header, three rows to one.
- **#4310** — four sync toasts that fired every 60 seconds.

## Three things that were wrong on the way in, and cost real time

**The iroh Router hypothesis.** Already recorded above, but worth repeating as a
pattern: the premise named a mechanism that does not exist in this repo. Checking
that first would have saved an hour.

**The placeholder's axis.** The triage said the placeholder overflowed
horizontally. It does not. A float is shrink-to-fit, so the box was exactly the
paragraph's content width and the hint wrapped to three lines INSIDE it;
`height: 0` meant the block stayed one line tall while two lines painted down
over the content below. Every horizontal-overflow assertion stayed green through
the bug, and the first draft of the new test passed against the unfixed CSS. The
agent caught it by measuring before changing anything.

**"The hamburger's +48px will make the journal header fit."** It does not. At
360px the header wrapper gets 284px and the controls needed 518px — a 234px gap
no tightening closes. Two sub-premises were also wrong: `MMMM yyyy` is the
NARROWEST date string rather than the widest (weekly was already wrapping to
three lines), and `max-sm:` overrides silently do nothing against the size
variants' `[@media(pointer:coarse)]:` classes, because the coarse variant wins on
source order — measured as a 0px difference.

The common thread: every one of these was caught by measuring in a real browser
rather than reasoning from the CSS. Three of the four fixes in this session
changed shape once the numbers arrived.

## Operational notes for the next session

- **A stale worktree base bites in three different places.** A branch built
  while a sibling PR merges fails on (1) TypeScript, when a shared struct gains
  a required field; (2) **sqlx**, whose compile-time query check validates
  against that worktree's own `dev.db` — and `seed-worktree.sh` is idempotent,
  so it SKIPS an existing DB and does not self-heal. The fix is
  `cargo sqlx migrate run` in the worktree; and (3) semantic conflicts in files
  two branches both touched.
- **`push.sh`'s gate does not cover clippy or `cargo fmt --check`.** The script
  says so at the top. A `needless_range_loop` in a new test got through the full
  gate and was rejected by the pre-push hook afterwards.
- **Port 5173 is a singleton across worktrees.** `playwright.config.ts` pins it
  with `--strictPort`, so two worktrees cannot run e2e concurrently — and
  `reuseExistingServer: true` locally means a run *can* silently test another
  worktree's build. Serialise e2e, or use an isolated port.
- **Two tests flake under load**, both unrelated to what was being changed:
  `TrashView.test.tsx` (partial-progress toast) and
  `PageBrowser.multiselect.test.tsx`. Both pass in isolation. Worth a look if
  they recur.

## Still open from this session

Of the thirteen reports, twelve are resolved: eleven fixed, and the drag-handle
one closed as no-change — asked how the well-made outliners do it, the user
confirmed the existing arrangement (the chevron doubles as the drag activator
where a chevron exists, the grip only where it does not) is what they want, which
is already how the code behaves. That is also what Workflowy, Logseq and Roam do;
the apps that drag from the row body are the ones where tapping a row does not
start inline editing.

**The code-block language picker is the one still open**, and it needs a device.
The high-confidence hypothesis is placement: the picker anchors to a toolbar
pinned at the top edge of the soft keyboard and opens downward into it, and
`100dvh` does not shrink for the keyboard on Android, so Radix's collision
detection has nothing to flip against. `CalloutTypeSelector` shares every code
path and fits only because it has a handful of rows.

Two sync gaps are filed and unfixed: **#4298** (a device name is never exchanged
— `device_name` appears nowhere in the sync protocol, so every peer renders as a
raw UUID until renamed by hand on each device) and **#4299** (a captured LAN is
indistinguishable from a sleeping peer; the multicast-in/unicast-out asymmetry is
a distinctive signature and nothing reads it).

Worth noting for whoever picks up the rest: the user's install is 0.9.8 and main
is now ~95 commits ahead, so several rough edges observed on-device are already
fixed here — the responder-only "Never synced" row (`streamed_at`, migration
0111) and the `remote_device_id was empty` WARN (now `debug!`) among them. None
of this session's mobile work is verifiable on the phone until an APK is built;
the user declined to spend the CPU on that during the session.
