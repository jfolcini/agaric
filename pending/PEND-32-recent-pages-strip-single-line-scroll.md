# PEND-32 — `RecentPagesStrip` single-line horizontal scroll layout

## TL;DR

The desktop "Recently visited" strip
(`src/components/RecentPagesStrip.tsx`, FEAT-9) currently uses a CSS
grid (`repeat(auto-fit, minmax(120px, 180px))`) that **wraps to a
second row** as the user accumulates recent pages — each row is ~44 px,
so two rows is ~74 px of vertical chrome stacked above the view header.
PEND-19 plans to switch to `flex flex-wrap`, which still permits a
second row at narrower viewports.

User feedback (verbatim): *"the breadcrumbs below the app header should
only occupy one line at most and should be scrollable by scroll wheel
with the mouse or moving with the finger on touch."*

(Terminology note: as documented in PEND-19, the strip is **not** a
structural breadcrumb. It's an MRU row of recently-visited pages. The
underlying constraint — bounded vertical chrome — is valid regardless
of naming.)

This plan replaces the wrapping layout with a **fixed single-row,
horizontally-scrollable** strip. Rationale: predictable header height,
established UX precedent for MRU/recents affordances (browser tab
strips, VS Code editor tabs, Chrome "Most visited", Linear recent
issues, Notion recents).

Cost: **S** (~2–3 h). Risk: **low** (visual + scroll-handling, no data
path). Impact: **medium** (bounded header height across all viewports
and recent-page counts; future-proofs any later `MAX_RETAINED` increase
beyond 10).

## Relationship to PEND-19

PEND-19 redesigns chip *styling* (visible chrome, tighter geometry) and
chooses `flex flex-wrap` as the row layout. This plan revises only the
**layout** decision: keep PEND-19's chip styling and geometry, but
render the row as a single horizontal scroll container.

Two ways to land:

a) **Bundle.** Apply PEND-19's chip + geometry changes and this plan's
   single-line scroll in one commit. Test fixtures overlap; ~3 h total.
b) **Sequence.** PEND-19 first (chip styling, flex-wrap), then this
   plan on top (flex-wrap → single-row scroll). Slightly more total
   churn but each commit is independently revertible.

Either works. **Recommendation: bundle (a).** The two changes target
the same component, the test fixtures are shared, and the layout is
part of the same visual decision PEND-19 documents.

If PEND-19 is rejected and only the single-line scroll lands, this
plan stands on its own — chip styling stays as today's `Button ghost`,
but the row container becomes a single-line scroller.

## Current state (today, pre-PEND-19)

```tsx
<div
  className="grid gap-2"
  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 180px))' }}
>
  {visible.map(...)}
</div>
```

Strip vertical chrome:

- Single row: ~44 px (`py-1.5` × 2 + 32 px chip).
- Two rows: ~76 px (44 + 8 px gap + 32 px chip).

With `MAX_RETAINED = 10` (cap in `stores/recent-pages.ts`), at 1440 px
viewport the strip currently fits ~7 chips per row, so a second row
appears once visited count exceeds ~7. At 768 px the second row appears
at ~4. If the cap is later raised (worth considering once the strip
can scroll), the wrap problem worsens linearly.

## Concrete diff

### Wrap the row in `ScrollArea` with `orientation="horizontal"`

Per AGENTS.md "Mandatory patterns": *"`ScrollArea` from
`ui/scroll-area.tsx` for any scrollable container. Never use bare
`overflow-auto`."* The existing `<ScrollArea>` primitive already
accepts `orientation="horizontal"` (see
`src/components/ui/scroll-area.tsx` lines 12–36, the `viewportRef` /
`viewportClassName` / `viewportProps` props were added in UX-226
specifically for this kind of use).

```tsx
<ScrollArea
  orientation="horizontal"
  className="w-full"
  viewportRef={viewportRef}
  viewportClassName="overscroll-x-contain"
  viewportProps={{ onWheel: handleWheel }}
>
  <div className="flex items-center gap-1.5 px-4 md:px-6 py-1">
    {visible.map(...)}
  </div>
</ScrollArea>
```

