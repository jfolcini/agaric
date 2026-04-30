/**
 * useConflictSelection — multi-select state for ConflictList rows.
 *
 * Thin wrapper over useListMultiSelect that names selection-related
 * outputs in ConflictList terms (`selectedIds`, `toggleSelected`,
 * `selectRange`). Extracted from ConflictList.tsx for MAINT-128.
 */

import type { BlockRow } from '../lib/tauri'
import { useListMultiSelect } from './useListMultiSelect'

export interface UseConflictSelectionOptions {
  blocks: BlockRow[]
}

export interface UseConflictSelectionReturn {
  selectedIds: Set<string>
  toggleSelected: (id: string) => void
  selectRange: (id: string, targetState: boolean) => void
  selectAll: () => void
  clearSelection: () => void
}

export function useConflictSelection({
  blocks,
}: UseConflictSelectionOptions): UseConflictSelectionReturn {
  const { selected, toggleSelection, rangeSelect, selectAll, clearSelection } = useListMultiSelect({
    items: blocks,
    getItemId: (b: BlockRow) => b.id,
  })

  return {
    selectedIds: selected,
    toggleSelected: toggleSelection,
    selectRange: rangeSelect,
    selectAll,
    clearSelection,
  }
}
