/**
 * useSuggestedProperties — the keys a block is offered because a tag it
 * carries directly lists them (#6755), each once with the tag it came from.
 *
 * Read on every mount (`staleTime: 0`): a tag's list can change on its own
 * page while this block's surface is closed. A failed read offers nothing.
 */

import { useQuery } from '@tanstack/react-query'

import { unwrap } from '@/lib/app-error'
import type { SuggestedProperty } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'

const NONE: SuggestedProperty[] = []

export function useSuggestedProperties(blockId: string | null): SuggestedProperty[] {
  const { data } = useQuery(
    {
      queryKey: ['suggestedProperties', blockId],
      enabled: blockId !== null,
      staleTime: 0,
      queryFn: async (): Promise<SuggestedProperty[]> => {
        try {
          return unwrap(await commands.listSuggestedProperties(blockId ?? ''))
        } catch (err) {
          logger.warn('useSuggestedProperties', 'failed to load suggestions', { blockId }, err)
          return NONE
        }
      },
    },
    queryClient,
  )
  return data ?? NONE
}
