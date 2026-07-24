/**
 * ListMarker (#3000) — the leading, same-line list marker for a block whose
 * `listStyle` is `bullet` or `ordered`.
 *
 * Rendered in the CONTENT column (never the gutter) at the start of the block's
 * text line: a `•` for bullets, a computed `N.` for ordered items (the number
 * is derived from sibling position, never stored). Presentational and
 * decorative — `aria-hidden` (the list semantics for assistive tech come from
 * the tree's aria set-size/position), non-editable, and unselectable so it
 * never lands in a text selection or the serialized content.
 *
 * The read-only path (`StaticBlock`) renders this directly; the focused block's
 * marker is drawn by the roving editor's decoration plugin using the same glyph
 * rules (a later slice), so the two stay visually identical across focus.
 */

import type React from 'react'

import { BULLET_GLYPH, listMarkerText } from '@/lib/list-marker-glyph'
import type { ListStyle } from '@/lib/list-style'

// Re-exported so existing importers (`@/components/editor/ListMarker`) and
// tests keep their import path; the definitions live in the pure glyph module.
export { BULLET_GLYPH, listMarkerText }

export function ListMarker({
  style,
  ordinal,
}: {
  style: ListStyle
  ordinal?: number | undefined
}): React.ReactElement | null {
  if (style === 'none') return null
  return (
    <span
      className="list-marker"
      aria-hidden="true"
      contentEditable={false}
      data-testid="list-marker"
    >
      {listMarkerText(style, ordinal)}
    </span>
  )
}
