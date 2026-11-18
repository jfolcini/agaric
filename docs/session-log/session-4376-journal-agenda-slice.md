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
- A checkbox clicked while a completed repeating task's page reload is in flight was drawn back to its old state (#6972, filed, fixed by #6979). The spec clicks through each task with no wait between tasks.

**Shown red, on the bridge:**
- Ignoring `repeat-count` in `project_block_dates` reddens the bounds test (day +4 still projects "count three") and the Agenda test (six dates, not three).
- Ignoring `repeat-until` there reddens both at the until rows.
- A week shifted as eight days reddens the weekly test: day +7 projects nothing.
- `/repeat`'s catch-up commands written as from-completion redden the modes test at both catch-up dates.
- The drawer saving each number one higher reddens the drawer test at `repeat-count` and the row count.
- The projected row's text clipped with `truncate` reddens the chips test: the points above and below each chip hit the row.

**`settle` and the main thread:** a comment beside `emitted()` now says why the event has reached the bridge before `settle` answers (its app never runs, so the main-thread emit ran inline; its socket sends events before replies). The reviewer asked twice.

## Slice 18: attachments, agent access, mirror and the rest

**Promoted** to `REAL_BACKEND_SPECS`: `attachments`, `meeting-attachments`, `attachment-link-6032`, `inline-image-1434`, `pdf-annotation-1452`, `pdf-highlight-blocks-6629` (its "moved to another space" test no longer reloads and reseeds), `agent-access`, `mcp-agents`, `mirror-settings`, `smoke`, `deep-link` and `sync-refresh`. `spaces-management` was already listed.

What each needed, none of it a backend divergence:
- `agent-access` and `mcp-agents` read the socket and bridge paths `get_mcp_status` reports, not the mock's `/mock/...`. The injected toggle failure is `@mock-only`.
- `mirror-settings`: the folder comes from `pick_mirror_folder`'s OS dialog, which nothing headless answers, so the four tests that choose one are `@mock-only`. The other two run on the bridge.
- `meeting-attachments` called `list_blocks` with flat arguments. The mock took them; the real command wants its `request` object.
- `inline-image-1434` attaches before the page opens. Attached mid-view, the refreshed block's attachment row lay under the corner the click aims at.

**Ported from WebdriverIO**, each test shown red once on the bridge:
- `attachment-only-block-survives-blur`: red when the cleanup ignores attachments (the blank block goes) and, for the control, when it never deletes.
- `attachment-paste-roundtrip`: red when the paste cuts three bytes (length) and when it stores no image (no toast). `read_attachment` reaches the page as numbers through the bridge, read as `readAttachment` reads it.
- `space-move-property-loss`: the header move that drops a differently defined property and the one undo that brings it back join the existing Playwright twin. Red when the undo group's window is 0.
- `app-health` tests 1 and 3 become `e2e/app-health.spec.ts`, both `@real-only`. Red when the Background dispatched card is frozen and when the integrity result's count is fixed. The bug-report ZIP test stays in WebdriverIO.
- `enter-during-pull`: the pull is the peer's edit written as a command plus the `sync:complete` a pull ends in, and the page's read is answered late through a wrapped `invoke`. Red without #6814's re-read in `load()`: the typed line is lost.
- `spaces` tests 2 and 3 become `e2e/spaces-move-and-title.spec.ts`. The mock's window plugin now keeps the title `set_title` sets and answers `plugin:window|title`, so the title is read back from the window on both lanes. Red when search always scopes to Work and when the title names the first space.
- The mirror specs `mirror-inbound`, `mirror-new-file`, `mirror-read-back`, `mirror-spaces` and `mirror-structure`, all `@real-only`. Each test seeds its own vault and folder; WebdriverIO's tests shared one. `mirror-spaces` turns off the seeded Work space. The shared steps are `startMirror`, `mirrorFile`, `mirrorText` and `mirrorPassAfter` in `e2e/helpers.ts`.

**The mirror ports, shown red on the bridge** with a mutant in `src-tauri/src/mirror/mod.rs` each:
- `ingest()` ignoring `read_back`: all three read-back tests (the page takes the edit made while off, and the checkout's).
- `ingest()` answering nothing: inbound, the new file, and the renamed, moved and deleted files.
- Unmirrored spaces kept in the layout: `mirror-spaces` (the Work file stays).
- No hold for a file outside every space folder: the strayed file is never listed.
- Never paused: the unmounted folder never pauses.

**Back-to-back checkbox clicks:** two, three and four clicks with nothing between them on a task that does not repeat end where they should, on screen and in the backend (bridge, 36 of 36). The lost clicks seen earlier were all #6972.
