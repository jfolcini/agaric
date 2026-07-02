/**
 * useVirtualizedGroupedRows — shared virtualized grouped-list scaffolding
 * (#2252, extracted from DuePanel / DonePanel / AgendaResults).
 *
 * Flattens grouped items into a single `VirtualGroupedRow[]` (a `group-header`
 * row before each group's `item` rows) so `useVirtualizer` can window headers
 * and items as siblings and drop offscreen groups in their entirety instead of
 * mounting every sub-list (perf-review Tier 2 #6, 2026-05-14).
 *
 * Each item row carries `flatItemIndex`, threading it back to the items-only
 * flat array used by keyboard navigation (`focusedIndex` indexes that array,
 * NOT the virtual rows — headers must not shift the count). The hook also owns
 * the reverse `flatToVirtualIndex` map and the scroll-focused-row-into-view
 * effect, so keyboard-focus-to-virtual-index fixes live in exactly one place.
 *
 * Header markup and item renderers stay in the panels: header rows carry the
 * original `group` object so each caller renders its own header from it.
 *
 * `groups: null` selects the headerless flat mode (AgendaResults with
 * `groupBy: 'none'`): `ungroupedItems` become plain item rows with
 * `flatItemIndex` = array index and no header rows.
 */

import { type Virtualizer, useVirtualizer } from '@tanstack/react-virtual'
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'

export type VirtualGroupedRow<TGroup, TItem> =
  | { kind: 'group-header'; key: string; group: TGroup }
  | { kind: 'item'; key: string; item: TItem; flatItemIndex: number }

export interface UseVirtualizedGroupedRowsOptions<TGroup, TItem> {
  /** Display groups, in render order. `null` = headerless flat mode. */
  groups: readonly TGroup[] | null
  /** Items rendered without headers when `groups` is `null`. */
  ungroupedItems?: readonly TItem[] | undefined
  /**
   * Stable identity for a group, used as the header row key
   * (`header:<key>`). Must be unique across groups (e.g. label, page id).
   */
  getGroupKey: (group: TGroup) => string
  /** Items of a group, in render order. */
  getGroupItems: (group: TGroup) => readonly TItem[]
  /** Estimated header-row height in px (corrected by `measureElement`). */
  headerHeight: number
  /** Estimated item-row height in px (corrected by `measureElement`). */
  itemHeight: number
  /**
   * Keyboard-nav focused index into the items-only flat array
   * (`groups.flatMap(getGroupItems)`). Negative = no focus. Indexes past the
   * grouped portion (e.g. DuePanel's projected-entry tail) are ignored.
   */
  focusedIndex: number
  /** Scroll container the virtualizer windows against. */
  scrollParentRef: RefObject<HTMLDivElement | null>
}

export interface UseVirtualizedGroupedRowsResult<TGroup, TItem> {
  virtualRows: VirtualGroupedRow<TGroup, TItem>[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** flat item index → virtual row index (sparse; headers have no entry). */
  flatToVirtualIndex: number[]
}

const EMPTY_ITEMS: readonly never[] = []

export function useVirtualizedGroupedRows<TGroup, TItem extends { id: string }>({
  groups,
  ungroupedItems = EMPTY_ITEMS,
  getGroupKey,
  getGroupItems,
  headerHeight,
  itemHeight,
  focusedIndex,
  scrollParentRef,
}: UseVirtualizedGroupedRowsOptions<TGroup, TItem>): UseVirtualizedGroupedRowsResult<
  TGroup,
  TItem
> {
  // Accessor identities are latched in refs (same pattern as DuePanel's
  // ProjectedEntryContent) so inline-arrow callers don't bust the
  // `virtualRows` memo: arrow-key roving focus re-renders the panel on every
  // keypress, and a fresh `virtualRows` array each render would recreate
  // `estimateSize` / thrash the virtualizer for nothing. Accessors must
  // therefore be PURE structural projections (e.g. `(g) => g.items`) — an
  // accessor whose OUTPUT changes without a `groups` identity change would
  // not recompute the rows.
  const getGroupKeyRef = useRef(getGroupKey)
  getGroupKeyRef.current = getGroupKey
  const getGroupItemsRef = useRef(getGroupItems)
  getGroupItemsRef.current = getGroupItems

  const virtualRows = useMemo<VirtualGroupedRow<TGroup, TItem>[]>(() => {
    if (!groups) {
      return ungroupedItems.map((item, idx) => ({
        kind: 'item' as const,
        key: item.id,
        item,
        flatItemIndex: idx,
      }))
    }
    const rows: VirtualGroupedRow<TGroup, TItem>[] = []
    let flatIdx = 0
    for (const group of groups) {
      rows.push({
        kind: 'group-header',
        key: `header:${getGroupKeyRef.current(group)}`,
        group,
      })
      for (const item of getGroupItemsRef.current(group)) {
        rows.push({
          kind: 'item',
          key: item.id,
          item,
          flatItemIndex: flatIdx++,
        })
      }
    }
    return rows
  }, [groups, ungroupedItems])

  // `measureElement` corrects to the actual row height after first paint;
  // the two constants only seed the initial layout estimate.
  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (row?.kind === 'group-header') return headerHeight
      return itemHeight
    },
    [virtualRows, headerHeight, itemHeight],
  )

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: virtualRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => virtualRows[index]?.key ?? index,
  })

  // Scroll the keyboard-focused item into view via the virtualizer.
  // `focusedIndex` indexes the items-only flat array; map it to the
  // virtual-row index so headers don't shift the count.
  const flatToVirtualIndex = useMemo(() => {
    const map: number[] = []
    virtualRows.forEach((row, idx) => {
      if (row.kind === 'item') map[row.flatItemIndex] = idx
    })
    return map
  }, [virtualRows])

  useEffect(() => {
    if (focusedIndex < 0) return
    const idx = flatToVirtualIndex[focusedIndex]
    if (idx == null) return
    virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [focusedIndex, virtualizer, flatToVirtualIndex])

  return { virtualRows, virtualizer, flatToVirtualIndex }
}
