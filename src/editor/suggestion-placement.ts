/**
 * Where a typing-triggered picker sits. Pure, in viewport coordinates.
 *
 * The anchor is the trigger (`[[`, `/`, `#`…) through the caret, so the popup
 * keeps its left edge while the query grows and never covers the typed line.
 * The side is chosen once, at open; afterwards only the anchor moves it.
 */

export type SuggestionSide = 'below' | 'above'

export interface SuggestionAnchor {
  /** The trigger's left edge. */
  left: number
  /** Top of the highest line the trigger and query span. */
  top: number
  /** Bottom of the lowest line they span. */
  bottom: number
}

export interface SuggestionPlacementInput {
  anchor: SuggestionAnchor
  side: SuggestionSide
  /** The usable viewport (above an on-screen keyboard). */
  viewport: { width: number; height: number }
  popupWidth: number
  /** Space between the line and the popup. */
  gap: number
  /** Space kept free at the viewport's edges. */
  padding: number
}

export interface SuggestionPlacement {
  left: number
  /** The anchored edge: the popup's top when below, its bottom when above. */
  edge: number
  maxHeight: number
}

/** Below when the popup fits there or below has the more room; otherwise above. */
export function chooseSuggestionSide(
  anchor: SuggestionAnchor,
  viewportHeight: number,
  wantedHeight: number,
  gap: number,
  padding: number,
): SuggestionSide {
  const below = viewportHeight - anchor.bottom - gap - padding
  const above = anchor.top - gap - padding
  return below >= wantedHeight || below >= above ? 'below' : 'above'
}

export function placeSuggestionPopup({
  anchor,
  side,
  viewport,
  popupWidth,
  gap,
  padding,
}: SuggestionPlacementInput): SuggestionPlacement {
  const rightmost = viewport.width - popupWidth - padding
  const left = Math.max(padding, Math.min(anchor.left, rightmost))
  if (side === 'below') {
    const edge = anchor.bottom + gap
    return { left, edge, maxHeight: Math.max(0, viewport.height - padding - edge) }
  }
  const edge = anchor.top - gap
  return { left, edge, maxHeight: Math.max(0, edge - padding) }
}
