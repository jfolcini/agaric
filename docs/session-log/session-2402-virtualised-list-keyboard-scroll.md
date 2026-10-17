# Session 2402 — Keyboard and Load more in the virtualised History and Trash lists

Writing #5737's "Vim keys in the History list" spec found that the keys
did not work past the first screen.

**The keys.** History's scroll effect in `useHistoryKeyboardNav` looked up
the focused row among the mounted rows, so End or PageDown past the
virtualised window found nothing. The row was never mounted and no cursor
showed.
- `HistoryListView` now calls `virtualizer.scrollToIndex`, as
  `TrashListView` already did.
- Once the row mounts, it also `scrollIntoView`s it, as
  `VirtualizedResultListbox` does. The list's bottom can sit below the page
  fold under the compaction card, so scrolling only the list left the row
  off screen. A spec shows red without each half.

**The review found a regression the first fix introduced.**
- The new effect also ran on every `entries.length` change. Without a
  `resetKey`, `useListKeyboardNavigation` resets the cursor to 0 when the
  count changes. So Load more threw the list back to the top.
- The list now scrolls only when the cursor moves, and History passes
  `resetKey: queryKey`, as DonePanel and DuePanel do.

**The Trash list had the same Load more jump on main.** It was reproduced
by `e2e/trash-load-more.spec.ts` (scrollTop 3840 → 0) and fixed the same
way. Its `resetKey` is the space plus the client-side filter.

**Behaviour change.** After a restore or purge shrinks Trash, the cursor
keeps its index, clamped to the end, instead of jumping to row 0.

**Left out.** Opening History doesn't focus the list. App's one-frame focus
runs before the grid renders, so focus lands on `#main-content`. The keys
still work, because the listener is on the document, and the first key
focuses the grid. Fixing it needs a deferred-focus mode that nothing in the
app has yet.

**Ran:**
- vitest on the history and Trash components and the two nav hooks;
- `npm run typecheck`;
- Playwright: the new specs with `--repeat-each=3`, plus every History and
  Trash spec.
