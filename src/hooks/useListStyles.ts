/**
 * useListStyles — derives the per-block {@link ListStyle} map (#3000) from the
 * shared `BatchPropertiesProvider` (see `useBatchPropertyRows`).
 *
 * Like {@link useExtraBlockProperties}, this is a pure PROJECTION of the single
 * page-wide `getBatchProperties` batch the provider already fetches — it fires
 * no IPC of its own and MUST be called inside a `BatchPropertiesProvider`.
 * Outside one it returns an empty map. It inherits the provider's invalidation:
 * the map refreshes on every `block:properties-changed` event and on space
 * switch, so toggling a block's list style updates the markers.
 *
 * Only `bullet` / `ordered` blocks appear in the map; a `none` block (no
 * `listStyle` property row) is absent — consumers treat "absent" as `'none'`.
 *
 * Identity invariant: the returned map keeps its reference when the projected
 * styles are unchanged, so a no-op refetch (or a drag/reorder that does not
 * refetch) does not bust downstream `React.memo` short-circuits.
 */

import { useMemo, useRef } from 'react'

import { useBatchPropertyRows } from '@/hooks/useBatchPropertyRows'
import { listStyleFromRows } from '@/lib/list-style'
import type { ListStyle } from '@/lib/list-style'

/** True iff two id→style maps have identical entries. */
function mapsEqual(a: Map<string, ListStyle>, b: Map<string, ListStyle>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, style] of a) {
    if (b.get(id) !== style) return false
  }
  return true
}

export function useListStyles(blocks: ReadonlyArray<{ id: string }>): Map<string, ListStyle> {
  const batch = useBatchPropertyRows()
  const get = batch?.get

  const { idSignature, ids } = useMemo(() => {
    const blockIds = blocks.map((b) => b.id)
    return { idSignature: blockIds.join('\0'), ids: blockIds }
  }, [blocks])

  const prevRef = useRef<Map<string, ListStyle>>(new Map())

  return useMemo(() => {
    const next = new Map<string, ListStyle>()
    for (const id of ids) {
      const rows = get?.(id)
      if (rows == null) continue
      const style = listStyleFromRows(rows)
      if (style !== 'none') next.set(id, style)
    }
    const prev = prevRef.current
    const result = mapsEqual(prev, next) ? prev : next
    prevRef.current = result
    return result
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `ids` is recomputed in the same memo as `idSignature` (the listed dep), so it changes iff the signature changes; `get` re-derives when the shared batch refetches. Mirrors useExtraBlockProperties.
  }, [idSignature, get])
}
