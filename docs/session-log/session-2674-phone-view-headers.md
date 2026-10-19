# Session 2674 — on a phone the view header scrolls away with the content, Pages' header is one row, and each screen has one title

#5927, measured at 360 × 780 with touch: the first Pages row started at
y = 405 under a 48 px bar and a 225 px pinned header.

- **The header scrolls on phones:** below `md` a second header slot inside the
  main scroller takes over from `ViewHeaderOutletSlot`, so the header leaves
  with the content; a header marked `data-sticky-search` (Pages, Search) stays
  pinned. Desktop is unchanged.
- **Pages header, one row:** search, a sort icon, a ⋮ menu (Saved views and
  Tags / Graph / Query / Templates / Trash, with the trash count) and "+" New
  Page as an icon; the match count is dropped on phones and the filter chips
  scroll sideways in one row. The menu reuses the kebab pattern of
  `PageHeaderMenu` (Popover with `MenuPopoverContent`); there is no
  DropdownMenu primitive to add one for.
- **Agenda:** the nested `max-h` scroll box and its gutter are gone below `md`;
  the list still renders only the rows near the screen, the virtualizer now
  following the main scroller.
- **One title per screen:** `FeaturePageHeader`'s title is screen-reader only
  below `md`, its actions kept, which covers Trash, Journal Day and Week and
  the Agenda heading; each view still has exactly one `h1`.

After: Pages' first row at y ≈ 190, Agenda's at 290 and its header scrolls
away, Trash keeps its rows at 184 without the repeated title.

`e2e/phone-view-headers.spec.ts` (4 tests) checks the first row in the top 40%,
the header leaving on scroll with Pages' search pinned, one heading per
screen, and Agenda's single scroller rendering a window of rows. All four
failed on the old code; zero scroll margin and a non-sticky search each failed
their check. `navigateToView` opens Pages' shortcuts through the ⋮ menu on
phones.

Ran: vitest over `src/components`, `src/hooks` and `src/lib/i18n` (12540), the
110 affected Playwright specs (677), `npm run typecheck`, `oxlint src e2e`. No
real-backend spec clicks anything moved (the app window is desktop-sized).
