# Session 4512 — the editing box holds the row, one link look, no reveal on a range, the bubble above

Part of the #7040 UI review, item D3 (maintainer decision 19).

**What shipped**

- **The editing box holds the row.** `SortableBlock` wraps a block's checkbox, property-editor anchors and text in a `block-frame` that draws the editing box while the block is focused, and the cursor row's ring moved onto it from the text. A task's box now takes in its checkbox and its chips line. Both rings are inset, so a phone's row, which starts at x = 0, shows its left edge. One `@utility block-editing` draws the box, for the frame and for a row edited inside an unlocked embed, which has no frame. Page mode draws no box per block, as before.
- **One link look.** A new `--color-link`, derived from `--block-ref-foreground`, colours page links and URLs at the surrounding text's weight, underlined at half strength; a URL no longer reads as plain text. What stays different means something: a URL's ↗ (it leaves the app), a block ref's tinted chip in the same hue (it shows another block's text), a tag's muted pill (a label, not a link), the references panel's hairline on the link that lists the row (#4551).
- **No reveal on a range (decision 19).** The Markdown markers show for a plain caret or a selected atom, never for a range, so the text no longer shifts while you select it. The range-only walks are gone.
- **The selection bubble sits above** the selection, so it no longer covers the next block, and drops below only when the formatting toolbar leaves no room above (`flip` bounded to the area under the lowest unpinned toolbar). Its tooltips open upwards. #1958's reason for below, a toolbar at the top of the block, went away when the toolbar moved to the view bar.

**Left as they are**

- The multi-select highlight still covers a block's text, not the whole row the editing box now draws.
- The editor's URL shows no ↗ while the static render does; the colour marks it as a link in both.
- TipTap re-places the bubble on window scroll only, not on the app's scroller, so an open bubble scrolled up rides with its text, as the below placement did.
- On the first line, when the bubble flips below, it covers that block's chips line.
- A printed link is the light theme's link colour, which clears AA on white; the print stylesheet never set link colours.

**Tests**

- e2e (mock lane): new `editor-desktop-polish` — the box holds the checkbox and the chips, a row edited inside an unlocked embed has it too, a URL looks like a page link and neither is the text's colour, a range shows no markers (Shift+Arrow and a mouse drag), the bubble sits above a mid-page selection and clears the toolbar on a first line in block and page mode. Red on the old code with the predicted assertions.
- Falsified one mutation at a time: the box back on the text, the URL in the text colour, the link token as the foreground, the reveal without its range gate, the bubble below, the flip without its boundary, the cursor ring removed, the embed wrapper without the box.
- **Edited to the new markup:** `block-select-cursor` (the ring on `block-frame`), `batch-operations` (the cursor ring is inset; the row, not the text), `markdown-reveal.spec` ×3 and `page-mode-reveal.spec` (a range shows no markers; a caret after it does), `print-page` (a printed link darker than mid-grey, not near-black), `markdown-reveal.test` ×5 and `page-mode-reveal.test` (a range reveals nothing, a caret reveals its markers; "Ctrl+A on one block reveals" deleted, it contradicts decision 19), `SortableBlock.test` (the frame's structure).
