# PEND-19 — `RecentPagesStrip` redesign: visible chip chrome + tighter geometry

## TL;DR

The desktop "Recently visited" strip (`src/components/RecentPagesStrip.tsx`,
FEAT-9) reads as too plain, too sparse, and lacking discoverability. Each chip
is a `<Button variant="ghost" size="sm">` — transparent at rest, with no
visible affordance until hovered. The container is a rigid CSS grid
(`auto-fit, minmax(120px, 180px)`) that forces every chip to claim 120–180 px
even when the title is short, producing a sparse, tag-cloud look at the
expense of compactness.

User feedback (verbatim): *"too plain, doesn't look like a breadcrumb, not
compact enough."* Note: the strip is **not** a structural breadcrumb — there
is no hierarchy, no parent/child relationship, no path. Items are
independent, ordered MRU. The framing is corrected here, but the underlying
complaints (plain, weak chrome, sparse geometry) are valid and addressed by
this redesign.

This plan applies **Option B** (chip-on-hover with visible rest-state) from
the design discussion, translated for an MRU-chip row rather than a
path-style breadcrumb. Visual changes only: store contract, keyboard nav,
focus management, click semantics, mobile gating, and per-space scoping all
remain untouched.

Cost: **S** (~1.5–3 h). Risk: **low** (visual-only, no data path).
Impact: **medium** (clear discoverability win on a high-traffic surface).

## Current state

| Aspect | Today |
| --- | --- |
| Chip primitive | `<Button variant="ghost" size="sm">` → `h-8 px-3 text-xs` (32 px tall) |
| Rest-state chrome | None — transparent background, `text-muted-foreground` only |
| Hover state | `hover:bg-accent hover:text-accent-foreground` (inherited from `ghost`) plus `hover:text-foreground` override |
| Focus state | Standard 3 px ring (`focus-visible:ring-ring/50`) + `focus-visible:bg-accent/50` (UX-284) |
| Layout | CSS grid: `repeat(auto-fit, minmax(120px, 180px))` + `gap-2` |
| Row padding | `px-4 md:px-6 py-1.5` |
| Row identity | None — appears as a row of unlabelled chips between `TabBar` and the view header |
| Overflow when count > row capacity | Natural grid wrap to a second row (no popover) |
| Cap | `MAX_RETAINED = 10` in `stores/recent-pages.ts` → up to 9 visible (active page excluded) |

The strip occupies ~44 px of vertical chrome on desktop (6 + 32 + 6) but only
displays 3–7 chips per row depending on viewport width. Each chip claims
120–180 px regardless of title length — a 4-character title gets the same
horizontal slot as a 22-character one. The visual rhythm is therefore "sparse
grid of low-contrast text labels" rather than "row of recently-visited
pages".

## What "Option B" looks like for this component

The original Option B was specified for path-style breadcrumb segments
(`Breadcrumb` primitive, used by `BlockZoomBar` and the `PageHeader`
namespace path). On a structural breadcrumb the goal was *"chip-on-hover
replacing a text-link"*. `RecentPagesStrip` already uses chips, so the
translated goal is:

> **Visible rest-state chrome on every chip**, tighter geometry, and a
> flexible (non-grid) row that lets short titles take less width.

Industry references for the resulting look:

- **Chrome's "Most visited" tiles + Edge's history strip** — small, clearly-
  bounded chips with a faint border, each sized to its content.
- **Linear's recent-issues row** — pill chips with subtle border at rest,
  accent-tinted on hover, tight `gap-1.5`.
- **Notion's "Recents" sidebar** — each item rendered with a soft hover
  background, page-icon prefix; horizontal variant of the same pattern.
- **VS Code's "Open editors" strip** — clearly-delineated tab-like chips,
  not transparent ghost buttons.

The common thread: **a row of recently-visited items must telegraph
"clickable navigation chips" before the user moves their mouse**, and the
chips should be sized to their content, not stretched to a uniform grid.

## Concrete diff

### Chip styling — replace the `Button` ghost variant with a purpose-built chip

Replace the per-chip `<Button>` with a hand-rolled `<button>` styled as a
distinct chip. Reasons:

- The `Button` component's `ghost` variant is designed for toolbar buttons
  that disappear into the background until hovered. That's the wrong rest-
  state for a row of items the user is *expected* to scan.
- A purpose-built chip lets us pin the geometry (`h-7`, `px-2.5`) without
  fighting the design system's `size="sm"` token.
- We keep all four mandatory patterns from `AGENTS.md` (CVA-style class
  composition via `cn()`, semantic tokens, `focus-visible:ring`, touch
  target via existing parent gate).

