# Session 2863 — a journal block added after a space switch lands in the new space

Found while debugging #6066's real-backend red (`e2e-tauri/property-defs-per-space.e2e.ts:89`). Main has the bug; that spec only exposed it.

**Bug:**
1. In Work, "Add your first block" creates Work's journal page for today.
2. Switch to Personal and click "Add block". The new block goes under Work's page.
3. Personal's journal, re-read after leaving it and coming back, shows only its own page for today. The typed block looks lost, but it sits in Work.

**Cause.** `useJournalBlockCreation` keeps `createdPages`, the day pages it just created. The map is keyed by date only. `JournalPage` stays mounted across a space switch, and both `makeDayEntry` and `handleAddBlock` read `createdPages` before the space's own `pageMap`. So the old space's page for that date won. The CI app log showed it: `load_page_subtree` refused that page as "not in current space" while the block was written under it anyway.

**Fix.**
- `createdPages` records the space its pages were created in. Under another active space it reads as empty.
- A page created after a switch starts a fresh map.
- The journal stays mounted; `useCalendarPageDates` ties its fetched key to the space the same way. Remounting it per space (`key={currentSpaceId}`) was tried and broke `spaces-management.spec.ts` › "switching to a space whose journal is on today reuses its existing page" (#5460).

**Not fixed here:**
- The backend's `create_block` accepted a parent page in Work while Personal was the active scope, so nothing on that side refused the misplaced block.
- `useJournalAutoCreate`'s `autoCreatedRef` is not tied to a space either. That only means Work's day is not auto-created after Personal's, which is harmless.

**Shown red:** with `createdPages` ignoring the space:
- the unit test failed with `expected 'PAGE_IN_SPACE_TEST' to be undefined`;
- the mock-lane spec in `spaces-happy-paths.spec.ts` failed: after the round-trip, `personal line` is not visible.

With a new page carrying the old space's map, the unit test's exact-entries assertion failed.

**Suites run:**
- vitest over `src/hooks`, `src/components/journal` and `src/__tests__`;
- typecheck;
- Playwright over the spaces, journal, property, tags and deep-link specs.

The real-backend proof is #6066's spec once this lands.
