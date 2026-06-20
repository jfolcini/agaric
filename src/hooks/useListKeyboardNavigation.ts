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

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'

export interface UseListKeyboardNavigationOptions {
  /** Number of items in the list */
  itemCount: number
  /**
   * Optional value that identifies the *logical list*. When it changes the
   * hook resets `focusedIndex` to 0 (e.g. a new search query). When it is
   * supplied, a plain `itemCount` change (collapsing a group, Load-More)
   * no longer resets to 0 — `focusedIndex` is CLAMPED into the new
   * `[0, itemCount - 1]` range so the focus ring stays put.
   *
   * When omitted, the hook keeps its historical behaviour: any `itemCount`
   * change resets `focusedIndex` to 0. Callers that filter a single list in
   * place (e.g. `CodeLanguageSelector`, `HistoryView`) rely on that and
   * therefore do NOT pass a `resetKey`.
   */
  resetKey?: unknown
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

interface KeyLike {
  key: string
  preventDefault: () => void
}

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
  const { resetKey } = options
  const hasResetKey = resetKey !== undefined
  const [focusedIndex, setFocusedIndex] = useState(0)

  // FE-A8: distinguish a *new list* (query change) from a list that merely
  // grew/shrank in place (group collapse, Load-More).
  //
  //  - When a `resetKey` is supplied, a change to it is the query-change
  //    signal: reset `focusedIndex` to 0. A plain `itemCount` change then
  //    only CLAMPS the index into the new range so collapsing a group or
  //    paging in more rows keeps the focus ring where the user left it.
  //  - When no `resetKey` is supplied, preserve the historical contract:
  //    any `itemCount` change resets to 0 (in-place filter lists rely on
  //    this — see `resetKey` doc).

  // Reset to 0 on query (resetKey) change. Skips the initial mount via a ref
  // so we don't fight the `useState(0)` initialiser.
  const firstResetKeyRun = useRef(true)
  useEffect(() => {
    if (!hasResetKey) return
    if (firstResetKeyRun.current) {
      firstResetKeyRun.current = false
      return
    }
    setFocusedIndex(0)
    // `hasResetKey` is a pure derivation of `resetKey` (`resetKey !== undefined`),
    // so it only changes when `resetKey` itself changes — listing it adds the
    // dependency the linter wants without introducing any extra effect runs.
  }, [resetKey, hasResetKey])

  // itemCount change: clamp when keyed (resetKey present), else reset to 0.
  // `hasResetKey` only selects the branch; it must NOT be a reactive dependency
  // here — a bare toggle of whether a resetKey is present (with itemCount
  // unchanged) must not re-run this clamp/reset. The resetKey's own effect above
  // already handles query changes. We read the current value through a ref so
  // the effect stays keyed to `itemCount` alone while always seeing fresh props.
  const hasResetKeyRef = useRef(hasResetKey)
  hasResetKeyRef.current = hasResetKey
  useEffect(() => {
    if (hasResetKeyRef.current) {
      // Clamp into [0, itemCount - 1]; an empty list parks focus at 0.
      setFocusedIndex((prev) => (itemCount === 0 ? 0 : Math.min(prev, itemCount - 1)))
    } else {
      setFocusedIndex(0)
    }
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