```tsx
const chipClass = cn(
  // base
  'inline-flex h-7 min-w-0 max-w-[160px] shrink-0 items-center gap-1.5',
  'rounded-md border px-2.5 text-xs',
  'transition-colors',
  // rest state — visible chrome
  'border-border/60 bg-secondary/40 text-muted-foreground',
  // hover — clearer interactive state
  'hover:border-accent hover:bg-accent hover:text-accent-foreground',
  // focus — standard 3 px ring per AGENTS.md (this is a chip, not a link)
  'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
  // UX-284 keyboard-traversal indicator
  'focus-visible:bg-accent/60',
  // touch target via parent media query (the row already gates min-h on coarse pointers)
)
```

The custom chip is ~30 lines lifted out into `src/components/ui/recent-page-chip.tsx`
so the `RecentPagesStrip` body stays focused on data and keyboard logic. Per
AGENTS.md, this is created **before** consumption (small new primitive in
`ui/`, not an inline one-off).

### Row layout — replace the rigid grid with `flex flex-wrap`

The grid forces uniform 120–180 px per chip. A flex-wrap row lets each chip
size to content (with `max-w-[160px]` truncation), packing more chips per
row when titles are short and breaking to a second row only when needed.

```tsx
<div className="flex flex-wrap items-center gap-1.5">
  {visible.map(...)}
</div>
```

Effect at common viewports (assuming average title ~14 chars ≈ 100 px chip):

| Viewport | Today (grid) | After (flex-wrap) |
| --- | --- | --- |
| 1440 px | ~7 chips, one row | ~10 chips, one row |
| 1280 px | ~6 chips, one row | ~8 chips, one row |
| 1024 px | ~5 chips, one row | ~6 chips, one row |
| 800 px | ~4 chips, one row | ~5 chips, one row |
| 768 px | ~3 chips, one row | ~4 chips, one row |

With `MAX_RETAINED = 10` and one excluded (active page), the strip can hold
up to 9 chips. On 1280 px+ the redesign typically fits all of them on one
row; on smaller widths it may wrap to a second row, which is acceptable
(natural CSS reflow, no overflow popover needed — see "Out of scope" below).

### Row geometry — tighter padding and gap

| Property | Today | After |
| --- | --- | --- |
| Row vertical padding | `py-1.5` (6 px) | `py-1` (4 px) |
| Inter-chip gap | `gap-2` (8 px) | `gap-1.5` (6 px) |
| Row horizontal padding | `px-4 md:px-6` | unchanged (matches `TabBar` rhythm) |
| Chip height | `h-8` (32 px, from `Button size="sm"`) | `h-7` (28 px) |
| Chip horizontal padding | `px-3` (from `Button size="sm"`) | `px-2.5` (10 px) |
| Chip max-width | `180px` (grid track upper bound) | `160px` (truncate via `max-w-[160px]`) |

Net vertical strip height: 44 px → 36 px (~18 % reduction).

### Leading row identifier — **decided: omit**

Considered (and discarded by user decision): a single `Clock` icon at the
start of the flex row to identify the row as "Recently visited". Discarded
in favour of keeping the strip pure-content. The row's accessible name is
already carried by the `<nav aria-label={t('recent.ariaLabel')}>` wrapper
and the OS title-bar / tab-bar surfaces above it provide enough context.
Reversible later if the row identity proves unclear in real use.

## Out of scope (explicit)

The original design discussion proposed four "side improvements" alongside
the breadcrumb restyle. After the user clarified that the target is
`RecentPagesStrip`:

| # | Improvement | Applies to `RecentPagesStrip`? |
| --- | --- | --- |
| 1 | Page icons before each crumb (Notion-style) | **No** — `RecentPagesStrip` is a flat MRU list, not a hierarchy. Page-type icons would be additive but were not asked for and add per-row complexity. Skip. |
| 2 | Different separator per use-case (`/` vs `›`) | **No** — there are no separators between MRU chips; they're independent items. Not applicable. |
| 3 | Tighten the overflow popover trigger | **No** — `RecentPagesStrip` has no popover; the grid wraps naturally. Improvement 3 was scoped to the structural `Breadcrumb` primitive. |
| 4 | Drop redundant exit-zoom button on touch in `BlockZoomBar` | **No** — `BlockZoomBar` is a different component. |

**Improvements 3 and 4 remain valid but belong to a separate task on the
structural `Breadcrumb` / `BlockZoomBar`.** Filed as `PEND-21`. Not bundled
here to keep the scope and the test impact narrow.

## UX evaluation

### What this fixes

- **"Too plain"** → Chips have a visible border + faint background at rest,
  so the row reads as "interactive items" before any pointer movement.
- **"Doesn't look like a breadcrumb"** → The user's mental model of "trail
  of pages I've been to" is honoured: the strip now reads as a clear,
  intentional row of clickable items rather than a sparse text grid.
- **"Not compact enough"** → 18 % shorter row, chips sized to content
  instead of forced into 120–180 px tracks, more chips per row at every
  desktop viewport.

### What this does **not** change (and shouldn't)

- **Mobile gate.** Strip still hidden on `useIsMobile()`.
- **Per-space scoping.** Still reads `recentPages` from
  `selectRecentPagesForSpace(s, currentSpaceId)`.
