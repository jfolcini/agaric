# Session 3946 — Review notes from #6604–#6627

One follow-up for the non-blocking reviewer notes on the PRs merged in this sweep (17 items, no
GitHub issue). Each note was checked against the code first; several did not hold.

## Built

- **#6604** One key for "Open releases page": the sync toast uses `help.updateOpenReleasesButton`,
  `sync.openReleasesAction` is gone, and HelpTab's mobile button lost the `aria-label` that
  repeated its text.
- **#6606** `useIsShortViewport` reads one media query (`SHORT_VIEWPORT_QUERY`) for both the
  initial value and the listener.
- **#6609** WelcomeModal: the desktop slash row now says "Type / for…", which is true on both, so
  `welcome.workflowSlashTouch` is gone and only the formatting row carries touch keys (optional).
- **#6615** The `LEFT_OUT` map in `page-toolbar-commands.test.ts` was empty, so its test looped
  over nothing; both are gone and the per-command test asserts page mode answers each command.
- **#6616** StatusPanel's metrics and BootGate's starting screen were `<output>` around a `<dl>`
  and a `<p>`; they are `div role="status"`, as AgendaResults does it.
- **#6617** A Backspace merge that fails after the user moved to another block no longer pulls
  focus back (`backToSource` checks the live focus, as Enter's `restoreSource` does).
- **#6619** Table sort reads a cell's shown text (`findTextPieces`, as in-page find), so a column of
  tag or page chips sorts by their titles instead of as empty.
- **#6622** `cb.onFocusPrev(x ?? undefined)` and one `caretX` check in `focusNeighbour`.
- **#6626** A template insert that throws now logs, toasts and reloads the page, so blocks that
  landed before the failure show.
- **#6627** `detectColumns` is imported from `use-query-table-columns`; `TaskCheckbox` from
  `TaskMarkerButton` (only `PageSourcePreview` and a test used the re-export, not `SortableBlock`
  or page mode as the note said); the column picker says "Move X up/down", matching its arrows and
  its vertical list.
- **Docs** `COMPARISON.md` §7 and its copies: a query block takes the builder's `v2:` payload or the
  flat legacy text form, and not the search syntax (#6628); the "dropped in #4804" attribution was
  wrong (#4804 is the group picker). The block-embed row says the subtree renders live; the stale
  "`/embed` read-only" documentation finding is removed. `COMPARISON-OBSIDIAN.md` window management
  says tabs exist and split panes do not. Rows inside the tables `COMPARISON.md` marks "left as
  written" (the 2026-10-21 Obsidian summary, the "as on 2026-10-21" advanced-query row) were left.

## Not built

- **#6605** The script's "~34.0h" matches its measured lag window; only the merged PR body said 33 h.
- **#6610** `settings.languageHelp`'s two sentences say different things, and both are true
  (#6610's last commit reverted the "System stays English" change the note was written against).
- **#6615 `CANCEL_BUTTON`** is used: it gives the buffer's Cancel its icon, label and tip. Moving it
  into `SOURCE_TOOLBAR_ACTIONS` breaks `source-toolbar-parity.test.ts`, and building its action
  inline in the `useMemo` trips oxlint's `react(refs)`.
- **#6618** The replace cursor cannot linger after a failed save: `edit` writes the text
  optimistically before it awaits, so find runs (and consumes the cursor) either way. Setting the
  cursor after the save would let that run go by without it.
- **#6622 Enter in keyboard drag** drops and opens the editor, but so do Space and a mouse drop: a
  successful move refocuses the dragged block by design (`restoreFocusOnSuccess` in
  `use-block-dnd.ts`). Probed in Playwright.
- **#6627 `ColumnPickerSlot`** stays: inlined, `QueryResult` reaches complexity 27 (limit 25).

## Checks

Red first, then green, and each falsified by removing the fix: the merge-after-moving-on test, the
chip-column sort test and the failed-template reload test. `use-block-keyboard-lines.test.ts`'s
ArrowLeft test now expects `onFocusPrev(undefined)` (was no arguments). Ran the touched vitest
files, `npm run typecheck`, `npm run lint`, `prek run --all-files`, the manual-stage hooks, and
seven Playwright specs (query-table-columns, table-handles, mobile-drawer, onboarding-first-run,
enter-merge-latency, templates, settings-help). The whole Playwright lane was not run.
