# Session 1010 — Visual polish (#929 findings 3, 6, 9)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#929 finding 3 + 9 — focused/active block row treatment.** `.block-active` was only a
  gutter-reveal hook (`[.block-active_&]` selectors); the focused row itself had no visual
  treatment. Added a calm static treatment to the row when focused — a faint `bg-accent/30`
  tint plus a 2px left accent bar (`shadow-[inset_2px_0_0_var(--primary)]`), reduced-motion-safe
  by construction (no animation). The `block-active` class is retained so the gutter reveal
  keeps working. + unit tests asserting the focused row carries the treatment and the
  unfocused row does not (finding 9).
- **#929 finding 6 — DONE checkbox glyph token.** The DONE check was a hardcoded
  `text-white`, unlike every sibling badge which pairs a `*-foreground` token with its bg.
  Added `--task-done-foreground` (mirrors `--priority-foreground`) + the `@theme`
  `--color-task-done-foreground` mapping, and replaced `text-white` with
  `text-task-done-foreground`. Same appearance, now inside the token discipline.

## Tests

SortableBlock active-row + unfocused tests; existing BlockInlineControls tests still green
(266 in the two touched suites). `tsc -b` clean; dev-server CSS compiles and the
`task-done-foreground` token/utility are generated.

## Notes / deferred

- Findings **1 + 2** (drag gutter width-0 below 768px; touch DnD e2e) are already addressed
  by the shipped #933 (#918/#919 touch-drag-handle hittability — gate the collapse on
  `!isTouchDevice` + a real touch grip); the touch-DnD e2e was deferred there as high-flake.
- Deferred (commented on #929): finding 4 (one shared selection/focus recipe utility),
  finding 5 (selection-bubble enter/exit animation — the cited path is stale, needs
  re-locating), finding 7 (richer block-tree empty state), finding 8 (read computed
  `--indent-width` into the DnD projection instead of the hardcoded `INDENT_WIDTH=24`).
