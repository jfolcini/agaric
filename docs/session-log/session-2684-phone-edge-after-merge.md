# Session 2684 — main's phone edge spec checks the Journal's block text, not a heading a phone no longer shows

Main went red on `e2e/phone-content-edge.spec.ts` after #5955 and #5958
merged in the same sweep, each green on its own base. #5958's Journal test
read the first `h1` as the day heading; since #5955 the header bar names the
day on a phone and that `h1` is screen-reader-only, so the spec measured its
1 px clip box at 15 px. There is no visible day heading left to align, so the
test now checks the block and task text and the Today band, and says why.

Ran: `phone-content-edge.spec.ts` (red on main before the change, as in CI)
and `phone-view-headers.spec.ts`, 8 passed.
