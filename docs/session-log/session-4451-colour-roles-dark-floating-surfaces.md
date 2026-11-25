# Session 4451 — colour roles: today in ink, a priority scale, due-today amber, and dark floating surfaces

Part of the #7040 UI review, items S1 and K1–K6, built on the maintainer's 2026-11-25 decision that today is drawn in ink.

**What shipped**

- **Priority scale.** P1 is solid ink (`--foreground` fill, `--background` label), P2 a grey tint set per theme, and P3 neutral (`--secondary`). P1 and P3 are defined once in `:root` and follow each theme. The agenda's group-by-priority headers are plain ink: P1 used to share the Overdue header's red. The toolbar's priority dots are one ink colour at three strengths. In page mode a P1 keeps its fill, since its label is the page colour.
- **Due today** uses the `--date-due` pair (`dueDateColor`), now amber rather than orange (the light high-contrast override too), so it no longer matches P2, overdue or the search-match yellow.
- **Today in ink:** Month's disc, the date picker's ring and the shared calendar's ring use `--foreground`. Brand red is now only the capture button and the graph's current page.
- **Dark floating surfaces (K1).** Dark `--popover` is lifted to 0.27. The floating and overlay elevations carry a stronger top highlight and a 1 px light ring. Tooltips are inverted in every theme. The other dark themes get the ring and the tooltip through `.dark`, but keep popover equal to card, because lifting it would collide with their muted and hover fills.
- **Dark alerts (K2).** The four borders become `0.5 0.11` at their own hue, inside sRGB, and the fills chroma 0.04. Only the error and tip borders were actually out of gamut.
- **Brand vs destructive (K3)** are separated by lightness: destructive is darker in the light themes and lighter in the dark ones. A tinted destructive button failed 4.5:1 on dark popovers, where delete buttons sit.
- **Dark highlight (K4):** a dark wash (`0.42 0.08 95`) with light text, and the six highlight colours to match. Solarized Dark, Dracula and One Dark Pro inherit it, because their own text is too dim on the wash.
- **K5:** dark `--op-*` badge fills sit above the row, and the unchecked switch thumb is ink in dark.
- **Find in page (K6):** matches use the search-result yellow pair. The current match is that pair inverted, not a white slab.

**Tests**

- `theme-contrast.test.ts` gains a distinguishability check over all six themes, with and without more contrast:
  - P1 vs overdue and destructive; P2 vs due-today (read from `dueDateColor`); due-today vs overdue; P3 vs DOING and the focus ring; today vs brand and destructive. Each pair must be achromatic vs chromatic, or at least 30° of hue apart. The review caught due-today vs overdue at 21° under more contrast in the light themes.
  - Brand vs destructive must be at least 0.08 apart in L.
  - Dark popover vs card must be at least 0.03 apart in L.
  - It was red in 81 cases on main's values.
- A priority-scale check (no hue, P1 furthest from the page) was red in all 12 theme cases on main.
- `theme-overlay` (Dark's Select lifts off the card, tooltips inverted, Month's today in ink), `in-page-find` (match fills) and `page-mode-look` (a P1 keeps its fill) were shown red against main or with the fix reverted. The today due chip has its own contrast pair again.
- Existing unit tests that pinned the old classes were updated: `date-utils`, `BlockInlineControls`, `SortableBlock`, `FormattingToolbar`, `MonthlyDayCell`, `calendar`, `tooltip`, `agenda-sort`.

**Traps**

- `just check-fe` can outlast a tool call on a loaded box. Its steps pass when run one at a time.
- `diagram-legibility.spec.ts` measures a label at 10.99994 px against `>= 11` in this container, identically on main; CI passes it.
