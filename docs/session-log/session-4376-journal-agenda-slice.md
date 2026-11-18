# Session 4376: area slice 14, part 1, journal and agenda on the real backend

#6926 slice 14 (#6529), split in two. This part promotes the journal and agenda specs and ports the small WebdriverIO specs. Part 2 ports `agenda-count-after-write`, `agenda-projected-repeat` (671 lines, six tests) and `due-date-agenda`.

**Promoted to `REAL_BACKEND_SPECS`:** `agenda-advanced`, `agenda-filter-builder`, `journal-monthly`, `journal-page-mode`, `journal-panels`, `journal-undo`, `capture-deep-link`, `journal-week-empty-day-add-block`, `journal-add-block-reuses-empty`, and the new `journal-delete-page`.

**agenda-filter-builder:**
- Its date-preset test pinned the browser clock with `page.clock` to a Wednesday, so that "This week" held yesterday, today and tomorrow. On the bridge the seed's due dates follow the backend's real clock, and the list came back empty.
- It now uses "Next 7 days": the seed's tasks due today and tomorrow, without yesterday's or the one due a week out, on any day.
- The combined result with `context = @office` (Ship v2.0 release, Fix login bug) is unchanged.

**journal-add-block-reuses-empty** gains the navigation re-read the WebdriverIO `journal-add-block-reuses-seed` made: type into the seed, leave the journal and come back, then expect one block, the seed, holding the text.

**Ported from WebdriverIO and deleted there:**
- `journal-add-block-reuses-seed` is folded into the test above.
- `journal-delete-page` is now `e2e/journal-delete-page.spec.ts`. Today is the seed's daily page.

**Deleted from WebdriverIO:** `journal-week-empty-day-add-block` (its Playwright twin is promoted) and `journal-note-crossview`. `block-persist-reload`'s comment no longer names the latter.

**Shown red, on the bridge:**
- `journal-delete-page` fails with the delete confirm doing nothing. The day empties only once the backend's delete lands, so that assertion pins a real delete.
- `journal-add-block-reuses-empty` fails when `unfocusedBlankTail` never reuses a block.
- The agenda filter test fails when "Next 7 days" maps to fourteen: "Design new dashboard" appears.

**Ran:** the ten specs on the bridge at three workers, twice (53 of 53 each), and on the mock with its hooks withheld (53 of 53).
