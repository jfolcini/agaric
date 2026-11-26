# Session 4501 — the outline on one left edge, faint indent guides, a phone's top-level chevron at the row's end

Part of the #7040 UI review, item S5 (maintainer decision 11, amended: on a phone a top-level parent's chevron ends its row).

**What shipped**

- **One left edge.** The title, Add block, the references heading and every top-level block's first glyph start at one x on desktop and phone. Leading controls (grip, chevron, checkbox) hang left of the column through `--block-hang` in `src/index.css`; the `outline-column` utility gives each `BlockTree` mount (page editor, tag notes, journal day and week) the room they hang into. Page mode lines its text up with block mode.
- **The chevron beside the text.** A parent's fold chevron sits in the text box's inset, just left of its first glyph, on desktop, tablet and in page mode. On a phone a top-level parent's chevron ends its row instead, a 44 px box after the text, so a top-level task's checkbox keeps its whole 44 px target; nested parents on a phone keep the chevron on the left.
- **Indent guides.** Each ancestor draws a faint 1 px guide (`bg-border/70`) under its chevron's position. Guides take no click.
- **A wider phone indent.** 20 px a level below 48rem.
- **A tablet's chevron stays clear of the sidebar.** On a coarse pointer `--block-room` leaves room for a top-level chevron's 44 px hit area, so the pane no longer clips it against the open sidebar; a phone resets it, since its top-level chevron ends the row.

**Left as they are**

- During a drag the dragged row's guides keep its list depth while its padding follows the projected depth; the row is translucent and the state transient.
- Page mode draws no indent guides; S5 scoped them to block mode.

**Tests**

- e2e (mock lane): new `outline-edge` — one x for the title, Add block, the references heading and each top-level block; a child one indent step in with a guide per level that takes no click; the chevron left of the first glyph, or at the end of a phone's top-level row with a 44 px box, and a top-level task's checkbox with its 44 px hit area; on a touch tablet with the sidebar open, the chevron's whole 44 px hit area inside the pane. Each on desktop and phone profiles.
- vitest: `SortableBlock` (keyboard order on desktop, tablet and phone, depth 0 and nested), `BlockInlineControls`, `page-gutter`, `page-tasks`.
- Shown red on the old code and each under one mutation: the phone's top-level chevron on the left (`chevronAtRowEnd` false), its rule widened to nested parents or to touch tablets, the tablet room reverted (hit area 32 px), the phone reset removed (title at 44 px instead of 16).
- **Edited to the new layout:** `gutter-layout`, `block-metadata-row-layout`, `page-mode-gutter`, `page-mode-touch` and `block-dnd-touch` (the lane inside the column, a 12 px phone indent, the chevron at the row's end on touch, `data-chevron`, `pl-14`, `gap-0.5`); the unit tests above; `use-block-dnd`'s computed `--indent-width` fixture, 12 → 20 px.
