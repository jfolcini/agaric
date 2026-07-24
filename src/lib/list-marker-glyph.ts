/**
 * Pure list-marker glyph rules (#3000), shared by the read-only `ListMarker`
 * React component and the roving editor's `ListMarkerDecoration` plugin so the
 * focused and unfocused marker are byte-identical. Kept dependency-free (no
 * React, no IPC bindings) so the editor extension can import it without pulling
 * the property/bindings graph into the editor bundle.
 */

import type { ListStyle } from '@/lib/list-style'

/** The bullet glyph (canonical `•`). */
export const BULLET_GLYPH = '•'

/**
 * The visible marker text for a block: `•` for a bullet, the computed `N.` for
 * an ordered item (defaulting to `1.` if the ordinal is missing), or `''` for
 * a plain block.
 */
export function listMarkerText(style: ListStyle, ordinal: number | undefined): string {
  if (style === 'ordered') return `${ordinal ?? 1}.`
  if (style === 'bullet') return BULLET_GLYPH
  return ''
}
