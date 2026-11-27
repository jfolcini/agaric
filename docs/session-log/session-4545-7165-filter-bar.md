# Session 4545 — #7165 U3: one filter-bar layout in every view

Round 3 of the UI review (#7165, from the notes on #7155) chose one filter-bar layout for every view, phone and desktop.

**Premise check**

- Confirmed on `origin/main`. Graph and Pages put chips, Add filter, then Clear all in one wrapping row. Agenda put Clear all before Add filter, with its View menu to the right of the bar. Search put everything in one row, so with no chips Add filter stood alone. References put chips, Add filter, Clear all and Sort in one row.
- Confirmed the icons too: a funnel in Graph, Agenda and References; "+" in Pages and Advanced query (both use Pages' `AddFilterPopover`); "+" with a chevron in Search.

**Change**

- `src/components/filters/FilterBar.tsx` is the one layout. It shows the chips on their own wrapping row, only when there are chips. Below them is one actions row: Add filter, then Clear all (only when there are chips), then the view's trailing controls.
- The five bars render through it with their own chips, actions and data flow: `GraphFilterBar`, `AgendaFilterBuilder`, `PageBrowserFilterRow`, `search/FilterChipRow` and `BacklinkFilterBuilder`.
- Graph's Focus on this page and Agenda's View menu move into the bar's trailing slot. `GraphView` and `AgendaView` pass them in.
- Add filter shows the funnel in Pages, Advanced query and Search. Search's chevron is gone. Add group keeps its icon.
- On a phone, Pages' chips now wrap instead of scrolling sideways on one row: the choice asks for one wrapping row everywhere.
- References' Clear all also resets the sort. It now shows only when there are chips, as the choice asks. Before, a sort alone was enough to show it.

**Tests**

- `FilterBar.test.tsx`: without chips there is no chips row and no Clear all; with chips the order is chips row, then Add filter, Clear all, trailing. Red under two mutations: Clear all always rendered, and Clear all before Add filter.
- `e2e/filter-bar-layout.spec.ts`, desktop (1440×900) and Pixel 7: in Graph, Pages, Agenda, Search and References, every chip ends above Add filter, and Add filter holds `svg.lucide-funnel`. Advanced query's Add filter holds the funnel. Red when `FilterBar` went back to one row (all five views on the bounding-box assertion), and when Pages' icon went back to `Plus` (Pages and Advanced query).
- Updated because they pinned the old behaviour:
  - `FilterHelperPopover.test.tsx` expected two icons and now expects one funnel.
  - `PageBrowserFilterRow.test.tsx`'s phone sideways-scroll block is deleted.
  - `strip-scrollbars.spec.ts` no longer checks the Pages filter scroller, which is gone.
  - `AgendaView.test.tsx`'s builder mock now renders `trailing`.

**Review**

- Trailing controls now end the actions row in every view: `FilterBar` wraps them in one `ms-auto` group. Before, Agenda's View menu sat right after Clear all, and Graph's Focus on this page reached the far end only when the "Showing N of M" count was there to carry `ml-auto`. The `ml-auto` copies in `GraphFilterBar` and `FilterSortControls` are gone. `e2e/filter-bar-layout.spec.ts` checks that Graph's, Agenda's and References' trailing controls end the row, on desktop and phone. It goes red for all six when `ms-auto` is removed.
- Graph's "No filters applied" badge is gone, along with its i18n key. Without chips the bar shows only Add filter, so the badge said nothing new. The `GraphFilterBar.test.tsx` checks that used it as an empty-state marker now check that no chip renders.
