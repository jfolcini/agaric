# Session 2434 — New date pages reach the journal's Day mode

#5735's journal specs found it. A date page created outside the
journal's own Daily and Weekly views stayed invisible to Day mode: the day
showed "No blocks for" until the journal changed month or remounted.

**Fixed:**
- **Stream mode.** StreamView fed new pages to its own date map only.
  - It now reports them through JournalPage's `addPage`, as Daily and
    Weekly do, and `useStreamDates.addPage` is gone.
  - Spec: `journal-stream-page-dates.spec.ts`. A page created in Stream
    shows in Day mode and gets its date-picker dot.
- **The block `/date` picker.** Its create branch registered the page with
  the page store but never told the page-dates cache.
  - It now calls `invalidateCalendarPageDates()` after the create.
  - Spec: `journal-date-page-from-picker.spec.ts`.

**Checked, no change:** Quick Capture already invalidates the cache through
`reloadChangedPageStores`. A throwaway probe confirmed the captured day
shows in Day mode.

**Shown red:** each spec against the tree without its fix, failing on the
day's block tree not being found. The new `use-block-date-picker` unit case
was red with the call removed.

**Ran:**
- vitest on `JournalPage`, `StreamView`, `useStreamDates` and
  `use-block-date-picker`;
- both specs after rebasing on main, and each with `--repeat-each=3`;
- the existing date-picker specs;
- `npm run typecheck`.
