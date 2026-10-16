# Session 2149 — the week-view clipboard specs pass on every weekday

Both week-view clipboard specs (#5561) went red when the UTC date rolled over to Friday 2026-10-16. They had passed on main the evening before, with the same code. The fault was test geometry; no product code changes.

**Mock lane (`e2e/week-cross-day-clipboard.spec.ts`).** BlockTree swaps any row outside the scroller and its 200px margin for a bare `<li data-block-id data-placeholder>` (`useViewportObserver`, read by `SortableBlockWrapper`).
- On a Friday, Ctrl+clicking today's block makes Playwright scroll the fifth section into view. That pushes Monday's row past the margin, and it turns into a placeholder.
- The second Ctrl+click had already resolved Monday's `block-static`. That node detached, and the locator never matched again.
- Copy passed because it clicked the earlier day first.
- On Saturday and Sunday, today's own row would have started as a placeholder.

The fix:
- `ctrlSelect` scrolls the row's `li` into view before it clicks. The `li` exists in both shapes, full row and placeholder.
- `seedSecondDay` finds today's section the same way.
- Each of copy, cut and paste now runs in both selection orders, earlier day first and later day first. Before, the weekday chose which order ran.
- The paste check now compares the anchor page's whole contents.

**Real lane (`e2e-tauri/week-cross-day-clipboard.e2e.ts`).** Without reduced motion, `WeeklyView` mounts a day's tree only when the day enters the viewport (`useEnteredViewport`). Today's section, below the fold on a Friday, held no text yet, so the marker search found nothing. Today is now found by its date id, the way `due-date-agenda.e2e.ts` does it. The spec scrolls it into view and waits for the marker row.

**Weekdays.** A scratch copy of the mock spec pinned `page.clock` to each of Mon 12 through Sun 18 October. 42 of 42 passed: Monday pairs with Tuesday, and every other day pairs with Monday. The real-lane spec cannot run here, so this PR's real-backend job is its check.

**Falsified,** on copies:
- Without the scroll in `ctrlSelect`, the three later-day-first tests fail at the click.
- The old `seedSecondDay` lookup fails all twelve runs pinned to Saturday and Sunday at its `toBeVisible`.
- Pasting after each tree's own last selected block (the pre-#5561 bug) fails both paste tests.
- Reversing the selection order in `selectionByPage` fails all six.

Not changed: the weekly view opens at Monday, so on a late weekday today's section is below the fold until the user scrolls or presses Today.

Ran:
- the mock spec: 6/6;
- `npm run typecheck` and `npm run typecheck:e2e-tauri`;
- `npx vitest run e2e-tauri`: 42;
- `oxlint` and `oxfmt --check`.
