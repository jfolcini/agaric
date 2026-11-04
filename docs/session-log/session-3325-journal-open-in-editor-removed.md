# Session 3325 — The journal's "Open in page editor" link is removed

The maintainer reported that the journal's *Open in page editor* link no longer worked and asked whether it should be fixed or removed.

**What it was for.** Each Week and Stream day heading carried the icon from the first journal commits (2026-03-29/30); 5e8301f08 (2026-03-30, journal polish) added the text link on the Day view. At the time a journal day was a bare block list, and the link opened the day's page in the page editor, which had the page header the journal lacked.

**What broke it.** UX-242 in 12a052e7a (2026-04-20) routed every date-titled page that `navigateToPage` opens to Journal → Daily, on purpose, so every link to a day lands in the journal. From then on the link opened the day it was already on in Day view (it only added the day to the recents strip), and in Week and Stream it did what the clickable date heading already does.

**Decision: remove.** Fixing it would undo UX-242 for one button. The journal day now carries what the page editor offered for it: the *Blocks | Page* switch (on a phone, the *Page actions* menu), bookmark and delete, and the references and task panels. From Week and Stream the date heading opens the day.

**What changed**
- `DaySection`: the Day-view link, the Week/Stream heading icon, and the `onNavigateToPage` guard on the Day row's bookmark and delete.
- The `journal.openInEditor` and `journal.openInEditorLabel` keys (English only; no locale had them).
- Their vitest cases in `DaySection.test.tsx` and `JournalPage.test.tsx`. The specs that used the link to tell that a day had a page (`e2e/sync-refresh.spec.ts`, `e2e-tauri/sync-refresh.e2e.ts`) now read its *Delete page* button; `page-mode-touch.spec.ts` counts three buttons on the day's phone row.

**Red first**
- the new `journal-page-mode.spec.ts` case (a week's day heading opens the day, whose *Page* switch puts it in page mode) with the heading's click made a no-op: the *Daily view* tab stayed unselected.

**Suites:** vitest over `DaySection` and `JournalPage`; typecheck; oxlint and oxfmt on the changed files; Playwright `journal-page-mode`, `page-mode-touch`, `sync-refresh`.
