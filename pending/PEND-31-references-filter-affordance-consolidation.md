# PEND-31 — References panel: collapse two filter affordances into one in the header

## TL;DR

The references panel today (`LinkedReferences` + `UnlinkedReferences`,
rendered at the bottom of every page via `PageEditor`) presents **two
separate filter affordances** in two different locations:

1. A **show/hide filters toggle** (`SlidersHorizontal` icon + "Filters"
   text), inline with the collapsible title in the header row. Toggles
   the visibility of `BacklinkFilterBuilder` (pill row + "Add filter").
2. A **source-page filter trigger** (`Filter` funnel icon, opens a
   popover), rendered **below** the title in its own row, only on
   `LinkedReferences` (`UnlinkedReferences` has no equivalent).

User feedback (verbatim): *"the filter icon/button appears below the
collapsible title, I would like it to appear right next to the
collapsible title, maybe we should delete the hide/show filters button
next to the count and put it there, it seems like a useless feature."*

Agreed. The show/hide toggle is **low value** — it gates a small
(~30 px) pill row that, when empty, shows just `[Filter icon] [+ Add
filter]`, and when populated is exactly the UI the user wants to keep
visible. The `{N} applied` badge already conveys the only summary the
toggle was hiding. Hiding the pill row when filters *are* applied
actively removes the only affordance to inspect/remove them.

Plan: consolidate to **one** filter surface in the header
(`SourcePageFilter` funnel icon, lifted up next to the title) and let
the `BacklinkFilterBuilder` render unconditionally when the panel is
expanded.

Cost: **S** (~1.5–2.5 h). Risk: **low** (visual + state simplification,
no data path). Impact: **medium** (discoverability win on a
high-traffic surface, removes redundant chrome, simplifies state).

## Current state

### `LinkedReferences` header (lines 290–330)

```tsx
<div className="flex flex-nowrap items-center gap-1 min-w-0">
  <CollapsiblePanelHeader …>{headerLabel}</CollapsiblePanelHeader>
  {expanded && (totalCount > 0 || hasActiveFilters) && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 h-7 gap-1 text-muted-foreground"
          onClick={() => setShowAdvancedFilters((prev) => !prev)}
          aria-expanded={showAdvancedFilters}
          aria-label={showAdvancedFilters ? t('references.hideFilters') : t('references.showFilters')}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t('references.filtersLabel')}</span>
        </Button>
      </TooltipTrigger>
      …
    </Tooltip>
  )}
  {expanded && filters.length > 0 && (
    <Badge variant="secondary" …>
      {t('references.filtersAppliedBadge', { count: filters.length })}
    </Badge>
  )}
</div>
```

Below the header (lines 350–360, inside `ListViewState`):

```tsx
<div className="linked-references-filters …">
  <SourcePageFilter sourcePages={sourcePages} included={…} excluded={…} … />
</div>
```

`SourcePageFilter` itself is a 28 × 28 px ghost button with a `Filter`
funnel icon, opening a `Popover` with the per-source-page list.

### `UnlinkedReferences` header (lines 277–317)

Same `SlidersHorizontal` toggle pattern as `LinkedReferences`, **but no
`SourcePageFilter`** — there's nothing else below the title beyond the
group list itself. So the unlinked path has only one filter affordance
(the toggle) and removing it leaves the header bare.

### Why the toggle adds little

| State | Toggle hides | Toggle reveals |
| --- | --- | --- |
| 0 filters applied | (nothing useful) | `[Filter] [+ Add filter]` (~30 px) |
| ≥1 filter applied | the only UI to inspect/remove the filters | the pills you want to see |
| Sort applied | the only UI to change/clear the sort | the sort control |

The `{N} applied` badge in the header already covers the "I have
filters but they're hidden" case at a glance. Past the badge, the
toggle is redundant — and worse, it lets users land in a state where
filters are silently active but invisible.

## Proposed change

### `LinkedReferences`

