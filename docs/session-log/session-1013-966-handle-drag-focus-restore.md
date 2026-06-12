# Session 1013 — #966: handle-drag Esc-cancel restores focus (#923 f1 fix)

**Bug:** drag-cancel (Esc) didn't restore focus for **handle-initiated** drags. The handle
`pointerdown` blurs the contenteditable → `useEditorBlur` unmounts the editor +
`setFocused(null)` BEFORE the 8px threshold fires `handleDragStart` (where #923 captured
`preDragFocusedIdRef`) — so the captured id was already null.

**Fix (option a — capture earlier):** snapshot the focused block at the handle's
`pointerdown`, before the blur.
- `src/lib/pre-drag-focus.ts` (new) — single-shot module-level channel
  `capturePreDragFocus`/`consumePreDragFocus` (a plain module ref, so `setFocused(null)`
  can't clobber it).
- `BlockGutterControls.tsx` — handle `onPointerDown` snapshots `focusedBlockId` then forwards
  to dnd-kit's own `onPointerDown` (wired on both desktop + touch handles, after
  `{...dragListeners}` so it wins the slot).
- `useBlockDnD.ts` — `handleDragStart` sets `preDragFocusedIdRef = liveFocus ?? capturedFocus`
  (keyboard drags keep live focus; the capture is always consumed so a non-drag handle press
  can't leak a stale id). Flush/`setFocused(null)` stays keyed on `liveFocus` only.

(Rejected option b — tagging the handle `data-editor-portal` — it would leave the editor
focused through the whole drag and regress normal blur-on-click-away.)

Tests: `useBlockDnD.test.ts` — handle-initiated cancel restores the captured id (and doesn't
re-clear); single-shot consumption guard. `BlockGutterControls.test.tsx` — handle pointerdown
forwards dnd-kit + snapshots focus. Verification: vitest 104 + 405 (broader) green; `tsc -b`
clean; desktop drag + normal blur unaffected.

Closes #966.
