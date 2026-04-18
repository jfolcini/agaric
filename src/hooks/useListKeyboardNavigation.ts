/**
 * Shared hook for list keyboard navigation.
 *
 * Supports vertical (ArrowUp/ArrowDown) and horizontal (ArrowLeft/ArrowRight)
 * modes, wrapping vs clamping, Vim-style j/k, Home/End,
 * and Enter/Space item selection.
 *
 * Implementation note: the per-key behaviour is expressed as a module-level
 * `KEY_RULES` table (same pattern as `src/editor/use-block-keyboard.ts`) so the
 * hook closure stays small and the per-key logic is straightforward to audit
 * and extend. Option defaults are resolved by the pure `resolveNavOptions`
 * helper, which makes the rules testable in isolation.
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

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
  /** Enable PageUp/PageDown keys (default: false) */
  pageUpDown?: boolean
  /** Number of items to jump with PageUp/PageDown (default: 10) */
  pageSize?: number
  /** Called when an item is selected (Enter or Space) */
  onSelect?: (index: number) => void
}

export interface UseListKeyboardNavigationReturn {
  /** Currently focused item index */
  focusedIndex: number
  /** Set the focused index directly */
  setFocusedIndex: Dispatch<SetStateAction<number>>
  /** Keyboard event handler — attach to the container element's onKeyDown.
   *  Returns true if the key was handled (caller should preventDefault). */
  handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
}

/**
 * Fully-resolved options with all defaults applied. Produced by
 * {@link resolveNavOptions} so `KEY_RULES` can read primitives directly.
 */
export interface ResolvedNavOptions {
  itemCount: number
  horizontal: boolean
  wrap: boolean
  vim: boolean
  homeEnd: boolean
  pageUpDown: boolean
  pageSize: number
  onSelect: ((index: number) => void) | undefined
}

/**
 * Resolve option defaults. Pure — no React, no closures over state.
 */
export function resolveNavOptions(options: UseListKeyboardNavigationOptions): ResolvedNavOptions {
  return {
    itemCount: options.itemCount,
    horizontal: options.horizontal ?? false,
    wrap: options.wrap ?? true,
    vim: options.vim ?? false,
    homeEnd: options.homeEnd ?? false,
    pageUpDown: options.pageUpDown ?? false,
    pageSize: options.pageSize ?? 10,
    onSelect: options.onSelect,
  }
}

// ---------------------------------------------------------------------------
// Dispatch infrastructure
// ---------------------------------------------------------------------------

type KeyLike = { key: string; preventDefault: () => void }

interface KeyRule {
  matches: (e: KeyLike, opts: ResolvedNavOptions) => boolean
  apply: (
    setIndex: Dispatch<SetStateAction<number>>,
    opts: ResolvedNavOptions,
    focusedIndex: number,
  ) => void
  /** If true, call `e.preventDefault()` before applying. Only set for PageUp/PageDown today. */
  preventDefault?: boolean
}

function isPrevKey(key: string, o: ResolvedNavOptions): boolean {
  if (o.horizontal) return key === 'ArrowLeft'
  if (key === 'ArrowUp') return true
  return o.vim && key === 'k'
}

function isNextKey(key: string, o: ResolvedNavOptions): boolean {
  if (o.horizontal) return key === 'ArrowRight'
  if (key === 'ArrowDown') return true
  return o.vim && key === 'j'
}

function stepPrev(prev: number, o: ResolvedNavOptions): number {
  if (o.wrap) return prev <= 0 ? o.itemCount - 1 : prev - 1
  return Math.max(0, prev - 1)
}

function stepNext(prev: number, o: ResolvedNavOptions): number {
  if (o.wrap) return prev >= o.itemCount - 1 ? 0 : prev + 1
  return Math.min(o.itemCount - 1, prev + 1)
}

/**
 * Ordered rule table. First match wins.
 *
 * Only PageUp / PageDown have `preventDefault: true` — this matches the
 * pre-refactor behaviour where the hook called `e.preventDefault()` for
 * those two keys only. All other handled keys rely on the caller to decide
 * whether to preventDefault (based on `handleKeyDown`'s return value).
 */
const KEY_RULES: readonly KeyRule[] = [
  // Previous: ArrowUp / ArrowLeft (horizontal) / k (vim, non-horizontal)
  {
    matches: (e, o) => isPrevKey(e.key, o),
    apply: (setIndex, o) => setIndex((prev) => stepPrev(prev, o)),
  },
  // Next: ArrowDown / ArrowRight (horizontal) / j (vim, non-horizontal)
  {
    matches: (e, o) => isNextKey(e.key, o),
    apply: (setIndex, o) => setIndex((prev) => stepNext(prev, o)),
  },
  // Home → first item
  {
    matches: (e, o) => o.homeEnd && e.key === 'Home',
    apply: (setIndex) => setIndex(0),
  },
  // End → last item
  {
    matches: (e, o) => o.homeEnd && e.key === 'End',
    apply: (setIndex, o) => setIndex(o.itemCount - 1),
  },
  // PageUp → jump back by pageSize (clamped, never wraps)
  {
    matches: (e, o) => o.pageUpDown && e.key === 'PageUp',
    apply: (setIndex, o) => setIndex((prev) => Math.max(0, prev - o.pageSize)),
    preventDefault: true,
  },
  // PageDown → jump forward by pageSize (clamped, never wraps)
  {
    matches: (e, o) => o.pageUpDown && e.key === 'PageDown',
    apply: (setIndex, o) => setIndex((prev) => Math.min(o.itemCount - 1, prev + o.pageSize)),
    preventDefault: true,
  },
  // Enter or Space → select (only when onSelect is provided)
  {
    matches: (e, o) => (e.key === 'Enter' || e.key === ' ') && o.onSelect !== undefined,
    apply: (_setIndex, o, focusedIndex) => o.onSelect?.(focusedIndex),
  },
]

export function useListKeyboardNavigation(
  options: UseListKeyboardNavigationOptions,
): UseListKeyboardNavigationReturn {
  const opts = resolveNavOptions(options)
  const { itemCount } = opts
  const [focusedIndex, setFocusedIndex] = useState(0)

  // Reset focusedIndex to 0 when itemCount changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on itemCount change
  useEffect(() => {
    setFocusedIndex(0)
  }, [itemCount])

  function handleKeyDown(e: React.KeyboardEvent | KeyboardEvent): boolean {
    if (itemCount === 0) return false
    for (const rule of KEY_RULES) {
      if (!rule.matches(e, opts)) continue
      if (rule.preventDefault) e.preventDefault()
      rule.apply(setFocusedIndex, opts, focusedIndex)
      return true
    }
    return false
  }

  return { focusedIndex, setFocusedIndex, handleKeyDown }
}
