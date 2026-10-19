# Session 2657 — Settings › Properties rows on a phone: name and control on one line, Edit options under the name

Maintainer feedback on #5938: on a phone, "Edit options" wrapped under the
property name but sat right of centre, unanchored.

- **Phone layout:** each row is a two-column grid. Line 1 holds the name and
  type badge, with Delete or Built-in pinned at the right end on every row.
  Line 2 holds Edit options, on select rows only, starting at the name's left
  edge (no side padding there). Rows without options stay one line. Line 1 is
  44 px tall on touch whether it ends in the trash button or the Built-in
  badge, so Edit options sits the same distance under every name.
- **Todo State,** the one row with locked options, puts its "Locked" note and
  help button on the options line, so Built-in stays on line 1.
- **Desktop** keeps one row in the original order.

`e2e/mobile-overflow.spec.ts` now checks at 360 px that Delete or Built-in is
on the name's line and right-most in the row, that each select row's options
start at the name's left edge right below line 1, and that other rows take one
line. It was red on six select rows against #5938's wrap layout.

Ran: the 360 px block of `mobile-overflow` (23), the Settings › Properties
specs (144), vitest over `src/components/properties` (250),
`npm run typecheck`, `oxlint src e2e`.
