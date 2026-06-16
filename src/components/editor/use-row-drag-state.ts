/**
 * useRowDragState — per-row narrow subscription to the drag store (#1267).
 *
 * Reads THIS row's derived drag snapshot from the `DragStateStore` published by
 * `BlockListRenderer`, via `useSyncExternalStore` keyed on `blockId`. A bare
 * pointer-move that doesn't change this row's snapshot does not re-render it, so
 * the `React.memo` on `SortableBlockWrapper` finally holds for the (N − 2) rows
 * that are neither the dragged nor the over-row.
 *
 * Fallback: when no provider is present (standalone unit renders), the caller's
 * DnD props are used instead, preserving the pre-#1267 prop contract.
 */

import { useCallback, useContext, useSyncExternalStore } from 'react'

import {
  type DragState,
  DragStateContext,
  deriveRowDragState,
  type RowDragState,
} from '@/components/editor/drag-state-store'

/**
 * @param blockId  the row's block id (subscription key)
 * @param fallback live drag state from props, used only when no store provider
 *                 is mounted (keeps SortableBlockWrapper's prop contract for
 *                 tests / standalone use).
 */
export function useRowDragState(blockId: string, fallback: DragState): RowDragState {
  const store = useContext(DragStateContext)

  const subscribe = useCallback(
    (onChange: () => void) => {
      // No store → nothing to subscribe to; the fallback path drives rendering.
      if (!store) return () => {}
      return store.subscribe(blockId, onChange)
    },
    [store, blockId],
  )

  const getSnapshot = useCallback((): RowDragState | null => {
    if (!store) return null
    return store.getRowSnapshot(blockId)
  }, [store, blockId])

  const subscribed = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // When a store is present, its snapshot is the source of truth. Otherwise
  // derive from the prop fallback (recomputed each render — fine, there is no
  // store to subscribe to and this path is the legacy/standalone case).
  return subscribed ?? deriveRowDragState(blockId, fallback)
}
