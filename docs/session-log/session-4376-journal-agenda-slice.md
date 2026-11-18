# Session 4376: area slices 14 and 18, journal, agenda, attachments and mirror, on the real backend

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

## Slice 14, part 2: the agenda ports

**agenda-count-after-write**, now `e2e/agenda-count-after-write.spec.ts`:
- It runs with `test.use({ slowMaterializerMs: 1000 })` (G3, #6930), so the `agenda_cache` rebuild outlasts the view's re-read debounce. It never leaves the week view between the `/due` write and the count.
- The seed already has tasks due today, so it reads today's count first and expects one more.
- It goes red on the bridge when the change feed sends its event without waiting for the rebuilds.
- Its entry in `SPECS_WITH_A_SLOW_MATERIALIZER` is gone.

**due-date-agenda**, now `e2e/due-date-agenda.spec.ts`:
- `/due today` on a TODO lists it under TODO in today's Due panel and adds one to the week view's count.
- A `- [ ]` changed to `- [/]` in Edit as Markdown regroups it under DOING, and the reopened task reads DOING.
- The WebdriverIO original retried by navigating until the panel matched. The panel now refreshes on the backend's `blocks:changed`, and a polling assertion waits for it.
- Two of the spec's own races turned up at load, each 1 in 8 to 12:
  - The task's editor, still focused after `/due`, re-mounted when the page reopened and took the focus from the Page actions menu just opened, which closed it. The test now leaves the editor with Escape. It is a narrow window for a user too.
  - Keys sent to the Markdown buffer right after a click acted before the click's caret was taken in. The line is now selected whole and replaced, as `page-source-edit` does.
- It goes red on the bridge, at the TODO group, when the picker writes another date than the one it shows.

**Ran:** each spec on the bridge at three workers, 15 of 15 (`due-date-agenda`) and 3 of 3 (`agenda-count-after-write`), and on the mock.

**agenda-projected-repeat**, now `e2e/agenda-projected-repeat.spec.ts`:
- Tasks are seeded through IPC, then the backend is settled, so the projection is current before a view mounts. The WebdriverIO original remounted the view until the projection's cache caught up; nothing here waits on a timer.
- The four projection tests (repeat-count and repeat-until bounds, weekly, Agenda mode, the phone row's chip touch area) are `@real-only`, since the mock's `list_projected_agenda` is a stub. The `/repeat` modes and the drawer tests run on both.
- The next occurrence's due date and the row counts are read back through `list_blocks`.
- A checkbox clicked while a completed repeating task's page reload is in flight is drawn back to its old state (#6972, filed). The spec waits for each completion's next occurrence before the next click.

**Shown red, on the bridge:**
- Ignoring `repeat-count` in `project_block_dates` reddens the bounds test (day +4 still projects "count three") and the Agenda test (six dates, not three).
- Ignoring `repeat-until` there reddens both at the until rows.
- A week shifted as eight days reddens the weekly test: day +7 projects nothing.
- `/repeat`'s catch-up commands written as from-completion redden the modes test at both catch-up dates.
- The drawer saving each number one higher reddens the drawer test at `repeat-count` and the row count.
- The projected row's text clipped with `truncate` reddens the chips test: the points above and below each chip hit the row.

**`settle` and the main thread:** a comment beside `emitted()` now says why the event has reached the bridge before `settle` answers (its app never runs, so the main-thread emit ran inline; its socket sends events before replies). The reviewer asked twice.
