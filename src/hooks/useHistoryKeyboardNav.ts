/**
 * useHistoryKeyboardNav — document-level keyboard navigation for the
 * history list.
 *
 * Wraps `useListKeyboardNavigation` with vim-key handling, Home/End,
 * and PageUp/PageDown, then layers HistoryView-specific shortcuts on
 * top: Space toggles the focused row, Ctrl/Cmd+A selects all, Enter
 * confirms revert (when there is a selection), and Escape clears the
 * selection. Also installs the scroll-into-view effect that keeps the
 * focused row visible inside `listRef`.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import { type Dispatch, type SetStateAction, useEffect } from 'react'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { useListKeyboardNavigation } from './useListKeyboardNavigation'

export interface UseHistoryKeyboardNavOptions {
  /** Number of items in the list. */
  itemCount: number
  /** Container ref — used to scroll the focused item into view. */
  listRef: React.RefObject<HTMLDivElement | null>
  /** Whether the user has at least one entry selected (gates Enter). */
  hasSelection: boolean
  /** Toggle selection on the focused row (Space). */
  onToggleSelection: (index: number) => void
  /** Select all reversible entries (Ctrl/Cmd+A). */
  onSelectAll: () => void
  /** Open the revert-confirmation dialog (Enter, when hasSelection). */
  onConfirmRevert: () => void
  /** Clear the selection (Escape). */
  onClearSelection: () => void
}

export interface UseHistoryKeyboardNavReturn {
  focusedIndex: number
  setFocusedIndex: Dispatch<SetStateAction<number>>
}

export function useHistoryKeyboardNav({
  itemCount,
  listRef,
  hasSelection,
  onToggleSelection,
  onSelectAll,
  onConfirmRevert,
  onClearSelection,
}: UseHistoryKeyboardNavOptions): UseHistoryKeyboardNavReturn {
  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount,
    wrap: false,
    vim: true,
    homeEnd: true,
    pageUpDown: true,
  })

  // Document-level shortcut handler. Mirrors the original effect body
  // verbatim so existing tests pass byte-equivalently.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return

      // Delegate arrow / j / k / Home / End / PageUp / PageDown.
      if (navHandleKeyDown(e)) {
        e.preventDefault()
        return
      }

      // Space — toggle checkbox on focused item.
      if (matchesShortcutBinding(e, 'listToggleSelection') && focusedIndex >= 0) {
        e.preventDefault()
        onToggleSelection(focusedIndex)
        return
      }

      // Ctrl/Cmd+A — select all.
      if (matchesShortcutBinding(e, 'listSelectAll')) {
        e.preventDefault()
        onSelectAll()
        return
      }

      // Enter — confirm revert (only when at least one row is selected).
      if (e.key === 'Enter' && hasSelection) {
        e.preventDefault()
        onConfirmRevert()
        return
      }

      // Escape — clear selection.
      if (matchesShortcutBinding(e, 'listClearSelection')) {
        e.preventDefault()
        onClearSelection()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    navHandleKeyDown,
    focusedIndex,
    hasSelection,
    onToggleSelection,
    onSelectAll,
    onConfirmRevert,
    onClearSelection,
  ])

  // Scroll the focused row into view whenever it moves.
  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-history-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex, listRef])

  return { focusedIndex, setFocusedIndex }
}
