/**
 * pre-drag-focus — module-level capture of the block that was focused at the
 * instant a drag handle was pressed (#966).
 *
 * Why this exists
 * ---------------
 * A handle-initiated drag (mouse pressing the gutter `GripVertical` button)
 * destroys editor focus BEFORE the drag actually starts:
 *
 *   1. `pointerdown` lands on the drag-handle `<button>` (which is NOT marked
 *      `data-editor-portal`), so the contenteditable blurs.
 *   2. `useEditorBlur` runs its full teardown — `rovingEditor.unmount()` (sets
 *      `activeBlockId` to null) + `setFocused(null)` (clears the store).
 *   3. ONLY THEN, once the pointer has moved past the 8px activation distance,
 *      does dnd-kit fire `handleDragStart`.
 *
 * By the time `handleDragStart` runs, both `rovingEditor.activeBlockId` and the
 * store's `focusedBlockId` are already null, so the #923 focus-restore-on-cancel
 * has nothing to restore — Esc/cancel leaves the user with no focused block.
 *
 * The fix (#966, option a): the drag handle's `onPointerDown` runs in step 1,
 * BEFORE the blur teardown, so it is the last moment the pre-drag focus is still
 * known. We snapshot it here; `handleDragStart` consumes it as a fallback when
 * the live focus has already been cleared.
 *
 * A plain module-level ref (not the Zustand store) keeps the channel simple and
 * free of store-merge semantics: the blur's `setFocused(null)` can't clobber it,
 * and the value is single-shot (consumed exactly once per drag).
 */

let preDragFocusedBlockId: string | null = null

/**
 * Snapshot the block id to restore if the imminent drag is cancelled. Call from
 * the drag handle's `onPointerDown`, BEFORE the contenteditable blur tears down
 * focus. Pass the currently-focused block id (read from the store/editor while
 * it is still live).
 */
export function capturePreDragFocus(blockId: string | null): void {
  preDragFocusedBlockId = blockId
}

/**
 * Read and clear the captured pre-drag focus. Single-shot: returns the captured
 * id once, then null until the next `capturePreDragFocus`. `handleDragStart`
 * calls this to recover the focus that the handle-press blur already destroyed.
 */
export function consumePreDragFocus(): string | null {
  const id = preDragFocusedBlockId
  preDragFocusedBlockId = null
  return id
}
