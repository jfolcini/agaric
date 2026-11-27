# Session 4548 — #7165 U7 and U6: a selected block shows its checkbox alone; the tag colour shots

Round 3 of the UI review, lane D.

**U7: the selection wrap goes**

- `block-selected` (`src/index.css`) drew a 2 px ring and a tint on a selected row's frame (`SortableBlock`). The utility and its class are gone: a selected block shows only its checked selection checkbox. Nothing else read the wrap: page mode marks its selection with ProseMirror's own, the drag ghost (`BlockDndOverlay`) and the batch bar draw their own boxes, and the keyboard cursor's 3 px ring on the focused row is a separate feature (#5734) and stays.
- There is no `aria-selected` on the row to keep; the selection reaches assistive tech through the checkbox's checked state and the announcer, both unchanged.
- **Checkbox placement.** Measured on the tour's Product Roadmap Q1 (H1, H2, a paragraph, a task with chips, a nested child, a wrapping paragraph): on desktop the checkbox's centre was already within 0.5 px of the first line's centre, from the lane's `min-h-block-line` slot. On a phone it sat 4–6 px low: the touch branch of `BlockGutterControls` put the checkbox in an unsized column, so its 44 px hit box hung from the row's top. It now sits in `h-block-line`, a fixed-height copy of the first-line slot, which the hit box overflows evenly. Every shape now measures within 0.5 px on both profiles. The touch row still reserves nothing for a checkbox it does not show (#7157 R1).
- **The nested chevron.** On a phone a nested row's chevron was placed from the row's start while the checkbox sits in flow before the text, so the chevron covered the checkbox's left edge. It now follows the text past the checkbox slot (`touch-select-slot ~` the chevron, `SortableBlock`); `batch-operations.spec.ts` § 6 asserts the chevron starts past the checkbox's tap box, red without the rule.

**U6: already in the tour**

- The `views` scene already shoots `tag-color` (the preset swatches) and `tag-color-custom` (react-colorful's `HexColorPicker` under "Custom color"), on both profiles. The Tags list's colour button is the only place a tag's colour is set. A tour run on both profiles rendered all four shots, the phone's as a bottom sheet, with no keyboard UI. No change made.

**Tests**

- `batch-operations.spec.ts` § 6, desktop and Pixel 7: a page of a heading, a paragraph and a task with priority and due chips. Each selected row's `li`, swipe row and frame draw no background and no box shadow, the checkbox is checked, and its centre is within 2 px of the first glyph's line. Red without the touch slot (phone, the heading: 4 px), and red with the wrap put back by a CSS rule (both profiles, the background).
- Specs that read selection off the `block-selected` class read the checked checkbox instead, through `selectedCheckboxes` in `e2e/helpers.ts`.
- Old assertions replaced: `interaction-states.spec.ts` "a selected task row is highlighted with its checkbox and chips" (the highlight box enclosed the checkbox and chips) is deleted, its claim now false; `block-select-cursor.spec.ts`'s `expectCursorOn` expected the row the cursor left to draw a 2 px ring when selected, and now expects no shadow and a checked checkbox; `SortableBlock.test.tsx` "draws the multi-select highlight on the row frame" is deleted; `BlockListItem.test.tsx` no longer checks for a class nobody sets.

**Seen, not changed (outside the lane)**

- On a phone, scrolled, the sticky batch bar shows the rows under it through itself in both themes. Same before and after.
