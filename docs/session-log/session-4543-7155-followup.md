# Session 4543 — #7155 round 2 follow-up: the review notes on #7156–#7162 and four flakes

One follow-up for the non-blocking notes left on round 2's approved PRs (#7156–#7162) and the flakes seen alongside them, per How we work: notes never push to an approved branch; they batch into one PR.

**What shipped**

- **Phone Pages "+" vs sort (#7156).** The sort glyph was lucide's unstyled 24 px against the Button's 16 px, and in dark only the outlined "+" had the `input/30` fill. Both glyphs are now 16 px, 20 px on a coarse pointer like the More button beside them, and the phone sort trigger takes the outline's fill.
- **History badge (#7160).** The op badge's icon dropped its `mr-1`, which doubled the Badge's `gap-1`.
- **Graph depth picker (#7160).** `ml-1 h-7` became `size="sm"`: the stray offset goes, and `h-7` no longer squeezes the segmented control's 36 px coarse frame to 28 px.
- **Comments (#7157).** `InfoPopover` says Radix closes it on a mouse's pointerdown outside but not on touch, where it waits for the click the trigger stops. `SortableBlock` says its phone frame shift applies at every depth.
- **Test reset (#7158).** `_resetHardwareKeyboardLatchForTests` removes `<html data-keyboard>`.
- **Rust (#7159).** `PressureEpisodes` imports `AtomicU64` beside `AtomicBool`.
- **Dead key (#7161).** `pageProperty.toggleLabel` is gone from all five locales.
- **Due panel cost (#7162).**
  - The panel windows its rows again through `useVirtualizedGroupedRows`. A tab's name and, under Group: Page, each page's heading are rows of the window.
  - The React Compiler caches `virtualizer.getVirtualItems()` on the virtualizer's stable identity: the hook lives in a `.ts` file the compiler never sees, so the consumer does not bail out. The window never followed a scroll, so `DuePanel` opts out (`'use no memo'`). Reading the items at the top of the body did not help.
  - On the mock with 500 open tasks (Chromium 1280×720, no throttling, five runs each), mounting went from 869–1243 ms to 102–124 ms, and redrawing All after the Today tab from 606–1031 ms to 14–20 ms. The probe was throwaway. The committed spec pins the deterministic part: fewer than 50 rows mount, and a scroll to the bottom mounts the last and unmounts the first.
  - The open-task read no longer depends on the page's date, so a step between later pages reads them no second time.
- **Group: Page breadcrumb (#7162).** A row under its page's heading hides its "→ Page" (`hidden`; the page id stays for open-in-new-tab).
- **Tests only (#7162).** `DayHeader`'s phone branch is pinned: desktop portals the title row into the header slot with its actions, a phone keeps the title alone with the day. JournalPage.integration's delete helper drives one known path per view instead of branching on the button it finds.

**Not done**

- **view-shell tag (#7156).** The note was wrong: `trash` is a word of the `pages` area, which view-shell already carries, so a Trash-only change selects it.
- **Toast over Quick capture (#7160).** It needs a decision, not a fix. A failed capture keeps the sheet open, and its error toast covers Cancel and Capture. The options are toasts at the top while a bottom sheet is open, toasts lifted above the sheet, or the failure shown inline in the sheet. It waits for the maintainer.

**Flakes**

- **page-kebab "Undo twice then Redo" (bridge).** The backend groups undo by its own clock, so `page.clock.fastForward` moved only the browser and two edits within 500 ms joined one group. It failed 3 of 30 at 4 workers; `outlastUndoGroup()` made it 30 of 30.
- **editor-lifecycle "creates a block via the Add block button" (bridge).** `openGettingStarted` returned on the page title, which shows before the subtree read lands, so the count read 0. It failed 8 of 50 at 4 workers across both add-block tests, and 0 of 50 once the helper waits for the first block.
- **phone-toolbar "the Date menu on a phone".** Not reproduced: 60 runs at 10 workers, 36 under 8× and 20× CPU throttling, one full `@mobile` run beside a cargo build.
- **phone-bottom-sheets "menu rows and list rows fill while pressed".** It failed once in that full `@mobile` run. Not reproduced: 60 runs at 10 workers, 36 under 8× and 20× throttling, one full `@mobile` run (385 tests) beside two CPU hogs.

**Checked and left alone**

- `DonePanel` reads `getVirtualItems()` inside a render prop with the same hook, so it could have had DuePanel's bug. With the compiler on, 45 extra done items on the bridge, and a scroll to the bottom, its first row unmounted and new rows mounted. The probe was not committed.
- #7162 had rewritten `due-panel-keyboard-jumps.spec.ts` for an unwindowed list; it is back to checking that End reaches a row outside the window.

**Tests**

- Every behaviour change has a test shown red once by breaking the code it covers.
- Mock specs touched or affected (11 files) passed 70 of 71; the one red was the keyboard-jumps spec, fixed above. Bridge specs touched or affected (12 files) passed 131 of 131.
- Clippy, fmt and the related nextest run (6701 tests) passed; so did typecheck, lint and the related vitest files. `e2e-related` picks the whole lane for this range, which is CI's run.
