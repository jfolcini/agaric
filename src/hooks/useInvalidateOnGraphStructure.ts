/**
 * useInvalidateOnGraphStructure — refetch a query prefix when the page-link
 * graph changes.
 *
 * A `[[link]]` typed, pasted or synced fires no property event, so the
 * graph-structure counter (bumped by the page-block store on every local op and
 * by `sync:complete`) is what notices a link appearing or disappearing while a
 * references panel is mounted. It INVALIDATES rather than joining the query key:
 * the counter moves at every typing pause, and a new key would drop the loaded
 * pages, the expanded groups and the header count to a skeleton each time.
 * Invalidation refetches the loaded pages in place; the first value is the
 * mount, not a change.
 *
 * `queryKey` is a prefix — `invalidateQueries` prefix-matches, so every limit
 * variant under it refetches. Memoize it at the call site: it is an effect
 * dependency.
 */

import { useEffect, useRef } from 'react'

import { useGraphStructureEvents } from '@/hooks/useGraphStructureEvents'
import { queryClient } from '@/lib/query-client'

export function useInvalidateOnGraphStructure(queryKey: readonly unknown[]): void {
  const { structureKey } = useGraphStructureEvents()
  const seenStructureKeyRef = useRef(structureKey)

  useEffect(() => {
    if (seenStructureKeyRef.current === structureKey) return
    seenStructureKeyRef.current = structureKey
    void queryClient.invalidateQueries({ queryKey })
  }, [structureKey, queryKey])
}
