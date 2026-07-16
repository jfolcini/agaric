/**
 * useStarredPages — localStorage-backed starred pages with cross-instance sync.
 *
 * The localStorage shape is owned by `src/lib/starred-pages.ts` (a JSON
 * array under the `starred-pages` key, registered as
 * `PREFERENCES.starredPages`). The hook is a thin subscriber over the
 * shared `usePreference` primitive (#2666): every registry write — this
 * hook's own `toggle`/`setMany` (which delegate to the lib writers) or any
 * other `writePreference` caller — broadcasts the change, so every mounted
 * hook instance re-reads. This replaces the hand-rolled
 * `'starred-pages-changed'` window event (itself a replacement for the
 * per-component `starredRevision` counter pattern that desynced
 * `PageBrowser`/`PageHeader` instances). Two PageBrowser/PageHeader
 * instances on the same page stay in sync without a Zustand store — see
 * AGENTS.md "Architectural Stability".
 *
 * Returned `starredIds` is referentially stable across renders while the
 * persisted contents have not changed (the primitive caches the parsed
 * snapshot against the raw stored string), so memos that depend on it stay
 * quiet.
 */
import { useCallback, useMemo } from 'react'

import { PREFERENCES, usePreference } from '@/lib/preferences'
import { setStarred, toggleStarred } from '@/lib/starred-pages'

export interface UseStarredPagesReturn {
  /** Current starred page IDs. Reference-stable while contents are unchanged. */
  starredIds: ReadonlySet<string>
  /** Convenience predicate. Stable when `starredIds` is. */
  isStarred: (pageId: string) => boolean
  /** Toggle a page's starred state and broadcast the change to other instances. */
  toggle: (pageId: string) => void
  /**
   * Bulk-set the starred state of many pages in one write, then broadcast the
   * change once so other instances re-read. Mirrors `toggle`'s
   * write-before-broadcast ordering.
   */
  setMany: (ids: string[], starred: boolean) => void
}

export function useStarredPages(): UseStarredPagesReturn {
  const [starredArray] = usePreference(PREFERENCES.starredPages)

  // `starredArray` is reference-stable while the stored contents are
  // unchanged (primitive snapshot cache), so the derived Set is too.
  const starredIds = useMemo<ReadonlySet<string>>(() => new Set(starredArray), [starredArray])

  const isStarred = useCallback((pageId: string) => starredIds.has(pageId), [starredIds])

  // The lib writers persist synchronously through `writePreference`, which
  // writes BEFORE broadcasting — so every instance (including this one)
  // re-reads fresh data. One broadcast per call, batches included.
  const toggle = useCallback((pageId: string) => {
    toggleStarred(pageId)
  }, [])

  const setMany = useCallback((ids: string[], starred: boolean) => {
    setStarred(ids, starred)
  }, [])

  return { starredIds, isStarred, toggle, setMany }
}
