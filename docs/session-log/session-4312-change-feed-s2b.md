# Session 4312 — change feed, slice S2b: local writes leave the cache refresh to the feed

Slice S2b of #6545, on top of S1 (#6897) and S2a (#6919). The backend's change feed now refreshes every derived cache after a local command, so the hand calls writers made to the cache helpers are gone. There is one commit per domain, each with an `e2e-tauri/` spec shown red locally.

## What shipped

- **Structure:** the `recordGraphStructureChange` hand calls are gone from 12 writers and from `notifyPageAdded`/`notifyPagesRemoved`.
  - Restores and `notifyUndoNewAction` keep an immediate bump, because that bump also expires hover-prefetched subtrees (`src/lib/prefetch-page-subtree.ts`), and the feed arrives too late for that.
  - Spec `link-it-linked-refs`: "Link it" lists the block in the open page's Linked References.
- **Properties and property_defs:** the `invalidatePropertyCaches` hand calls are gone from page source and the five definition editors, including their Undo, and from the row editor's options save.
  - Spec `property-options-feed`: an option added from the page header clears a block's doesn't-fit mark.
  - The block drawer has no select options editor, and the page header's select loads its definitions once and never re-reads them, so the spec runs the other way round from the design note.
- **Names:** the `invalidateNameCaches` / `invalidateCalendarPageDates` hand calls are gone from Trash restores, tag rename and delete, page delete and its Undo, and date-page creates.
  - `notifyPagesRemoved` no longer falls back to a full reset.
  - Spec `restore-bookmark-feed`: a page bookmarked and trashed by IPC, then restored with the Trash button, reappears in the sidebar's Bookmarks. Trashing in the UI does not isolate the arm, because the resolve store brings the entry back.
- **Attachments:** the hand calls are gone from paste/drop, `/attach` and the voice note, and `MeetingDialog`'s full reset after a meeting and its Undo is gone too.
  - Spec `attachment-paste-feed`: a pasted PDF shows in the block's attachment row.
- **Docs:** `src/stores/AGENTS.md` § "Writes outside the page store" now says a local command needs no helper call, and what `reloadChangedPageStores` runs.
- **Kept:**
  - The full resets for import, Settings › Rebuild (no op), undo and `reloadChangedPageStores`.
  - Every targeted bus event and resolve-store update.
  - `invalidateDerivedCaches()`, which S2a's reviewer suggested replacing with `invalidateDomains(null)`. Five test files spy on it, and the name says what it is for.

## Decisions and traps

- **The real-backend lane runs in a cloud container:**
  - `apt-get install webkit2gtk-driver openbox xdotool` and `cargo binstall tauri-driver@2.1.0`.
  - Build the app with `npm run tauri -- build --debug --no-bundle --config '{"build":{"beforeBuildCommand":"npm run build"}}' -- -p agaric -p agaric-diagnostics`, then run specs with `WDIO_SKIP_TAURI_BUILD=1 bash scripts/e2e-tauri-local.sh <spec>`. The app build fails when wdio runs it in-process (`define_import_meta_default.resolve is not a function`).
  - `cargo nextest` relinks the binary without `dist/`, so don't run it in between.
- **Session 4288 said** the S2a spec did not run here. That changed before S2a merged, and its log was corrected in the same PR.
- **Unit tests now call `invalidateDomains([...])` by hand** in place of the feed: PageHeader, JournalPage.integration, PageModeEditor and UnlinkedReferences. The tauri-mock's `dispatch()` sends no event in vitest.
- **The hand calls fired before the background rebuild and the feed fires after it.** The journal's Delete page and a Trash restore now show in the pickers after the lifecycle debounce and the rebuild, which is the latency the design accepted.

## What ran

- **Each domain's spec:** green, then red at its own assertion with that domain's arm dropped from `DOMAIN_INVALIDATIONS` (rebuild, run, restore, rebuild). The reviewer re-ran all four reds.
- **The full vitest suite:** 27,416 passed.
- **Static checks:** `npm run typecheck`, `typecheck:e2e-tauri`, oxlint and oxfmt.
- **Mock lane:** 49 Playwright spec files (pages, trash, bookmarks, references, tags, attachments, properties, history, journal, graph). `voice-note-record.spec.ts` cannot run here: its browser binary is missing.
- **Real-backend lane:** 21 existing e2e-tauri specs in these areas, among them agenda-count-after-write, journal-delete-page, sync-refresh, trash-page-cascade, batch-add-tag, meeting-attachments and property-option-rename.
