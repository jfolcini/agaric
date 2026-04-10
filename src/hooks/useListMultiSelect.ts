/**
 * useListMultiSelect — shared multi-select logic for flat list views.
 *
 * Provides selection management (single toggle, shift-range, select-all, clear)
 * with UX-140 shift-state-propagation: shift-click applies the *target* state
 * (add or remove) of the clicked item to the entire range.
 *
 * Used by TrashView, HistoryView, and ConflictList.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseListMultiSelectOptions<T> {
  items: T[]
  getItemId: (item: T) => string
  /** Skip non-selectable items (e.g. non-reversible ops in HistoryView). */
  filterPredicate?: (item: T) => boolean
}

export interface UseListMultiSelectReturn {
  selected: Set<string>
  toggleSelection: (id: string) => void
  rangeSelect: (id: string, targetState: boolean) => void
  selectAll: () => void
  clearSelection: () => void
  handleRowClick: (id: string, e: React.MouseEvent | React.KeyboardEvent) => void
  lastClickedId: string | null
}

export function useListMultiSelect<T>({
  items,
  getItemId,
  filterPredicate,
}: UseListMultiSelectOptions<T>): UseListMultiSelectReturn {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

  // Reset selection when items length changes (pagination, filter, item removal)
  const prevLengthRef = useRef(items.length)
  useEffect(() => {
    if (items.length !== prevLengthRef.current) {
      setSelected(new Set())
      setLastClickedId(null)
    }
    prevLengthRef.current = items.length
  }, [items.length])

  // Keep a ref to `selected` so handleRowClick can read current state without
  // adding `selected` to its dependency array (avoids re-creating on every change).
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const isSelectable = useCallback(
    (item: T): boolean => (filterPredicate ? filterPredicate(item) : true),
    [filterPredicate],
  )

  const toggleSelection = useCallback(
    (id: string) => {
      if (filterPredicate) {
        const item = items.find((it) => getItemId(it) === id)
        if (item && !filterPredicate(item)) return
      }
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setLastClickedId(id)
    },
    [items, getItemId, filterPredicate],
  )

  const rangeSelect = useCallback(
    (id: string, targetState: boolean) => {
      let fromIndex =
        lastClickedId != null ? items.findIndex((it) => getItemId(it) === lastClickedId) : 0
      if (fromIndex < 0) fromIndex = 0
      const toIndex = items.findIndex((it) => getItemId(it) === id)
      if (toIndex < 0) return

      const start = Math.min(fromIndex, toIndex)
      const end = Math.max(fromIndex, toIndex)

      setSelected((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          const item = items[i]
          if (!item) continue
          if (!isSelectable(item)) continue
          const itemId = getItemId(item)
          if (targetState) next.add(itemId)
          else next.delete(itemId)
        }
        return next
      })
      setLastClickedId(id)
    },
    [items, getItemId, isSelectable, lastClickedId],
  )

  const selectAll = useCallback(() => {
    const next = new Set<string>()
    for (const item of items) {
      if (!isSelectable(item)) continue
      next.add(getItemId(item))
    }
    setSelected(next)
  }, [items, getItemId, isSelectable])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
  }, [])

  const handleRowClick = useCallback(
    (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
      if (e.shiftKey) {
        // UX-140: propagate the clicked item's *target* state to the range.
        // If the item is currently selected the user wants to deselect → false.
        // If not selected → true.
        const isCurrentlySelected = selectedRef.current.has(id)
        rangeSelect(id, !isCurrentlySelected)
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelection(id)
      } else {
        toggleSelection(id)
      }
    },
    [rangeSelect, toggleSelection],
  )

  return {
    selected,
    toggleSelection,
    rangeSelect,
    selectAll,
    clearSelection,
    handleRowClick,
    lastClickedId,
  }
}
