# Session 2648 — at 360 px the journal calendar, Settings › Properties rows and Month's today circle stay on screen

#5925: three surfaces drew past a 360 px phone's edge.

- **Journal calendar:** the dropdown sat at x = 8–390, so the next-month
  arrow and Sunday were off-screen. On mobile it now opens as a bottom sheet
  titled "Date picker"; desktop keeps the anchored dropdown. It uses
  `useIsMobile` with `Sheet` rather than `useDialogOrSheet`, which would also
  have turned the desktop dropdown into a dialog. The calendar needs 340 px,
  so the sheet pads it `px-2`.
- **Settings › Properties:** the row contents, not the rows, ran to x = 361.
  `PropertyDefinitionsList` lets them wrap, with "Edit options" and
  Delete/Built-in wrapping together under the name; `list-item.tsx` is shared
  with Tags, Templates and projected entries, so it stays as it was.
- **Month view:** the 44 px today circle overflowed its cell and covered the
  count. It is 28 px (the whole cell stays the tap target), and the count moves
  into the dots row under the date, which shrinking alone did not clear.

Tests: a 360 × 780 touch block in `e2e/mobile-overflow.spec.ts` checks the
calendar stays in the viewport and its next-month arrow changes the month, no
Properties row's content passes the row or the viewport, and the today circle
stays inside its cell and off the count. Each was red on the old code and
again with only its fix reverted. Vitest covers the calendar's sheet path.

Ran: `mobile-overflow` and the 13 other specs covering these surfaces (154),
vitest (141), `npm run typecheck`, `oxlint src e2e`.
