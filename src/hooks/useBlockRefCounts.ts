/**
 * useBlockRefCounts — how many blocks reference each block of a page (#6746),
 * one `count_backlinks_in_page` read per page, whatever its size. Only the
 * blocks something references are in the map.
 *
 * The graph-structure counter is in the key rather than an invalidation axis
 * (`useInvalidateOnCounter`): a `((ref))` written on another page while this
 * one was closed must show when it opens again, and an invalidation heard by
 * no mounted tree reaches no cache. `placeholderData` keeps the old counts on
 * screen while the next read runs, so nothing flickers.
 *
 * Block mode reads it through {@link BlockRefCountsContext}, mounted by
 * `BlockTree`; page mode hands it to its node views (`PageModeEditor`).
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createContext, useContext } from 'react'

import { useGraphStructureEvents } from '@/hooks/useGraphStructureEvents'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

const NONE: Readonly<Record<string, number>> = {}

export function useBlockRefCounts(pageId: string | null): Readonly<Record<string, number>> {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { structureKey } = useGraphStructureEvents()
  const { data } = useQuery(
    {
      queryKey: ['blockRefCounts', spaceId, pageId, structureKey],
      queryFn: async () => {
        try {
          return unwrap(
            await commands.countBacklinksInPage(
              pageId as string,
              requireActiveScope(spaceId as string),
            ),
          )
        } catch (err) {
          // A count is a hint: without it the blocks show none, as before.
          logger.warn('useBlockRefCounts', 'reference counts failed', { pageId }, err)
          return NONE
        }
      },
      enabled: pageId !== null && spaceId !== null,
      placeholderData: keepPreviousData,
    },
    queryClient,
  )
  return data ?? NONE
}

export const BlockRefCountsContext = createContext<Readonly<Record<string, number>>>(NONE)

/** The reference count of `blockId`, 0 when nothing references it. */
export function useBlockRefCount(blockId: string): number {
  return useContext(BlockRefCountsContext)[blockId] ?? 0
}