1. **Move `SourcePageFilter` into the header row**, immediately after
   `CollapsiblePanelHeader`, in the same position the
   `SlidersHorizontal` toggle occupies today. Same gating
   (`expanded && (totalCount > 0 || hasActiveFilters)`) so the funnel
   only appears when there's something to filter.
2. **Delete the `SlidersHorizontal` toggle button** and the
   `showAdvancedFilters` state + reset effect.
3. **Render `BacklinkFilterBuilder` unconditionally** when `expanded`
   (it already self-collapses to a small `[Filter] [+ Add filter]` row
   when there are no pills).
4. **Keep the `{N} applied` badge** — still a useful at-a-glance
   summary, especially when the panel is collapsed.
5. **Remove the now-empty `<div className="linked-references-filters">`
   wrapper** below the header (the `SourcePageFilter` is its only
   child).

### `UnlinkedReferences`

1. **Delete the `SlidersHorizontal` toggle button** and the
   `showAdvancedFilters` state + reset effect.
2. **Render `BacklinkFilterBuilder` unconditionally** when not
   `collapsed`.
3. **Keep the `{N} applied` badge** (already gated on
   `showAdvancedFilters && filters.length > 0`; flip to just
   `filters.length > 0`).
4. **No `SourcePageFilter` is added here** — out of scope (see "Out of
   scope" below).

### State / prop simplifications

- Drop `showAdvancedFilters` + `setShowAdvancedFilters` from both
  components.
- Drop the `setShowAdvancedFilters(false)` lines in the per-`pageId`
  reset `useEffect`s.
- No prop changes on `BacklinkFilterBuilder` itself — it stays a
  controlled component.

### i18n cleanup

After this change, the following keys in `src/lib/i18n/references.ts`
become unused:

- `references.hideFilters` ("Hide filters")
- `references.showFilters` ("Show filters")
- `references.filtersLabel` ("Filters")

Remove them (and any test references) in the same commit. The
`references.filtersAppliedBadge` and `references.filtersAppliedAriaLabel`
keys stay (the badge is preserved).

## Test impact

### `src/components/__tests__/LinkedReferences.test.tsx`

- **Delete** test 26a "filter button shows visible 'Filters' text label
  (UX-363)" (lines ~889–908). The button is gone.
- **Delete** test 27 "'More filters' toggles advanced filter panel"
  (lines ~910–941). Toggle behavior no longer exists.
- **Delete** test 28 "'More filters' button shows 'Hide filters' when
  expanded" (lines ~943–967).
- **Update** any test that does `await user.click(screen.getByRole(
  'button', { name: /show filters/i }))` to drop the click — the
  `BacklinkFilterBuilder` is already visible.
- **Add** one test asserting `SourcePageFilter` (`source-page-filter-
  trigger` testid) renders in the **header row** (parent assertion
  against `linked-references-header`'s container).
- **Add** one test asserting `BacklinkFilterBuilder` is visible without
  any toggle click after initial render.

### `src/components/__tests__/UnlinkedReferences.test.tsx`

- **Delete** any test asserting the `Show/Hide filters` toggle behavior
  (search for `/show filters/i` and `/hide filters/i`).
- **Update** `BacklinkFilterBuilder` visibility assertions: it now
  renders whenever the panel is expanded.
- The badge assertion at line ~1354 (`'1 filter applied'`) stays —
  badge gating is loosened from `showAdvancedFilters && filters.length
  > 0` to just `filters.length > 0`, but the assertion is reached the
  same way.

### `src/components/__tests__/CollapsiblePanelHeader.test.tsx`

No changes (the primitive itself is untouched).

### E2E

No `playwright` spec exercises the `Show/Hide filters` toggle directly
(verified by `find_file_by_name 'e2e/*references*'` — no matches for
toggle-specific specs at time of writing). Re-run the full e2e suite to
confirm no incidental coverage regression.

## Step-by-step plan

1. **`src/components/LinkedReferences.tsx`**
   - Drop `useState(showAdvancedFilters)` + the `setShowAdvancedFilters`
     reset in the `pageId` effect.
   - Drop the `Tooltip` + `Button` block for the `SlidersHorizontal`
     toggle (lines ~299–320).
   - Lift `<SourcePageFilter …/>` into the header row, replacing the
     deleted block. Keep the same `expanded && (totalCount > 0 ||
     hasActiveFilters)` gating.
   - Delete the `<div className="linked-references-filters …">` wrapper
     below the header (lines ~350–360).
   - Render `<BacklinkFilterBuilder …/>` unconditionally (drop the
     `showAdvancedFilters &&` guard at line ~362).
   - Drop the `SlidersHorizontal` import.
2. **`src/components/UnlinkedReferences.tsx`**
   - Drop `useState(showAdvancedFilters)` + the reset in the `pageId`
     effect.
   - Drop the `Tooltip` + `Button` block for the toggle (lines
     ~286–307).
   - Loosen the badge gating from `!collapsed && showAdvancedFilters &&
     filters.length > 0` to `!collapsed && filters.length > 0` (line
     ~308).
   - Render `<BacklinkFilterBuilder …/>` unconditionally when
     `!collapsed` (drop the `showAdvancedFilters &&` guard at line
     ~319).
   - Drop the `SlidersHorizontal` import.
3. **`src/lib/i18n/references.ts`**
   - Delete the three unused keys: `references.hideFilters`,
     `references.showFilters`, `references.filtersLabel`.
4. **Tests** — apply the deletions / additions enumerated under "Test
   impact" above. Run `npm run test -- src/components/__tests__/Linked
   References.test.tsx src/components/__tests__/UnlinkedReferences.test
   .tsx` until green, then `npm run test` to confirm no incidental
   breakage.
5. **Verification**
   - `npm run lint` (Biome).
   - `npm run typecheck`.
   - `npm run test` (full Vitest suite).
   - `npx playwright test` (full e2e).
   - Manual smoke: open a page with `>5` linked references, confirm the
     funnel icon sits next to the title, the popover still opens, the
     pill row is visible immediately, and the badge appears when
     filters are added.

## Out of scope

- **Adding `SourcePageFilter` to `UnlinkedReferences`.** It would
  improve symmetry, but the unlinked surface is lower-traffic and
  often has only one or two source pages. File as a separate UX item
  if symmetry becomes a concern.
- **Replacing the `BacklinkFilterBuilder` pill row with its own
  popover** (matching `SourcePageFilter`'s pattern). Bigger UX
  rethink; the always-visible pill row is fine and matches typical
  filter-pill conventions (Linear, GitHub).
- **Renaming / restyling the `Filter` funnel icon.** It already uses
  the standard ghost-button + state colors (`text-primary` /
  `text-destructive` for include/exclude states, see
  `SourcePageFilter` lines 44–50).
- **Touch-target sizing on the header row.** `SourcePageFilter`
  already uses `[@media(pointer:coarse)]:h-11` (line 122); no change
  needed when lifting it into the header.
- **The internal `Filter` decorative icon at the start of
  `BacklinkFilterBuilder`'s pill row** (line 192). It's a label icon,
  not an interactive trigger — keep as is.

## Risks

- **Always-visible pill row adds ~30 px of permanent vertical chrome
  when no filters are applied** (just `[Filter icon] [+ Add filter]
  [Sort: …]`). Low risk: the references panel is always at the bottom
  of the page, scroll-only territory, and the row is informationally
  meaningful (it surfaces the filter affordance). If user testing
  flags this as too heavy, the fall-back is to make the
  `BacklinkFilterBuilder` collapse to **just** the `+ Add filter`
  button when `filters.length === 0 && !sort` — cheaper than restoring
  the full toggle.
- **Test churn is concentrated in two files** but moderate (~5–8 tests
  deleted, ~2 added). Risk of stale assertions surviving — mitigate by
  searching for `showFilters`, `hideFilters`, `filtersLabel`,
  `SlidersHorizontal`, `showAdvancedFilters` across the test suite
  before opening the PR.
- **Translators**: the three deleted i18n keys are English-only in
  this repo today (`src/lib/i18n/references.ts` is the only locale
  file), so no translation churn.
