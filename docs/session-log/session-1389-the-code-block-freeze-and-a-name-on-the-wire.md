# Session 1389 — the code-block freeze, and a name on the wire

Continuation of 1388. The phone was reconnected and the brief was: fix the one
mobile bug still open from the thirteen filed on-device, then close #4298 and
#4299 — the two sync gaps 1388 filed but did not fix.

One of those three turned out to be a much larger animal than its report.

## The bug report was "the code block language selection doesn't work"

It is not a picker bug. **Any code block froze the entire app on mobile,
permanently.** Typed as ```␣, inserted from the slash menu, or picked in the
toolbar — all the same. Not slow: dead. A page left alone for three minutes
never recovered, and on the device the app had to be force-stopped.

I had already hit this on the phone earlier in 1388 and misread it. Tapping
"CODE — Insert code block" in the slash menu locked the UI; logcat showed
`sync unfroze … SandboxedProcessService0` right around then, so I attributed it
to Android's cached-app freezer and moved on. It was this bug, and the freezer
line was a coincidence.

### Getting from a vague report to a mechanism

The report named the picker, so the picker is where I started, and for a while
the evidence pointed there convincingly. The rows use a bare `onPointerDown`
while every sibling row in that menu uses `toolbarPressHandlers`; the
`CodeLanguageSelector` is the only child of `TurnIntoMenu` that touches
`editor` directly rather than dispatching through the focus-keyed block event
bus. Both are real asymmetries. Neither was the cause.

What actually settled it was refusing to reason from the code and building a
repro that could be interrogated. A Playwright spec at an iPhone-13 profile
reproduced it, and from there the useful moves were:

- **A discriminator matrix instead of a hypothesis.** Empty block vs not,
  filtered vs unfiltered, pointer vs keyboard, "rust" vs "Plain text" (which
  passes no language at all). Every combination froze, which killed the entire
  "it's about the language attribute" family at once and pointed at the code
  block itself.
- **Reducing to the shortest trigger.** The ```␣ input rule involves no
  toolbar, no popover, no picker. It froze too. That is the repro that shipped
  as the regression test.
- **Interrupting the hung page rather than guessing.** `Debugger.pause` over CDP
  works on a page whose main thread is wedged, and gave the loop directly:

      DOMObserver.observer → flush → updateState → selectionToDOM
        → setCurSelection → domSelectionRange → (mutations) → flush → …

`CodeBlockWithShortcut` rendered **every** language through
`ReactNodeViewRenderer(MermaidCodeBlockView)`. A React node view rewrites its
contentDOM subtree when it re-renders; prosemirror-view's `DOMObserver` records
those mutations and flushes; the flush re-renders the node view. Nothing
terminates it.

### Three wrong premises this cost, worth writing down

**"React is looping."** It is not. I installed a devtools-hook commit counter
and React committed 11 times after the trigger and then stopped entirely. React
frames dominate the paused stack because it is downstream of the flush, not
because it is the driver. A `Maximum update depth` guard would never fire here.

**"It's the small viewport."** It is the **user agent**. `browser.android` /
`browser.ios` select different selection-handling paths inside prosemirror-view.
Measured, all with the same input rule: 390×664 desktop-UA fine; `hasTouch`
fine; `isMobile` fine; `deviceScaleFactor: 3` fine; iPhone UA frozen; Pixel 8 UA
frozen. An early bisect said "small viewport" only because my probe reported
`HANG` for both "page frozen" and "Playwright could not click an off-screen
row" — two different failures wearing one label. Worth remembering: a probe that
collapses distinct failures into one verdict will send you somewhere wrong with
confidence.

**"It'll be an upstream regression."** prosemirror-view 1.42.2 was available and
does not fix it (tested by patching `node_modules` directly, which avoids
lockfile churn during an experiment). Disabling our node view does.

### The change

Only mermaid needs React, so only mermaid gets the React node view. Every other
language uses a plain DOM node view reproducing `CodeBlockLowlight`'s own
`renderHTML` — `<pre><code class="language-x">`. The extension is configured
with `lowlight` only, so no extra `HTMLAttributes` are in play, and lowlight's
highlighting rides on decorations inside `contentDOM`, unaffected.

This also makes the node view's own doc comment true again. It already claimed
"every other language renders the standard editable code block, so non-mermaid
code-block behaviour is unchanged" while in fact routing all of them through
React — the comment described the intent and nobody checked the code still
matched it.

