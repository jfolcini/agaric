/**
 * useInvalidateOnGraphStructure — refetch a query prefix when the page-link
 * graph changes.
 *
 * A `[[link]]` typed, pasted or synced fires no property event, so the
 * graph-structure counter (bumped by the page-block store on every local op and
 * by `sync:complete`) is what notices a link appearing or disappearing while a
 * references panel is mounted. Why it invalidates rather than joining the query
 * key: {@link useInvalidateOnCounter}.
 *
 * `queryKey` is a prefix. Memoize it at the call site: it is an effect
 * dependency.
 */

import { useGraphStructureEvents } from '@/hooks/useGraphStructureEvents'
import { useInvalidateOnCounter } from '@/hooks/useInvalidateOnCounter'

export function useInvalidateOnGraphStructure(queryKey: readonly unknown[]): void {
  const { structureKey } = useGraphStructureEvents()
  useInvalidateOnCounter(structureKey, queryKey)
}
