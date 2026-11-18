/**
 * useInvalidateOnCounter — refetch a query prefix when a monotonic counter moves.
 *
 * A refresh axis — the graph-structure counter (a `[[link]]` typed, pasted or
 * synced), the block-property counter (a TODO ticked) — is not part of what a
 * panel queries, and moves while the user is doing something else. Joining the
 * query key would drop the loaded pages, the expanded groups and the header
 * count to a skeleton each time (#4962); invalidating refetches them in place.
 * The counter's first value is the mount, not a change, so the initial render
 * never invalidates.
 *
 * A Load more in flight waits to land first (#6911): invalidating cancels a
 * running fetch and refetches only the pages the cache already holds, so the
 * page the user asked for would be dropped. Once it lands, the refetch covers it.
 *
 * `queryKey` is a prefix — `invalidateQueries` prefix-matches, so every variant
 * under it refetches. Memoize it at the call site: it is an effect dependency.
 */

import { useEffect, useRef } from 'react'

import { queryClient } from '@/lib/query-client'

export function useInvalidateOnCounter(counter: number, queryKey: readonly unknown[]): void {
  const seenCounterRef = useRef(counter)

  useEffect(() => {
    if (seenCounterRef.current === counter) return
    seenCounterRef.current = counter
    const loadingMore = queryClient
      .getQueryCache()
      .findAll({ queryKey, fetchStatus: 'fetching' })
      .filter((query) => query.state.fetchMeta?.fetchMore != null)
      .flatMap((query) => query.promise ?? [])
    void Promise.allSettled(loadingMore).then(() => queryClient.invalidateQueries({ queryKey }))
  }, [counter, queryKey])
}
