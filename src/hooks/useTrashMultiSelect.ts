/**
 * useTrashMultiSelect — multi-select state for TrashView rows.
 *
 * Thin wrapper over useListMultiSelect that names the selection
 * outputs in TrashView terms. Mirrors useConflictSelection so the
 * orchestrator can compose hooks with consistent shapes. Extracted
 * from TrashView.tsx for MAINT-128.
 */

import type React from 'react'
import type { BlockRow } from '../lib/tauri'
import { useListMultiSelect } from './useListMultiSelect'

export interface UseTrashMultiSelectOptions {
  items: BlockRow[]
}

export interface UseTrashMultiSelectReturn {
  selected: Set<string>
  toggleSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  handleRowClick: (id: string, e: React.MouseEvent | React.KeyboardEvent) => void
}

export function useTrashMultiSelect({
  items,
}: UseTrashMultiSelectOptions): UseTrashMultiSelectReturn {
  const { selected, toggleSelection, selectAll, clearSelection, handleRowClick } =
    useListMultiSelect({
      items,
      getItemId: (b: BlockRow) => b.id,
    })
  return {
    selected,
    toggleSelection,
    selectAll,
    clearSelection,
    handleRowClick,
  }
}