The regression test drives the mobile user-agent (a small viewport alone does
**not** reproduce, so a test written at iPhone dimensions with a default UA
would have passed against the bug), asserts the `<pre>` materialises, and then
types into it, because a frozen main thread swallows the keystroke. Verified
non-vacuous: it times out at 1.1 min against the previous node view.

## #4298 — a device name that actually crosses the wire

`device_name` appeared nowhere in the sync protocol. Every construction site set
it to `None` and the only writer was the local `update_peer_name` command, so
after a verified two-way pair both devices rendered each other as
`e3d48f0a-45a…` until renamed by hand on each one separately.

Two columns, not one. `device_name` stays the **user's override**;
`remote_device_name` (migration 0114) is the **peer's claim**. Folding the claim
into the existing column would mean a peer's next sync silently overwrites a
name the user chose, which is the one outcome a rename feature must never
produce. Precedence is `device_name → remote_device_name → truncateId(peer_id)`,
expressed once in `lib/peer-display-name.ts` rather than as a `??` chain at six
call sites.

That fallback also corrects a lie: `update_peer_name`'s doc comment has always
claimed passing `None` clears the name "back to the device-supplied value" —
true of the intent, false of the schema, because no device-supplied value
existed. Now one does.

The name rides on `HeadExchange` as `Option<String>` with `#[serde(default)]`,
the same shape `pairing_proof` already established; the enum carries no
`deny_unknown_fields`, so an older peer ignores the field and a newer peer
defaults it. Clamped to 64 **characters** rather than bytes — a byte cap would
cut a CJK name to about a third of the rendered width it was budgeted — and
clamped on send *and* again on receive, because the sender is an untrusted
remote and nothing a well-behaved one does can be assumed of a hostile one.

The local name comes from `tauri_plugin_os::hostname()`, refreshed into
`app_settings` at boot so `agaric-sync` reads it from the pool and never grows a
Tauri dependency.

**Known gap, deliberately accepted:** `HeadExchange` is initiator-only and the
responder has no equivalent one-shot frame, so a responder learns its peer's
name but does not answer with its own in that session. This converges anyway —
every device runs the resync scheduler and dials, so each is the initiator of
*some* session — but immediately after a first pair one side can show a UUID
until its own next outbound dial. Adding a responder→initiator name frame would
buy only that window, at the cost of a new wire shape.

## #4299 — analysis, not code (yet)

Posted as a comment on the issue. The core observation is that everything needed
to discriminate "peer asleep" from "LAN captured by a VPN" is already in scope at
the failure site (`session_supervisor.rs:1672`) and simply unused: we know the
peer is currently reaching us over mDNS, we know the candidate addresses, and we
know which local address we bound. We report a timeout, which is exactly what a
sleeping peer produces.

The chosen signal is a **connected-UDP-socket egress probe**: open an unbound
`SOCK_DGRAM`, `connect()` it to the peer's address (no packets are sent — the
kernel just resolves a route), and compare `getsockname()` against the address
the endpoint bound. That is `ip route get` in portable, unprivileged userspace,
and it is precisely the measurement that diagnosed the original failure. It
catches the whole class — split-tunnel VPNs, corporate clients, multi-homed
hosts — and, importantly, catches the case that started this, where the LAN was
numbered out of *public* space (`192.160.160.0/24` swallowed by a tunnel's
`192.160.0.0/13`) and any "is this RFC1918?" heuristic would have missed it.

Gated on the mDNS asymmetry so it never runs on the common sleeping-peer path,
and surfaced as **durable state on the peer row** rather than a toast —
`record_initiator_failure` suppresses the repeat, so a toast-based fix would be
swallowed exactly as the current message is.

## A second mobile bug, found on the device

The Turn-into popover grows past the screen and its top third is clipped off,
unreachable. `PopoverContent` capped itself at `calc(100dvh-4rem)` under a
comment asserting that "`dvh` tracks the soft keyboard". It does not: on Android
the IME shrinks only the visual viewport. The codebase's own
`computeKeyboardInset` is built on exactly that fact — it derives the keyboard
height as `innerHeight - (vv.height + vv.offsetTop)`, which would be zero if
`dvh` shrank — so the comment and the helper contradicted each other and the
helper was right.

