# Session 4547 — #7165 U1, U2, U8: the search sheet's toggle, the phone inset against the scrollbar, the gap under a title

Lane C of round 3 of the UI review (#7165).

**U1: the search sheet's scope toggle filled the sheet (phone)**

- Cause: on a phone `ToggleGroup` adds `flex grow` so that its segments fill a row. The sheet lays its children out in a flex column, so in All pages mode (a fixed `h-[90dvh]`) the `grow` stretched the toggle down the sheet, 367 px tall, with the palette under it.
- Fix: `grow-0` on the sheet's toggle (`SearchSheet.tsx`). The primitive is lane B's, so it was left alone. It does the same in any flex column on a phone.
- Measured on a Pixel 7 in All pages mode: before, toggle 367 px and the palette input at y 545. After, toggle 36 px and the input at y 214. This page mode and its empty state were already 36 px. With the viewport cut to stand in for the keyboard, the toggle stays one segment high.

**U2: the editing frame against the scrollbar (phone)**

- The scrollbar: App's main `ScrollArea` takes `data-slot="main-content"`, which replaces the root's `data-slot="scroll-area"`. The index.css rules that swap Radix's overlay bar for a space-reserving native one never match it. So the main view draws Radix's overlay bar (8 px on touch, shown while hovered or scrolled) over the pane's right padding.
- Cause: the brief's guess, the scroll container's padding, was wrong. Text already stops 8 px clear of the bar. Only the phone editing frame reached into the right padding (`-mr-2`, `SortableBlock.tsx`), to match its left inset against the screen edge, and so it ran under the bar.
- Fix: the frame no longer reaches right. It now ends 8 px from the bar, as it starts 8 px from the left edge (before: 0 px). Pages and the day view follow, at every depth; list rows never reached into the padding.
- Rejected: widening the viewport's right padding first. It gave the same frame inset but took 8 px of width from every phone view, and that wrapped an empty Week day's chip row onto a second line (`phone-block-lists.spec.ts` "an empty Week day is one row", 88 px against at most 56).
- Desktop is unchanged: the frame rule is phone-only.

**U8: the gap under a day or page title (desktop)**

- The band under the header's hairline is the formatting toolbar's room: the scroller's `md:p-6` top padding (24 px) plus `ViewToolbarSlot`'s `md:h-1` (4 px) equal the bar's `h-7`. The bar covers that band when a block is focused, so nothing moves. It cannot shrink unless the bar shrinks or covers the first block.
- Today's day added its tint's `py-2` (`DaySection.tsx`) on top of that: 36 px under the hairline against a page's 28.
- Fix: the tint drops its top padding on a desktop day (`md:pt-0` when the heading is hidden). The view header's bottom padding goes from `pb-3` to `pb-2` (`App.tsx`), which applies to every desktop view header.
- Desktop, today's day: hairline at 105 → 101, first block 141 → 129. Hairline to block text 40 → 32; title row to hairline 13 → 9.
- Desktop page: hairline 147 → 143, first block 175 → 171. Under the hairline unchanged (the bar's 28); above it, 13 → 9.
- Phone: no change. It keeps no toolbar room; a page's in-scroller header sits 16 px above its first block.

**Tests**

- `phone-bottom-sheets.spec.ts`: "the scope toggle keeps one segment high and the results take the rest of the sheet". Red without `grow-0`: `groupOverSegment` was 333, expected 0.
- `phone-content-edge.spec.ts`: "a focused task's editing frame sits as far from the scrollbar as from the left edge" replaces "… keeps the same inset on both sides". The old test measured the right inset to the window edge. Red with `-mr-2` put back: 8 px apart.
- `sticky-toolbar.spec.ts`: "on page / today's journal day, the first block sits the bar's height under the header, and focusing it moves nothing". Red with `pb-3`: 13 above the hairline, expected 9. Red without the tint change: 36 below it, expected 28.
