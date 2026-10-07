# Session 1882 — keyboard jumps in virtualised agenda lists (#5302)

This session continued session 1873 with a `/batch-issues` sweep.

## Board

- **Merged.** #5299 and #5300 were green and approved, so both merged.
  #5271 was next. It had two import-only conflicts in `GraphView` and
  `FilterHelperPopover`: `main` added `requireActiveScope` and the branch
  added `cn`, so both imports were kept. It merged once CI was green on the
  merge commit.
- **No follow-up PR for review notes.** #5299 had none. #5300 had two, and
  neither earned a change:
  - The `resolveTagFilters` note was "not a regression; if it ever
    matters".
  - The suggestion to read `spaceId ?` in `useQueryExecution` as
    `spaceId == null` would change behaviour, not just style: the same file
    passes `''` as "no space" (`spaceId ?? ''`), and only the truthy check
    catches it.
- **Claims.** Another session had claimed #5301 and five audit bugs. This
  session took #5302, which builds on #5271's `useRovingRowFocus`.

## #5302

- **The bug.** Due, Done and Agenda rows are virtualised. A Home, End,
  PageUp or PageDown jump made `scrollToIndex` re-window the list. The row
  holding DOM focus unmounted in the same commit that mounted the target, so
  focus fell to `<body>`. `useRovingRowFocus` only hands focus on from
  another row, so it never came back. Arrow keys worked only because the
  next row is always inside the overscan.
- **The fix.**
  - `useVirtualizedGroupedRows` passes a `rangeExtractor` that keeps the
    focused row mounted. It only counts a row inside this list's scroll
    parent, because Due and Done share the journal page. It drops an index
    past the end, for a list that shrank while a row held focus.
  - `useKeyboardNavigableList` scrolls the focused row. It used to scroll
    `querySelectorAll(...)[focusedIndex]`, which indexes mounted rows by
    logical index, so it scrolled the wrong row once the window had moved
    and missed the Due panel's projected tail entirely.
  - The reviewer found that after End the cursor row could sit below the
    page fold: only the inner list had scrolled. `useRovingRowFocus` now
    also calls `scrollIntoView({ block: 'nearest' })` on the row it focuses.
- **Not fixed here.** Home aligns the first item to the top of the list,
  which hides its group header. That predates this change.

## Verified

- Each new test was shown red against a mutated copy, then the copy was
  restored and checked with `cmp`. The mutations removed the extractor and
  each of its guards, reverted the scroll-effect lookup, and dropped the
  roving row's scroll.
- **Full vitest (reviewer, before the `scrollIntoView` line):** 866 files,
  20403 tests passed (51 skipped, 1 expected fail).
- **After that line:** vitest over `src/hooks`, `src/components/agenda`,
  `src/components/editor`, `src/components/journal` and `JournalPage`:
  207 files, 4280 tests. `npm run typecheck` exits 0.
- **Playwright against the mock backend (18 passed):**
  - `due-panel-keyboard-jumps` (new; red with the extractor removed)
  - `agenda-virtualization`
  - `journal-panels`
  - `keyboard-collisions`
- **Real browser, 45 tasks due today.** After each of End, Home, PageDown
  and PageUp, focus is on the cursor row, the row is inside both the list
  and the window, and exactly one cursor is mounted. Before the fix, focus
  was on `<body>` after the first jump in Due, Done and Agenda.
