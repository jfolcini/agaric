# Session 1017 — DnD visual polish (#923 f3/f4, #929 f8)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#923 f3 — drop indicator above/below the over-row.** `useBlockDnD` now computes `dropAfter`
  (true when the active block sits above the over-row, i.e. dragging downward → drop lands
  after), threaded through BlockTree → BlockListRenderer → SortableBlockWrapper. The indicator
  renders above the over-row when `!dropAfter`, below it when `dropAfter` — matching where the
  block will insert (Notion/Logseq show the bar on the exact edge).
- **#923 f4 — ghost-row drag overlay.** Replaced the bare 5px pill with a translucent ghost of
  the dragged row (truncated content text in an `opacity-70 bg-card border shadow-lg`
  container, indented at the projected depth) + a 180ms drop-settle animation (collapses to 0
  under reduced-motion). Selection-count badge preserved.
- **#929 f8 — computed --indent-width into the projection.** `useBlockDnD` reads the responsive
  CSS `--indent-width` (24/16/12px by pointer/width) via getComputedStyle (fallback to the JS
  `INDENT_WIDTH=24`, SSR-guarded), re-resolved on drag start, and passes it to `getProjection`
  — so pointer-distance-per-level matches the rendered indent guides on every viewport.

## Tests

`dropAfter` suite (down→true, up→false, self/sentinel→false), computed-indent-width fallback,
SortableBlockWrapper above/below placement, overlay ghost structure. Full touched-area run
2968 green; `tsc -b` clean.
