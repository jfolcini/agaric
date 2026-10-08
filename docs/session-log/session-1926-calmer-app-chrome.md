# Session 1926 — calmer app chrome (#5332 item 8)

Item 8 of the #5332 design plan, approved with the rest of the plan this
session.

What shipped:

- The app header is 48px (was 56; 50 on a coarse-pointer `lg` screen, where
  the 44px tabs and their padding do not fit). The space stripe is 2px.
- From `lg` up the journal view tabs read as a segmented control while
  staying a `tablist` with roving focus, because a Radix ToggleGroup renders
  `radiogroup`/`radio` and every spec clicks the tabs by role. Below `lg` the
  mode menu stays. The duplicate "Go to agenda" button is gone; the day
  view's h1 is the date.
- At rest the page title row shows only Star and "Page actions". Trash,
  Undo, Redo, the outline and the emoji picker are items in that menu
  (Redo disabled and skipped by the arrow keys when there is nothing to
  redo); "Save as template" covers the removed template toggle. The outline
  is a controlled Sheet that returns focus to the kebab.
- The sidebar footer is one row of icon buttons (Sync, Settings); the
  last-synced time lives in the tooltip and an sr-only description.
- Settings shows its title once: the shell header label is the h1. On phones
  the Search header wraps to two rows instead of four.

Measured, first content row before → after: Settings 186 → 94px on desktop
and 682 → 590 on a phone; phone Search 360 → 191; desktop Search 141 → 133
(the rest is the shared view-header and content padding every view uses).

Review found and fixed three regressions the change itself introduced:
cancelling Delete from the menu dropped focus to `<body>` (the menu item that
opened the dialog was gone), a `disabled` Sync button hid its "Offline" /
last-synced tooltip from sighted users (now `aria-disabled`), and in the
default light theme a footer icon's hover fill matched the active Settings
pill (now the nav rows' half-strength hover; `nav-active-item.spec.ts` covers
the footer). Six docs pages that described the old chrome were updated.

Left as they were: closing the emoji picker still drops focus to `<body>`
(pre-existing — a Radix modal returns focus only to its own trigger).

Verified: `npm run typecheck`; full vitest 870 files, 20 639 passed, 1
expected fail, 51 skipped (sharded to fit the foreground limit); Playwright
360 passed, 1 pre-existing skip across 36 specs. Every new assertion was
shown red against a mutated copy and restored.
