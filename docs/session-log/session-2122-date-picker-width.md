# Session 2122 — The block date picker fits its calendar

The maintainer found the block date picker (`/due`, `/schedule` and their
shortcuts) too wide. Its dialog was `sm:max-w-md`, which put wide empty
margins on both sides of the calendar.

The dialog is now as wide as the calendar plus the dialog's padding.
- **Mouse.** Day cells are `w-8`, so the dialog is `sm:max-w-xs`.
- **Touch.** A coarse pointer gets `w-11` cells, so it gets
  `sm:max-w-sm`; a flat `max-w-xs` would have overflowed on tablets.
- **Phones.** Below `sm` the dialog keeps its viewport-wide cap.

The Journal calendar dropdown was already sized to its calendar. On desktop,
its legend's `gap-3` made it a few pixels too wide for one line, so
"Property" wrapped onto a line of its own. The legend now uses `gap-x-2
gap-y-1` and fits on one line, and the dropdown is a line shorter.

Checked with Playwright screenshots against the mock: desktop with a mouse,
and a tablet with touch. Both components' vitest files, the dropdown's three `menus-popovers` e2e
tests, the typecheck, oxlint and oxfmt passed.
