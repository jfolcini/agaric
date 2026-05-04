# PEND-21 — Structural breadcrumb: icon-button affordance + drop redundant exit-zoom button

## TL;DR

Two small, independently-revertible polish items on the structural
`Breadcrumb` primitive (`src/components/ui/breadcrumb.tsx`) and its
`BlockZoomBar` consumer (`src/components/BlockZoomBar.tsx`). Both surfaced
during the PEND-19 design discussion; both are out of scope for that file
and live here instead.

1. **Icon-only trigger affordance bug.** The `BreadcrumbHome` button
   (leading `Home` icon) and the `OverflowPopover` trigger (`…` icon) both
   carry `hover:underline focus-visible:underline` styling — but underlining
   a single icon produces **no visible change** because there's no text
   baseline to decorate. Hover and focus states are effectively invisible.
   Replace with a subtle hover-chip treatment (`bg-accent/40 rounded-sm`)
   plus the standard 3 px focus ring — these are icon buttons, not
   wayfinding text-links, so the form-control ring rule from `AGENTS.md`
   applies cleanly without re-litigating FEAT-13.

2. **Redundant exit-zoom button on touch in `BlockZoomBar`.** On coarse
   pointers `BlockZoomBar` renders **two** "exit zoom" affordances: the
   leading `Home` icon (which calls `onZoomToRoot`, available on every
   pointer mode) and a right-aligned `<X /> Exit zoom` button (touch-only,
   gated by `[@media(pointer:coarse)]`). Same action, two surfaces, one of
   them inconsistent across pointer modes. Drop the touch-only button. If
   discoverability is a concern, tighten the Home icon's `aria-label` from
   `block.zoomToRoot` ("Go to root") to something closer to "Exit zoom".

Cost: **S** (~1–2 h combined). Risk: **low** (visual + a single button
deletion). Impact: **low-medium** (icon affordance is a real discoverability
bug; exit-zoom dedup is a clarity win).

## Item 1 — Icon-only trigger affordance

### Current state

`BreadcrumbHome` and `OverflowPopover`'s trigger both reuse the FEAT-13
text-link styling:

```ts
const homeButtonClass = cn(
  'inline-flex shrink-0 items-center text-muted-foreground transition-colors',
  'hover:underline focus-visible:underline focus-visible:outline-hidden',
)

const overflowTriggerClass = cn(
  'inline-flex shrink-0 items-center text-muted-foreground transition-colors',
  'hover:underline focus-visible:underline focus-visible:outline-hidden',
)
```

These classes were copied wholesale from `itemButtonClass` (the text-link
crumb segments) in commit `c9123287` (FEAT-13). For text segments,
`hover:underline` is the conventional link affordance and works visually.
For **icon-only** buttons (`Home`, `MoreHorizontal`) there is no glyph
baseline to decorate, so:

- Hover state: zero pixels change. The icon is still
  `text-muted-foreground`. The user gets no signal that they're hovering an
  interactive element.
- Focus-visible state: same — `focus-visible:underline` decorates nothing,
  and `focus-visible:outline-hidden` actively *suppresses* the browser
  default focus ring. Result: keyboard users can land focus on the icon and
  see no indicator at all.

This is a discoverability + a11y regression that slipped through FEAT-13's
review because the spec was scoped to text crumbs. The fix doesn't reverse
FEAT-13 — text-link styling on the wayfinding segments stays — it adds a
distinct treatment for the two icon buttons that bracket them.

### Proposed fix

Icon-only buttons get a subtle hover chip + standard 3 px focus ring:

```ts
const homeButtonClass = cn(
  'inline-flex shrink-0 items-center justify-center rounded-sm p-1',
  'text-muted-foreground transition-colors',
  'hover:bg-accent/40 hover:text-foreground',
  'focus-visible:bg-accent/60 focus-visible:text-foreground',
  'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
)

const overflowTriggerClass = cn(
  'inline-flex shrink-0 items-center justify-center rounded-sm p-1',
  'text-muted-foreground transition-colors',
  'hover:bg-accent/40 hover:text-foreground',
  'focus-visible:bg-accent/60 focus-visible:text-foreground',
  'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
)
```

Reasoning per `AGENTS.md`:

- The "principled deviation" comment at the top of `breadcrumb.tsx`
  documents why text-link crumbs get `focus-visible:underline` instead of
  the form-control ring. **Icon-only buttons are not text-link wayfinding
  segments** — the deviation rationale doesn't apply to them. The standard
  `focus-visible:ring-[3px] focus-visible:ring-ring/50` rule from `AGENTS.md`
  applies to icon buttons.
- The hover-chip treatment matches Notion / Linear / VSCode conventions for
  icon-only toolbar triggers and is consistent with how the design system
  already treats other small icon buttons (`FilterPill`'s remove button uses
  the same `rounded-full p-1 hover:bg-muted` pattern).
- Both the home and the overflow trigger get the **same** classes for
  visual consistency — they're sibling icon affordances on the same trail.

The top-of-file doc comment on `breadcrumb.tsx` should be updated to record
the split:
> Text-link crumb segments keep `focus-visible:underline` (FEAT-13).
> Icon-only triggers (`BreadcrumbHome`, `OverflowPopover`) use the standard
> `focus-visible:ring-[3px]` form-control treatment because the underline
> rule has no visible effect on a single icon glyph.

