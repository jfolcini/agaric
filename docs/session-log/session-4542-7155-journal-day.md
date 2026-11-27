# Session 4542 — #7155 R6, R7: the Day header works like a page's, and the day's tasks sit under time tabs

Round 2 of the UI review (#7155): decision D3, and decision D4 with the revised 4b and the re-asked 4c.

**What shipped**

- **R6 (desktop).** The Day view's date row works like a page's title row.
  - `DayHeader` renders it into the `ViewHeader` outlet: date, Blocks/Page, bookmark and a ⋮ with Properties… and Delete page. The toolbar sits beneath.
  - Week and Stream keep one toolbar on top for all their days.
  - The phone keeps its bookmark and ⋮ row; its sheet gained Properties…. Until then the journal had no way to a day page's own properties.
- **R7 (both).** The day's task panel was rewritten (`DuePanel`, `useDuePanelData`, new `task-buckets.ts`).
  - Today's and every later page get tabs All · Overdue · Today · This week · Later · No date, counted from that page's date. The week ends by the week-start setting. Counts sit on the tabs only, and the header reads "Tasks".
  - A task goes by its earlier date (due or scheduled). A tab is a flat list by date, then priority.
  - A "Group: None / Page" setting (`agaric:duePanel:groupBy`) heads each page's tasks, ordering pages by their earliest task date, then that task's priority.
  - A past page lists only its own open tasks, leaving out DONE and CANCELLED. Age labels ("3d overdue") count from the real today.
  - The old "Properties" tab was a custom-date-property source filter, not the day's properties. It went with the "Hide future scheduled" toggle, the state groups, the Overdue / Upcoming / Scheduled-earlier sections and their components.
  - Settings › Tasks & reminders › Deadline warning fed only those sections, so it is deleted too: the component, preference, i18n keys, spec and its `REAL_BACKEND_SPECS` entry.
  - Today reads every open task through `query_by_property`, paged. No new IPC.
- **One properties surface.** After #7161 merged, Properties… opens the shared `PagePropertyTable` dialog (a sheet on a phone). It mounts once first opened, because it reads the page's properties as it mounts and Week and Stream mount a day page per day. Focus returns to the day's ⋮.

**Tests**

- New:
  - `task-buckets.test.ts`;
  - DuePanel tabs, grouping, a later page's counts and the week-start end;
  - DayPageEditor's title row, its ⋮ and Properties… on desktop and phone;
  - e2e `due-panel.spec.ts` and `journal-header-sections.spec.ts` "title row holds";
  - a tabs test in the bridge spec `journal-panels.spec.ts`.
- Many old tests pinned the removed filters, sections, toggle and setting, and went with them. The contracts that remain keep their tests.
- The reviewer found that cancelled tasks still showed on a day's own list, and that the bridge spec `agenda-advanced.spec.ts` still drove the deleted filter pills; it fixed both. It also added the week-start test, after a `weekStartsOn` mutant survived.
- Every new test was shown red by builder or reviewer. The reviewer ran 367 `@journal` and settings mock tests, and 28 bridge tests on a built bridge.
- **Scale:** the panel no longer virtualizes. On the mock, 500 open tasks take about a second to mount, and every property change re-reads them all. Left to the follow-up.
- **After review:**
  - CI and a local run of every mobile and journal mock spec found three old specs pinning the previous Day header: the Blocks/Page switch ending the row, a phone menu without Properties…, and one unscoped tabpanel now that the task panel has tabs. They were updated.
  - The review bot noticed that with Group: Page the keyboard list stayed in date order while the rows were drawn grouped. A test showed ArrowDown then Enter opening another page's task; the list is now built in drawn order.
- **Bridge fixes.** CI's real-backend lane found that the panel dropped every projected repeat occurrence on today's and later pages: `uniqueProjected` skipped any projection whose block was among the open tasks, and the repeating task itself always is. It now skips only the day's own rows, as `main` did. A DuePanel test was shown red with the old filter. The bridge specs `agenda-projected-repeat`, `date-chip-editing`, `due-date-agenda`, `journal-delete-page` and `sync-refresh` drove the removed sections or the moved Delete; they were rewritten for the tabs and the ⋮, each shown red once. The full bridge lane then passed apart from one `editor-lifecycle` run that did not reproduce.
