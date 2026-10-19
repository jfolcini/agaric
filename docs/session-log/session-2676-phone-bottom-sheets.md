# Session 2676 — on a phone, panels, dialogs and long menus open as bottom sheets, and toasts sit above the capture button

#5931, with the search sheet's items from #5929 and #5930 and #5930's toast
close button, measured at 390 × 844 with touch.

- **Side panels** (block properties, History, Outline, Keyboard shortcuts)
  were 293 px right-hand panels; on a phone they switch to `side="bottom"`
  (they are already Sheets; `useDialogOrSheet` would have made them centred
  dialogs on desktop).
- **New page and the date picker** use `useDialogOrSheet('dialog')`; the date
  picker's body scrolls so the calendar can't be cut off by the keyboard.
- **Long menus** (the block long-press menu, 548 px tall, and the page ⋮ menu,
  631 px) open through a new shared `MenuSheet` on a phone; the block menu's
  submenus already expand inline. The sheet traps focus, so "Add alias" now
  focuses its input after the sheet lets go.
- **Search sheet:** the 20 px handle has a 44 px tap area, the scope chip that
  repeated the This page / All pages switch is gone, and the find box lost its
  border and second close button.
- **Toasts** move from top-centre (over the header and the search field) to
  bottom-centre on a phone, 9rem plus the safe-area inset above the edge so
  they clear the capture button, and 5rem above the keyboard when it is up;
  the close button gets a 44 px hit area. c0ddd9384 had moved them to the top
  to keep clear of the thumb area and the system navigation bar; the safe-area
  inset in the new offset keeps that covered.

`e2e/phone-bottom-sheets.spec.ts` (10 tests) checks each overlay sits on the
bottom edge and spans the width, the search sheet's one close button and
44 px handle, and a toast clear of the header, the capture button and, with
the keyboard up, the focused field. Each source file reverted failed its
assertion. Vitest covers the phone path of each changed component and
`MenuSheet`.

Ran: vitest (5825), the 82 Playwright specs touching these overlays (633),
`npm run typecheck`, `npm run lint`, and `page-alias-undo.e2e.ts` on the real
backend for the alias focus change.
