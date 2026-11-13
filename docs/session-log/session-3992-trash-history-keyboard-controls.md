# Session 3992 — buttons in Trash and History work from the keyboard

The same family as session 3984's Pages fix, confirmed by its reviewer; no issue.

Trash and History heard Enter and Space at the document and acted on them from any focused
control. Space on *Restore all*, *Empty trash*, the op-type legend or *Load more* selected the
list cursor's row, and while a History row was selected, Enter on the legend opened the revert
confirmation.

One predicate, `pressesFocusedControl` beside `useListKeyboardNavigation`, now gates Pages, Trash
and History. Enter and Space belong to the list only when focus is on nothing in particular (the
document, the body, or an element that holds the list such as `#main-content`), on the list
itself, or on one of its rows. Anywhere else the key is the focused control's.

Decisions and traps:

- "The list or the body" alone, as #6654 had it for Pages, breaks History, whose Tab stop and
  clicked rows hold focus for Enter-to-revert, and Trash, where focus after a view switch is
  `#main-content`.
- `BatchActionToolbar`'s `stopPropagation` and `tabIndex` shielded only the three document
  listeners and are deleted. The row, checkbox and cell `stopPropagation` calls stay: they also
  keep keys from each row's own handler, and tests pin them.
- `listRef` is optional in `useTrashListShortcuts` because an existing test builds its options
  from a type that lacks it.
- The predicate's `target === document` arm serves existing hook tests that dispatch on the
  document; a real keydown never targets it.

Ran: the three hooks' and views' vitest suites through `vitest related`, typecheck, and the
keyboard, Trash, History and Pages Playwright specs. The whole Playwright lane is CI's run.
