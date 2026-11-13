# Session 3992 — buttons in Trash and History work from the keyboard

The same family as session 3984's Pages fix, confirmed by its reviewer; no issue.

Trash and History heard Enter and Space at the document and acted on them from any focused
control. Space on *Restore all*, *Empty trash*, the op-type legend or *Load more* selected the
list cursor's row, and while a History row was selected, Enter on the legend opened the revert
confirmation. Inside a History row, Space on *Reset to this point* or *Diff* selected the row
instead of pressing the button: the row's own handler caught the key on its way up.

One predicate, `pressesFocusedControl` beside `useListKeyboardNavigation`, now gates Pages, Trash
and History. Enter and Space belong to the list only when focus is on nothing in particular
(`<body>`, or an element that holds the list such as `#main-content`), on the list itself, or on
the row holding its Tab stop. Anywhere else the key is the focused control's. A History row now
toggles itself on Space only when the Space is pressed on the row.

Decisions and traps:

- "The list or the body" alone, as #6654 had it for Pages, breaks History, whose Tab stop and
  clicked rows hold focus for Enter-to-revert, and Trash, where focus after a view switch is
  `#main-content`.
- "Any row", the first draft, broke Pages: a click in a row's padding focuses the row
  (`tabindex="-1"`) without moving the cursor, and Enter then opened the cursor's page. Only a
  row with `tabindex="0"`, the roving Tab stop of History and Trash, counts.
- `BatchActionToolbar`'s `stopPropagation` shielded only the three document listeners, and its
  `tabIndex` existed only because a toolbar with a key handler must be focusable; both are
  deleted. Nothing focuses the toolbar.
- The checkbox `stopPropagation` calls stay (the row tests pin that a checkbox key stays off the
  document), as do the action and diff cells' (lint pairs them with the cells' `onClick`). In
  Trash rows they are what keeps the row's own Enter and Space handler off its buttons.
- `listRef` is required in `useTrashListShortcuts`; its hook test passes a null ref.
- No `target === document` arm: a real keydown targets the focused element or `<body>`. The
  History and Trash hook tests dispatch on `<body>`.

Ran: full vitest, typecheck, lint, `prek` (all files and manual stage), and the keyboard-controls,
Trash, History and Pages Playwright specs; each new spec shown red. The whole Playwright and
WebdriverIO lanes are CI's run.
