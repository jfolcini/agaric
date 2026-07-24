/**
 * ListMarkerContext (#3000) — supplies each block's list marker (style +
 * computed ordinal) to the render layer without prop-drilling.
 *
 * `BlockListRenderer` computes the whole page's `listStyle` map (projected from
 * the shared property batch via `useListStyles`) and the ordered-number map
 * (`computeListOrdinals`) once, and exposes them here. `StaticBlock` (and the
 * roving editor's marker decoration) read their own block's marker by id.
 *
 * Ordinals depend on the full sibling list, so a single block cannot derive its
 * own number — hence a context keyed by id rather than a per-block prop.
 * Outside a provider (isolated unit renders) `useListMarker` reports `'none'`,
 * matching a plain block.
 */

import { createContext, useContext, useMemo } from 'react'
import type React from 'react'

import type { ListStyle } from '@/lib/list-style'

export interface ListMarkerValue {
  /** The block's list style (`'none'` when it has no `listStyle` property). */
  styleOf: (blockId: string) => ListStyle
  /** The block's 1-based ordinal when `ordered`, else `undefined`. */
  ordinalOf: (blockId: string) => number | undefined
}

const ListMarkerContext = createContext<ListMarkerValue | null>(null)

export function ListMarkerProvider({
  value,
  children,
}: {
  value: ListMarkerValue
  children: React.ReactNode
}): React.ReactElement {
  return <ListMarkerContext.Provider value={value}>{children}</ListMarkerContext.Provider>
}

/** The resolved marker for a single block. */
export interface BlockListMarker {
  style: ListStyle
  ordinal: number | undefined
}

/**
 * Read a block's list marker (style + ordinal). Returns `{ style: 'none' }`
 * outside a {@link ListMarkerProvider}.
 */
export function useListMarker(blockId: string): BlockListMarker {
  const ctx = useContext(ListMarkerContext)
  return useMemo(() => {
    if (!ctx) return { style: 'none', ordinal: undefined }
    return { style: ctx.styleOf(blockId), ordinal: ctx.ordinalOf(blockId) }
  }, [ctx, blockId])
}
