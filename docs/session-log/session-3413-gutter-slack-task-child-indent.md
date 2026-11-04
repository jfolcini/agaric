# Session 3413 — the drag handle gets slack, and a task's children indent from its text

After #6315 made both editing modes lay out the gutter alike, the maintainer looked at two details on a screenshot page and chose the recommended option for each.

1. **Slack inside the box.** `--block-lane` gains 0.25rem on its outer side, so the drag handle's dots sit 6 px inside the page column (block mode) or the frame (page mode) instead of 2 px. All text moves 4 px right in both modes: plain 446, task 470 at Medium in a 1280 px window.
2. **A task's children indent from its text.** With no checkbox room on a plain line, a task's text sat one checkbox (plus gap) right of a plain line's, which equals one indent step at Medium, so a task's plain child started at the task's own text x and read as not indented. A block's offset is now `--indent-width × depth + --block-task-shift × (task ancestors)`: a task's child sits one step right of the task's text (494), its grandchild another step (518); a plain block's children are unchanged relative to their parent.

**How.**
- `countTasksAtOrAbove` (`src/lib/tree-utils.ts`) counts the task ancestors in one pass.
- **Block mode:** `BlockListRenderer` computes the counts per visible row and `SortableBlock` pads by them. A todo-state change rebuilds the rows, so children re-indent live. The drop indicator and the drag previews use the projected parent's count.
- **Page mode:** `PageLists.redraw` computes the counts and tells a block when its count changes. The node view sets `--tasks-above`, which the margin in `page-document.ts` reads. The drop bar lands at the new parent's text plus one step.
- `DragIndentGuides` (one x per depth) stays approximate under a task; a comment says so. The drag overlay and embeds draw no checkbox and are unchanged.
- **Phones:** block mode on touch keeps an empty checkbox box on plain rows, so its task shift is the 44 px checkbox alone, and a task's child now starts one step past the task's text (task 60, child 72). Page mode's phone layout keeps its checkbox in the lane, so its shift is 0 and nothing moves there.

**Tests.**
- `e2e/gutter-layout.spec.ts` covers Small, Medium and Large in both modes, plus a phone case. It asserts:
  - the handle's dots sit at least 6 px inside the box;
  - a task's child, a plain block's child, and a grandchild under a task each sit one indent step right of their parent's text;
  - Ctrl+Enter on the parent moves the children, re-measured live;
  - page-mode text x equals block-mode text x on every row.
- On the code before this change it was red ("expected ≥ 6, got 2"; "its plain child vs a task: expected 24, got 2 / 0 / −2"), and it is green after.
- Each piece was also falsified on its own: the lane width, the block-mode shift, page mode's `--tasks-above` and its redraw notice, the projected drop count, the coarse-pointer shift, the phone zero, and the page drop bar.
- `page-mode-gutter.spec.ts` pins the drop bar under a task. New unit tests cover `countTasksAtOrAbove`, page mode's live re-indent on toggle and Tab, and the drag state.
- Also ran, all passing except one `phone-header-bar` navigation timeout that passed on rerun and under lower load:
  - vitest over the editor, page-mode and block-tree tests;
  - `npm run typecheck`;
  - Playwright `gutter-*`, `block-*`, `page-mode*`, `journal-*`, `phone-*`, `mobile-*`, `embed*`, `font-size-scaling` and `keyboard-shortcuts`.
