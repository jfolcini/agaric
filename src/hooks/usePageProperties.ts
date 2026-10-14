/**
 * usePageProperties — the page's own `get_properties` rows, shared by every
 * page-header consumer (`usePageTemplateMeta`, `PagePropertyTable`) so a page
 * open issues one fetch (#5445).
 *
 * Refetches on mount, on a `block:properties-changed` event for this page (an
 * event for any other block, such as a TODO toggle on a child, is ignored),
 * and on `invalidatePageProperties()`, which `invalidatePropertyCaches()` calls
 * for the writes that emit no event (sync, MCP, undo, import; #5287).
 */

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { unwrap } from '@/lib/app-error'
import type { PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { PAGE_PROPERTIES_QUERY_ROOT, pagePropertiesQueryKey } from '@/lib/property-caches'
import {
  ensurePropertyChangeDispatch,
  type PropertyChangeTarget,
  registerPropertyChangeTarget,
} from '@/lib/property-change-dispatch'
import { queryClient } from '@/lib/query-client'

const invalidateChangedPage: PropertyChangeTarget = (payload) => {
  void queryClient.invalidateQueries({
    queryKey: payload ? pagePropertiesQueryKey(payload.block_id) : [PAGE_PROPERTIES_QUERY_ROOT],
  })
}

// The dispatcher keeps its targets in a Set, so every mount re-adding this one
// function is still a single registration; it stays registered for the
// process, like the dispatcher's own listener.
function listenForPropertyChanges(): void {
  registerPropertyChangeTarget(invalidateChangedPage)
  ensurePropertyChangeDispatch((err) => {
    logger.warn('usePageProperties', 'Failed to listen for property change events', {}, err)
  })
}

export function usePageProperties(pageId: string) {
  useEffect(listenForPropertyChanges, [])

  return useQuery(
    {
      queryKey: pagePropertiesQueryKey(pageId),
      queryFn: async (): Promise<PropertyRow[]> => unwrap(await commands.getProperties(pageId)),
      refetchOnMount: 'always',
      // `PagePropertyTable` edits a local copy and adopts each fetch by
      // reference, so an answer equal to the cached one must still be new.
      structuralSharing: false,
    },
    queryClient,
  )
}
