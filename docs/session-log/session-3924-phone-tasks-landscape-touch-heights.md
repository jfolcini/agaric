# Session 3924 — phone: Tasks in the drawer, landscape drawer, journal touch heights

Finishes #6532's three open checkboxes (the toolbar two merged in #6582).

- **Tasks in the sidebar.** `AppSidebar` renders a Tasks row after Journal
  (`journal.tasks`, `CheckSquare`) that sets the journal store's mode to
  `agenda` and selects the journal view. Tasks is the current row on the
  journal in agenda mode; Journal is current on every other journal mode, and
  choosing Journal from the agenda drops back to `daily` (a dated mode it
  already shows is kept), else a Journal row next to Tasks would open Tasks.
  The row shows at every width, not only on a phone: there is one sidebar.
  `SIDEBAR_NAV_ITEMS` is unchanged, since Tasks is a journal mode, not a view.
- **Landscape phone.** `useSidebarState`'s `isMobile` (Sheet versus pinned)
  is now `useIsMobile() || (useIsTouch() && viewport under 500 px tall)`.
  `useIsMobile` itself is unchanged. `MobileSidebarTrigger` in `App.tsx` reads
  the sidebar's own `isMobile` instead of `useIsMobile`, so the hamburger shows
  exactly when the drawer is the sidebar. The height is the layout viewport's,
  which the soft keyboard does not shrink on Android edge-to-edge
  (`useSoftKeyboardInset`'s doc), so opening the keyboard on a tablet does not
  flip it to the drawer.
- **Touch heights.** `touch-hit-area` on the week and stream day headings, the
  due/scheduled count chips and the refs chip beside them (`DaySection`), and
  the due-date chip (`DueDateChip` in `BlockListItem`, so every list that
  shows it). Today's heading row wraps at 360 px (the Scheduled chip and the
  page actions drop to a second line 8 px below), where two 44 px hit areas
  overlapped; the row's `gap-y` is 24 px on a coarse pointer, so a wrapped row
  is 16 px taller and an unwrapped one is unchanged.
- **Not done: tag chips.** `.tag-ref-chip` is inline in wrapping text
  everywhere content renders; a 44 px hit area overhangs the lines above and
  below, so a tap on the neighbouring text of a block would open the tag.
  Left for a decision (for example only in single-line list rows).

Checks run: the new e2e tests in `mobile-drawer.spec.ts` (Tasks at 360 px;
863x360 touch gets the drawer; 1024x768 touch tablet keeps the pinned
sidebar) and `phone-touch-targets.spec.ts` (headings and chips at 360 px)
were red before the fix; each chip's class, the gap and the 500 px bound were
falsified one at a time. `AppSidebar.test.tsx` gained the Tasks tests, falsified
three ways. Playwright: those two specs plus `nav-active-item`, `smoke`,
`date-chip-editing`, `phone-header-bar`. Vitest: `src/components/layout`, the
sidebar, `DaySection`, `WeeklyView`, `BlockListItem` and `App` tests;
`npm run typecheck`. `just e2e-related` selects the whole lane (the sidebar
hook has no area), so CI's run is the check.
