# Session 1009 — Wave 2: touch/drag e2e coverage + #958 residual

Closes the remaining e2e-coverage findings across #923/#926/#927/#929 and resolves the
#958 residual. All 15 new DnD/touch tests pass serially; #958's 3 fixme'd cases are
un-fixme'd and green.

## New / expanded e2e
- **#923 f2** — visual drag-layer (`block-dnd-mouse.spec.ts`): in-flight overlay ghost +
  indent guides; drop indicator at projected depth (drag onto a different over-row, since
  the per-row indicator only paints on the *over* row, not the active row); Esc-abort leaves
  order unchanged with no `move_block`.
- **#929 f2** — touch / narrow-viewport DnD (`block-dnd-touch.spec.ts`, new): grip visible +
  non-zero box at 390px (regression guard for #729/#927 f1); touch drag reorders; long-press
  context-menu Move Down reorders.
- **#927 f2** — touch gestures (`touch-gestures.spec.ts`, new): long-press BlockContextMenu
  (Indent/Dedent/Move/Zoom), tap-bullet zoom, swipe-to-delete + Undo toast, more-actions sheet.
- **#926 f6** — split the e2e drag helper: desktop `dragBlock` (distance-activated, no
  artificial hold) vs `dragBlockTouch` (coarse-pointer + 250ms hold); added `touchLongPress`
  / `touchSwipe` (real `TouchEvent`s) and `openPageMobile` (mobile Sheet/palette nav, since
  the desktop sidebar is hidden below `md`). Existing `dragBlock`/`dragBlockWithOffset`
  callers unchanged.
- **#926 f3** — long-press → context-menu reorder covered by the touch specs above.

## #958 residual (all 3 un-fixme'd, green)
- **move-undo (real mock bug, fixed):** `tauri-mock` `move_block` recorded `old_position`
  from the raw stored value (some 0-based from the seed) instead of the 1-based dense rank,
  so undo re-inserted at the wrong slot. Now captures `old_position` as the 1-based dense
  rank among live siblings (`handlers.ts`). Production undo was always correct (full re-fetch).
- **dedent-undo (test flaw):** the scaffolding indent + the dedent fell in the same 500ms
  undo group, so one Ctrl+Z reverted both — added a wait so they're separate groups.
- **tag-chip nav (test flaw):** headless Chromium doesn't deliver a DOM `click` to the
  atomic NodeView via `.click()`; use `dispatchEvent('click')`. Wiring + mock were correct.

## Known follow-up
The #923 f1 "restore focus on drag-cancel" doesn't fire for **handle-initiated** drags: the
handle `mousedown` blurs the contenteditable (→ `setFocused(null)`) before `handleDragStart`
captures `preDragFocusedIdRef`, so there's nothing to restore on Esc. Filed as a follow-up.

## Verification
`block-dnd-mouse + block-dnd-touch + touch-gestures --workers=1` → 15/15 pass;
`undo-redo-blocks + inner-links` → 30/30 pass; `tsc -b` clean; mock unit tests green.
