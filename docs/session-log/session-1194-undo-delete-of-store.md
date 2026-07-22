# Session 1194 — Move swipe-delete Undo into the undo store

**Date:** 2026-07-22
**Branch:** `arch/undo-delete-of-store`
**Closes:** #2901

## Summary

The swipe-delete Undo path — a ~60-line async state machine that probes the page op-log,
undoes at a computed depth, rolls back mis-undos via `redoPageOp`, and pokes the undo
store's positional bookkeeping — lived in `SortableBlock.tsx` and called write IPCs
directly, bypassing the store that owns undo semantics. Moved wholesale into
`stores/undo.ts` as a new `undoDeleteOf` action.

## The change

- **`src/stores/undo.ts`** — new action
  `undoDeleteOf(pageId, blockId, reloadPage: () => void | Promise<void>)`, implemented as
  `undoDeleteOfImpl` inside the `create()` closure (same pattern as `undoByRefs` /
  `undoPositional`). Contains the moved state machine verbatim: `listPageHistory` (scan
  limit 50) → index-based depth probe `[index, index+1]` via `undoPageOp` → device_id/seq
  match → `onNewAction(pageId)` (now genuinely internal — the old "bypasses the undo
  store's bookkeeping" comment is resolved) → `notify`/`announce` → page reload; on
  mismatch, `redoPageOp` rollback then retry one depth deeper; `notifySwipeUndoFailed` on
  exhaustion/error.
- **`src/components/editor/SortableBlock.tsx`** — removed `undoSwipeDelete`,
  `historyEntryBlockId`, `notifySwipeUndoFailed`, `SWIPE_UNDO_HISTORY_SCAN`, and the
  now-unused write-IPC imports (`listPageHistory`/`redoPageOp`/`undoPageOp`) + others. The
  swipe-undo click delegates: `undoDeleteOf(pageId, blockId, () =>
  getPageStore(pageId)?.getState().load())`.

## Store-layering / import-cycle constraint (review fix)

The undo store must NOT import `@/stores/page-blocks` — `page-blocks` already imports
`useUndoStore`, so a direct `getPageStore` import in `undo.ts` closes a module cycle and
fails the `frontend import cycles (zero)` guard. Instead the page reload is **injected as
a `reloadPage` callback** supplied by `SortableBlock.tsx` (which already depends on
`page-blocks`). Both `scripts/check-import-cycles.mjs` (0 cycles) and
`scripts/check-store-layering.mjs` pass.

## Tests

`undo.test.ts` — 7 new cases driving `undoDeleteOf` directly against mocked `@/lib/tauri`
(happy path, index-derived depth, mis-undo redo-rollback + reprobe, `onNewAction`
bookkeeping reset, not-found / history-rejects / both-depths-wrong error paths).
`SortableBlock.test.tsx` — simplified to wiring-only, plus a test capturing the injected
`reloadPage` callback and asserting it drives the real provider's `load()` →
`loadPageSubtree` IPC. Non-tautological: `[index,index+1]`→`[0,1]` fails the depth test;
disabling the `redoPageOp` rollback fails two tests. 275 (undo+SortableBlock) + 579
(page-blocks/BlockTree) vitest pass; tsc + oxlint clean.
