# Session 2503 — repeat rules on the real backend (#5734, #5735, #5736)

Real-lane specs for #5734 item 10, #5735 item 5 and #5736 item 7, in
`e2e-tauri/agenda-projected-repeat.e2e.ts`, sharing one boot.

**Specs:**
- **repeat-until and repeat-count:**
  - Three daily tasks are due today: one stops after three occurrences, one
    after today+2, and one is unlimited.
  - Stepping the Daily journal forward, each day's Due panel projects
    exactly the tasks still in range.
  - The unlimited task is the control: waiting for it makes sure the panel
    answered for that day.
- **`/repeat` `.+` and `++`, weekly and monthly:**
  - Four stale tasks get one anchored rule each from the slash menu.
  - Completing them gives the next date, read in Edit as Markdown after a
    reopen: `.+` counts from today, and `++` steps past today from the stale
    date. Monthly clamps the day as the backend does.
- **Repeat properties in the drawer:**
  - The rule, `repeat-count` and `repeat-until` edited in the property drawer
    read back after a reopen, and they drive completion.
  - Each completion copies the rule and the limit, sets the new due date and
    `repeat-seq`, and stops at the limit.

**Shared helpers:** the task-row, completion, slash-pick and edit-at-end
helpers moved to `e2e-tauri/helpers.ts`, and `slash-repeat-remove.e2e.ts`
uses them.

**Corrections to the issues:**
- **No anchored yearly:** there are no `.+yearly` / `++yearly` slash items;
  anchored modes are daily, weekly and monthly only.
- **Counting:** repeat-count N means N future occurrences.
- **The drawer edits, never adds,** repeat properties: they are
  non-deletable, so Add property leaves them out.

**Found, waiting on the maintainer:**
- **#5736 item 6:** Settings › Properties cannot rename a key or change its
  type. There is no backend command for either, and editing a select's
  options does not carry over to existing values. The docs promise all of
  it.
- **#5735 item 5:** Agenda mode shows no projected occurrences; only the Due
  panel does. The doc says Agenda mode projects them.

**Shown red:**
- **Bounds:** the count and until checks in `project_block_dates` disabled.
- **Anchored modes:** `shift_date`'s `.+` and `++` arms anchored on the stale
  date.
- **The drawer:** its property save made a no-op.
- **Each red** fails only its own spec, and the weekly projection stays green
  as the control.

**Ran:**
- the file three times in a row on a rebuilt binary;
- `slash-repeat-remove.e2e.ts` twice;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint and
  oxfmt.
