# Session 1937 — reorder bookmarks by drag (#5359)

The user wanted to sort the sidebar bookmarks and have the order survive
restarts.

Bookmarks were already an ordered JSON array under `starred-pages`, and the
sidebar already rendered that order with new bookmarks appended, so this
needed no new key and no migration.

What shipped:

- `moveStarred(id, overId)` (`src/lib/starred-pages.ts`) moves an id within
  the full stored array and writes once. The sidebar shows only the current
  space's live bookmarks; writing that shorter list back would drop other
  spaces' and trashed bookmarks. `useStarredPages` exposes it as `move`.
- `BookmarksSection` rows are dnd-kit sortables with the block tree's sensor
  settings: an 8px pointer drag, a 400 ms touch hold (a swipe still scrolls
  the drawer), and keyboard Space to pick up, arrows to move, Space, Enter or
  Tab to drop. Enter still opens the page. Announcements name the page title.
  A drag never opens the page.
- No `data-find-skip` container: dnd-kit's hidden text renders inside the
  sidebar, outside the in-page-find area.

Verified: unit tests for down, up, across hidden ids and missing ids, the
hook's `move`, and a keyboard reorder that persists across a remount; a
Playwright mouse drag and touch hold-drag that survive a reload. Builder and
reviewer broke each piece on copies (writing only the visible list, swapping
instead of moving, wrong start keys) and saw the tests go red. Vitest 57
passed, Playwright `bookmarked-pages.spec.ts` 10 passed, `npm run typecheck`
exit 0, oxfmt clean.
