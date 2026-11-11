# Session 3796 — History rows on a phone take two lines

A pass over the merged list rows (#6489) found History on a phone with rows 112–132px tall. Reset wrapped onto a line of its own under the content, so about four operations fit on a screen, and the floating ↑/↓ touch-nav bar covered rows near the end of the list.

- Variants, rendered in the running app by injecting each as a stylesheet:
  - (A) Reset as an icon-only 44px trailing button. It drops the visible "Reset" label that was added deliberately, because tooltips do not fire on touch.
  - (B) The labelled Reset trailing on the same row. With Diff also labelled, the text column shrinks to about 150px and the meta line breaks into three.
  - A ⋮ row menu, not built: a one-item menu hides the most-used action for no gain.
  - (E) A two-line row, kept. The maintainer saw all three.
- (E), below `sm` only (the `history-row-cell` utility):
  - Line 1 holds the meta (badge, time) and the labelled Diff and Reset.
  - Line 2 holds the content, indented past the checkbox, with the device id trailing it under the actions.
  - With a realistic ULID device id, phone rows are 82–86px; the 44px touch-sized Reset sets the floor. Desktop rows are unchanged.
- The device id is a single span in its own cell of the text column's grid, so it is never duplicated: beside the meta line on a wide row, on the content line on a phone. Its separator travels with it.
- The list gets 4rem of bottom padding on a coarse pointer, so every row, the last included, can scroll clear of the touch-nav bar.
- The utility owns `display` at both widths. A first build left a `flex` class on the element, which came later in the sheet than the grid and silently won; the screenshots caught it.
- Test: a `list-rows-phone.spec.ts` case checks two things on a phone. Reset shares the badge's line, and the content starts below it at the badge's left edge with the device id centred on that content line. It went red on main (Reset under the content), on the `flex` regression (content squeezed onto line 1) and on the three-line version (the id on a line of its own).
- The `list-cursor` accent bar is square-ended everywhere. It was an inset box-shadow, and the card's rounded corner bent it into a curve on a list's first and last rows. It is now a 2px `::before` stopping 4px short of the row's ends, clear of the corner curve, with the card's own corners untouched. A `list-rows-phone.spec.ts` case puts the cursor on the History card's corner row with Home and checks the bar clears the corner curve; it went red with the inset removed.