### Test impact

Existing tests in `src/components/ui/__tests__/breadcrumb.test.tsx` assert
the **absence** of hover-bg / focus-ring classes on the home + overflow
trigger (FEAT-13 regression assertions). Those assertions need to flip:

- Home button: assert presence of `hover:bg-accent/40` + `focus-visible:ring`
  classes.
- Overflow trigger: same assertions.
- Crumb segments: assertions stay (text-link styling unchanged).

~6–8 line diffs across the existing test file. Add 1–2 new cases to assert
the hover/focus class presence on the icon buttons.

## Item 2 — Redundant exit-zoom button on touch

### Current state

`BlockZoomBar.tsx` ends with:

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={onZoomToRoot}
  className="hidden [@media(pointer:coarse)]:inline-flex shrink-0 mr-2"
  aria-label={t('blockZoom.exitZoom')}
  data-testid="exit-zoom-btn"
>
  <X className="h-3.5 w-3.5 mr-1" />
  {t('blockZoom.exitZoom')}
</Button>
```

So on touch the user sees:

- **Left:** `Home` icon (calls `onZoomToRoot`, 44 px hit area via the
  breadcrumb primitive's `[@media(pointer:coarse)]:min-h-11` gate).
- **Right:** `<X /> Exit zoom` button (also calls `onZoomToRoot`, also
  visible only on touch).

Two buttons, one action. The right-aligned button only exists on touch —
desktop users have only the Home icon. The asymmetry is itself a smell:
either the Home icon is sufficient (true on desktop) or it isn't (then
desktop also needs an exit affordance). The simpler answer is "Home icon is
sufficient on every pointer mode".

### Proposed fix

Delete the `<Button>` block (lines 106–116 of `BlockZoomBar.tsx`). Optional
follow-up: rename the Home icon's `aria-label` from `block.zoomToRoot` ("Go
to root") to a touch-friendlier phrase like `blockZoom.exitZoom` ("Exit
zoom"), reusing the existing i18n key.

### Test impact

- `src/components/__tests__/BlockZoomBar.test.tsx` asserts the presence and
  click behaviour of `exit-zoom-btn` (line 201–203). That test goes away.
- The Home-icon click test stays.
- One e2e (`e2e/breadcrumb-navigation.spec.ts` from FEAT-13 session 497)
  covers BlockZoomBar zoom-and-exit on desktop. Re-run; expect green.
- No coarse-pointer e2e exists today for this surface (regression risk is
  low — same `onZoomToRoot` call path).

Touch users **lose** the explicit "Exit zoom" verbal label. Mitigation: the
Home icon's tooltip / aria-label gets the explicit "Exit zoom" wording
(optional follow-up above).

## Out of scope

- Anything inside the `RecentPagesStrip` (covered by PEND-19).
- Changes to the text-link styling of the crumb **segments** themselves
  (FEAT-13 stays in force).
- The breadcrumb keyboard-nav model (UX-215) and overflow-collapse threshold
  (`OVERFLOW_THRESHOLD = 5`).

## Step-by-step plan

1. Update `homeButtonClass` and `overflowTriggerClass` in
   `src/components/ui/breadcrumb.tsx`. Update the top-of-file doc comment
   to record the icon-vs-text-link split.
2. Flip the FEAT-13 regression assertions in
   `src/components/ui/__tests__/breadcrumb.test.tsx` for the home + overflow
   triggers (text-link assertions on crumb segments stay).
3. Add 1–2 new assertions for hover-bg + focus-ring presence on the icon
   buttons.
4. Delete the touch-only `<Button>` in `BlockZoomBar.tsx`.
5. Delete the `exit-zoom-btn` test case in `BlockZoomBar.test.tsx`.
6. (Optional) Update Home icon's `aria-label` to `blockZoom.exitZoom`.
7. `npm run test -- breadcrumb BlockZoomBar` (vitest) — expect green.
8. `npx playwright test e2e/breadcrumb-navigation.spec.ts` — expect green.
9. Commit. Single commit per `AGENTS.md` style guide.

## Cost / risk / impact

| | |
| --- | --- |
| Cost | **S** — ~1–2 h end-to-end. ~10 LOC styling diff + ~10 LOC test flips + button deletion. |
| Risk | **Low** — Item 1 is isolated to two `cn()` constants; Item 2 is a deletion of a redundant action. No store, hook, or behaviour change. |
| Impact | **Low-medium** — Icon affordance fix closes a real discoverability bug (keyboard users currently get no focus indicator on Home / overflow). Exit-zoom dedup is consistency polish. |
| Reversibility | **High** — single commit revert. |

## Notes

- These two items were originally proposed alongside PEND-19 as side
  improvements 3 + 4 in a design discussion. After clarification that
  PEND-19's target is `RecentPagesStrip` (not the structural breadcrumb),
  these became separate-task material; user approved filing them here.
- Item 1 is **not** a reversal of FEAT-13. It's a clarification: FEAT-13
  was scoped to text-link crumb segments; the icon buttons that bracket
  them were swept up by accident.
