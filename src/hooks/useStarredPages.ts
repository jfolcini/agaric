/**
 * useStarredPages — the active space's bookmarks, the synced `bookmark` page
 * property (`src/lib/starred-pages.ts`, #6544).
 *
 * "Starred" is the identifier only; every surface that renders this calls it
 * a bookmark.
 *
 * Every mounted instance reads one TanStack query per space, so the page
 * header, the Pages browser, the command palette and the sidebar stay in step
 * without a store. A write updates that query at once and then reaches the
 * backend; a failed write re-reads what the backend holds. A change that
 * arrives some other way (sync, MCP, import, undo) is re-read through
 * `invalidateDerivedCaches`.
 */
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import {
  type Bookmark,
  type BookmarkPlan,
  bookmarksQueryKey,
  loadBookmarks,
  planAdd,
  planMove,
  planRemove,
  writeBookmarks,
} from '@/lib/starred-pages'
import { useSpaceStore } from '@/stores/space'

export interface UseStarredPagesReturn {
  /**
   * The bookmarked page ids, iterating in sidebar order. Reference-stable
   * while the list is unchanged.
   */
  starredIds: ReadonlySet<string>
  /** Whether the active space's list has been read; until then `starredIds` is empty. */
  loaded: boolean
  /** Convenience predicate. Stable when `starredIds` is. */
  isStarred: (pageId: string) => boolean
  /** Bookmark the page after the last one, or remove its bookmark. */
  toggle: (pageId: string) => void
  /** Bookmark (in the order given) or unbookmark every page of `ids`, one write per page. */
  setMany: (ids: string[], starred: boolean) => void
  /** Move a bookmark to `overId`'s place in the sidebar order (a sortable drop). */
  move: (pageId: string, overId: string) => void
}

const EMPTY: readonly Bookmark[] = []

export function useStarredPages(): UseStarredPagesReturn {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { data, isSuccess } = useQuery(
    {
      queryKey: bookmarksQueryKey(spaceId ?? ''),
      queryFn: async () => {
        try {
          return await loadBookmarks(spaceId ?? '')
        } catch (err) {
          logger.warn('useStarredPages', 'reading the bookmarks failed', { spaceId }, err)
          throw err
        }
      },
      enabled: spaceId != null,
    },
    queryClient,
  )
  const list = data ?? EMPTY

  const starredIds = useMemo<ReadonlySet<string>>(() => new Set(list.map((b) => b.id)), [list])

  const isStarred = useCallback((pageId: string) => starredIds.has(pageId), [starredIds])

  /**
   * Show the planned list now, then write it. Planned from the cached list at
   * call time rather than the rendered one, so two calls before a re-render
   * both count.
   */
  const apply = useCallback(
    (plan: (current: readonly Bookmark[]) => BookmarkPlan | null) => {
      if (spaceId == null) return
      const key = bookmarksQueryKey(spaceId)
      const planned = plan(queryClient.getQueryData<Bookmark[]>(key) ?? EMPTY)
      if (planned === null) return
      queryClient.setQueryData(key, planned.next)
      writeBookmarks(planned).catch((err: unknown) => {
        logger.warn('useStarredPages', 'writing a bookmark failed', { spaceId }, err)
        void queryClient.invalidateQueries({ queryKey: key })
      })
    },
    [spaceId],
  )

  const toggle = useCallback(
    (pageId: string) => {
      apply((current) =>
        current.some((b) => b.id === pageId)
          ? planRemove(current, [pageId])
          : planAdd(current, [pageId]),
      )
    },
    [apply],
  )

  const setMany = useCallback(
    (ids: string[], starred: boolean) => {
      apply((current) => (starred ? planAdd(current, ids) : planRemove(current, ids)))
    },
    [apply],
  )

  const move = useCallback(
    (pageId: string, overId: string) => {
      apply((current) => planMove(current, pageId, overId))
    },
    [apply],
  )

  return { starredIds, loaded: isSuccess, isStarred, toggle, setMany, move }
}
