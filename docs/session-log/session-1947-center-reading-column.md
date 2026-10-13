# Session 1947 — center the reading column in the content pane (#5354)

On desktop the reading column sat against the left of the content pane: at
1440×900 it left 64px on its left and 416px on its right, and the header
actions sat at the far right edge, away from the text. Two parts of #5332
caused it: the `max-w-reading` cap had no `mx-auto`, and the pane's desktop
padding was 64px left against 24px right.

What shipped:

- `.page-editor` and the journal's root get `w-full max-w-reading mx-auto`
  (`w-full` because auto margins turn off flex stretch); the month grid stays
  full width.
- The page header and the agenda header, portaled into the view-header
  outlet, get the same cap, so the title and actions end at the column's
  edges.
- The outlet and the main scroll viewport use `md:pointer-fine:px-16`, so a
  centered column lands on the pane's center. Pages, Search and History now
  have 64px on the right instead of 24px.
- `e2e/block-metadata-row-layout.spec.ts` "Reading width, desktop" checks,
  with the sidebar open and collapsed, that the page editor and the journal
  daily and stream columns are centered (±1px), that the month grid stays
  wider than the column, and that the page actions and the journal template
  button end at the column's right edge.

The main viewport's scrollbar is Radix's overlay and takes no width, so no
scrollbar gutter is needed (measured with scrollbars on).

Verified: the new assertions went red with the sources put back (gaps 64 vs
416, and 64 vs 592 collapsed), red again with the column centered but the
headers uncapped, and red with the padding uneven; green after across 23
specs (253 passed). Vitest on the 8 touched component suites passed;
typecheck, oxlint and oxfmt clean.
