/**
 * Shared hook for list keyboard navigation.
 *
 * Supports vertical (ArrowUp/ArrowDown) and horizontal (ArrowLeft/ArrowRight)
 * modes, wrapping vs clamping, Vim-style j/k, Home/End,
 * and Enter/Space item selection.
 */

import { useEffect, useState } from 'react'

export interface UseListKeyboardNavigationOptions {
  /** Number of items in the list */
  itemCount: number
  /** Use ArrowLeft/ArrowRight instead of ArrowUp/ArrowDown (default: false) */
  horizontal?: boolean
  /** Wrap around when reaching the ends (default: true) */
  wrap?: boolean
  /** Enable Vim-style j/k navigation (default: false, vertical mode only) */
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
  const {
    itemCount,
    horizontal = false,
    wrap = true,
    vim = false,
    homeEnd = false,
    onSelect,
  } = options

  const [focusedIndex, setFocusedIndex] = useState(0)

  // Reset focusedIndex to 0 when itemCount changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on itemCount change
  useEffect(() => {
    setFocusedIndex(0)
  }, [itemCount])

  function handleKeyDown(e: React.KeyboardEvent | KeyboardEvent): boolean {
    if (itemCount === 0) return false

    // Build prev/next key sets based on orientation
    const prevKeys: string[] = horizontal ? ['ArrowLeft'] : ['ArrowUp']
    const nextKeys: string[] = horizontal ? ['ArrowRight'] : ['ArrowDown']
    if (vim && !horizontal) {
      prevKeys.push('k')
      nextKeys.push('j')
    }

    // Previous (ArrowUp / ArrowLeft / k)
    if (prevKeys.includes(e.key)) {
      if (wrap) {
        setFocusedIndex((prev) => (prev <= 0 ? itemCount - 1 : prev - 1))
      } else {
        setFocusedIndex((prev) => Math.max(0, prev - 1))
      }
      return true
    }

    // Next (ArrowDown / ArrowRight / j)
    if (nextKeys.includes(e.key)) {
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
