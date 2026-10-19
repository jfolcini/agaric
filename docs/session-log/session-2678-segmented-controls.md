# Session 2678 — segmented controls show which option is on, in every theme, and work from the keyboard

#5921. The selected segment of a single-choice group was `bg-secondary` on a
`bg-background` track: 1.08:1 in light, at most 1.40:1 in any theme, so the
choice was invisible. AND/OR/NOT, the query type picker, All/Any and
Include/Exclude used the primary fill instead, and `LinkedReferences` used
`aria-pressed` buttons.

- **Look:** the selected segment keeps `bg-secondary` and gains a 1 px
  `border-foreground` outline, keyed on `aria-checked` (a tooltip trigger
  overwrites `data-state`, which let the `EditModeSwitch` and
  `DuePanelFilters` workarounds go). The track stays `bg-background`: the
  issue's `bg-muted` track drops unselected `muted-foreground` labels under
  4.5:1 in Dracula, One Dark Pro and Solarized Dark. `theme-contrast.test.ts`
  pins the outline on the track and on its fill (3:1) and the unselected
  label (4.5:1) in all six themes, with and without high contrast.
- **Keyboard:** Radix's ToggleGroup moves focus on arrow keys but not the
  selection. The wrapper selects the segment an arrow, Home or End focuses,
  and Tab lands on the selected one, for every single-choice group.
- **Pickers:** `LinkedReferences` (a `KindToggle`, "Filter by link kind"),
  `TagFilterPanel`, `QueryBuilderModal`'s type picker (its hand-written arrow
  handling is gone), `TagComposer` and `IncludeExcludeToggle` are each a
  `ToggleGroup`; a re-click of the selected segment no longer clears it.
  `DuePanelFilters`' one-segment group is a `Switch`, "Hide future scheduled".

Shown red: removing the select-on-focus (11 keyboard tests), `checked={false}`
on the Switch, and a raised Solarized Dark `--secondary` (the outline-on-fill
check).

Ran: the full vitest suite (938 files), `npm run typecheck`, `npx oxlint`, and
the 24 Playwright specs that touch these pickers or other ToggleGroups (162).
No real-backend spec targets these pickers.