- **Active-page exclusion.** Still derived from `useTabsStore` active tab's
  page-stack top.
- **Click semantics.** Plain click → `navigateToPage`; Ctrl/Cmd/middle-click →
  `openInNewTab`. Unchanged.
- **Keyboard navigation (UX-256).** Roving tabindex, ArrowLeft/Right wrap,
  Enter/Space activates. Unchanged — the new chip element keeps
  `tabIndex={idx === focusedIndex ? 0 : -1}` and `useListKeyboardNavigation`
  hook wiring is data-shape-only.
- **Focus management.** `buttonRefs` map + `useEffect` focus-on-traversal
  still works (the new `<button>` elements register the same way).
- **`aria-label` on the `<nav>`.** Unchanged; the row's accessible name
  comes from the existing `t('recent.ariaLabel')`.
- **Auto-hide rules.** Empty visible list → return null. Unchanged.

### Why a custom chip rather than reusing `Button`

`<Button variant="ghost">` is correct for toolbar actions where the rest-
state should fade into the background. For a row of items the user is
expected to *scan* (recent-pages strip, filter pill row, breadcrumb trail),
the rest-state needs visible chrome. We already do this for `FilterPill`
(visible badge with border) and `Badge` (CVA variants with rest-state
background). A `RecentPageChip` primitive in `src/components/ui/` makes the
pattern reusable and keeps the strip body focused on data + keyboard logic.

If a similar "scan-row of clickable chips" pattern recurs (e.g., a future
"pinned pages" or "frequently visited" row), the `RecentPageChip` primitive
or a generalised `NavChip` is reusable. Not generalised pre-emptively —
extract on second use, per AGENTS.md "Simplicity First".

## Testing impact

Existing tests under `src/components/__tests__/RecentPagesStrip.test.tsx`
target behaviour, not styling: chip count, exclusion, click semantics,
keyboard nav, axe. **All pass unchanged** — the new chip is still a
`<button role="button">` carrying the page title.

New regression assertions to add (small batch, ~4 cases):

1. Chips render with `border` + `bg-secondary/40` classes at rest (CSS-snapshot
   or class-name presence). Catches an accidental revert to ghost-button
   styling.
2. Row container uses `flex flex-wrap` (not `grid`).
3. Chip max-width applies (`max-w-[160px]` class present).
4. axe clean (regression — already covered, will re-run with new DOM).

Optional: a Playwright smoke that takes a screenshot at 1280 px and asserts
the strip height is ≤ 40 px. Skip unless the visual regression is high-risk.

## Migration / backward compatibility

None required. No public API changes. No store, hook, or i18n contract
touched. No new translation keys.

## Step-by-step plan

1. Create `src/components/ui/recent-page-chip.tsx` with the new chip
   primitive (~30 LOC). Verify via existing UI primitive conventions
   (CVA-style class composition, `cn()`, semantic tokens).
2. Replace the `<Button>` instantiation in `RecentPagesStrip.tsx` with the
   new chip; keep all data binding, keyboard, click, and focus logic
   identical.
3. Switch the row container from CSS grid to `flex flex-wrap items-center
   gap-1.5`; tighten `py-1.5` → `py-1`.
4. Add the regression test cases listed above.
5. Run `npm run test -- RecentPagesStrip` (vitest) — expect green.
6. `npx playwright test e2e/keyboard-roving.spec.ts` (or whichever spec
   covers UX-256) — expect green.
7. Commit. Single commit per AGENTS.md commit-style guide.

## Cost / risk / impact

| | |
| --- | --- |
| Cost | **S** — ~1.5–3 h end-to-end. ~30 LOC new chip + ~10 LOC strip diff + ~30 LOC tests. |
| Risk | **Low** — visual-only; behaviour, a11y, keyboard nav, and store contracts untouched. |
| Impact | **Medium** — high-traffic surface (mounted on every desktop view above the page header), discoverability win, ~18 % vertical compression. |
| Reversibility | **High** — single commit revert restores prior styling. |

## Resolved decisions

1. **Leading row identifier (Clock icon):** **omit.** Strip ships pure-
   content; row identity carried by `<nav aria-label>`.
2. **Structural `Breadcrumb` improvements 3 + 4:** **filed separately as
   PEND-21** (icon-button affordance fix on `BreadcrumbHome` + overflow
   trigger, plus redundant exit-zoom button on touch in `BlockZoomBar`).
   Out of scope here.
3. **`RecentPageChip` extraction to `src/components/ui/`:** **yes.**
   Reusable primitive in the right design-system layer.

## Notes

- This walks back **no** prior decision. FEAT-9 (UX-256, UX-284) chose
  `Button variant="ghost"` for the chips at the time the strip was
  introduced; the geometry (rigid grid, py-1.5) was a default rather than a
  design call. This redesign is additive UX polish, not a reversal.
- Original design-discussion thread is not preserved here intentionally —
  this file is the single source of truth for the redesign scope.
