# Session 1016 — #929 visual polish (findings 4, 5, 7)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#929 f4 — one selection/focus recipe.** Selection feedback was rendered 3 inconsistent
  ways (StaticBlock/EditableBlock `ring-primary/50 bg-primary/5`; BlockListItem
  `ring-ring/50 bg-accent/30`). Added a single `@utility block-selected { @apply ring-2
  ring-inset ring-ring/50 bg-accent/30 }` (beside the existing `focus-ring` utilities) and
  applied it at all three surfaces, so selection looks identical everywhere.
- **#929 f5 — selection bubble entrance animation.** Added `animate-in fade-in-0 zoom-in-95
  duration-fast ease-smooth` to the SelectionBubbleMenu container (matching the
  tooltip/context-menu/suggestion motion; `--duration-fast` collapses to 0ms under
  reduced-motion). No behavior change.
- **#929 f7 — richer block-tree empty state.** The page-root empty state now passes a
  `FileText` icon + a "Type / for commands" description (new i18n `blockTree.emptyPageHint`),
  instead of a bare message.

## Tests

StaticBlock/BlockListItem/EditableBlock assert `block-selected` is/isn't applied; bubble
container carries the animate-in classes; empty state renders icon + hint. 277 tests in the
touched files green; `tsc -b` clean.
