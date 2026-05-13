# Journal header responsiveness — drop redundant trigger + stack on mobile

> Status: ready for review.
> Triggered by: the journal header overflows on narrow screens. Mode tabs (Day/Week/Month/Agenda) + prev/next + date label + Today + Agenda + calendar add up to 9-10 hit targets in a fixed-height row. The redundant `SidebarTrigger` in the header eats another ~44 px of width that the rail's bottom button already covers.

## What's actually rendered on mobile today

`src/App.tsx:407-420` renders the app header:

```tsx
<header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
  <SidebarTrigger className="md:hidden" />
  {currentView === 'journal' ? <JournalControls /> : (...)}
</header>
```

`JournalControls` (`src/components/JournalControls.tsx:99`) is `flex flex-1 items-center gap-2 flex-wrap`. The `flex-wrap` is set, but `<header>`'s `h-14` (56 px) clips anything that wraps past the first row, so the date nav block silently disappears on a 375 px phone.

The `useIsMobile` breakpoint is 768 px (`src/hooks/useIsMobile.ts:3`), and the `AppSidebar` is `<Sidebar collapsible="icon">` (`AppSidebar.tsx:129`). On mobile, the sidebar primitive renders a **persistent 48-px icon rail and the Sheet** (`src/components/ui/sidebar.tsx:346-393`). The rail's bottom slot holds `CollapseButton` (`AppSidebar.tsx:307`) — its `onClick` is `toggleSidebar()`, which on mobile opens the Sheet (`sidebar.tsx:124-127`). So the user already has an always-visible affordance to open the sidebar from the rail; the header `SidebarTrigger` duplicates it.

## The fix

### 1. Drop the redundant header `SidebarTrigger`

`src/App.tsx:408`. Delete the line:

```tsx
<SidebarTrigger className="md:hidden" />
```

Remove the now-unused `SidebarTrigger` import on `src/App.tsx:14`. The mobile rail's `CollapseButton` (`AppSidebar.tsx:307`) is the always-visible entry point. Frees ~44-48 px of horizontal header width on mobile — exactly where it's needed for (2).

If at any point we switch the sidebar back to `collapsible="offcanvas"` (no rail), the header trigger becomes load-bearing again. That's a one-line revert; not worth keeping the duplicate around for the hypothetical future.

### 2. Two-row journal header on narrow screens

`src/components/JournalControls.tsx:99`. Change the root container from a single flex-wrap row into a `flex-col sm:flex-row` stack:

```tsx
<div
  className="flex flex-1 flex-col sm:flex-row sm:items-center gap-2"
  data-testid="journal-header"
>
  {/* Row 1 (always): mode tablist + spacer + calendar icon */}
  <div className="flex items-center gap-0.5">
    {/* mode tabs (existing) */}
  </div>
  <div className="hidden sm:block flex-1" />

  {/* Row 2 on mobile / inline on sm+: prev / date / next / Today / Agenda + calendar */}
  <div className="flex items-center gap-1">
    {/* date nav block (existing) */}
  </div>
</div>
```

Pair it with letting the header height expand on narrow widths. `src/App.tsx:407`:

```diff
- <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
+ <header className="flex min-h-14 shrink-0 flex-col sm:flex-row sm:items-center gap-2 border-b bg-background px-4 py-2 sm:py-0">
```

`min-h-14` keeps today's chrome height on desktop; `py-2` pads the two-row stack on mobile so the rows breathe instead of cramming into 56 px.

The non-journal branch (`else` at `App.tsx:411-419`) is short — page-name label + GlobalDateControls — and stays single-row everywhere; the `sm:flex-row` on the header still puts it on one line on `sm:` and wraps on the very narrowest widths if a long page name forces it.

### 3. Compact mode tabs at the narrowest widths

`src/components/JournalControls.tsx:106-132`. The four mode tabs (Day / Week / Month / Agenda) take ~180-220 px when expanded. On a 360 px phone they crowd the calendar icon out of row 1 even after the stack split. Two options, pick the cheaper:

