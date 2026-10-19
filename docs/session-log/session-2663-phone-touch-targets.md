# Session 2663 — the drawer rows, two name inputs and four small controls take a 44 px tap on a phone

#5930, measured at 390 × 844 with touch. The search sheet's chip and handle,
the toast close button and the capture button go with #5931 and #5932, which
rework those surfaces.

| Control | Before | After |
|---|---|---|
| Drawer rows and the Bookmarks header | 32 px tall | 44 px |
| Tags "New tag name", Templates "New template name" | 30 px tall | 44 px |
| Advanced Query NOT | 37 × 28 | 44 × 44 |
| References "Collapse group" | 14 × 14 | 44 × 44 |
| Agenda status chip's edit button | 20 px | 44 px hit area, 20 px laid out |
| Settings › Properties task-cycle help | 14 × 14 | 44 × 44 |

- **Drawer alignment (#5929's item):** the nav rows and footer sat at x = 8
  under header controls at x = 16; `SidebarGroup` and `SidebarFooter` pad
  `px-4`, keeping `px-2` for the desktop icon rail. Desktop rows stay 32 px.
- **Collapse group** lives in the shared `CollapsibleGroupList`, so Unlinked
  references and search result groups get the 44 px target too; it is an
  `IconButton` now.
- **Agenda chip:** the issue's 20 px is the chip's edit button; the chip itself
  is 46 px tall. The edit button uses `touch-hit-area`, copied unchanged from
  #5945 so the two PRs converge.
- **Inputs:** `flex-1` collapsed them inside a column row; it is `sm:flex-1`, as
  `PropertyDefinitionsList` already does.

`e2e/phone-touch-targets.spec.ts` taps 21 px off each control's centre in all
four directions with `elementFromPoint`, so a pseudo-element hit area counts,
and checks the drawer rows' left edge. Reverting the sources failed all six
tests; reverting only the padding failed the alignment check (8 for 16).

Ran: the new spec and 25 related Playwright specs (215), vitest over the
changed components (841), `npm run typecheck`, `oxlint src e2e`.
`just e2e-related` selects both lanes whole (`src/index.css`), so CI's run is
the check for the rest.
