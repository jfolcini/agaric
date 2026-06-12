# Session 1018 — #922 keyboard/outline (findings 2, 3, 4)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#922 f2 — moveUp/moveDown cross the parent boundary (Logseq/Workflowy pop-out).**
  `page-blocks.ts`: `moveUp` on a FIRST child now pops it OUT to become its parent's previous
  sibling (under the grandparent, just before the parent); `moveDown` on a LAST child pops it
  out to just after the parent. Root-edge keeps the legacy no-op. Cross-parent moves are
  structural (`move_block` IPC + `load()` + undo), so they reload; the in-group swap path is
  unchanged for non-edge cases. Both resolve `true` on the committed move; `enqueueMove`
  serialization preserved.
- **#922 f3 — keyboard zoom into a leaf block.** Dropped the `hasChildren` gate on the Alt+.
  zoom-in handler so any block can be zoomed. New `use-block-zoom-empty-seed.ts` hook seeds a
  first child UNDER the zoom root when zoomed into a childless block — via a NON-wholesale
  splice (preserving the rest of the page, unlike the H-9 empty-page replace), idempotent per
  zoom root, racing-child-guarded, focuses the new child.
- **#922 f4 — keyboard-shortcuts help reachable while editing.** Added a `SHOW_SHORTCUTS_EVENT`
  window event + a "Keyboard shortcuts" command-palette entry that dispatches it; `useAppDialogs`
  opens the sheet regardless of focus. `?`-while-editing still types a literal `?` (untouched).

## Tests

moveUp/moveDown pop-out (nested + root no-op) asserting move_block parent/slot + reload; leaf
zoom gate removal + empty-zoom seed (preserves siblings, idempotent, no-op when has children);
palette entry dispatches the event; useAppDialogs opens on the event. 2353 touched-area tests
green; `tsc -b` clean.
