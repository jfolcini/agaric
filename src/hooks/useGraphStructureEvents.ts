/**
 * useGraphStructureEvents — subscribe to the module-level graph-structure
 * mutation counter (`src/lib/graph-structure-events.ts`).
 *
 * #1530: the counter increments whenever a mutation changes the page-link graph
 * topology — a local block/link/page CRUD op (via `page-blocks.ts`) or an
 * applied remote sync batch (`sync:complete`). `GraphView` reads it as a
 * dependency to invalidate its (spaceId, tagIds)-keyed cache and refetch
 * (stale-while-revalidate) instead of serving stale nodes/edges until the TTL.
 *
 * Because the counter is module-level it survives unmount/remount, so a mutation
 * that occurs while `GraphView` is unmounted is still reflected on the next mount
 * (the same survives-unmount guarantee as the property counter in #1818).
 */

import { useSyncExternalStore } from 'react'

import {
  getGraphStructureKey,
  subscribeToGraphStructureEvents,
} from '../lib/graph-structure-events'

export interface UseGraphStructureEventsReturn {
  /** Monotonic counter — increments (debounced) on each graph-topology mutation. */
  structureKey: number
}

/**
 * Subscribe to the module-level graph-structure mutation counter.
 */
export function useGraphStructureEvents(): UseGraphStructureEventsReturn {
  const structureKey = useSyncExternalStore(subscribeToGraphStructureEvents, getGraphStructureKey)

  return { structureKey }
}
