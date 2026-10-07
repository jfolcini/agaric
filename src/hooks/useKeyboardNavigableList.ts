/**
 * The keyboard primitive (`useListKeyboardNavigation`) plus the list-container
 * ref every keyboard-navigable agenda panel (DonePanel, DuePanel) attaches.
 * Scrolling belongs to the rows: `useRovingRowFocus` focuses the cursor row and
 * scrolls it into view.
 */

import { type Dispatch, type RefObject, type SetStateAction, useRef } from 'react'

import {
  type UseListKeyboardNavigationOptions,
  useListKeyboardNavigation,
} from '@/hooks/useListKeyboardNavigation'

export interface UseKeyboardNavigableListOptions {
  /** Enable Home/End keys (default: false). */
  homeEnd?: boolean
  /** Enable PageUp/PageDown keys (default: false). */
  pageUpDown?: boolean
  /** Number of items to jump with PageUp/PageDown (default: 10). */
  pageSize?: number
  /** Wrap around when reaching the ends (default: true). */
  wrap?: boolean
  /** Use ArrowLeft/ArrowRight instead of ArrowUp/ArrowDown (default: false). */
  horizontal?: boolean
  /**
   * A value that, when changed, resets `focusedIndex` to 0. Use a stable
   * scalar (e.g. a JSON-stringified filter signature) so the dependency
   * comparison is referentially correct. Forwarded to the primitive, so
   * supplying it also switches a plain `itemCount` change from a reset to a
   * clamp (see `useListKeyboardNavigation`).
   */
  resetKey?: unknown
}

export interface UseKeyboardNavigableListReturn<T extends HTMLElement = HTMLElement> {
  focusedIndex: number
  setFocusedIndex: Dispatch<SetStateAction<number>>
  /** Returns `true` when the key was consumed; caller should preventDefault. */
  handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
  /** Attach to the list container element. */
  listRef: RefObject<T | null>
}

export function useKeyboardNavigableList<T extends HTMLElement = HTMLElement>(
  itemCount: number,
  onSelect: (index: number) => void,
  options?: UseKeyboardNavigableListOptions,
): UseKeyboardNavigableListReturn<T> {
  const { homeEnd, pageUpDown, pageSize, wrap, horizontal, resetKey } = options ?? {}

  const listRef = useRef<T | null>(null)

  const navOptions: UseListKeyboardNavigationOptions = {
    itemCount,
    onSelect: (idx) => onSelect(idx),
    ...(homeEnd !== undefined && { homeEnd }),
    ...(pageUpDown !== undefined && { pageUpDown }),
    ...(pageSize !== undefined && { pageSize }),
    ...(wrap !== undefined && { wrap }),
    ...(horizontal !== undefined && { horizontal }),
    ...(resetKey !== undefined && { resetKey }),
  }

  const { focusedIndex, setFocusedIndex, handleKeyDown } = useListKeyboardNavigation(navOptions)

  return { focusedIndex, setFocusedIndex, handleKeyDown, listRef }
}
