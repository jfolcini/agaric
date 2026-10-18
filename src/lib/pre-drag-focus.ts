/**
 * pre-drag-focus — module-level capture of the block that was focused at the
 * instant a drag handle was pressed (#966).
 *
 * Why this exists
 * ---------------
 * A handle press (the gutter `GripVertical` button, not marked
 * `data-editor-portal`) blurs the editor before dnd-kit's 8px activation
 * distance fires `handleDragStart`. `useEditorBlur` keeps a mouse press's block
 * in edit mode until the press ends, so `handleDragStart` normally reads the
 * focus from the live editor. When the blur has already cleared it, #923's
 * restore-on-cancel falls back to this snapshot, taken in the handle's
 * `onPointerDown`, before the blur.
 *
 * A plain module-level ref (not the Zustand store) keeps the channel simple and
 * free of store-merge semantics: the blur's `setFocused(null)` can't clobber it,
 * and the value is single-shot (consumed exactly once per drag).
 */

let preDragFocusedBlockId: string | null = null

/**
 * Snapshot the block id to restore if the imminent drag is cancelled. Call from
 * the drag handle's `onPointerDown`, before the press blurs the editor. Pass
 * the currently-focused block id (read from the store/editor while it is still
 * live).
 */
export function capturePreDragFocus(blockId: string | null): void {
  preDragFocusedBlockId = blockId
}

/**
 * Read and clear the captured pre-drag focus. Single-shot: returns the captured
 * id once, then null until the next `capturePreDragFocus`. `handleDragStart`
 * falls back to it when the handle press's blur already cleared the focus.
 */
export function consumePreDragFocus(): string | null {
  const id = preDragFocusedBlockId
  preDragFocusedBlockId = null
  return id
}
