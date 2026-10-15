# Session 2087 — A focus move inside a tree re-renders only its two rows

#5550 stopped a focus move from re-rendering trees that neither lose nor gain
the focused block. Inside the owning tree, every row still re-rendered: the
`BlockActions` context bag every row reads changed identity on each move.

Two things changed the bag:
- **The five by-id handlers.** `handleIndentById`, `handleDedentById`,
  `handleMoveUpById`, `handleMoveDownById` and `handleMergeById` captured
  `focusedBlockId`. They now read it from `focusedBlockIdRef`, updated in the
  same layout effect as `rovingEditorRef`. Their callers (the context menu and
  the swipe gesture) all fire after commit, so the ref holds the value the
  closure held.
- **Two inline adapters in `BlockTree`.** `onDuplicate` and `onBatchDelete`
  were fresh closures every render. They are now `useCallback`s.

`BlockTree.focus-renders.test.tsx` now pins exact per-row render counts: a move
within a day renders the two rows involved once each, and a move across days
renders only the row losing focus and the row gaining it. With an inline
adapter restored, both went red on the render map, with five or ten rows
instead of two. A new hook test pins that `handleMergeById` reads the focus
current at call time; it went red with the captured value restored.

Suites run: vitest on `src/components/editor`, `src/components/block-tree`,
`src/components/journal` and `src/stores`, typecheck, lint, and Playwright on
`block-keyboard-move`, `block-duplicate` and `batch-operations`.
