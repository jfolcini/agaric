# Session 2879 — the journal's Daily view opens its day in page mode

#5691's checklist item "The journal's daily, week and stream views": the Daily view now opens its day in page mode, the way a page view does. Weekly, stream and month stay in block mode.

**How the day mounts.** `JournalPage` → `DailyView` (keyed by date) → `DaySection mode="daily"` → `PageBlockStoreProvider` + `BlockTree`. Date-titled pages always route to the Daily view (`tabs.ts`), never to `PageEditor`, so before this a day's page could never open in page mode.

**What changed.**
- **`DayPageEditor.tsx` (new):** used in the daily mode only. It calls `usePageMode` and renders `PageModeSlot`, or `BlockTree` plus Add block. It puts `EditModeSwitch` at the end of the day's row and owns the link landing that `DailyView` had, skipped while page mode is wanted, as `PageEditor` does.
- **Ctrl+E:** the shortcut and palette listener moved from `PageHeader` into `EditModeSwitch`, so any surface that shows the switch takes Ctrl+E. Only one switch is ever mounted: `ViewDispatcher` renders the current view, the page view renders the active tab's page, and `DailyView` mounts one `DaySection`.
- **`page-mode-switch.ts`:** its scroll rows include `.journal-day-page`. Without this, switching modes lost the journal's scroll place.
- **A new day made from the journal template** opens with the cursor on the template's first block. Found in review. `useJournalBlockCreation` focuses that block for block mode, but page mode focused only an empty page, so a template day opened with no cursor. `PageModeEditor` now takes `focusedBlockId` when that block is on its page, and clears it as `takeCursor` does; a link target still wins.

**Shown red,** each with a one-command mutation that restored the file:
- daily never routed to `DayPageEditor`;
- weekly and stream routed to page mode;
- the cap or touch ignored;
- Add block shown in page mode;
- the Ctrl+E binding dead;
- block-mode landing run in page mode, or no landing in block mode;
- the journal day removed from the switch's scroll rows (Playwright);
- page mode's write never landing (Playwright persistence);
- the template-focus branch disabled (vitest and Playwright).

**Suites (review run):**
- vitest over journal, pages, page-mode, hooks, stores and `src/__tests__`: 281 files, 5391 tests;
- `npm run typecheck`, `npm run lint` and the import-cycle check;
- Playwright: 45 journal, template and cross-day specs, plus 114 page-mode and tab specs.

`just e2e-related` says "the whole lane", because `src/stores/navigation.ts` changed, so CI is that check.

**Week and stream,** assessed for the maintainer and not built: about 3–5 days for the week view over 2 PRs, and 1–2 more for stream. Neither needs a new store, op type or IPC.
- One always-mounted editor per day: up to 7 in the week view, up to `STREAM_MOUNT_WINDOW` in the stream. AGENTS.md invariant 4's sentence on those views would need an approved rewording.
- A decision on Ctrl+E: one switch for the whole view, or a shortcut that acts only on the focused day.
- An opt-out for page mode's empty-page focus, so empty days don't steal focus as they mount.
- The week's reschedule-by-drag handing off from page mode's pointer drag to `RescheduleDropZone`.
- Text dragged between two days' documents becoming a cut and paste, which loses block ids and `((refs))`.
- The stream's remount cost, measured at its window.
