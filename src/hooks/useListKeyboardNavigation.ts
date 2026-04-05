/**
 * Shared hook for ArrowUp/ArrowDown list keyboard navigation.
 *
 * Supports wrapping vs clamping, Vim-style j/k, Home/End,
 * and Enter/Space item selection.
 */

import { useEffect, useState } from 'react'

export interface UseListKeyboardNavigationOptions {
  /** Number of items in the list */
  itemCount: number
  /** Wrap around when reaching the ends (default: true) */
  wrap?: boolean
  /** Enable Vim-style j/k navigation (default: false) */
  vim?: boolean
  /** Enable Home/End keys (default: false) */
  homeEnd?: boolean
  /** Called when an item is selected (Enter or Space) */
  onSelect?: (index: number) => void
}

export interface UseListKeyboardNavigationReturn {
  /** Currently focused item index */
  focusedIndex: number
  /** Set the focused index directly */
  setFocusedIndex: React.Dispatch<React.SetStateAction<number>>
  /** Keyboard event handler — attach to the container element's onKeyDown.
   *  Returns true if the key was handled (caller should preventDefault). */
  handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
}

export function useListKeyboardNavigation(
  options: UseListKeyboardNavigationOptions,
): UseListKeyboardNavigationReturn {
  const { itemCount, wrap = true, vim = false, homeEnd = false, onSelect } = options

  const [focusedIndex, setFocusedIndex] = useState(0)

  // Reset focusedIndex to 0 when itemCount changes
  useEffect(() => {
    setFocusedIndex(0)
  }, [itemCount])

  function handleKeyDown(e: React.KeyboardEvent | KeyboardEvent): boolean {
    if (itemCount === 0) return false

    // ArrowUp or k (if vim)
    if (e.key === 'ArrowUp' || (vim && e.key === 'k')) {
      if (wrap) {
        setFocusedIndex((prev) => (prev <= 0 ? itemCount - 1 : prev - 1))
      } else {
        setFocusedIndex((prev) => Math.max(0, prev - 1))
      }
      return true
    }

    // ArrowDown or j (if vim)
    if (e.key === 'ArrowDown' || (vim && e.key === 'j')) {
      if (wrap) {
        setFocusedIndex((prev) => (prev >= itemCount - 1 ? 0 : prev + 1))
      } else {
        setFocusedIndex((prev) => Math.min(itemCount - 1, prev + 1))
      }
      return true
    }

    // Home
    if (homeEnd && e.key === 'Home') {
      setFocusedIndex(0)
      return true
    }

    // End
    if (homeEnd && e.key === 'End') {
      setFocusedIndex(itemCount - 1)
      return true
    }

    // Enter or Space — call onSelect
    if ((e.key === 'Enter' || e.key === ' ') && onSelect) {
      onSelect(focusedIndex)
      return true
    }

    return false
  }

  return { focusedIndex, setFocusedIndex, handleKeyDown }
}
