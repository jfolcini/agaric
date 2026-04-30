/**
 * useHistorySelection — multi-selection logic for the history list.
 *
 * Wraps `useListMultiSelect` with HistoryEntry-specific keying
 * (`device_id:seq`) and exposes a `getSelectedEntries()` helper that
 * materialises the selected entries (sorted newest-first) for the
 * batch-revert IPC. Non-reversible ops (`purge_block`,
 * `delete_attachment`) are skipped via the filter predicate.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import type React from 'react'
import { useCallback } from 'react'
import type { HistoryEntry } from '../lib/tauri'
import { useListMultiSelect } from './useListMultiSelect'

/** Op types that cannot be reversed. */
export const NON_REVERSIBLE_OPS = new Set(['purge_block', 'delete_attachment'])

/** Unique key for a history entry. */
export function entryKey(entry: HistoryEntry): string {
  return `${entry.device_id}:${entry.seq}`
}

export interface UseHistorySelectionReturn {
  /** IDs of currently selected entries (`device_id:seq`). */
  selectedIds: Set<string>
  /** Toggle selection by row index (used by Space-key handler). */
  toggleSelectedIndex: (index: number) => void
  /** Select all reversible entries (Ctrl/Cmd+A). */
  selectAll: () => void
  /** Clear the selection. */
  clearSelection: () => void
  /** Click handler that handles shift+click range and ctrl+click toggle. */
  handleRowClick: (index: number, e: React.MouseEvent | React.KeyboardEvent) => void
  /** Currently-selected entries, sorted newest-first (for revert IPC). */
  getSelectedEntries: () => HistoryEntry[]
}

export function useHistorySelection(entries: HistoryEntry[]): UseHistorySelectionReturn {
  const {
    selected,
    toggleSelection,
    selectAll,
    clearSelection,
    handleRowClick: rawHandleRowClick,
  } = useListMultiSelect<HistoryEntry>({
    items: entries,
    getItemId: entryKey,
    filterPredicate: (entry) => !NON_REVERSIBLE_OPS.has(entry.op_type),
  })

  const toggleSelectedIndex = useCallback(
    (index: number) => {
      const entry = entries[index]
      if (entry) toggleSelection(entryKey(entry))
    },
    [entries, toggleSelection],
  )

  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent | React.KeyboardEvent) => {
      const entry = entries[index]
      if (entry) rawHandleRowClick(entryKey(entry), e)
    },
    [entries, rawHandleRowClick],
  )

  const getSelectedEntries = useCallback(
    (): HistoryEntry[] =>
      entries
        .filter((e) => selected.has(entryKey(e)))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [entries, selected],
  )

  return {
    selectedIds: selected,
    toggleSelectedIndex,
    selectAll,
    clearSelection,
    handleRowClick,
    getSelectedEntries,
  }
}
