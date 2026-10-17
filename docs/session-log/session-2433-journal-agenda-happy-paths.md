# Session 2433 — Happy-path specs for the journal and agenda

These are #5735's mock-lane items, part of the #5726 sweep. Each spec was
shown red by a product mutation, and a reviewer re-ran the mutations.

**Shipped:**
- **`journal-monthly.spec.ts`**
  - Monthly cells carry one dot per source on days with a due and a
    scheduled task, none on an empty day, and a click opens Daily on that
    date.
  - The journal date picker shows one dot per source the same way.
  - The pages are seeded over IPC, so the spec reads November: the boot
    cache holds October and only a journal-UI create merges into it.
- **`agenda-filter-builder.spec.ts`**: Due "This week" plus a property
  filter narrows to exactly the matching tasks. Removing both chips brings
  back the default TODO/DOING list.
- **`agenda-sort-group.spec.ts`**: Sort by and Group by survive a trip to
  Pages, which remounts AgendaView.
- **`due-panel.spec.ts`**
  - Hide-before-scheduled hides a task due today but scheduled next week,
    keeps it hidden across views, and shows it again when turned off.
  - "(3d overdue)" shows on an overdue row, and a click opens its page with
    that block's editor focused.
  - Its seeding moved to `seedSearchBlocks`, and so did
    `due-panel-keyboard-jumps.spec.ts`'s.
- **`date-chip-editing.spec.ts`**
  - The Agenda due chip's editor applies `+3d`, `next monday` and `Apr 15`
    on Enter, the result survives a round-trip, and Escape writes nothing.
  - The toolbar's Set scheduled date writes a scheduled chip that survives
    a reopen. It replaces an open-only test in `toolbar-controls.spec.ts`.

**Premises that were wrong:**
- The date picker shows no count on hover.
- The Agenda filter has no custom date range, and no Group by tag.
- The Due panel never had a `key = value` property pill. The doc claimed
  one, so `docs/features/journal-and-agenda.md` no longer does.
- The Properties source count needs the real lane: the mock never matches
  date-typed properties.

**For the maintainer:**
- Two buttons named "Clear all filters" do different things. The filter
  bar's clears to every dated task; the empty state's restores TODO/DOING.
- Sort by has no effect while the list is grouped, and grouping by Page is
  the default.

**Fixes found on the way:** a page created in Stream never reached Day mode
or the date picker. That fix and its spec ship in their own PR.

**Ran:**
- the seven touched spec files together (37 passed, 2 pre-existing skips),
  and each new file with `--repeat-each=3`;
- `npm run typecheck`.
