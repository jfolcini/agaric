# Session 2677 — on a phone, Pages titles fit, History's pill stops covering its cards, Agenda rows take two lines, and the capture button gets out of the way

#5932 items 1–5 (item 6 shipped in #5941), with #5930's capture button size,
measured at 360 × 780 with touch.

- **Pages rows** showed a checkbox, bookmark, icon, title, age and trash, so
  titles truncated to 63 px. Below `sm` a row shows the icon, title and age; a
  long press (`useLongPress`) selects it and shows the checkboxes, and while a
  selection is on a tap toggles rows. Bookmark and Trash are in the selection
  toolbar, which now wraps so they stay on screen at 360 px. A long press
  can't both select and open a context menu, so there is no row menu.
- **History:** the touch pill was 328 px wide over the cards (`self-end` in a
  non-flex parent); it is `ml-auto w-fit`, 106 px. The type select and "?"
  share a row, and Diff and Reset move under the text, which grows from 81 to
  238 px.
- **Agenda and the other block lists** (`BlockListItem`, shared by Due, Done,
  tagged and unfinished tasks): the status icon and title take line 1,
  priority, date and source line 2, so "Review pull requests" fits one line.
- **Capture button:** 56 × 56 (every Button size forces 44 on touch, so it uses
  `size={null}`), 16 px from the bottom with the main content's padding cut to
  match; it hides on a scroll down and returns on a scroll up, at the top or
  on a new screen, and hides while an editing toolbar is pinned to the bottom
  (the toolbar registers itself in `pinned-toolbar.ts`; browsers send no blur
  when the focused editor unmounts, so focus can't drive it). Page mode has no
  pinned toolbar, so the button stays while typing there.
- **Graph:** below `sm` the filter bar and focus control drop their borders;
  the card is the one surface.

`e2e/phone-views.spec.ts` (5 tests) pins each item; each went red with the code
it covers reverted. `settings-phone.spec.ts` follows the new button position.

Ran: vitest (the full suite, then the 30 affected files), every Pages,
History, Agenda, Due, Graph, Trash, batch, mobile, touch, toolbar, page-mode
and journal Playwright spec (776), `npm run typecheck`, `oxlint src e2e`, and
`journal-template-quick-capture.e2e.ts` on the real backend for the button.
