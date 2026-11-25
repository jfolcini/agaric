# Session 4456 — one empty-state weight, an unopened space lands on today's journal, and a list error is reported once

Part of the #7040 UI review, items S10 and S11.

**What shipped**

- **`EmptyState`'s icon is a 24 px glyph in a 48 px circle** (20 in 40 when compact), set once in the component.
  - Icons were added where views had left them out: Agenda, Advanced query, Sync devices, Agent activity, the agent list, an empty zoom or page, and the journal fallback.
  - The tag filter panel's dashed box and the search sheet's in-page empty state now use `EmptyState`.
  - The sidebar's Bookmarks hint stays plain text: a region landmark, heading and circle don't fit the sidebar.
- **A space never opened lands on today's journal.** `navigationSlice`'s fallback was `'page-editor'`, which with no tabs always meant "No page open". A space with a saved view or tabs restores them as before.
- **A list's load failure is reported once, inline.**
  - `ListViewState` shows its alert whenever the last load failed, above any rows it keeps. A failed refresh used to leave the rows with only a toast.
  - PageBrowser does the same; its `isError` leaves out the invalid-filter cancellation, which toasts its own reason.
  - The load toasts are gone from TagList, LinkedReferences, TrashView, the page browser, PropertyDefinitionsList, TemplatesView and HistoryView.
  - UnlinkedReferences uses `ListViewState`'s alert, and toasts only while collapsed, where it has nowhere to show one.
- **The toast's close button is a 24 px icon button inside the toast** (a sonner override in `index.css`), centred on the text, with the 44 px `touch-hit-area` and a 3 px ring.

**False premises in the issue**

- Every view it named was already on `EmptyState`; "a lone centred sentence" was an `EmptyState` without its icon.
- There was no shared reporter to fix at one seam: each list toasted on its own.
- The inline alert's text and Retry were already centred on one line (measured within 1 px).

**Traps**

- `switchToSpace` (e2e helper) now waits for the switcher's listbox to close. Landing on the journal made a race with the palette's Escape more frequent; it went from 1 in 6 to 0 in 32.
- The toasts removed here were the only error reporting some unit tests checked. Those tests now assert the inline alert and that no toast fired.

**Tests**

- vitest: `EmptyState` sizes; `ListViewState` alert above kept rows; TagList, HistoryView and UnlinkedReferences show the alert and no toast; the invalid filter leaves `isError` false.
- e2e:
  - `spaces-management`: an unopened space lands on today's journal;
  - `list-error-retry`: a failed list load is reported once;
  - `error-scenarios` and `phone-bottom-sheets`: the toast's close button sits inside it.
- 17 one-command mutations each reddened the predicted assertion.
