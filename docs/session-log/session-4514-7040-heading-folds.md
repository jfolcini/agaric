# Session 4514 — headings fold their sections

Part of the #7040 UI review, item S5b (the maintainer's reach, drag and Enter decisions of 2026-11-26).

**What shipped**

- **A heading's chevron folds its section:** its children, then the blocks after it at its depth, up to the next heading of the same or a higher level, never past its parent. It is a block fold like any other, per page and per device, with no new store, table or property, so unfolding a folded H1 shows each H2's fold and every block fold inside as they were. A heading with nothing to fold shows no chevron. Block mode, the zoom pane, the focus and find reveals, links and breadcrumbs into a folded section, and page mode all read one pure `src/lib/section-fold.ts`.
- **Drag.** A folded heading carries its hidden section in one batch move with one Undo; an unfolded heading moves its line. A drop next to a folded section lands past it.
- **Keyboard moves.** `Ctrl+Shift+↑` / `Ctrl+Shift+↓` do what a drop one shown row away does: a folded heading takes its section, and any block steps over a folded neighbour and its section as one unit. The context menu's moves and the after-Enter path go through the same wrapper.
- **Enter** at the end of a folded heading unfolds the section, and the new block is its first line: the heading's first child when it has children, in both modes, with nothing re-parented.
- `foldsOver` reads the outline once with a stack of open folds, since it runs on every focus move and every page-mode transaction.

**Left as they are**

- A plain block moved or dropped below a folded heading lands inside its section, because the section runs to the next heading of its level. It stays shown while focused and folds away when focus leaves.
- Range selection (Shift+click and the keyboard) reads the rendered rows, so it leaves a folded heading's hidden siblings out: deleting the selection leaves them, and copy omits them. A drag carries them.
- An indented drop below a folded heading makes the block the heading's first child in block mode, and the section's last top block's child in page mode. Hidden either way.
- Enter in the middle of a folded heading with children: page mode makes the tail the heading's first child, block mode's split puts it after the children.
- Page mode's heading folds are unit-tested only.

**Tests**

- e2e (mock lane): new `heading-folds` (reach, nested folds, chevron and its 44 px target, `Ctrl+.`, find, Enter, keyboard moves with the stored order re-queried). Red on the old code, 10/10.
- e2e (bridge, on `REAL_BACKEND_SPECS`): new `heading-folds-drag`, the batch move and its Undo re-queried after navigating away and back.
- vitest: `section-fold` (the range, `carriedEnd`, `stepOver`, `foldsOver`), the collapse, drag, zoom and find-reveal hooks, page mode's collapse, and the store's first-child create. The 100K-block scale-envelope test passes.
- A separate session reviewed it and added the keyboard moves, the first-child Enter and the one-pass `foldsOver`, each red first. It falsified six of the builder's assertions and its own, one mutation at a time.
- **Edited to the new behaviour:** `use-block-action-orchestration.test` ×5 (`createBelow` takes a fourth `firstChild` argument); `hasChildrenSet` → `foldableSet` in the BlockListRenderer and keyboard-hook tests; `use-find-reveal.test`'s setup takes the blocks.
