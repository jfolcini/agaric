# Session 3929 — Rendered axe sweep, design-system batch, prefer-tag-over-role review

Finishes the three open checkboxes of #6528. The first four (the DONE check mark, the sync dot, "more contrast" outlines, every token pair pinned) merged in #6581.

## Rendered sweep

- **`runAxe` / `axeViolations` in `e2e/helpers.ts`.** The fourteen specs that each injected `axe-core` themselves now call these. `runAxe` injects once per document and throws when its selector matches nothing, so a scoped run cannot pass over an empty context.
- **`e2e/views-axe.spec.ts`** runs every rule on each `VIEW_HEADING` view in light and dark. Its first run failed every view. Fixed, not excepted:
  - `region`: the desktop sidebar was outside every landmark. `Sidebar` (`ui/sidebar.tsx`) now renders its inner element, and the mobile sheet's body, as `<nav aria-label="Sidebar">`.
  - `heading-order`: Tags (`TagFilterPanel` h3/h4 → h2/h3), Advanced Query (saved views h3 → h2), Journal (`SectionTitle` and the projected heading were h4 under the view's h1; both hosts of `DuePanel`, the daily view and a journal page, head it with an h1, so they are h2 and `ProjectedEntriesSection` lost its `headingLevel` prop).
  - No colour-contrast finding in either theme.
- **`e2e/token-chip-contrast.spec.ts`** runs `color-contrast` over the Projects page in all six themes with priority, highlight, page link, tag, block ref and external link chips seeded, and asserts axe measured each chip (a pass on its markup, nothing incomplete). Trap: History's op badges cannot be measured this way; axe files text on a `.list-row` as incomplete because the row's tint is a pseudo element. They stay pinned by the token pairs in `theme-contrast.test.ts`.
- Shown red: lowering `--block-ref-foreground` in `.theme-dracula` failed the chip spec in Dracula on the block-ref label; raising `:root --muted-foreground` failed the Pages view in light on `color-contrast`.

## Design-system batch

- The ten `text-[10px|11px|0.7rem]` class literals are `text-xs`; two vacuous `not.toContain('text-[10px]')` assertions went with them.
- `FilterHelperPopover`'s categories had `role="menu"` with no arrow keys; they are plain buttons in the popover's dialog, as in `AddFilterPopover` (test red first).
- Six bare scrollers are `ScrollArea` (TagComposer, ImportSection, BibliographySection, SavedViewsDropdown, FilterHelperPopover, `marks/table.tsx`). Three stay: EmojiPicker's grid is the virtualizer's scroll element and Radix inserts a `display: table` wrapper between the grid and its rows; pdf.js throws unless its container is absolutely positioned; the touch toolbar is a fixed, swiped row that only a device can check.
- The eleven raw `shadow-sm` are `shadow-(--shadow-resting)`.
- `focus-ring-visible` on the raw focusable `<button>`s that had no ring, starting with DaySection, StatusPanel and CollapsibleGroupList. Buttons styled by a CSS class with its own `:focus-visible` (chips), `tabIndex={-1}` ones and those whose class comes from a caller were left.

## prefer-tag-over-role

118 disables before, 96 after. 21 `role="status"` elements whose content is phrasing became `<output>` (a `block` class where the element was a block box); the decorative calendar dot lost a `role="img"` it had beside `aria-hidden`. Tests that read the literal attribute now assert `toHaveRole('status')`. Every remaining disable has a reason naming why the native element cannot be used; the status ones that wrap skeleton rows, `<p>`, `<details>` or a button now say so (an `<output>` takes phrasing content only), replacing claims that `<output>` "is inline" or that tests needed the attribute. Five other disables had their reason only in prose above; it is now inline.

## Checks run

Targeted vitest per touched component (all green), `npm run typecheck`, `npx oxlint src e2e scripts`, both new specs, the migrated specs' axe tests, and in-page-find, due-panel, journal-panels, table-view-render, advanced-query-saved-views, search-filters, menus-popovers, tags-query-modes, search-filter-chips on the final tree. Changed vitest assertions were each falsified (kbd size, SectionTitle level, projected heading level, repeat indicator and find counter as `<output>`).
