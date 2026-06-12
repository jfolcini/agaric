# Session 1001 — UX backlog: touch-gesture safety (#927 f5, f7)

Part of the "fix all ux backlog issues" sweep (#921–#929). Touch-only changes —
**needs on-device QA; do not auto-merge** (the #938 precedent). jsdom/Playwright cannot
exercise real touchmove scroll-vs-long-press timing or a physical swipe, so the unit
tests are the verification of record.

## #927 — outline-structure / touch interaction

### Finding 5 — long-press vs vertical-scroll conflict
`useBlockTouchLongPress.ts` already cancelled the long-press timer on move; hardened it:
the cancel threshold (`LONG_PRESS_MOVE_THRESHOLD = 10px`) is now measured as Euclidean
distance from the original `touchstart` in **any** direction, so vertical, horizontal,
and diagonal drags all cancel the 400ms long-press (scroll wins); sub-10px jitter still
opens the menu. Added unit tests for pure-vertical scroll cancel and cumulative-travel
cancel (compare-to-start, not per-move).

### Finding 7 — swipe-to-delete is now recoverable (Gmail-style undo)
The 200px swipe still deletes immediately (no blocking confirm), but now fires an
**Undo toast** as the safety net:
- Extracted a shared `performPageUndo(pageId)` / `performActivePageUndo()` helper in
  `useUndoShortcuts.ts`; the Ctrl+Z keyboard branch now calls it, so the toast's Undo
  replays the **exact same page-op undo** (undo + screen-reader announce + store reload).
- `SortableBlock`'s `handleSwipeDelete` calls `onDelete(blockId)` then
  `notify(t('block.swipe.deleted'), { duration: 5000, action: { label: t('action.undo'),
  onClick: performActivePageUndo } })`. No-ops when `onDelete` is absent.
- New i18n key `block.swipe.deleted`; reused `action.undo`.

### Tests / verification
- `npx vitest run src/hooks src/components/editor` → **2974 passed, 0 failed**.
- `npx tsc -b` → no errors. No non-null assertions added.
- Device QA outstanding: real touchmove scroll-vs-long-press timing, the live 200px
  swipe firing the toast, and tapping Undo on a physical device.

Partial #927 — Findings 5 & 7. Remaining: f1/f3/f4/f6 (device-feature work). No `Closes`.
