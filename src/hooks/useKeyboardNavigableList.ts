/**
 * Composite hook that wraps `useListKeyboardNavigation` with the
 * scroll-into-view + reset-on-filter-change patterns used by every
 * keyboard-navigable list panel in the app (DonePanel, DuePanel).
 *
 * Why a separate hook? The keyboard primitive only manages
 * `focusedIndex` + a key-event handler. Every consumer additionally
 * needs:
 *
 *   1. A list-container ref so the focus check can determine whether
 *      the user is actively keyboard-navigating.
 *   2. A `useEffect` that scrolls the focused item into view when
 *      focus is inside the list (avoids hijacking scroll position
 *      when focus is elsewhere).
 *   3. A `useEffect` that resets `focusedIndex` to 0 when an external
 *      "view signature" changes (e.g. the filter selection or the
 *      target date the panel is rendering).
 *
 * Item lookup uses a CSS selector (default `[data-block-list-item]`)
 * scoped under `listRef`. This matches the existing DOM-attribute
 * convention used by the agenda panels and avoids forcing every
 * caller to thread per-item refs.
 *
 * Honours `prefers-reduced-motion`: when the caller opts into smooth
 * scrolling via `scrollBehavior: 'smooth'`, the hook downgrades to
 * `'auto'` if the OS reports a reduced-motion preference.
 */

import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react'
import {
  type UseListKeyboardNavigationOptions,
  useListKeyboardNavigation,
} from './useListKeyboardNavigation'

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
   * comparison is referentially correct.
   */
  resetKey?: unknown
  /**
   * CSS selector used to locate items inside `listRef` for the
   * scroll-into-view effect. Default: `[data-block-list-item]`.
   */
  itemSelector?: string
  /**
   * Scroll behavior passed to `Element.scrollIntoView`. When set to
   * `'smooth'`, the hook downgrades to `'auto'` under
   * `prefers-reduced-motion: reduce`. Default: undefined (browser
   * default).
   */
  scrollBehavior?: ScrollBehavior
}

export interface UseKeyboardNavigableListReturn<T extends HTMLElement = HTMLElement> {
  focusedIndex: number
  setFocusedIndex: Dispatch<SetStateAction<number>>
  /** Returns `true` when the key was consumed; caller should preventDefault. */
  handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
  /** Attach to the list container element. */
  listRef: RefObject<T | null>
}

const DEFAULT_ITEM_SELECTOR = '[data-block-list-item]'

export function useKeyboardNavigableList<T extends HTMLElement = HTMLElement>(
  itemCount: number,
  onSelect: (index: number) => void,
  options?: UseKeyboardNavigableListOptions,
): UseKeyboardNavigableListReturn<T> {
  const {
    homeEnd,
    pageUpDown,
    pageSize,
    wrap,
    horizontal,
    resetKey,
    itemSelector = DEFAULT_ITEM_SELECTOR,
    scrollBehavior,
  } = options ?? {}

  const listRef = useRef<T | null>(null)

  const navOptions: UseListKeyboardNavigationOptions = {
    itemCount,
    onSelect: (idx) => onSelect(idx),
    ...(homeEnd !== undefined && { homeEnd }),
    ...(pageUpDown !== undefined && { pageUpDown }),
    ...(pageSize !== undefined && { pageSize }),
    ...(wrap !== undefined && { wrap }),
    ...(horizontal !== undefined && { horizontal }),
  }

  const { focusedIndex, setFocusedIndex, handleKeyDown } = useListKeyboardNavigation(navOptions)

  // Reset focusedIndex to 0 whenever the caller-provided resetKey changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on resetKey change
  useEffect(() => {
    setFocusedIndex(0)
  }, [resetKey])

  // Scroll the focused item into view, but only when focus is actually inside
  // the list — avoids hijacking the page's scroll position when the user
  // isn't actively keyboard-navigating (e.g. on initial mount or when a
  // filter change resets focusedIndex while focus is elsewhere).
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (!list.contains(document.activeElement)) return
    const items = list.querySelectorAll<HTMLElement>(itemSelector)
    const el = items[focusedIndex]
    if (!el?.scrollIntoView) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const behavior: ScrollBehavior | undefined =
      scrollBehavior === 'smooth' && reduced ? 'auto' : scrollBehavior

    el.scrollIntoView(behavior ? { block: 'nearest', behavior } : { block: 'nearest' })
  }, [focusedIndex, itemSelector, scrollBehavior])

  return { focusedIndex, setFocusedIndex, handleKeyDown, listRef }
}
