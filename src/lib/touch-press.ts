/**
 * The touch press shared by the block row's long press
 * (`use-block-touch-long-press.ts`), its drag sensor and the block-reference
 * peek's long press (`useBlockRefPeek.ts`): one hold and one drift for all.
 */

/** Hold (ms) before a touch press is recognised; also the drag sensor's delay. */
export const LONG_PRESS_DELAY = 400
/**
 * Finger drift (px) that ends a pending press; also the drag sensor's tolerance.
 * The sensor and the block row's long press share both constants (`useBlockDnD`
 * imports them) and the same per-axis measure (`exceedsThreshold`), so no drift
 * can end one gesture while sparing the other.
 */
export const LONG_PRESS_MOVE_THRESHOLD = 5

/** dnd-kit's `hasExceededDistance`: either axis past the threshold. */
export function exceedsThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) > LONG_PRESS_MOVE_THRESHOLD || Math.abs(dy) > LONG_PRESS_MOVE_THRESHOLD
}

/** Whether a touch landed inside the mounted editor's contenteditable. */
export function isInsideEditableText(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('.ProseMirror, [contenteditable="true"]') !== null
  )
}
