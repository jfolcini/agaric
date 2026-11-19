# Session 4411 — the search-replace Ctrl+Z spec waits the undo window out in real time

Main's bridge lane went red at `107c74b` (run 44482738755, `bridge-specs (3)`): `e2e/search-replace.spec.ts` › "Ctrl+Z on a page opened after a run undoes that page's part only" read the page back as `[""]` instead of `['one pinnacle', 'two pinnacle']`.

**Cause.** Ctrl+Z on a page the undo store never tracked is positional: `undo_page_group` groups ops less than `UNDO_GROUP_WINDOW_MS` apart by the backend's op stamps. The test stepped past the window with `page.clock.fastForward`, which moves the browser's clock only. That worked on the mock, whose stamps come from the browser. On the bridge, when the seed and the replace landed within the window in real time, the seed's `create_blocks_batch` joined the replace's group, and one Ctrl+Z took the seeded blocks back with the run.

**Fix.** The test waits the window out with `outlastUndoGroup()` (`e2e/helpers.ts`), the helper made for writes the backend groups. The `page.clock` install it no longer needs goes.

**Not shown red locally.** The failure needs the seed and the replace within 500 ms of real time, which a local run does not reliably produce. The main run above is the red. CI's bridge lane runs the spec on this change.

**Ran:** `npm run typecheck:e2e`, oxlint and oxfmt on the spec.
