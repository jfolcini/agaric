# Session 4523 — chips, callout labels and listed block text follow the note text size

Part of the #7040 UI review, coverage item C4: the rest of the largest note text size after #7139 (maintainer decisions 27, 28 and 36).

**What shipped**

- **Chips grow with their icons (decision 28).** A block's priority, date, repeat, property and count chips take a new `@utility text-block-chip`, 0.75× the note text, so 12 px at Medium as before. Page mode's text chips scale at 0.6875×, and the empty metadata row reserves the taller of a chip's and a badge's height.
- **A callout's label** takes `text-block-sm`, 0.875×, 14 px at Medium.
- **A block's text wherever it shows (decision 27)** takes `text-block-sm`: the due and done panels, search results, linked, unlinked and outgoing references, the alias card, history and its diff, trash, query results, an embedded block and a reference's peek. The agenda's projected entries follow too. Page names in navigation and the app's own words stay fixed.
- `cn` knows both utilities as font sizes, so a colour class no longer drops them and `text-xs` still overrides them.
- `docs/features/appearance.md` and `views.md` say what the setting reaches.

**Left as they are**

- The Query block's table stays at its fixed size (decision 36), and so do the drag overlay, the template picker and the palette's search groups.
- At Medium every changed element is pixel-identical: a spec measured fifteen of them on the branch and on `main`, font size, line height, width and height.

**Tests**

- **e2e (mock lane):** `font-size-scaling` gains the chips and callout label, then block text in the due panel, search, the alias card, the three reference lists, history and its diff, trash, query results, an embed and a peek. Each was red with its class reverted.
- **e2e (bridge):** `agenda-projected-repeat` gains a projected entry at each note text size, since the mock returns no projected entries.
- `utils.test` pins `cn` keeping both utilities beside a colour and letting `text-xs` win.
- `BlockListItem.test`, `BlockInlineControls.test` and `PropertyChip.test` pin the new size classes in place of the old fixed ones.
- A separate session reviewed it, merged `main` twice, and added the embed, the peek and the history diff.
