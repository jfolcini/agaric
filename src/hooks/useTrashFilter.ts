/**
 * useTrashFilter — UX-221 / UX-248 search-filter state for TrashView.
 *
 * Owns the filter input value, its 300ms debounced echo, the
 * Unicode-aware filteredBlocks memo, and the clearFilter helper.
 * Extracted from TrashView.tsx (MAINT-128) so the orchestrator stays
 * focused on data fetching and dialog wiring.
 */

import { useCallback, useMemo, useState } from 'react'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import type { BlockRow } from '../lib/tauri'
import { useDebouncedCallback } from './useDebouncedCallback'

export interface UseTrashFilterOptions {
  blocks: BlockRow[]
}

export interface UseTrashFilterReturn {
  filterText: string
  setFilterText: (value: string) => void
  debouncedFilter: string
  filteredBlocks: BlockRow[]
  clearFilter: () => void
}

export function useTrashFilter({ blocks }: UseTrashFilterOptions): UseTrashFilterReturn {
  const [filterText, setFilterTextState] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedFilter(value)
  }, 300)

  // Wrapping the raw value setter + debounce.schedule into a single
  // callback keeps the orchestrator's onChange handler a one-liner.
  const setFilterText = useCallback(
    (value: string) => {
      setFilterTextState(value)
      debounced.schedule(value)
    },
    [debounced],
  )

  const filteredBlocks = useMemo(() => {
    if (!debouncedFilter) return blocks
    // UX-248 — Unicode-aware fold (Turkish / German / accented).
    return blocks.filter((b) => matchesSearchFolded(b.content ?? '', debouncedFilter))
  }, [blocks, debouncedFilter])

  const clearFilter = useCallback(() => {
    setFilterTextState('')
    setDebouncedFilter('')
    debounced.cancel()
  }, [debounced])

  return {
    filterText,
    setFilterText,
    debouncedFilter,
    filteredBlocks,
    clearFilter,
  }
}
