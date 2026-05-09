/**
 * usePopoverEntity — generic search-popover state machine.
 *
 * PEND-30 D-3 — collapses the page-popover and tag-popover state
 * (4 useStates each in the original `SearchPanel.tsx`) into a single
 * factory hook. The two popovers differed only in:
 *  - IPC source: `listBlocks` (page) vs `listTagsByPrefix` (tag).
 *  - Client-side post-filter: the page picker folds with
 *    `matchesSearchFolded` for Turkish/German/etc. parity (UX-248);
 *    the tag picker relies on server-side prefix matching.
 *
 * Both wrinkles are factored into the `searchFn(query): Promise<T[]>`
 * callback the caller provides — the hook stays generic.
 *
 * The hook is intentionally local to `SearchPanel`: arrow-key list
 * navigation and roving-tabindex focus already live inside the shared
 * `SearchablePopover` view-component, so this file owns only
 * `open` / `query` / `suggestions` / `loading`. Re-using it elsewhere
 * is fine but requires no `src/hooks/` promotion.
 */

import { useEffect, useState } from 'react'
import { logger } from '../../lib/logger'

export interface PopoverEntityState<T> {
  /** Whether the popover is open. Wired into `SearchablePopover.open`. */
  open: boolean
  /** Setter for `open`; pass directly to `onOpenChange`. */
  setOpen: (open: boolean) => void
  /** Current search-input value inside the popover. */
  query: string
  /** Setter for `query`; pass directly to `onSearchChange`. */
  setQuery: (query: string) => void
  /** Suggestions returned by the most recent `searchFn` invocation. */
  suggestions: T[]
  /**
   * `true` while a `searchFn` invocation is in flight. Cleared on
   * settle (success or error).
   */
  loading: boolean
  /**
   * Reset the popover to its closed/empty state. Call after the user
   * picks an item so the next open starts with a fresh slate.
   */
  reset: () => void
}

export interface UsePopoverEntityOptions<T> {
  /**
   * Called whenever the popover is open and either the query or one of
   * `extraDeps` changes. Must return a `Promise` resolving to the list
   * to display. Errors are caught and logged via `logger.warn`; the
   * suggestion list is reset to `[]` on failure (mirroring the
   * original SearchPanel behaviour).
   */
  searchFn: (query: string) => Promise<T[]>
  /**
   * Tag identifying the source in `logger.warn` output. Must match the
   * label the original SearchPanel passed (`page` → `'page resolution
   * failed'`, `tag` → `'tag resolution failed'`) so existing log
   * filters keep working.
   */
  logLabel: string
  /**
   * Extra reactive dependencies that should re-fire `searchFn`.
   * Typical use: `[currentSpaceId]` for the page picker, `[]` for the
   * tag picker. Each value participates in the effect's dep array.
   */
  extraDeps?: ReadonlyArray<unknown>
}

export function usePopoverEntity<T>(options: UsePopoverEntityOptions<T>): PopoverEntityState<T> {
  const { searchFn, logLabel, extraDeps = [] } = options
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<T[]>([])
  const [loading, setLoading] = useState(false)

  // Re-fetch whenever the popover opens or the query/extraDeps change.
  // Mirrors the original SearchPanel page-/tag-popover effects line for
  // line, including the early `if (!open) return` guard so we never
  // fetch into a closed popover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: extraDeps is the spread variant of a dep array; Biome can't statically analyse it.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    searchFn(query)
      .then((items) => {
        if (cancelled) return
        setSuggestions(items)
      })
      .catch((err) => {
        if (cancelled) return
        logger.warn('SearchPanel', `${logLabel} resolution failed`, undefined, err)
        setSuggestions([])
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, query, ...extraDeps])

  function reset() {
    setOpen(false)
    setQuery('')
  }

  return {
    open,
    setOpen,
    query,
    setQuery,
    suggestions,
    loading,
    reset,
  }
}
