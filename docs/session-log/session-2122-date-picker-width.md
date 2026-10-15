# Session 2122 — The block date picker fits its calendar

The maintainer found the block date picker (`/due`, `/schedule` and their
shortcuts) too wide. Its dialog was `sm:max-w-md`, which put wide empty
margins on both sides of the calendar.

The dialog is now as wide as the calendar plus the dialog's padding.
- **Mouse.** Day cells are `w-8`, so the dialog is `sm:max-w-xs`.
- **Touch.** A coarse pointer gets `w-11` cells, so it gets
  `sm:max-w-sm`; a flat `max-w-xs` would have overflowed on tablets.
- **Phones.** Below `sm` the dialog keeps its viewport-wide cap.

Checked with Playwright screenshots against the mock: desktop with a mouse,
and a tablet with touch. The block date picker's vitest file, the typecheck,
oxlint and oxfmt passed.
