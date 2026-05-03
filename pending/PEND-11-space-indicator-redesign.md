# PEND-11 — Space indicator redesign: thin top stripe + sidebar picker only

## TL;DR

The current "active space" identity surface is **over-indicated**: four redundant
affordances exist for a single piece of state (`currentSpaceId`). User proposal
is to collapse this down to **one ambient cue** (a 2–3 px accent-coloured stripe
at the top of the window) plus **one interactive control** (the existing
`SpaceSwitcher` in the sidebar header).

I broadly agree. The proposal is consistent with how mature multi-workspace
apps (Slack's workspace stripe, Linear's accent treatment, VS Code's Profile
indicator) signal session context — ambient, peripheral, non-competing with
content. The `--accent-current` CSS variable is already plumbed end-to-end and
is currently under-used; this proposal essentially activates that latent
infrastructure.

I'd push back on **one** detail: the proposed scheme drops the only collapsed-rail
identity cue. Recommended refinement is to keep `SpaceAccentBadge` in the
icon-rail mode and drop only `SpaceStatusChip` from the sidebar footer. See
[Refined proposal](#refined-proposal).

Cost: **S** (mostly deletion). Risk: **low** (visual-only, no data path).
Impact: **medium** (genuine reduction of UI clutter; activates an unused token).

## Current state — what the user sees today

The active space is communicated through **four** simultaneous affordances:

| # | Surface | Where | Visibility | Carries name? | Carries colour? | Clickable? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `SpaceSwitcher` (Radix Select) | Sidebar header, expanded mode | When sidebar expanded | Yes ("Space: Personal") | No | Yes (opens dropdown) |
| 2 | `SpaceAccentBadge` | Sidebar header, **collapsed** mode | When sidebar collapsed | No (first letter only) | Yes (32 px circle) | Yes (cycle to next) |
| 3 | `SpaceStatusChip` | Sidebar footer, above sync chip | When sidebar expanded | Yes | Yes (3 px left stripe + dot) | Yes (focuses #1) |
| 4 | OS window title | Title bar (native decorations) | Always (OS chrome) | Yes (`Personal · Agaric`) | No | n/a |

Plus the dormant `--accent-current` CSS custom property on `:root`, which is
rebound on every space change (`useAppSpaceLifecycle.ts`) but is **read by
nothing except the three space components themselves**. The variable exists
but never paints anything outside its own input.

This is genuinely too much. The chip and the switcher carry the same name
~10 px apart vertically; the badge and chip carry the same colour. The
window title is the only one that survives sidebar collapse + manual user
input focus.

## The user's proposal

> A two- or three-pixel-high line right at the top of the window with the
> colour of the space, and the space picker in the left side panel as only
> indications of current space.

Restated as a concrete diff:

- **ADD**: a thin (`2–3 px`) accent-coloured stripe spanning the full window
  width, anchored to the top of the webview viewport (below the OS title bar
  on platforms where one is rendered).
- **KEEP**: `SpaceSwitcher` (#1) in the sidebar header.
- **DROP**: `SpaceStatusChip` (#3) and `SpaceAccentBadge` (#2).
- **(implicit) KEEP**: OS window title (#4) — it's a system surface, not
  in-app UI.

## UX evaluation

### Why the proposal is sound

- **Pre-attentive processing.** A coloured top edge is processed in peripheral
  vision without competing with content. Users develop "this colour means
  this space" muscle memory within hours, then never look at the picker
  again. The chip/badge demand foveal attention to read.
- **Always-on, regardless of sidebar state.** The chip and badge are
  mutually exclusive (chip on expand, badge on collapse). A top stripe is
  visible in either mode, on mobile, in fullscreen, in zen views — all
  states. This is a strict superset of the current coverage.
- **Industry precedent.** Slack pins workspace accent to a 4 px left stripe;
  Linear uses workspace accent throughout focus rings and the breadcrumb;
  VS Code's Profile indicator renders as a small colour-coded badge.
  None of these apps have four indicators for one piece of state.
- **Activates the existing token.** `--accent-current` is already wired
  through `useAppSpaceLifecycle.ts`. The redesign wants two CSS rules: the
  stripe element + a single read of the variable. No new state, no new
  store, no new effect.
- **Reduces cognitive load.** Four indicators for one binary-ish state is
  a textbook case of redundant signalling. The user reading the same name
  twice in two adjacent locations is a tell.

### Concerns / pushback

1. **2 px disappears on HiDPI displays.** At `devicePixelRatio: 2` (every
   Retina / most modern Windows) a 2 px line is 1 logical pixel and can
   anti-alias to invisibility. **3 px is the floor.** Slack uses 4 px;
   Linear's accents range 2–4 px depending on surface. Recommend 3 px as
   the target with the option to bump to 4 px after live-testing.
2. **Pure colour-only indicators fail accessibility audits.** ~8 % of
   users (deuteranopia / protanopia) cannot distinguish red-green pairs;
   the current palette has `accent-emerald` (green) and `accent-rose` (red)
   which would alias for them. Mitigation: the **name is still readable
   in the SpaceSwitcher trigger** ("Space: Personal"), so the colour is a
   redundant ambient cue, not the primary signal. This is acceptable.
   Optional follow-up: tint the SpaceSwitcher trigger's left border 1 px
   in `--accent-current` so the accent appears next to the name for
   colour-blind users (single CSS rule, ~zero cost).
3. **Loses the "click chip to focus picker" affordance.** A 3 px stripe
   is not a click target — the chip's `focusSpaceSwitcher()` shortcut goes
   away. Acceptable because (a) the keyboard shortcut `Ctrl+1..9` /
   `⌘1..9` is already the fast path and is now surfaced in the switcher
   tooltip (UX-368), and (b) the switcher itself is one click away.
4. **Loses the collapsed-rail identity cue.** When the sidebar is
   collapsed, the `SpaceSwitcher` is hidden by `group-data-[collapsible=icon]:hidden`
   (`AppSidebar.tsx:155-157`). With chip + badge both deleted, the **only**
   in-app cue in collapsed mode is the 3 px stripe. The user has no way
   to see the space *name* without expanding the sidebar. The OS window
   title still carries it, but on Linux + GNOME with custom decorations
   it can be hidden. **This is the one place I'd refine the proposal.**
5. **OS title bar overlap on macOS.** Tauri uses native decorations
   (`tauri.conf.json` has no `decorations: false`), so the OS title bar
   sits *above* the webview. The 3 px stripe goes at the top of the
   webview, which is visually contiguous with the title bar bottom edge.
   This is fine, just worth noting in the implementation.

## Refined proposal

Same skeleton as the user's proposal, with one delta:

- **ADD**: 3 px accent-coloured stripe, top of webview, full width, fixed
  position, `z-index` above content but below modals.
- **KEEP**: `SpaceSwitcher` (#1).
- **KEEP**: `SpaceAccentBadge` (#2) — collapsed-rail mode only. Without
  it, the icon rail loses all space identity except the (potentially
  hidden) OS title bar.
- **DROP**: `SpaceStatusChip` (#3) — pure redundancy with #1.
- **DROP**: the `space-y-2` placeholder slot in `AppSidebar.tsx:278` and
  any associated `t('space.statusChip')` translations.

Net result: **two in-app affordances** (top stripe always, badge in
collapsed mode only), where today there are three (badge XOR chip, plus
switcher).

### Sketch — implementation outline

This is sketch-level, not a fully-spec'd plan; intent is to show that
the change is small.

**1. Stripe component.** New file, ~25 LOC:

```tsx
// src/components/SpaceTopStripe.tsx
export function SpaceTopStripe(): React.JSX.Element | null {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const active = availableSpaces.find((s) => s.id === currentSpaceId)
  if (active == null) return null
  return (
    <div
      data-testid="space-top-stripe"
      data-space-id={active.id}
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 h-[3px] z-40 pointer-events-none"
      style={{ backgroundColor: `var(--${active.accent_color}, var(--accent-current))` }}
    />
  )
}
```

`aria-hidden` because the name is already reachable via the switcher;
the stripe is decorative redundancy. `pointer-events-none` so it never
steals clicks from the actual chrome.

**2. Mount it in `App.tsx`** above the `<SidebarProvider>` so it sits
above sidebar + content.

**3. Delete** `SpaceStatusChip.tsx` (124 LOC), its test (126 LOC), the
import in `AppSidebar.tsx`, the footer slot, and the
`space.statusChip` i18n keys in `src/i18n/locales/*.json`.

**4. Verify** the existing `SpaceAccentBadge` tests still pass (the
collapsed-rail behaviour is untouched).

**5. Optional** — if the colour-blind concern bites in dogfooding, add
one rule to `SpaceSwitcher`'s trigger:
`style={{ borderLeftColor: 'var(--accent-current)', borderLeftWidth: 2 }}`.

## Alternatives considered

**Alt A — Stripe + badge (refined proposal above).** ★ recommended.

**Alt B — Stripe only, no collapsed badge.** Strictly the user's original
proposal. Cleaner but loses the collapsed-mode name affordance entirely.
Acceptable iff the user is comfortable with "expand sidebar to see name."

**Alt C — Stripe + integrate name into the existing top header.** Today's
`<header className="h-14 ...">` in `App.tsx:406` carries `JournalControls`
or `headerLabel`. We could prefix it with a small `Personal ·` chip in
the accent colour (Linear's pattern). Higher cost (header slot
plumbing), and the header is already busy with view-specific controls;
not worth the trade.

**Alt D — Stripe + tint global focus rings to `--accent-current`.** Make
every focused button/input glow the space colour. Very ambient, very
modern. But aggressive: a Personal-space user with red accents will
have red focus rings everywhere, which fights with the existing
status-overdue / destructive button red. Reject — too invasive.

**Alt E — Drop the top stripe; lean entirely on a redesigned switcher
\- window title.** Make the switcher's trigger `border-l-4` in the
accent colour and add a small dot. Single in-app indicator. Simpler
than Alt A but loses the "ambient peripheral" property — user has to
look at the sidebar to know the space, which defeats the point on
mobile (sidebar collapsed) or in long scroll.

**Alt F — Wider stripe (8–12 px) acting as a draggable window-move
zone on Linux.** Combines indicator + drag-region. Cute but couples
two concerns; if Tauri ever changes the drag-region API the indicator
breaks too. Reject.

## Open questions

These don't block landing; flagging for the implementer.

- **Where exactly does the stripe sit on Tauri Android?** Android has
  no OS title bar but has a status bar; the stripe should NOT collide
  with the status-bar safe-area inset. Likely needs
  `top-[env(safe-area-inset-top)]` on Android.
- **What colour does the stripe show during the boot window** (after
  splash, before `availableSpaces` resolves)? Today `--accent-current`
  defaults to `var(--primary)`. The stripe component returns `null`
  when `active == null`, so during boot there's just no stripe — that
  reads as "loading," which is correct.
- **Theme transitions** — the dark-theme `--accent-*` tokens are
  already brighter (see `index.css:366-372`). The stripe will switch
  with the theme automatically. No extra work.

## Files affected

| File | Change | LOC delta |
| --- | --- | --- |
| `src/components/SpaceTopStripe.tsx` | NEW | +~25 |
| `src/components/__tests__/SpaceTopStripe.test.tsx` | NEW | +~60 |
| `src/App.tsx` | mount `<SpaceTopStripe />` | +2 |
| `src/components/AppSidebar.tsx` | drop `SpaceStatusChip` import + footer slot | −10 |
| `src/components/SpaceStatusChip.tsx` | DELETE | −124 |
| `src/components/__tests__/SpaceStatusChip.test.tsx` | DELETE | −126 |
| `src/i18n/locales/en.json` (+ peers) | drop `space.statusChip*` keys | −~10 |
| `src/components/__tests__/AppSidebar.test.tsx` | drop chip-presence assertions | −~20 |
| `src/components/__tests__/App.test.tsx` | optional: assert stripe presence | +~15 |

Net: roughly **−170 LOC** including tests. Pure simplification.

## Cost / Risk / Impact

- **Cost:** S (≈2–3 h end-to-end, including test rewrites and i18n key
  cleanup across all locales).
- **Risk:** low. No data flow, no IPC, no migration. Visual-only. The
  worst-case regression is a wrong colour or missing stripe — both
  caught by a single visual smoke test on mount.
- **Impact:** medium. Removes ~250 LOC of redundant UI surface,
  activates a token that's currently dead weight, aligns the app with
  industry conventions for multi-workspace identity. Not a flagship
  feature, but a clear visual hygiene win.

## Recommendation

Land Alt A (refined proposal — stripe + collapsed badge, drop chip).
Do **not** add the optional `--accent-current` border on the
SpaceSwitcher trigger as part of the same change; ship the minimum
first, dogfood for a week, then decide whether the colour-blind concern
needs the extra cue.
