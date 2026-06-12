# Session 1002 — UX backlog: e2e coverage for #922 + #924

Part of "fix all ux backlog issues". Adds Playwright coverage for confirmed gaps in the
keyboard-block-ops (#922) and mouse-editor-select (#924) review findings. The features
already shipped; this is coverage only. No production code changed.

## #922 — keyboard block-ops (f5, f6, f7)
- **f5 structural undo/redo** (`e2e/undo-redo-blocks.spec.ts`): added indent-undo/redo
  (passes — depth reverts in place via `refreshAfterUndoRedo`). The **dedent-undo** and
  **move-undo** cases are `test.fixme(#958)`: the "Undone" toast fires but reorder/reparent
  does NOT revert in place (only single-block depth refreshes). This demonstrates the
  "possibly-stale refresh" the f5 finding itself flagged — kept as executable repros.
- **f6 Ctrl+. keyboard collapse** (`e2e/keyboard-shortcuts.spec.ts`): presses the key (not
  a chevron click) on a focused parent and asserts `aria-expanded` flips + child hides.
- **f7 keyboard zoom** (`e2e/keyboard-shortcuts.spec.ts`): Alt+. zooms into a focused
  parent (breadcrumb renders, siblings filtered out), Escape zooms back to root.

## #924 — mouse editor select/links/chips (f4, f5, f6)
- **f4 selection bubble** (`e2e/selection-bubble.spec.ts`, new): select a word → bubble
  visible → click Bold → `<strong>` applied; plus negative cases (empty caret, atom chip).
- **f5 external-link actions** (`e2e/editor-link-actions.spec.ts`, new): Ctrl+Click fires
  the opener with the exact href (`plugin:shell|open`); right-click → "Copy URL" writes the
  href to the clipboard (`plugin:clipboard-manager|write_text`).
- **f6 editor-mode chip nav** (`e2e/inner-links.spec.ts`): block-ref chip click navigates
  (passes). The **tag-chip** case is `test.fixme(#958)` — wiring is source-verified
  (`BlockTree → useRovingEditor({ onTagClick }) → TagRef.configure`) but the tauri-mock
  doesn't resolve a navigable page for a tag id, so navigation isn't observable in e2e.

## Verification
- All new specs run green serially (`--workers=1`): 27 passed in the touched files +
  fully-green keyboard-shortcuts / selection-bubble / editor-link-actions; 3 `test.fixme`
  (tracked in #958). `tsc -b` + oxlint clean.

Partial #922 (f5 partial, f6, f7) and #924 (f4, f5, f6 partial). Deferred to #958.
