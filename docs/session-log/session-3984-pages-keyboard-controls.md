# Session 3984 — buttons in the Pages view work from the keyboard

Two keyboard bugs a reviewer confirmed while checking #6648; neither had an issue.

- Space and Enter on any control in the Pages view (a row's title, its bookmark star, its
  checkbox, New Page, Cancel in the delete dialog) opened the list cursor's page instead. The
  document-level listener in `usePageBrowserKeyboard` skipped only inputs. It now sends Enter and
  Space to the list only when they are pressed on the list itself or with nothing focused. Arrow
  keys still move the cursor from anywhere.
- After arrow-key moves, loading more rows jumped the list to the top. With no reset key, any
  change in item count reset the cursor to row 0 and the focused-row scroll followed it. The
  cursor's reset key is now space, filter text, sort and filters; the manual reset effect is gone.

A third fix came out of the first: a keyboard bookmark toggle on a long list moved the page out of
the rendered window and focus fell to the body. A `rangeExtractor` keeps the focused row mounted.

Decisions and traps:

- Search avoids the first bug with a handler on the listbox itself. Trash and History use the same
  document listener and dodge it with `stopPropagation` on each control; their header buttons are
  not covered, read in the code and not run. Left for its own change.
- The shared `useListKeyboardNavigation` hook is unchanged: Pages is the only view that sends Enter
  from the document to "open".
- The agenda's `rangeExtractor` reads the focused row's `data-index`, which still holds the old
  position while a re-sort renders. Pages records the row's key in `onFocus` instead.
- A held off-screen row stays mounted until focus moves; one extra row at most.

Ran: the PageBrowser, keyboard-hook, Trash and batch-toolbar vitest suites, typecheck, the ten
`e2e/pages-*` spec files and a second batch of twelve related specs. The rest of the selection and
the WebdriverIO specs were left to CI.
