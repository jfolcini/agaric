# Session 4504 — the journal's mode switch says its word, one View menu for the agenda, counts as labels

Part of the #7040 UI review, items P1, P3 and D1 (maintainer decisions 12, 15, 20 and 25).

**What shipped**

- **The mode switch says its word (P1).** On a phone the switch reads "Day ▾", "Agenda ▾", not one letter; below 380 px the chevron hides and the word stays, so Month fits a 360 px row.
- **Delete in the day's ⋮ (P1).** On a phone "Delete page" is a destructive row in the Page actions sheet, not a one-tap trash above today's blocks. It still asks to confirm, and it waits for the menu to close, so cancelling returns focus to the ⋮. A desktop keeps its trash button.
- **"Agenda" everywhere (P3).** The sidebar row, the tab, the h1 and the header; the standalone "Tasks" label is gone and `journal.tasks` leaves every locale.
- **One View ▾ (P3).** Group by and Sort by move from chip-like buttons into one outline View button at the end of the filter row, with labelled lists; a sheet on a phone, and it stays open while you choose. Filters stay chips.
- **Counts as labels (D1).** `ui/section-count.tsx`'s `SectionCount` writes the label, then the number as a metadata-tone badge at the header's size: the Due header ("Due 1 · Scheduled 2"), Overdue, Scheduled earlier, Upcoming, "Completed 2", the Done panel's page groups and the agenda's group headers. With the chosen Due segment empty, the header names that segment's zero.
- **The Due panel's switch label** is the segments' size, and a week or stream day's "+" sits beside its date.

**False premises in the issue**

- The phone day's content already started at y = 133, the filter-icon row and "Unfinished tasks" were gone, and the Overdue label already lined up with the task rows.
- There is no filter on the day any more, so the ⋮ holds edit mode and Delete only.

**Left as they are**

- The References panel keeps "5 references": a filter-count badge follows its header, so "References 5 2" would read as two numbers.
- The Due panel's filter segments keep "Due (1)": they are segments, not section headers.
- Today's house icon stays; no decision covered it.

**Tests**

- e2e (mock lane): new `journal-header-sections` — the switch's word, Delete in the phone ⋮ with focus back on cancel, Agenda's names, the View popover on a desktop and the sheet on a phone, the count format, the switch label's size, the "+" beside its date.
- vitest: new `section-count`; `DayPageEditor` (the delete row), `DuePanel` (the header names an empty chosen segment), `AgendaSortGroupControls` (rewritten for the one View button).
- Shown red on the old code and each under one mutation: the switch back to one letter, Delete back on the phone row, delete before the menu closes, the sheet without its title, the count badge's tone, "{n} Completed", the label's size, the "+" pushed right, the h1 back to "Journal", the View closing on each choice, the sidebar's "Tasks", the empty segment's header, the count's size class.
- **Edited to the new markup:** `agenda-advanced` and `agenda-sort-group` (the Group by / Sort by buttons → the View lists, the choice by `aria-current`; the date display's "Tasks" → absent); `task-rows-chips`, `phone-touch-targets`, `phone-bottom-sheets` and `mobile-drawer` ("Tasks" → "Agenda"); `phone-view-headers` (the hidden h1 → "Agenda"); vitest `AppSidebar`, `JournalPage` (the divider and "keeps Tasks label" tests deleted), `AgendaView`, `AgendaResults`, `AgendaView.loadmore-titles`, `OverdueSection`, `UpcomingSection`, `AlertSection` ("(n)" → the badge), `DuePanel` and `DonePanel` (the header text → its count's name), `i18n` and `catalog-parity` (the deleted keys); `AgendaFilterBuilder.test`'s copy of the controls' tests deleted.
