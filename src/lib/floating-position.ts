/**
 * Apply Floating-UI computed coordinates to a popup, with a safe
 * off-screen fallback when no coordinates are available (e.g.
 * `computePosition()` rejected).
 *
 * Pass `{ x, y }` on success → popup is positioned at `(x, y)`.
 * Pass `null` on failure → popup is moved off-screen to
 * `(-9999px, -9999px)` so it cannot float orphaned mid-page after
 * the anchor scrolls or moves.
 *
 * Shared helper consolidates the
 * `BlockPropertyEditor` (kept popup at last position on failure)
 * and `suggestion-renderer` (off-screen fallback) call sites.
 */
export function applySafePosition(
  element: HTMLElement,
  position: { x: number; y: number } | null,
): void {
  if (position === null) {
    element.style.left = '-9999px'
    element.style.top = '-9999px'
    return
  }
  element.style.left = `${position.x}px`
  element.style.top = `${position.y}px`
}