Fixed at the primitive, not the call site: the cap became
`--radix-popover-content-available-height`, with the old `100dvh` expression
demoted to a fallback that in practice only fires in jsdom.

**The first attempt at this was wrong in an instructive way, and the review
caught it.** It also added the keyboard inset to the bottom `collisionPadding`,
on the premise that "the soft keyboard is not part of any collision boundary the
browser knows about". That premise is false. Radix positions with a fixed
strategy and an empty collision boundary, so floating-ui's clipping rect is the
viewport rect, and `getViewportRect` reads `visualViewport` — the same
keyboard-free band `computeKeyboardInset` is derived from. The boundary already
excluded the keyboard, so the padding subtracted it a second time.
`detectOverflow` folds the padding object into both overflows, so `size()`'s
`maximumClippingHeight = height - overflow.top - overflow.bottom` telescopes to
`clippingHeight - paddingTop - paddingBottom`, and `availableHeight =
min(height - overflow[heightSide], maximumClippingHeight)` picks that
doubly-subtracted term up through the `min()`.

*(Corrected after the fact: this paragraph originally credited the doubling to
Radix's `shift({mainAxis: true})` "making that the cap outright on vertical
placements". That is wrong, and `popover.tsx` now says so in as many words — for
`top`/`bottom` placements the main shift axis is x, so `shift` never touches the
height at all. The measurement settles which reading is right: at this geometry
the "outright" reading predicts 356px and the `min()` reading 310px, against
311px measured. Worth leaving visible, because it is the same axis fact the file
then had to correct a second time in a different comment — being wrong about
`shift` twice in one file was the near miss of the follow-up review.)*

Measured at an iPhone-13 viewport with a 300px keyboard, available height came
out at **56px** — one row of padding — against 311px without it. A taller
keyboard drives the expression negative, the `max-height` is discarded as
invalid, and the cap vanishes altogether — which is why the shipped cap wraps
the var in a `max(…, 8rem)` floor.

So the reasoning that produced this section's opening paragraph was right about
`dvh` and wrong about Radix, and being right about the first made the second
feel settled. The lesson is narrower than "verify assumptions": the helper that
proved `dvh` does not track the keyboard is the *same* helper floating-ui
effectively reimplements, so the very evidence that convicted `dvh` should have
exonerated Radix. Two consumers of `visualViewport`, and I read one of them as
proof the other was blind.

The test carries the correction: it asserts the popover is tall enough to be
usable, not merely that it clears the keyboard. "Clears the keyboard" is
satisfied by a 56px box, which is exactly how the double subtraction survived
the first round.

That floor had a sting in its tail, and the next review round found it. The
`max(…, 8rem)` guard is 128px; the spec's `MIN_USABLE_POPOVER_HEIGHT` is 120px;
so replaying the double subtraction now collapsed the cap to 56px, the floor
lifted the rendered box back to 128px, and all three assertions passed — the
regression test could no longer see its own regression. The comment on the
constant even said 8rem was chosen to clear the test's floor, which is the
dependency backwards: the code had been sized to satisfy the assertion instead
of the assertion constraining the code. The fix moves the assertion onto the
resolved `--radix-popover-content-available-height`, the pre-floor cap and the
quantity the double subtraction actually corrupts, and re-derives the 128px from
two 44px touch rows plus the primitive's own padding. Neither number depends on
the other any more.

## Operational notes

- **`Debugger.pause` over CDP is the tool for a wedged page.** `page.evaluate`
  hangs, `console.log` from inside the loop still streams, and a paused stack
  plus `Debugger.evaluateOnCallFrame` can read React fiber internals. This was
  the difference between guessing and knowing.
- **Patch `node_modules` to test a dependency bump.** `npm pack` the candidate,
  copy `dist/` over, run the repro, restore. No lockfile churn for an experiment
  that turns out negative — as this one did.
- **`pkill -f "vite --port 5173"` matches its own shell** and killed the heredoc
  that was writing the next test file. Use a PID list, or a pattern that cannot
  match the invoking command line.
- Nothing of this session's mobile work is verified on the device: the phone
  runs 0.9.8 and main is ~100 commits ahead. The fixes are verified against a
  mobile user-agent in Chromium, which is what gates the freeze — but an APK
  build remains the only way to confirm on hardware.
