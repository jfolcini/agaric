/**
 * The page index (#6527): every page heading of one space behind one TanStack
 * query, for the pickers that filter the whole list client-side.
 *
 * In a page-heavy vault `list_all_pages_in_space` is megabytes of JSON, so a
 * picker must not fetch and parse it on every open.
 */
import { unwrap } from '@/lib/app-error'
import type { PageHeading } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'

const PAGE_INDEX_QUERY_ROOT = 'page-index'

/** The query of `spaceId`'s page index, for `useQuery` and `queryClient.fetchQuery`. */
export function pageIndexQuery(spaceId: string): {
  queryKey: readonly [string, string]
  queryFn: () => Promise<PageHeading[]>
} {
  return {
    queryKey: [PAGE_INDEX_QUERY_ROOT, spaceId],
    queryFn: async () => {
      try {
        return unwrap(
          await commands.listAllPagesInSpace({ kind: 'active', space_id: spaceId }, null),
        )
      } catch (err) {
        logger.error('page-index', 'reading the page list failed', { spaceId }, err)
        throw err
      }
    },
  }
}

// A page created, renamed, trashed, restored or moved to another space changes
// its space's list; a sync, an import or an MCP write reaches the bus as
// `invalidated`. A tag change does not.
subscribeToNameChanges((change) => {
  if (change.kind === 'invalidated' || change.entity === 'page') {
    void queryClient.invalidateQueries({ queryKey: [PAGE_INDEX_QUERY_ROOT] })
  }
})
