/**
 * useTrashListShortcuts — document-level keyboard handling for the
 * trash listbox.
 *
 * Combines (1) generic list navigation via the supplied
 * useListKeyboardNavigation handler (Arrow / Home / End / PageUp /
 * PageDown), (2) Space toggle, Ctrl/Cmd+A select-all, Escape clear,
 * and (3) UX-275 sub-fix 3 batch toolbar shortcuts (Shift+R restore,
 * Shift+Delete / Shift+Backspace purge). Extracted from TrashView for
 * MAINT-128.
 */

import { useEffect } from 'react'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import type { BlockRow } from '../lib/tauri'

export interface UseTrashListShortcutsOptions {
  filteredBlocks: BlockRow[]
  focusedIndex: number
  selectedSize: number
  navHandleKeyDown: (e: KeyboardEvent) => boolean
  toggleSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  requestBatchRestore: () => void
  requestBatchPurge: () => void
}

export function useTrashListShortcuts({
  filteredBlocks,
  focusedIndex,
  selectedSize,
  navHandleKeyDown,
  toggleSelection,
  selectAll,
  clearSelection,
  requestBatchRestore,
  requestBatchPurge,
}: UseTrashListShortcutsOptions): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return

      // Delegate to list keyboard navigation (ArrowUp/Down, Home/End, PageUp/Down)
      if (navHandleKeyDown(e)) {
        e.preventDefault()
        return
      }

      // Space — toggle focused item
      if (matchesShortcutBinding(e, 'listToggleSelection') && focusedIndex >= 0) {
        const block = filteredBlocks[focusedIndex]
        if (block) {
          e.preventDefault()
          toggleSelection(block.id)
        }
        return
      }

      // Ctrl/Cmd+A — select all visible
      if (matchesShortcutBinding(e, 'listSelectAll')) {
        e.preventDefault()
        selectAll()
        return
      }

      // Escape — clear selection
      if (matchesShortcutBinding(e, 'listClearSelection') && selectedSize > 0) {
        e.preventDefault()
        clearSelection()
        return
      }

      // UX-275 sub-fix 3: batch toolbar shortcuts. Delegated to a helper so
      // this effect stays under Biome's cognitive-complexity ceiling.
      tryBatchShortcut(e)
    }

    // UX-275 sub-fix 3: batch toolbar shortcuts. Mirrors the keyboard-hint
    // pattern surfaced by HistorySelectionToolbar — fires only while the
    // batch toolbar is mounted (selectedSize > 0). Shift+R restores the
    // selection (gated by the >5 confirm), Shift+Delete purges (always
    // gated). Plain R / Delete are intentionally unbound to avoid
    // hijacking single-key navigation.
    function tryBatchShortcut(e: KeyboardEvent) {
      if (selectedSize === 0) return
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'R' || e.key === 'r') {
        e.preventDefault()
        requestBatchRestore()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        requestBatchPurge()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    navHandleKeyDown,
    focusedIndex,
    filteredBlocks,
    toggleSelection,
    selectAll,
    selectedSize,
    clearSelection,
    requestBatchRestore,
    requestBatchPurge,
  ])
}
