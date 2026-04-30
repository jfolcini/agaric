/**
 * useStarredPages — localStorage-backed starred pages with cross-instance sync.
 *
 * Replaces the per-component `starredRevision` counter pattern that
 * `PageBrowser` and `PageHeader` previously used to force re-renders
 * after a bare `toggleStarred()` lib call (MAINT-130 sub-item b).
 *
 * The localStorage shape is owned by `src/lib/starred-pages.ts` (a JSON
 * array under the `starred-pages` key). The hook sits on top: it reads
 * the persisted set on mount and subscribes to a custom
 * `'starred-pages-changed'` window event so every mounted hook instance
 * re-reads after any `toggle()` call. The event-based broadcast keeps
 * two PageBrowser/PageHeader instances on the same page in sync without
 * a Zustand store — see AGENTS.md "Architectural Stability".
 *
 * Returned `starredIds` is referentially stable across renders when the
 * persisted contents have not changed (the refresh listener compares
 * old vs new and short-circuits the state update on equality), so
 * memos that depend on it stay quiet.
 */
import { useCallback, useEffect, useState } from 'react'
import { getStarredPages, toggleStarred } from '../lib/starred-pages'

/** Window event name broadcast on every successful toggle. */
const STARRED_PAGES_CHANGED_EVENT = 'starred-pages-changed'

export interface UseStarredPagesReturn {
  /** Current starred page IDs. Reference-stable while contents are unchanged. */
  starredIds: ReadonlySet<string>
  /** Convenience predicate. Stable when `starredIds` is. */
  isStarred: (pageId: string) => boolean
  /** Toggle a page's starred state and broadcast the change to other instances. */
  toggle: (pageId: string) => void
}

function readStarredSet(): ReadonlySet<string> {
  return new Set(getStarredPages())
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export function useStarredPages(): UseStarredPagesReturn {
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(readStarredSet)

  useEffect(() => {
    function refresh() {
      const next = readStarredSet()
      setStarredIds((prev) => (setsEqual(prev, next) ? prev : next))
    }
    window.addEventListener(STARRED_PAGES_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(STARRED_PAGES_CHANGED_EVENT, refresh)
  }, [])

  const isStarred = useCallback((pageId: string) => starredIds.has(pageId), [starredIds])

  const toggle = useCallback((pageId: string) => {
    // Write to localStorage BEFORE dispatching so other instances see fresh
    // data when their refresh listener calls `getStarredPages()`. The lib's
    // `toggleStarred` is fully synchronous, so this ordering is sufficient
    // — no need to await anything before the broadcast.
    toggleStarred(pageId)
    window.dispatchEvent(new CustomEvent(STARRED_PAGES_CHANGED_EVENT))
  }, [])

  return { starredIds, isStarred, toggle }
}
