/**
 * useSavedViews — the active space's saved views, pages carrying the synced
 * `saved_view` property (`src/lib/saved-views.ts`, #6544).
 *
 * One TanStack query per space behind both lists (the Pages view's and
 * Advanced Query's), each taking its own kind.
 */
import { useQuery } from '@tanstack/react-query'

import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { loadSavedViews, type SavedView, savedViewsQueryKey } from '@/lib/saved-views'
import { useSpaceStore } from '@/stores/space'

const EMPTY: readonly SavedView[] = []

export interface UseSavedViewsReturn {
  /** The space the views belong to; `null` before a space is active. */
  spaceId: string | null
  /** Oldest first. Reference-stable while the list is unchanged. */
  views: readonly SavedView[]
}

export function useSavedViews(): UseSavedViewsReturn {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { data } = useQuery(
    {
      queryKey: savedViewsQueryKey(spaceId ?? ''),
      queryFn: async () => {
        try {
          return await loadSavedViews(spaceId ?? '')
        } catch (err) {
          logger.warn('useSavedViews', 'reading the saved views failed', { spaceId }, err)
          throw err
        }
      },
      enabled: spaceId != null,
    },
    queryClient,
  )
  return { spaceId, views: data ?? EMPTY }
}
