# Session 2570 — Agenda mode lists the coming occurrences of repeating tasks (#5735)

#5735 asked for a real-backend spec of Agenda mode's projected occurrences (dashed,
"Projected") stopping at `repeat-until` / `repeat-count`. Agenda mode showed none:
only the Due panel called `list_projected_agenda`. The maintainer chose to build
them, and approved the default range below.

**Built:**
- A projected section below Agenda's committed list, from the Due panel's own row
  component (`ProjectedEntries.tsx`, shared): each row says "Projected" in text and
  carries a `<time datetime>`; it opens the source task's page.
- `useAgendaProjectedEntries` pages `listProjectedAgenda` with its cursor and refetches
  on a property change; a rejection warns and offers retry.
- `planAgendaProjection` turns Agenda's filters into the IPC's range and a per-entry
  test: the span of the due- and scheduled-date filters from today on, or the next 7
  days (today and the six after) with neither; each occurrence judged by the filter
  for its own source; status and priority applied to the repeated task; no section
  under a tag, property, completed-date, created-date or Overdue-only filter, which
  an occurrence cannot answer; an occurrence on its task's own date dropped (`.+`
  can land there).
- The section keeps date order whatever the sort or grouping, stays out of the result
  count, has its own Load more, is reached by the arrow keys after the committed rows,
  and still shows under "No matches".
- The hook reads past a page the filters reject entirely, so a matching occurrence on
  a later page is never stranded behind an empty section.

**Backend:** none. `list_projected_agenda` already stops at `repeat-until` and
`repeat-count` for `+`, `.+` and `++`.

**Shown red:** unit, the own-date drop, the today clip, the filters that hide the
section, the status and priority predicates, the per-source span, the cursor, the
retry, the no-IPC guard, the read-past-a-rejected-page effect, the date, the keyboard
order, the empty state and the Load more. Real backend
(`agenda-projected-repeat.e2e.ts`, "lists the coming week of projected occurrences in
Agenda mode, up to each bound"): the hook returning nothing and a one-day default
range, both at the control wait for the unbounded task.
