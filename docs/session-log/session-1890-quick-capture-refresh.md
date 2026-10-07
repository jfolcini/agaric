# Session 1890 — quick capture shows in the open journal (#5291)

This is the next batch of the session that logged 1873, 1882, 1884 and
1887. #5311 (#5288) merged once `validate-all` and `dco` passed and the
reviewer had approved; its review had no notes.

## #5291

- **The bug.** Quick capture toasted "Captured" and closed, but the open
  journal, Bob's references panel and the Graph did not show the block
  until the user navigated away and back. Capturing again made a duplicate.
  `QuickCaptureDialog` discarded the returned row and refreshed nothing.
  `quick_capture_block` emits no event.
- **The fix.** On success, the dialog calls the `blocks:changed` handler
  body, `reloadChangedPageStores`, which is now exported, with the returned
  row's `page_id`. One call covers everything the issue lists:
  - it reloads the page's live stores;
  - it bumps the graph, calendar and block-property counters;
  - it refreshes the Pages list and picker caches;
  - it re-resolves the title.
- **Why not the issue's four separate calls.**
  - They miss `recordBlockPropertyChange()`, which is what refreshes
    `LinkedReferences`.
  - They skip the undo re-anchor. The capture is a page op the undo store
    never records, so on `main` it shifted the page's positional undo by
    one: a later Ctrl+Z on that page could land on an already-reversed op.
    With the re-anchor, the first Ctrl+Z removes the capture, the newest
    action on the page. The user's earlier typing on the page is then undone
    in 500 ms groups instead of one edit group, which is the state the page
    is in after navigating away and back.
- **Weekly view.** `load()` alone would not reach an empty weekly day: its
  store mounts only once the calendar map knows the page.
  `invalidateCalendarPageDates()`, inside the shared path, triggers that
  refetch.
- **Mock date.** The mock's `quick_capture_block` picked "today" with the
  UTC date, while the seed's daily page and the backend's `chrono::Local`
  use the local date. West of UTC, or in the early hours east of it, the
  capture landed under the space instead of today's page, and the new tests
  failed. It now uses the seed's `todayDate()`.
- **Not done here.** The MCP read-only tool `journal_for_date` can create a
  journal page without emitting `blocks:changed`. Read-only tools have no
  view emitter, so fixing it needs Rust plumbing. It is filed separately.

## Verified

- **Falsification.** Each break was made on a backed-up copy, then
  restored and checked with `cmp`. Each made a test red:
  - removing the reload (the store-contents test);
  - dropping the graph or the calendar bump (their counter assertions);
  - moving the reload into `finally` (the failure-path test);
  - the old UTC lookup, run with `TZ=Etc/GMT+12` (the success test).
- **Full vitest (reviewer, four shards):** 866 files, 20,410 tests passed
  (51 skipped, 1 expected fail).
- **After the mock fix:** the dialog and `tauri-mock` tests pass, 54 files
  and 1,116 tests, both under `TZ=Etc/GMT+12` and the default zone.
  `npm run typecheck` exits 0.
- **Playwright against the mock backend:**
  - `mobile-editor` (10 passed) carries the new test: capture, then the
    block shows on the open journal without navigating. It is red with the
    reload removed.
  - `mobile-overflow` passes (38).