Note `flex` (not `flex-wrap`) — chips stay on one line and overflow
into the scroll viewport. `shrink-0` on the chip class (already in
PEND-19's spec) prevents flex from compressing chip widths to fit the
viewport.

### Translate vertical wheel → horizontal scroll

Most desktop mice do not have a horizontal scroll wheel. When the
cursor is over the strip, the user expects the standard vertical wheel
to move the row sideways. Implemented as a small `onWheel` handler
threaded into the ScrollArea viewport:

```tsx
const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
  // Only translate if vertical delta is dominant. Trackpad two-finger
  // horizontal-swipe gestures already set deltaX directly — let those
  // through so native horizontal scroll keeps working.
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.currentTarget.scrollLeft += e.deltaY
    e.preventDefault()
  }
}, [])
```

Caveats:

- **Trackpad two-finger horizontal swipe** sets `deltaX` natively —
  handler skips it via the `|deltaY| > |deltaX|` guard, so native
  horizontal scroll keeps working untouched.
- **Shift+wheel** users get the same effect both natively (browser
  maps it to horizontal) and via this handler — handler runs first,
  `preventDefault` prevents the browser default; result is identical.
- **`prefers-reduced-motion`**: this handler does not animate; it
  just bumps `scrollLeft` synchronously. No change needed.

### Touch swipe

Native via `overflow-x: auto` on the ScrollArea viewport. No JS
needed. The `overscroll-x-contain` class prevents the swipe from
propagating to a parent container (e.g. a future swipe-to-go-back
gesture on Android).

### Keyboard ArrowLeft / ArrowRight — scroll focused chip into view

PEND-19 keeps `useListKeyboardNavigation` for arrow-key traversal.
With single-line layout, the focused chip can be off-screen. Augment
the existing focus-management `useEffect` to scroll the focused chip
into view:

```tsx
useEffect(() => {
  const activeEl = document.activeElement
  const isInsideStrip = Array.from(buttonRefs.current.values())
    .some((btn) => btn === activeEl)
  if (!isInsideStrip) return
  const target = buttonRefs.current.get(focusedIndex)
  if (target == null) return
  target.focus()
  target.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
  })
}, [focusedIndex, prefersReducedMotion])
```

Read `prefersReducedMotion` from a small local hook or inline
`window.matchMedia('(prefers-reduced-motion: reduce)').matches`. Check
`src/hooks/` for an existing helper before rolling a new one — the
codebase already honours the token in `index.css` so a hook may exist.

### Edge-fade affordance — defer to v2

Without a wrapping second row, users may not realise there's more
content to the right. The Radix horizontal scrollbar that ScrollArea
renders auto-fades on scroll/hover; on its own that's usually enough,
and a partially-cut last chip reinforces the cue.

A faint right-edge mask (`mask-image`) is the common further
reinforcement, but it requires a `ResizeObserver` to toggle on/off
based on overflow. **Recommendation: ship without the fade in v1.**
File a `MAINT-…` follow-up if real-world feedback says discoverability
is weak.

### Strip geometry — unchanged from PEND-19

| Property | After PEND-19 + PEND-32 |
| --- | --- |
| Row vertical padding | `py-1` (4 px) |
| Inter-chip gap | `gap-1.5` (6 px) |
| Chip height | `h-7` (28 px) |
| Strip total height | ~36 px (single row, fixed) |

Radix's horizontal scrollbar adds ~10 px when visible, but it auto-
hides; reserve space via `viewportClassName="pb-2"` only if visual
jitter on hover proves distracting in practice.

## Out of scope (explicit)

| # | Item | Why |
| --- | --- | --- |
| 1 | CSS `scroll-snap` per chip | Adds snap behaviour on scroll-end; nice-to-have but not requested. Skip unless asked. |
| 2 | Raise `MAX_RETAINED` beyond 10 | Independent decision in `stores/recent-pages.ts`. With single-line scroll the cap can be raised cheaply, but doing so is its own UX call. Not bundled. |
| 3 | "Pinned recents" / sticky leading items | Different feature. |
| 4 | Overflow popover / "More" dropdown | Wrong pattern for ordered MRU. Discarded in design discussion. |
| 5 | Drag-to-reorder | Recents are chronological, not user-curated. |
| 6 | Edge-fade `mask-image` affordance | Requires `ResizeObserver`; defer to v2 if needed. |

## UX evaluation

### What this fixes

- **Predictable header height.** Strip is exactly ~36 px regardless of
  recent-page count or viewport width. Two-row jumps (~76 px today, ~74
  px after PEND-19) eliminated.
- **Established pattern.** Matches Chrome / Edge tab bars, VS Code
  editor tabs, Linear recents, Notion recents — all of which use a
  single-line horizontal scroll for ordered MRU rows.
- **Future-proofs `MAX_RETAINED` increases.** Today's cap of 10 caps
  the wrap problem; raising it (say to 20–30 to retain longer history)
  becomes a one-line change once the layout no longer wraps.

### What this does **not** change

- Mobile gate (`useIsMobile()` returns `null` — strip not rendered).
- Per-space scoping (`selectRecentPagesForSpace`).
- Active-page exclusion (derived from `useTabsStore` active tab's
  page-stack top).
- Click semantics (plain → `navigateToPage`; ctrl/cmd/middle-click →
  `openInNewTab`).
- Roving tabindex / arrow-key wrap (UX-256).
- `aria-label` on the `<nav>` (`t('recent.ariaLabel')`).
- Auto-hide rules (empty visible list → return `null`).

### Discoverability tradeoff

Items past the visible right edge are out of sight. With
`MAX_RETAINED = 10` and ~7 chips visible at 1280 px, ~3 chips are
off-screen. Mitigations:

- Native scrollbar (Radix auto-shows on hover/scroll).
- Partially-cut last chip indicates overflow.
- Arrow-key traversal scrolls focused chip into view.
- Trackpad horizontal-swipe is native.
- Mouse-wheel-to-horizontal handler covers desktop-with-mouse.

This tradeoff is consistent with the precedent set by Chrome's tab
strip and IDE editor tabs — both accept that off-screen tabs require
interaction to reveal. The alternative (wrap to a second row) breaks
the predictable-height invariant and is what the user is explicitly
asking us to avoid.

## Testing impact

Existing tests under `src/components/__tests__/RecentPagesStrip.test.tsx`
target behaviour, not styling. Most pass unchanged. Updates needed:

1. **Container assertion.** Existing assertions on `grid` (today) or
   `flex-wrap` (post-PEND-19) flip to assert `<ScrollArea>` wrapper +
   inner `flex items-center` (no wrap).
2. **Wheel-to-horizontal handler.** New test: dispatch a synthetic
   `WheelEvent` with `deltaY: 100, deltaX: 0` over the viewport,
   assert `scrollLeft` advances and `preventDefault` was called.
   With `deltaX: 100, deltaY: 0` assert `scrollLeft` is **not**
   touched (handler skipped, native scroll handles it).
3. **Arrow-key `scrollIntoView`.** New test: fixture with enough
   recent pages to overflow the test viewport, simulate ArrowRight to
   the last chip, assert `scrollIntoView` invoked on the focused
   button (mock `Element.prototype.scrollIntoView`).
4. **Reduced-motion path.** Mock
   `matchMedia('(prefers-reduced-motion: reduce)').matches = true`,
   assert `scrollIntoView` called with `behavior: 'auto'`.
5. **a11y / axe regression.** Already covered; will re-run with the
   new DOM structure (`role="region"` from ScrollArea wrapper).

Optional Playwright smoke: at 800 px viewport with 9 visible chips,
confirm the strip is exactly one row tall (~36–46 px including
scrollbar) and that horizontal scroll works via wheel and via
keyboard arrow traversal.

## Migration / backward compatibility

None required. No public API changes. No store, hook, or i18n
contract touched. No new translation keys.

## Step-by-step plan

(Assumes PEND-19 lands first or in the same commit.)

1. Wrap the existing row in `<ScrollArea orientation="horizontal">`.
   Drop `flex-wrap` (or grid). Move `px-4 md:px-6 py-1` from the
   outer `<nav>` to the inner `flex` so the ScrollArea viewport has
   no padding (avoids scrollbar inset weirdness).
2. Add the `onWheel` handler that translates `deltaY` → `scrollLeft`
   when vertical is dominant. Thread via `viewportProps`.
3. Augment the focus-management `useEffect` with `scrollIntoView({
   block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion
   ? 'auto' : 'smooth' })`. Use any existing reduced-motion hook;
   otherwise inline `matchMedia`.
4. Verify `shrink-0` is on the chip class (PEND-19 already specifies
   this; confirm).
5. Update / add tests per the list above.
6. Run `npm run test -- RecentPagesStrip` (vitest) — expect green.
7. Run the relevant Playwright spec(s) for keyboard roving / app-
   shell layout.
8. Commit. Single commit per AGENTS.md commit-style guide; if
   bundling with PEND-19, scope the message accordingly.

## Cost / risk / impact

| | |
| --- | --- |
| Cost | **S** — ~2–3 h end-to-end. ~20 LOC component diff (ScrollArea + onWheel + scrollIntoView), ~50 LOC tests. |
| Risk | **Low** — visual + scroll-handling; behaviour, a11y, keyboard nav, and store contracts untouched. The wheel handler is the one piece with a non-obvious failure mode (over-eager `preventDefault` on trackpad horizontal swipe), guarded by deltaY-dominance check + tested. |
| Impact | **Medium** — bounded header height across all viewports and recent-page counts, aligns with established UX precedent for recents/tab strips, future-proofs `MAX_RETAINED` increases. |
| Reversibility | **High** — single commit revert restores the prior layout. |

## Open questions

1. **Bundle with PEND-19 or sequence?** Recommendation: **bundle**.
   Both are visual-only, both target the same file, test fixtures
   overlap. Sequencing adds churn for no benefit.
2. **Edge-fade affordance in v1?** Recommendation: **skip**. Radix
   scrollbar + partially-cut last chip is sufficient. File a
   `MAINT-…` follow-up if real-world feedback says otherwise.
3. **Raise `MAX_RETAINED` while we're here?** Recommendation:
   **no**. Independent UX call. File a `MAINT-…` to revisit once
   the layout no longer wraps.

## Notes

- This walks back **PEND-19's `flex-wrap` layout decision**. PEND-19's
  chip styling and geometry are preserved; only the row container
  layout changes. PEND-19's "Out of scope" table item #3 (overflow
  popover) remains discarded — single-line scroll is the chosen
  alternative, not an overflow popover.
- Original conversation framing referred to the strip as
  "breadcrumbs"; terminology corrected here per PEND-19's same
  correction. The MRU-row label is what the rest of the codebase uses.
- README index entry deferred to a separate housekeeping commit
  (matches the PEND-30 / PEND-31 precedent, where each plan was
  added without README churn so the diffs stay unrelated).