- **(a) Single-letter labels under `xs`.** Below ~480 px swap `Day` → `D`, `Week` → `W`, etc. Visible labels but very compact. Tooltip + `aria-label` already point at the long names so a11y is unchanged.
- **(b) Icon-only mode buttons under `xs`.** Use one of `Calendar`, `CalendarDays`, `CalendarRange`, `ListChecks` per tab. More universal, less language-dependent, but adds 4 icon imports and the "agenda" icon is ambiguous next to the existing standalone Agenda button.

Recommend **(a)** — D/W/M/A. Smaller diff, no new imports, retains a text affordance.

Implementation: add a `useIsXs` (or just `useMedia('(max-width: 479px)')`) check; render `tabLabels[m]` with `.charAt(0).toUpperCase()` when xs is true. Or equivalently, render two spans and toggle visibility with `inline xs:hidden` / `hidden xs:inline` if Tailwind's `xs` breakpoint is configured (it isn't by default — using `[@media(max-width:479px)]:` arbitrary variants keeps it Tailwind-config-free).

Optional follow-up if labels still spill: the standalone *Agenda* button at line 215-226 duplicates the *agenda* mode tab. Drop it on narrow screens (`hidden sm:inline-flex`) — the mode tablist already has it, and mobile users have one fewer button to tap by accident.

### 4. Tests

`src/components/__tests__/JournalControls.test.tsx` queries by `role="tab"` + `aria-label` for the mode tabs and `data-testid="date-display"` for the label — neither breaks when we swap text for a single letter (the accessible name comes from `aria-label`, which we keep as the full word). Add one test:

- At `useIsMobile() === true` (mock the hook), the header root carries `flex-col` and both row blocks are present.

`src/components/__tests__/App.test.tsx` checks the header's structure — verify after deleting `<SidebarTrigger className="md:hidden" />` that no test asserts on its presence (`grep -n SidebarTrigger src/components/__tests__/App.test.tsx`). If any do, swap them for an assertion on the rail's `CollapseButton` (`getByRole('button', { name: t('sidebar.collapse') })`).

## Verification

- `npm run typecheck`
- `npm run test -- JournalControls App` — unit assertions, especially the new mobile-stack test.
- Manual: open the journal at 375 × 667 (iPhone SE), 414 × 896 (iPhone 11), 768 × 1024 (iPad), 1280 desktop. Confirm:
  - All controls visible at every width (no clipped row).
  - The mobile rail's bottom button still opens the sidebar Sheet (existing behaviour, regression check).
  - Active mode tab + date label remain legible across widths.
- E2E: there's a `journal` Playwright spec — re-run it (`npm run e2e -- journal`) to confirm the structural change doesn't break the header tests.

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | S. ~1 hour total. Header trigger removal: 5 min (delete a line + an import). Two-row stack + header height: ~30 min. Compact mode-tab labels (option (a)): ~15 min. Test updates + manual sweep: ~30 min. |
| **Impact** | Closes the visible "header overflows / controls disappear" bug on every mobile journal viewport. Removes a duplicate sidebar entry point that confused at least one user (this report). Frees ~44 px of horizontal width without losing any function. |
| **Risk** | Very low. Three localised diffs (`App.tsx`, `JournalControls.tsx`, optional one CSS variant). The sidebar trigger removal is reversible in one line if we change the sidebar to `collapsible="offcanvas"` later. The two-row stack uses standard Tailwind responsive utilities — no new primitive, no JS breakpoint logic except the optional `useIsMobile` for the test mock. The compact-label option (a) is purely a label-rendering change; `aria-label` stays the long word. |
| **Reversibility** | High. Each of the three sub-changes is independently revertible. |

## Out of scope

- Any change to the sidebar primitive itself (`src/components/ui/sidebar.tsx`).
- The `GlobalDateControls` non-journal branch — already fits today.
- Renaming or rethinking the *Today* / *Agenda* / calendar buttons.
- Switching the sidebar from `collapsible="icon"` to `collapsible="offcanvas"`. That changes whether the rail exists at all and would re-justify the header trigger; out of scope.
