/**
 * useSavedPagesViews — the active space's Pages-view saved views (#2003
 * piece 1), view pages that sync (#6544), and the one the live
 * `{ sort, filters }` tuple matches.
 */
import { useCallback, useMemo } from 'react'

import { useSavedViews } from '@/hooks/useSavedViews'
import {
  findMatchingSavedPagesView,
  type PagesViewTuple,
  type SavedPagesView,
} from '@/lib/saved-pages-views'
import { deleteSavedView, restoreSavedView, saveView } from '@/lib/saved-views'

export interface UseSavedPagesViewsReturn {
  /** Oldest first. Reference-stable while the list is unchanged. */
  views: SavedPagesView[]
  /**
   * The saved view (if any) whose captured tuple structurally matches
   * `currentTuple`, or `null` when the current sort/filters combo
   * doesn't match any saved view. `null` when `currentTuple` was omitted.
   */
  activeView: SavedPagesView | null
  /** Save `tuple` as a view named `name`; resolves `false` when the space already holds the name. */
  saveView: (name: string, tuple: PagesViewTuple) => Promise<boolean>
  /** Move a view to the Trash; resolves to the stamp `restoreView` takes. */
  deleteView: (id: string) => Promise<number>
  restoreView: (id: string, deletedAt: number) => Promise<void>
}

export function useSavedPagesViews(currentTuple?: PagesViewTuple): UseSavedPagesViewsReturn {
  const { spaceId, views: all } = useSavedViews()
  const views = useMemo(
    () =>
      all.flatMap(({ id, name, payload }) =>
        payload.kind === 'pages'
          ? [{ id, name, sort: payload.sort, filters: payload.filters }]
          : [],
      ),
    [all],
  )

  const activeView = currentTuple ? findMatchingSavedPagesView(views, currentTuple) : null

  const save = useCallback(
    async (name: string, tuple: PagesViewTuple) => {
      if (spaceId == null) return false
      const saved = await saveView(spaceId, name, {
        kind: 'pages',
        sort: tuple.sort,
        filters: tuple.filters,
      })
      return saved !== null
    },
    [spaceId],
  )

  return {
    views,
    activeView,
    saveView: save,
    deleteView: deleteSavedView,
    restoreView: restoreSavedView,
  }
}
