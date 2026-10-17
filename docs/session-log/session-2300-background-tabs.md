# Session 2300 — Middle-click opens a page in a background tab; right-click offers it

#5684: the maintainer asked for middle click on desktop to open a page in a
background tab, and for right-click to offer the same.

**Tab model.** `src/stores/tabs.ts` had `openInNewTab`, which switches to the
new tab, and no background variant. `openInBackgroundTab` adds the tab and
leaves the active tab and the view alone. The tab bar shows on desktop only,
once two tabs exist.

**Shared pieces, not per-call-site handlers:**
- `useOpenInBackgroundTab`, with `middleClickProps` and
  `delegatedMiddleClickProps`, which cancel Linux autoscroll on mousedown and
  the primary-selection paste on mouseup;
- `NewTabTarget`, which wraps an element with the middle click and a Radix
  context menu;
- a new `ui/context-menu.tsx` primitive. Pages rows and search results had no
  context menu before; only the block menu did.

**Covered:**
- `[[links]]` and `((refs))` in static blocks, through one delegated handler
  on the block tree. Right-click on a link puts "Open in new tab" first in the
  block menu.
- Everything that uses `PageLink`: reference and search group headers, the
  tag view, agenda page names.
- Pages rows and tree entries, bookmarks, the recents strip, search results
  and recent searches, reference rows, agenda and task rows, and graph nodes.

**Skipped:**
- breadcrumbs, which open the Pages view or stay on the page;
- a context menu on graph nodes, which d3 draws;
- middle click inside the block being edited, which was not tested.

**Ctrl/Cmd+click.** The graph and the recents strip already used it for "new
tab" and switched to it. It now opens a background tab, like middle click and
like a browser.

**Mobile.** There are no tabs, so the menu item is hidden and middle click
does nothing.

**Tests.** 23 vitest mutations and two Playwright mutations (each rebuilt)
were all killed at the predicted assertion. A `stopPropagation` that no
mutation could make matter was deleted.

**Flake noticed.** graph-view's "label same height at three zoom levels"
failed 4 of 12 runs on main's own code. It goes on the flake list, to be
checked against tonight's reduced-motion change (#5666).

Gates: full vitest (21,384), `npm run typecheck`, oxlint, oxfmt, the new spec
with the tabs, menus, navigation and links specs (171/171 at `--repeat-each=3
--retries=0`), and one pass of the pages, search, agenda, references,
bookmarks and graph specs.
